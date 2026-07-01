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

test('learns heating params from synthetic Newton data (circulating + settled)', () => {
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
    m.observe(T, true, true, t); // pump circulating throughout
  }
  const p = m.heatParams();
  assert.ok(Math.abs(p.loss - loss) < 0.08, `loss ~${p.loss.toFixed(3)}`);
  assert.ok(Math.abs(p.teq - teq) < 3, `teq ~${p.teq.toFixed(2)}`);
});

test('ignores stagnant (pump-off) readings; learns cooling from the settle-to-settle delta', () => {
  const m = new ThermalModel({ store: fakeStore() });
  const H = 3_600_000;
  // A trustworthy reading while circulating + settled.
  m.observe(104, true, true, 0);
  m.observe(104, true, true, 6 * 60_000);
  // Pump off overnight: stagnant sensor reads garbage — must be ignored.
  m.observe(103, false, false, 7 * 60_000);
  m.observe(130, false, false, 3 * H);
  // Circulation resumes; first reading isn't settled yet, the next one is (96 °F).
  m.observe(96, false, true, 15 * H);
  m.observe(96, false, true, 15 * H + 6 * 60_000);
  assert.ok(m.stats().coolSamples >= 1, 'recorded one cooling observation across the off gap');
});

test('estimateTemp projects a stale reading forward when the pump is off', () => {
  const m = new ThermalModel({ store: fakeStore() });
  m.observe(104, false, true, 0);
  m.observe(104, false, true, 6 * 60_000); // reliable baseline at 104
  const est = m.estimateTemp(104, false, 6 * 60_000 + 4 * 3_600_000); // 4h later, pump off
  assert.equal(est.reliable, false);
  assert.ok(est.tempF < 104, `projected cooler than the stale 104 (${est.tempF})`);
});
