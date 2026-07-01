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

test('estimateTemp follows the forecast ambient (colder forecast -> colder projection)', () => {
  const H = 3_600_000;
  const mk = (ambient) => {
    const m = new ThermalModel({ store: fakeStore(), ambientFn: () => ambient });
    m.observe(104, false, true, 0);
    m.observe(104, false, true, 6 * 60_000); // reliable baseline at 104
    return m.estimateTemp(104, false, 6 * 60_000 + 8 * H).tempF; // 8h off
  };
  const cold = mk(40);
  const warm = mk(70);
  assert.ok(cold < warm, `cold forecast projects lower (${cold} < ${warm})`);
  assert.ok(cold < 104 && warm < 104);
});

test('cooling learns the loss coefficient against the forecast driving ΔT', () => {
  // Synthetic cooling toward a known ambient (50°F) at a known loss (0.1/hr).
  const ambient = 50;
  const loss = 0.1;
  const m = new ThermalModel({ store: fakeStore(), ambientFn: () => ambient });
  let T = 100;
  let t = 0;
  // Prime a settled, circulating, heater-off streak, then feed cooling steps.
  m.observe(T, false, true, t);
  t += 6 * 60_000;
  m.observe(T, false, true, t);
  for (let i = 0; i < 40; i++) {
    const rate = -loss * (T - ambient);
    const dtH = 0.25;
    T += rate * dtH;
    t += dtH * 3_600_000;
    m.observe(T, false, true, t);
  }
  const p = m.coolParams(t);
  assert.ok(m.stats().coolSamples >= 8, `enough samples (${m.stats().coolSamples})`);
  assert.ok(Math.abs(p.loss - loss) < 0.03, `learned loss ~${p.loss.toFixed(3)}`);
  assert.equal(p.ambient, ambient, 'ambient comes from the forecast, not learned');
});
