import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BestwayClient } from '../src/bestway/client.js';

// Builds a fake fetch that routes by "METHOD path" and records control calls.
function fakeFetch(routes, recorder) {
  return async (url, opts = {}) => {
    const u = new URL(url);
    const key = `${opts.method || 'GET'} ${u.pathname}`;
    const handler = routes[key] || routes[`${opts.method || 'GET'} *`];
    if (!handler) throw new Error(`No fake route for ${key}`);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (recorder) recorder.push({ key, body });
    const result = typeof handler === 'function' ? handler(body, u) : handler;
    return {
      ok: result.ok !== false,
      status: result.status || 200,
      text: async () => JSON.stringify(result.json ?? {}),
    };
  };
}

const DEVICE = {
  did: 'spa-123',
  product_name: 'Airjet',
  dev_alias: 'Garden Spa',
  is_online: 1,
};

function baseRoutes(attr, recorder) {
  return {
    'POST /app/login': { json: { token: 'tok', uid: 'u', expire_at: Math.floor(Date.now() / 1000) + 3600 } },
    'GET /app/bindings': { json: { devices: [DEVICE] } },
    'GET /app/devdata/spa-123/latest': { json: { attr } },
    'POST /app/control/spa-123': () => ({ json: {} }),
  };
}

test('getStatus parses Airjet attributes', async () => {
  const attr = {
    temp_now: 36,
    temp_set: 38,
    temp_set_unit: 0,
    power: 1,
    heat_power: 1,
    filter_power: 1,
    wave_power: 0,
    locked: 0,
  };
  const client = new BestwayClient({
    username: 'a',
    password: 'b',
    fetchImpl: fakeFetch(baseRoutes(attr)),
  });
  const status = await client.getStatus();
  assert.equal(status.deviceId, 'spa-123');
  assert.equal(status.name, 'Garden Spa');
  assert.equal(status.online, true);
  assert.equal(status.power, true);
  assert.equal(status.heat, true);
  assert.equal(status.filter, true);
  assert.equal(status.bubbles, false);
  assert.equal(status.currentTemp, 36);
  assert.equal(status.targetTemp, 38);
  assert.equal(status.unit, 'C');
});

test('setTargetTemperature clamps and sends temp_set', async () => {
  const recorder = [];
  const client = new BestwayClient({
    username: 'a',
    password: 'b',
    fetchImpl: fakeFetch(baseRoutes({ temp_now: 30, temp_set: 30, temp_set_unit: 0 }, recorder), recorder),
  });
  const applied = await client.setTargetTemperature(99, 'C'); // above max 40
  assert.equal(applied, 40);
  const control = recorder.find((r) => r.key.startsWith('POST /app/control'));
  assert.deepEqual(control.body, { attrs: { temp_set: 40 } });
});

test('setHeating(true) powers on heater + filter', async () => {
  const recorder = [];
  const client = new BestwayClient({
    username: 'a',
    password: 'b',
    fetchImpl: fakeFetch(baseRoutes({ temp_now: 30, temp_set: 30, temp_set_unit: 0 }, recorder), recorder),
  });
  await client.setHeating(true);
  const control = recorder.find((r) => r.key.startsWith('POST /app/control'));
  assert.deepEqual(control.body, { attrs: { power: 1, heat_power: 1, filter_power: 1 } });
});

test('login token is reused until near expiry', async () => {
  const recorder = [];
  const client = new BestwayClient({
    username: 'a',
    password: 'b',
    fetchImpl: fakeFetch(baseRoutes({ temp_now: 30, temp_set: 30, temp_set_unit: 0 }, recorder), recorder),
  });
  await client.getStatus();
  await client.getStatus();
  const logins = recorder.filter((r) => r.key === 'POST /app/login');
  assert.equal(logins.length, 1, 'should only log in once');
});
