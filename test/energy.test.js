import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyMeter } from '../src/energy.js';

function fakeStore() {
  return { data: {}, save() {} };
}
const H = 3_600_000;

test('counts the heater only when the element is actively firing (heat=3)', () => {
  const m = new EnergyMeter({ store: fakeStore(), watts: { heater: 1300, pump: 40, blower: 600 } });
  assert.equal(m.wattsFor({ raw: { heat: 3 }, filter: true }), 1340); // firing + pump
  assert.equal(m.wattsFor({ raw: { heat: 2 }, filter: true }), 40); // idle at target: pump only
  assert.equal(m.wattsFor({ raw: { heat: 0 }, filter: false }), 0);
  assert.equal(m.wattsFor({ raw: { heat: 0 }, bubbles: true, filter: true }), 640); // blower + pump
});

test('accumulates kWh over sampled intervals', () => {
  const m = new EnergyMeter({ store: fakeStore(), watts: { heater: 1300, pump: 40, blower: 600 }, rate: 0.4 });
  m.sample({ raw: { heat: 3 }, filter: true }, 0, 20260701, 202607); // 1340W baseline
  m.sample({ raw: { heat: 3 }, filter: true }, H, 20260701, 202607); // 1h at 1340W
  const s = m.summary();
  assert.ok(Math.abs(s.todayKwh - 1.34) < 0.001, `~1.34 kWh (${s.todayKwh})`);
  assert.ok(Math.abs(s.todayCost - 0.536) < 0.001, `~$0.54 (${s.todayCost})`);
});

test('attributes override + peak energy to their buckets at the peak rate', () => {
  const m = new EnergyMeter({ store: fakeStore(), watts: { heater: 1000, pump: 0, blower: 0 }, rate: 0.3, ratePeak: 0.6 });
  // interval 1: normal off-peak run
  m.sample({ raw: { heat: 3 } }, 0, 20260701, 202607, { inPeak: false, overridden: false });
  m.sample({ raw: { heat: 3 } }, H, 20260701, 202607, { inPeak: true, overridden: true }); // 1 kWh off-peak (prev ctx), then flag peak+override
  m.sample({ raw: { heat: 3 } }, 2 * H, 20260701, 202607, { inPeak: false, overridden: false }); // 1 kWh at peak+override
  const s = m.summary();
  assert.ok(Math.abs(s.monthKwh - 2) < 0.01, `2 kWh total (${s.monthKwh})`);
  assert.ok(Math.abs(s.overrideKwh - 1) < 0.01, `1 kWh override (${s.overrideKwh})`);
  assert.ok(Math.abs(s.peakKwh - 1) < 0.01, `1 kWh peak (${s.peakKwh})`);
  // costs: 1 kWh @ 0.30 (off-peak) + 1 kWh @ 0.60 (peak) = 0.90; override cost = the peak kWh = 0.60
  assert.ok(Math.abs(s.monthCost - 0.9) < 0.01, `$0.90 total (${s.monthCost})`);
  assert.ok(Math.abs(s.overrideCost - 0.6) < 0.01, `$0.60 override (${s.overrideCost})`);
});

test('resets the daily total on a new day but keeps the monthly total', () => {
  const m = new EnergyMeter({ store: fakeStore(), watts: { heater: 1000, pump: 0, blower: 0 } });
  m.sample({ raw: { heat: 3 } }, 0, 20260701, 202607);
  m.sample({ raw: { heat: 3 } }, H, 20260701, 202607); // +1 kWh day 1
  m.sample({ raw: { heat: 3 } }, H + 1, 20260702, 202607); // new day
  m.sample({ raw: { heat: 3 } }, 2 * H, 20260702, 202607); // ~+1 kWh day 2
  const s = m.summary();
  assert.ok(s.todayKwh < 1.1, `day reset (${s.todayKwh})`);
  assert.ok(s.monthKwh > 1.9, `month kept (${s.monthKwh})`);
});
