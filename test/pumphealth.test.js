import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PumpHealth } from '../src/pumphealth.js';

function fakeStore() {
  return { data: {}, save() {} };
}
const MIN = 60_000;

test('counts E02 transitions, not every poll of a latched fault', () => {
  const ph = new PumpHealth({ store: fakeStore() });
  ph.onStatus({ e02Active: false, tempF: 100, circulating: true, now: 0 });
  ph.onStatus({ e02Active: true, tempF: 100, circulating: false, now: MIN }); // trip
  ph.onStatus({ e02Active: true, tempF: 100, circulating: false, now: 2 * MIN }); // still latched
  ph.onStatus({ e02Active: true, tempF: 100, circulating: false, now: 3 * MIN });
  ph.onStatus({ e02Active: false, tempF: 100, circulating: true, now: 4 * MIN }); // cleared
  ph.onStatus({ e02Active: true, tempF: 100, circulating: false, now: 5 * MIN }); // second trip
  const s = ph.summary(6 * MIN);
  assert.equal(s.e02Week, 2, 'two events, not four polls');
});

test('two E02s in a week raises the warning', () => {
  const ph = new PumpHealth({ store: fakeStore() });
  ph.onStatus({ e02Active: true, tempF: 100, circulating: false, now: 0 });
  ph.onStatus({ e02Active: false, tempF: 100, circulating: true, now: MIN });
  assert.equal(ph.summary(2 * MIN).warning, false, 'one trip is not a trend');
  ph.onStatus({ e02Active: true, tempF: 100, circulating: false, now: 86_400_000 });
  assert.equal(ph.summary(86_400_000 + MIN).warning, true);
});

test('measures settle time from circulation start to stable readings', () => {
  const ph = new PumpHealth({ store: fakeStore() });
  ph.onStatus({ e02Active: false, tempF: 90, circulating: false, now: 0 });
  // Pump starts; readings converge 84 -> 96 -> 99 -> 100 -> 100 -> 100.
  const temps = [84, 96, 99, 100, 100, 100];
  temps.forEach((f, i) =>
    ph.onStatus({ e02Active: false, tempF: f, circulating: true, now: (i + 1) * 2 * MIN }),
  );
  const s = ph.summary(20 * MIN);
  // Stable when two consecutive deltas are <=1F: samples 99->100->100.
  assert.ok(s.settleRecentSec > 0, `settle recorded (${s.settleRecentSec}s)`);
});

test('a pump stop mid-settle abandons the measurement', () => {
  const ph = new PumpHealth({ store: fakeStore() });
  ph.onStatus({ e02Active: false, tempF: 90, circulating: false, now: 0 });
  ph.onStatus({ e02Active: false, tempF: 84, circulating: true, now: 2 * MIN });
  ph.onStatus({ e02Active: false, tempF: 96, circulating: false, now: 4 * MIN }); // stopped
  const s = ph.summary(10 * MIN);
  assert.equal(s.settleRecentSec, null, 'no bogus settle recorded');
});
