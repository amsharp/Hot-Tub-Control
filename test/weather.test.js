import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WeatherProvider } from '../src/weather.js';

const FORECAST = {
  hourly: {
    time: ['2026-07-01T00:00', '2026-07-01T01:00', '2026-07-01T02:00'],
    temperature_2m: [60, 70, 50],
  },
};
const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('disabled without a location; refresh is a no-op and ambientAt is null', async () => {
  const w = new WeatherProvider({ lat: null, lon: null, fetchImpl: okFetch(FORECAST) });
  assert.equal(w.enabled, false);
  assert.equal(await w.refresh(true), false);
  assert.equal(w.ambientAt(Date.parse('2026-07-01T00:30:00Z')), null);
});

test('refresh loads the series; ambientAt interpolates and clamps', async () => {
  const w = new WeatherProvider({ lat: 37, lon: -122, fetchImpl: okFetch(FORECAST), now: () => 0 });
  assert.equal(await w.refresh(true), true);
  assert.equal(w.series.length, 3);
  assert.equal(w.ambientAt(Date.parse('2026-07-01T01:00:00Z')), 70); // exact hour
  assert.equal(w.ambientAt(Date.parse('2026-07-01T00:30:00Z')), 65); // halfway 60->70
  assert.equal(w.ambientAt(Date.parse('2026-06-30T00:00:00Z')), 60); // clamp low
  assert.equal(w.ambientAt(Date.parse('2026-07-01T09:00:00Z')), 50); // clamp high
});

test('refresh honours the cache TTL; force overrides it', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => FORECAST };
  };
  let t = 0;
  const w = new WeatherProvider({ lat: 1, lon: 2, refreshMin: 60, fetchImpl, now: () => t });
  await w.refresh(true); // fetch #1
  await w.refresh(); // within TTL — cached
  assert.equal(calls, 1);
  t = 61 * 60_000; // past TTL
  await w.refresh(); // fetch #2
  assert.equal(calls, 2);
});

test('a failed fetch is swallowed and keeps the last good series', async () => {
  const w = new WeatherProvider({ lat: 1, lon: 2, fetchImpl: okFetch(FORECAST), now: () => 0, wait: async () => {} });
  await w.refresh(true);
  w.fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal(await w.refresh(true), false);
  assert.equal(w.series.length, 3);
  assert.ok(w.status().lastError, 'error surfaced in status()');
});

test('retries the fetch with backoff, then succeeds within attempts', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n < 3) throw new Error('transient');
    return { ok: true, status: 200, json: async () => FORECAST };
  };
  const w = new WeatherProvider({ lat: 1, lon: 2, fetchImpl, now: () => 0, wait: async () => {}, attempts: 3 });
  assert.equal(await w.refresh(true), true);
  assert.equal(n, 3);
  assert.equal(w.series.length, 3);
});

test('while empty, retries every emptyRetry window instead of waiting the full TTL', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 500, json: async () => ({}) }; // always fails -> stays empty
  };
  let t = 0;
  const w = new WeatherProvider({
    lat: 1, lon: 2, fetchImpl, now: () => t, wait: async () => {},
    refreshMin: 120, emptyRetryMin: 10, attempts: 1,
  });
  await w.refresh(); // t=0: due (empty) -> 1 attempt
  await w.refresh(); // t=0 again: not due (within 10 min)
  assert.equal(calls, 1);
  t = 11 * 60_000; // past the 10-min empty-retry window (but well under the 120-min TTL)
  await w.refresh();
  assert.equal(calls, 2, 'retried while empty without waiting the full TTL');
});
