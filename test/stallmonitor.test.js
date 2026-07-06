import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StallMonitor } from '../src/stallmonitor.js';

const MIN = 60_000;

test('warns once when firing long with no temperature gain', () => {
  let notices = 0;
  const m = new StallMonitor({ stallMinutes: 40, minGainF: 1, notify: async () => { notices += 1; } });
  // Fire continuously at a flat 97F.
  assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: 0 }), false); // baseline
  assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: 30 * MIN }), false); // not yet
  assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: 41 * MIN }), true); // stalled
  // No repeat spam while still stalled.
  assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: 60 * MIN }), false);
  assert.equal(notices, 1);
});

test('real progress re-baselines and prevents a warning', () => {
  const m = new StallMonitor({ stallMinutes: 40, minGainF: 1 });
  m.update({ firing: true, tempF: 97, reliable: true, now: 0 });
  m.update({ firing: true, tempF: 98, reliable: true, now: 20 * MIN }); // +1F -> progress, rebaseline
  // 40 min after the ORIGINAL start but only 20 after rebaseline, still flat: no warn yet.
  assert.equal(m.update({ firing: true, tempF: 98, reliable: true, now: 45 * MIN }), false);
  // Now flat long enough from the rebaseline -> warn.
  assert.equal(m.update({ firing: true, tempF: 98, reliable: true, now: 61 * MIN }), true);
});

test('the element stopping resets the episode', () => {
  const m = new StallMonitor({ stallMinutes: 40, minGainF: 1 });
  m.update({ firing: true, tempF: 97, reliable: true, now: 0 });
  m.update({ firing: false, tempF: 97, reliable: true, now: 50 * MIN }); // stopped -> reset
  // Fresh firing run; the clock restarts, so no warning at t=60.
  assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: 60 * MIN }), false);
});

test('ignores unreliable readings (never warns on stagnant-sensor noise)', () => {
  let notices = 0;
  const m = new StallMonitor({ stallMinutes: 40, minGainF: 1, notify: async () => { notices += 1; } });
  for (let t = 0; t <= 90 * MIN; t += 10 * MIN) {
    m.update({ firing: true, tempF: 97, reliable: false, now: t });
  }
  assert.equal(notices, 0);
});
