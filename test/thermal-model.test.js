import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThermalModel } from '../src/thermal/model.js';

function fakeStore() {
  return { data: {}, save() {} };
}

test('hoursToHeat is 0 at/above target', () => {
  const m = new ThermalModel({ store: fakeStore() });
  assert.equal(m.hoursToHeat(104, 104), 0);
  assert.equal(m.hoursToHeat(106, 104), 0);
});

test('hoursToHeat is positive and larger from a colder start', () => {
  const m = new ThermalModel({ store: fakeStore() });
  const warm = m.hoursToHeat(100, 104);
  const cold = m.hoursToHeat(90, 104);
  assert.ok(warm > 0);
  assert.ok(cold > warm);
});

test('hoursToHeat is Infinity when target exceeds heating equilibrium', () => {
  const m = new ThermalModel({ store: fakeStore() });
  // prior teq is 106, so 110 is unreachable
  assert.equal(m.hoursToHeat(100, 110), Infinity);
});

test('learns heating params from synthetic Newton data', () => {
  const m = new ThermalModel({ store: fakeStore() });
  const loss = 0.3;
  const teq = 108;
  let T = 90;
  let t = 0;
  for (let i = 0; i < 60; i++) {
    const rate = loss * (teq - T); // °F/hr
    const dtH = 0.25; // 15 min steps
    T += rate * dtH;
    t += dtH * 3_600_000;
    m.observe(T, true, t); // continuous temps; model's own thresholds gate learning
  }
  const p = m.heatParams();
  assert.ok(Math.abs(p.loss - loss) < 0.08, `loss ~${p.loss.toFixed(3)}`);
  assert.ok(Math.abs(p.teq - teq) < 3, `teq ~${p.teq.toFixed(2)}`);
});

test('a heater-state flip resets the learning baseline (no cross-transition rate)', () => {
  const m = new ThermalModel({ store: fakeStore() });
  m.observe(95, true, 0);
  const flipped = m.observe(96, false, 20 * 60_000); // state changed -> should not record
  assert.equal(flipped, false);
  assert.equal(m.stats().heatSamples, 0);
});
