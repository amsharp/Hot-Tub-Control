import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TouSchedule } from '../src/rates.js';
import { EnergyMeter } from '../src/energy.js';

const RATES = { summerOn: 0.5, summerMid: 0.35, summerOff: 0.3, winterMid: 0.4, winterSoff: 0.2, winterOff: 0.3 };
const s = new TouSchedule(RATES);
const at = (m, h) => new Date(2026, m - 1, 15, h, 30); // local time (Jul 15 2026 = Wed)

test('summer: on-peak 4-9 PM weekdays, off-peak otherwise', () => {
  assert.equal(s.rateAt(at(7, 17)), 0.5); // Wed July 5:30 PM
  assert.equal(s.rateAt(at(7, 15)), 0.3); // Wed July 3:30 PM
  assert.equal(s.rateAt(at(7, 21)), 0.3); // 9:30 PM is past peak
  assert.equal(s.periodAt(at(7, 17)), 'summer on-peak');
});

test('summer weekends: 4-9 PM is the cheaper mid-peak', () => {
  const sat = new Date(2026, 6, 18, 17, 30); // Sat Jul 18 2026, 5:30 PM
  assert.equal(s.rateAt(sat), 0.35);
  assert.equal(s.periodAt(sat), 'summer mid-peak (weekend)');
  // Falls back to summerOn when no weekend rate is configured.
  const noMid = new TouSchedule({ ...RATES, summerMid: undefined });
  assert.equal(noMid.rateAt(sat), 0.5);
});

test('winter: mid-peak 4-9 PM, super-off-peak 8 AM-4 PM, off-peak overnight', () => {
  assert.equal(s.rateAt(at(1, 17)), 0.4); // Jan 5:30 PM
  assert.equal(s.rateAt(at(1, 10)), 0.2); // Jan 10:30 AM — smart-heat hours
  assert.equal(s.rateAt(at(1, 23)), 0.3); // Jan 11:30 PM
  assert.equal(s.rateAt(at(1, 7)), 0.3); // Jan 7:30 AM (before 8)
  assert.equal(s.periodAt(at(1, 10)), 'winter super-off-peak');
});

test('season boundaries: June-September are summer', () => {
  assert.equal(s.isSummer(at(6, 12)), true);
  assert.equal(s.isSummer(at(9, 12)), true);
  assert.equal(s.isSummer(at(5, 12)), false);
  assert.equal(s.isSummer(at(10, 12)), false);
});

test('EnergyMeter prices intervals via the TOU function when provided', () => {
  const H = 3_600_000;
  const rateFor = (ms) => (ms < H ? 0.2 : 0.6); // first hour cheap, then expensive
  const m = new EnergyMeter({
    store: { data: {}, save() {} },
    watts: { heater: 1000, pump: 0, blower: 0 },
    rate: 0.99, // must be ignored when rateFor is set
    rateFor,
  });
  m.sample({ raw: { heat: 3 } }, 0, 20260701, 202607); // stamps rate 0.2
  m.sample({ raw: { heat: 3 } }, H, 20260701, 202607); // 1 kWh @ 0.2; stamps 0.6
  m.sample({ raw: { heat: 3 } }, 2 * H, 20260701, 202607); // 1 kWh @ 0.6
  const sum = m.summary();
  assert.ok(Math.abs(sum.monthKwh - 2) < 0.01, `2 kWh (${sum.monthKwh})`);
  assert.ok(Math.abs(sum.monthCost - 0.8) < 0.01, `$0.20 + $0.60 (${sum.monthCost})`);
  assert.equal(sum.rateNow, 0.6);
});
