import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../src/history.js';

const HOUR = 3600_000;
function fakeStore() {
  return { data: { samples: [] }, save() {} };
}

test('history records one point per hour, updating the current hour in place', () => {
  const h = new History({ store: fakeStore() });
  h.record({ currentTemp: 100, targetTemp: 104, unit: 'F' }, 0);
  h.record({ currentTemp: 101, targetTemp: 104, unit: 'F' }, 1000); // same hour
  assert.equal(h.list().length, 1);
  assert.equal(h.list()[0].f, 101);
  h.record({ currentTemp: 102, targetTemp: 104, unit: 'F' }, HOUR); // next hour
  assert.equal(h.list().length, 2);
});

test('history normalises Celsius readings to Fahrenheit', () => {
  const h = new History({ store: fakeStore() });
  h.record({ currentTemp: 40, targetTemp: 40, unit: 'C' }, 0); // 40C -> 104F
  assert.equal(h.list()[0].f, 104);
  assert.equal(h.list()[0].s, 104);
});

test('history caps at 24 hours', () => {
  const h = new History({ store: fakeStore() });
  for (let i = 0; i < 30; i++) {
    h.record({ currentTemp: 100 + i, targetTemp: 104, unit: 'F' }, i * HOUR);
  }
  assert.equal(h.list().length, 24);
  assert.equal(h.list()[23].f, 129); // most recent (i=29)
});

const DAY = 86_400_000;

test('daily rollup folds each day into one min/max/avg point', () => {
  const h = new History({ store: fakeStore() });
  // Day 0: temps 98, 100, 104 across three hours.
  h.record({ currentTemp: 98, targetTemp: 104, unit: 'F' }, 0);
  h.record({ currentTemp: 100, targetTemp: 104, unit: 'F' }, HOUR);
  h.record({ currentTemp: 104, targetTemp: 104, unit: 'F' }, 2 * HOUR);
  // Day 1: a single reading.
  h.record({ currentTemp: 90, targetTemp: 104, unit: 'F' }, DAY + HOUR);

  const d = h.daily();
  assert.equal(d.length, 2);
  assert.deepEqual({ min: d[0].min, max: d[0].max, avg: d[0].avg }, { min: 98, max: 104, avg: 101 });
  assert.equal(d[1].min, 90);
  assert.equal(d[0].t, 0);
});

test('daily rollup keeps ~13 months and ages out older days', () => {
  const h = new History({ store: fakeStore() });
  for (let i = 0; i < 420; i++) {
    h.record({ currentTemp: 100, targetTemp: 104, unit: 'F' }, i * DAY);
  }
  const d = h.daily();
  assert.equal(d.length, 400); // MAX_DAYS
  assert.equal(d[d.length - 1].t, 419 * DAY); // newest retained
});
