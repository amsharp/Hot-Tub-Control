import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FilterHealth } from '../src/filterhealth.js';

function fakeStore() {
  return { data: {}, save() {} };
}
const MIN = 60_000;
const H = 3_600_000;

// Feed `hours` of reliable samples at 2-min cadence around `lpm` starting at t0.
function feed(fh, lpm, hours, t0 = 0) {
  let t = t0;
  for (let i = 0; i < hours * 30; i++) {
    fh.record({ reliable: true, lpm }, t);
    t += 2 * MIN;
  }
  return t;
}

test('no health until enough samples span enough time', () => {
  const fh = new FilterHealth({ store: fakeStore() });
  for (let i = 0; i < 5; i++) fh.record({ reliable: true, lpm: 5 }, i * 2 * MIN);
  assert.equal(fh.health(10 * MIN).pct, null); // too few samples
});

test('a clean-filter day reads 100%', () => {
  const fh = new FilterHealth({ store: fakeStore() });
  const t = feed(fh, 5.5, 4); // 4h of firing at 5.5 L/min
  assert.equal(fh.health(t).pct, 100);
});

test('degraded flow reads as a proportional drop against the baseline', () => {
  const fh = new FilterHealth({ store: fakeStore() });
  let t = feed(fh, 6, 6); // baseline day: 6 L/min
  // Two days later, the filter has clogged: 4.5 L/min (75% of baseline). Old
  // samples age out of the 24h window.
  t += 48 * H;
  t = feed(fh, 4.5, 6, t);
  const h = fh.health(t);
  assert.equal(h.pct, 75);
  assert.equal(h.baselineLpm, 6);
});

test('ignores unreliable samples', () => {
  const fh = new FilterHealth({ store: fakeStore() });
  assert.equal(fh.record({ reliable: false, lpm: 99 }, 0), false);
  assert.equal(fh.record({ reliable: true, lpm: null }, 0), false);
  assert.equal(fh.record(null, 0), false);
});

test('baseline re-anchors automatically after a filter clean restores flow', () => {
  const fh = new FilterHealth({ store: fakeStore() });
  let t = feed(fh, 5, 6); // old, partially clogged normal: baseline 5
  t += 48 * H;
  t = feed(fh, 6.5, 6, t); // cleaned filter flows better than ever
  const h = fh.health(t);
  assert.equal(h.pct, 100); // window avg == new baseline
  assert.ok(h.baselineLpm > 6.4, `baseline ratcheted up (${h.baselineLpm})`);
});

test('reset() clears the baseline so the next window defines 100%', () => {
  const fh = new FilterHealth({ store: fakeStore() });
  let t = feed(fh, 6, 6);
  fh.reset();
  t += 48 * H;
  t = feed(fh, 4, 6, t); // post-reset flow defines the new normal
  assert.equal(fh.health(t).pct, 100);
});
