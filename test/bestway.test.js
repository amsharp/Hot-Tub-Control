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
  // Airjet_V01: Tunit=0 -> Fahrenheit.
  assert.equal(status.unit, 'F');
});

test('getStatus reads Celsius mode (Tunit=1)', async () => {
  const attr = { Tnow: 39, Tset: 40, Tunit: 1, power: 1, heat: 0, filter: 0, wave: 0 };
  const client = new BestwayClient({
    username: 'a',
    password: 'b',
    fetchImpl: fakeFetch(baseRoutes(attr)),
  });
  const status = await client.getStatus();
  assert.equal(status.unit, 'C');
  assert.equal(status.currentTemp, 39);
  assert.equal(status.targetTemp, 40);
});

test('getStatus prefers the inlet register (bulk temp) over Tnow', async () => {
  // Live-observed overshoot case: element-side Tnow reads 106 °F after cutoff
  // while the inlet register (word2 ÷10 → °C) reads the true bulk 40.8 °C.
  const attr = { Tnow: 106, Tset: 104, Tunit: 0, power: 1, heat: 4, filter: 2, wave: 0, word2: 408 };
  const client = new BestwayClient({ username: 'a', password: 'b', fetchImpl: fakeFetch(baseRoutes(attr)) });
  const status = await client.getStatus();
  assert.equal(status.tempSource, 'inlet');
  assert.equal(status.currentTemp, 105.4); // 40.8 °C in the active unit (F)
  assert.equal(status.panelTemp, 106); // headline reading still exposed
});

test('getStatus reports the inlet register in °C when the pump is in Celsius mode', async () => {
  const attr = { Tnow: 41, Tset: 40, Tunit: 1, power: 1, heat: 4, filter: 2, wave: 0, word2: 408 };
  const client = new BestwayClient({ username: 'a', password: 'b', fetchImpl: fakeFetch(baseRoutes(attr)) });
  const status = await client.getStatus();
  assert.equal(status.tempSource, 'inlet');
  assert.equal(status.currentTemp, 40.8);
});

test('getStatus falls back to Tnow when the inlet register is absent or implausible', async () => {
  const missing = await new BestwayClient({
    username: 'a', password: 'b',
    fetchImpl: fakeFetch(baseRoutes({ Tnow: 100, Tset: 104, Tunit: 0, power: 1, heat: 3, filter: 2, wave: 0 })),
  }).getStatus();
  assert.equal(missing.tempSource, 'panel');
  assert.equal(missing.currentTemp, 100);

  const glitched = await new BestwayClient({
    username: 'a', password: 'b',
    fetchImpl: fakeFetch(baseRoutes({ Tnow: 100, Tset: 104, Tunit: 0, power: 1, heat: 3, filter: 2, wave: 0, word2: 0 })),
  }).getStatus();
  assert.equal(glitched.tempSource, 'panel'); // 0 -> implausible 0 °C, guarded out
  assert.equal(glitched.currentTemp, 100);
});

test('setDisplayUnit writes the mapped Tunit value', async () => {
  const recorder = [];
  const client = new BestwayClient({
    username: 'a',
    password: 'b',
    fetchImpl: fakeFetch(baseRoutes({ Tnow: 90, Tset: 90, Tunit: 1 }, recorder), recorder),
  });
  await client.setDisplayUnit('F');
  const control = recorder.find((r) => r.key.startsWith('POST /app/control'));
  assert.deepEqual(control.body, { attrs: { Tunit: 0 } }); // F -> 0 on this firmware
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
