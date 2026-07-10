import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartHeatPlanner, fmtMin } from '../src/thermal/planner.js';

// Model stub with a fixed heat-up duration.
function fakeModel(hours) {
  return { hoursToHeat: (from, to) => (from >= to ? 0 : hours) };
}

const PEAK = [{ start: 16 * 60, end: 21 * 60 }]; // 4-9 PM

test('starts pre-heat at the latest safe time and latches on', () => {
  const p = new SmartHeatPlanner({ model: fakeModel(2), targetF: 104, targetMin: 16 * 60, peaks: PEAK, safetyMin: 30 });
  // startMin = 960 - 120 - 30 = 810 (1:30 PM)
  assert.equal(p.plan(100, 800, 1).heat, false); // before start -> ensure off
  const at = p.plan(100, 810, 1);
  assert.equal(at.heat, true); // at start -> on
  assert.equal(at.reason, 'preheat');
  // latch: stays on through target time even as temp reaches/dips around target
  assert.equal(p.plan(104, 820, 1).heat, true); // holding
  assert.equal(p.plan(101, 900, 1).heat, true);
});

test('never heats during a peak window', () => {
  const p = new SmartHeatPlanner({ model: fakeModel(2), peaks: PEAK });
  const r = p.plan(90, 17 * 60, 1); // 5 PM, cold
  assert.equal(r.heat, false);
  assert.equal(r.reason, 'peak');
});

test('keeps the heater OFF after the target time (no lingering evening heat)', () => {
  const p = new SmartHeatPlanner({ model: fakeModel(2), peaks: PEAK });
  assert.equal(p.plan(100, 22 * 60, 1).heat, false); // 10 PM, after peak -> ensure off
});

test('already at target in the morning coasts until the start time', () => {
  const p = new SmartHeatPlanner({ model: fakeModel(2), targetMin: 16 * 60, peaks: PEAK, safetyMin: 30 });
  // temp>=target -> hoursToHeat 0 -> tiny lead window; before it, ensure off
  assert.equal(p.plan(104, 9 * 60, 1).heat, false);
});

test('unreachable target: heats within the capped lead window, off before it', () => {
  const p = new SmartHeatPlanner({ model: { hoursToHeat: () => Infinity }, targetMin: 16 * 60, peaks: PEAK, maxLeadHours: 7 });
  // Cap = 7h before the 4 PM target -> window starts 9 AM. At 6 AM it's too early.
  assert.equal(p.plan(80, 6 * 60, 1).heat, false); // 6 AM -> ensure off (capped out)
  assert.equal(p.plan(80, 10 * 60, 1).heat, true); // 10 AM -> within 7h window -> heat
});

test('cross-midnight pre-heat: an early-morning target heats the prior evening', () => {
  // Target 6:00 AM (360), needs 5h -> lead window 5h+30 = 330 min, so start ~00:00.
  const p = new SmartHeatPlanner({ model: fakeModel(5), targetF: 104, targetMin: 6 * 60, peaks: PEAK, safetyMin: 30 });
  // 10:00 PM the prior evening (1320, past the 4-9 peak): before the lead window,
  // idle (NOT wrongly 'after-target' the way the old nowMin>=targetMin logic did).
  assert.equal(p.plan(95, 22 * 60, 1).heat, false);
  // 00:40 (40): minsUntil = 320 <= 330 lead -> pre-heat, even though nowMin(40) >
  // would-be startMin. This is the case the old nowMin>=targetMin logic broke.
  const at = p.plan(95, 40, 2);
  assert.equal(at.heat, true);
  assert.equal(at.reason, 'preheat');
  // 6:10 AM (370), just past target: stop (ensure off).
  assert.equal(p.plan(104, 370, 2).heat, false);
});

test('caps the pre-heat window so a marginal model cannot heat all evening', () => {
  // Marginal heater: model says 18h to reach target (the exact regression that
  // made it "stay on after hours"). maxLeadHours=7 must bound it.
  const p = new SmartHeatPlanner({ model: fakeModel(18), targetF: 104, targetMin: 16 * 60, peaks: PEAK, safetyMin: 30, maxLeadHours: 7 });
  assert.equal(p.plan(97, 22 * 60, 1).heat, false); // 10 PM -> 18h out, past the 7h cap -> OFF
  assert.equal(p.plan(97, 10 * 60, 1).heat, true); // 10 AM -> within 7h of 4 PM -> heat
});

test('the latch resets on a new day', () => {
  const p = new SmartHeatPlanner({ model: fakeModel(2), targetMin: 16 * 60, peaks: PEAK, safetyMin: 30 });
  p.plan(100, 810, 1); // commit day 1
  assert.equal(p.plan(100, 700, 2).heat, false); // day 2, before start -> not latched, off
});

test('peakEndMin returns the containing peak window end', () => {
  const p = new SmartHeatPlanner({ model: fakeModel(2), peaks: PEAK });
  assert.equal(p.peakEndMin(17 * 60), 21 * 60); // 5 PM -> peak ends 9 PM
  assert.equal(p.peakEndMin(10 * 60), null); // 10 AM -> not in peak
});

test('fmtMin formats minutes-of-day', () => {
  assert.equal(fmtMin(810), '1:30 PM');
  assert.equal(fmtMin(6 * 60), '6:00 AM');
  assert.equal(fmtMin(Infinity), '—');
});

test('forecast-predictive sizing pre-heats earlier on a colder night', () => {
  // Model stub: linear 2°F/hr heat-up, Newton cooling toward a fixed ambient so
  // a colder forecast projects a lower start temp and thus a longer pre-heat.
  const modelWith = (ambient) => ({
    hoursToHeat: (from, to) => (from >= to ? 0 : (to - from) / 2),
    projectCool: (fromTemp, fromTs, toTs) =>
      ambient + (fromTemp - ambient) * Math.exp(-0.05 * ((toTs - fromTs) / 3_600_000)),
  });
  const opts = { targetF: 104, targetMin: 16 * 60, peaks: [], safetyMin: 0 };
  const nowMin = 6 * 60; // 6 AM
  const nowMs = nowMin * 60_000; // wall clock consistent with nowMin
  const warm = new SmartHeatPlanner({ model: modelWith(75), ...opts }).plan(100, nowMin, 1, nowMs);
  const cold = new SmartHeatPlanner({ model: modelWith(35), ...opts }).plan(100, nowMin, 1, nowMs);
  assert.ok(cold.startMin < warm.startMin, `cold night starts earlier (${cold.startMin} < ${warm.startMin})`);
});

test('omitting nowMs keeps the non-predictive behaviour', () => {
  // No nowMs -> plain hoursToHeat(currentTemp) sizing, projectCool never called.
  const model = { hoursToHeat: (from, to) => (from >= to ? 0 : 3), projectCool: () => { throw new Error('should not be called'); } };
  const p = new SmartHeatPlanner({ model, targetF: 104, targetMin: 16 * 60, peaks: [], safetyMin: 0 });
  const r = p.plan(100, 6 * 60, 1); // no nowMs
  assert.equal(r.startMin, 16 * 60 - 180); // 960 - 3h
});
