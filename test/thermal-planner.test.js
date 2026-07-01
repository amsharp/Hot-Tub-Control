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
  assert.equal(p.plan(100, 800, 1).heat, null); // before start -> idle
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

test('coasts (no action) after the target time', () => {
  const p = new SmartHeatPlanner({ model: fakeModel(2), peaks: PEAK });
  assert.equal(p.plan(100, 22 * 60, 1).heat, null); // 10 PM, after peak -> idle
});

test('already at target in the morning coasts until the start time', () => {
  const p = new SmartHeatPlanner({ model: fakeModel(2), targetMin: 16 * 60, peaks: PEAK, safetyMin: 30 });
  // temp>=target -> hoursToHeat 0 -> startMin = 930; before that, idle
  assert.equal(p.plan(104, 9 * 60, 1).heat, null);
});

test('unreachable target (Infinity) heats as early as possible off-peak', () => {
  const p = new SmartHeatPlanner({ model: { hoursToHeat: () => Infinity }, targetMin: 16 * 60, peaks: PEAK });
  assert.equal(p.plan(80, 6 * 60, 1).heat, true); // 6 AM, off-peak, needs all day
});

test('the latch resets on a new day', () => {
  const p = new SmartHeatPlanner({ model: fakeModel(2), targetMin: 16 * 60, peaks: PEAK, safetyMin: 30 });
  p.plan(100, 810, 1); // commit day 1
  assert.equal(p.plan(100, 700, 2).heat, null); // day 2, before start -> not latched
});

test('fmtMin formats minutes-of-day', () => {
  assert.equal(fmtMin(810), '1:30 PM');
  assert.equal(fmtMin(6 * 60), '6:00 AM');
  assert.equal(fmtMin(Infinity), '—');
});
