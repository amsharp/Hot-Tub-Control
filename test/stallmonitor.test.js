import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StallMonitor } from '../src/stallmonitor.js';

const MIN = 60_000;
// Model stub: says it takes `hrs` to gain a degree (Infinity = unreachable).
const model = (hrs) => ({ hoursToHeat: () => hrs });

test('does NOT warn while heating within the model-expected time (no false alarm)', () => {
  let notices = 0;
  // Model: a degree legitimately takes 2h here. threshold = max(30min, 2.5×2h)=5h.
  const m = new StallMonitor({ model: model(2), factor: 2.5, notify: async () => { notices += 1; } });
  m.update({ firing: true, tempF: 97, reliable: true, now: 0 });
  // Whole-degree quantization holds it at 97 for ~2h legitimately — must NOT warn.
  for (let t = 20 * MIN; t <= 4 * 60 * MIN; t += 20 * MIN) {
    assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: t }), false, `t=${t / MIN}min`);
  }
  assert.equal(notices, 0);
});

test('warns once past factor×expected with no gain', () => {
  let notices = 0;
  const m = new StallMonitor({ model: model(1), factor: 2.5, notify: async () => { notices += 1; } }); // threshold 2.5h
  m.update({ firing: true, tempF: 97, reliable: true, now: 0 });
  assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: 2 * 60 * MIN }), false); // 2h < 2.5h
  assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: 160 * MIN }), true); // 2.67h >= 2.5h
  assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: 200 * MIN }), false); // no repeat
  assert.equal(notices, 1);
});

test('unreachable target (model says Infinity) warns after the grace period', () => {
  const m = new StallMonitor({ model: model(Infinity), graceMinutes: 30 });
  m.update({ firing: true, tempF: 97, reliable: true, now: 0 });
  assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: 20 * MIN }), false); // within grace
  assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: 31 * MIN }), true); // genuine stall
});

test('real progress re-baselines and re-arms', () => {
  const m = new StallMonitor({ model: model(1), factor: 2.5 }); // threshold 2.5h=150min
  m.update({ firing: true, tempF: 97, reliable: true, now: 0 });
  m.update({ firing: true, tempF: 98, reliable: true, now: 60 * MIN }); // +1F -> rebaseline at t=60
  assert.equal(m.update({ firing: true, tempF: 98, reliable: true, now: 200 * MIN }), false); // 140min from rebaseline < 150
  assert.equal(m.update({ firing: true, tempF: 98, reliable: true, now: 215 * MIN }), true); // 155min >= 150 -> stalled
});

test('element stopping resets the episode', () => {
  const m = new StallMonitor({ model: model(1), factor: 2.5 });
  m.update({ firing: true, tempF: 97, reliable: true, now: 0 });
  m.update({ firing: false, tempF: 97, reliable: true, now: 200 * MIN }); // stopped -> reset
  assert.equal(m.update({ firing: true, tempF: 97, reliable: true, now: 260 * MIN }), false); // fresh run
});

test('ignores unreliable readings', () => {
  let notices = 0;
  const m = new StallMonitor({ model: model(0.1), notify: async () => { notices += 1; } });
  for (let t = 0; t <= 300 * MIN; t += 20 * MIN) m.update({ firing: true, tempF: 97, reliable: false, now: t });
  assert.equal(notices, 0);
});
