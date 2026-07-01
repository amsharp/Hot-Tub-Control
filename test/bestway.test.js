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
  product_name: 'Airjet_V01',
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

test('getStatus parses Airjet_V01 attributes (Tnow/Tset/heat/... in °F)', async () => {
  const attr = {
    Tnow: 91,
    Tset: 104,
    Tunit: 0,
    power: 1,
    heat: 3, // multi-state enum on V01: 0=off, 2=on/maintaining, 3=heating
    filter: 2, // 0=off, 2=running
    wave: 0,
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
  assert.equal(status.currentTemp, 91);
  assert.equal(status.targetTemp, 104);
  // Airjet_V01 reports Fahrenheit even though Tunit reads 0 (profile.fixedUnit).
  assert.equal(status.unit, 'F');
});

test('setTargetTemperature clamps and sends Tset', async () => {
  const recorder = [];
  const client = new BestwayClient({
    username: 'a',
    password: 'b',
    fetchImpl: fakeFetch(baseRoutes({ Tnow: 90, Tset: 90, Tunit: 0 }, recorder), recorder),
  });
  const applied = await client.setTargetTemperature(120, 'F'); // above max 104°F
  assert.equal(applied, 104);
  const control = recorder.find((r) => r.key.startsWith('POST /app/control'));
  assert.deepEqual(control.body, { attrs: { Tset: 104 } });
});

test('setHeating(true) powers on heater + filter', async () => {
  const recorder = [];
  const client = new BestwayClient({
    username: 'a',
    password: 'b',
    fetchImpl: fakeFetch(baseRoutes({ Tnow: 90, Tset: 90, Tunit: 0 }, recorder), recorder),
  });
  await client.setHeating(true);
  const control = recorder.find((r) => r.key.startsWith('POST /app/control'));
  assert.deepEqual(control.body, { attrs: { power: 1, heat: 1, filter: 1 } });
});

test('login token is reused until near expiry', async () => {
  const recorder = [];
  const client = new BestwayClient({
    username: 'a',
    password: 'b',
    fetchImpl: fakeFetch(baseRoutes({ Tnow: 90, Tset: 90, Tunit: 0 }, recorder), recorder),
  });
  await client.getStatus();
  await client.getStatus();
  const logins = recorder.filter((r) => r.key === 'POST /app/login');
  assert.equal(logins.length, 1, 'should only log in once');
});
