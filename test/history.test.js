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
