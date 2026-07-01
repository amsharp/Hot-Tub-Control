import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSmartHomeRequest, statusToState, cToF } from '../src/google/smarthome.js';

function fakeClient(status, calls = []) {
  return {
    calls,
    getStatus: async () => status,
    setHeating: async (on) => calls.push(['setHeating', on]),
    setTargetTemperature: async (v, u) => {
      calls.push(['setTargetTemperature', v, u]);
      return v;
    },
    setBubbles: async (on) => calls.push(['setBubbles', on]),
  };
}

const STATUS_C = {
  deviceId: 'spa-123',
  name: 'Garden Spa',
  online: true,
  power: true,
  heat: true,
  filter: true,
  bubbles: false,
  locked: false,
  currentTemp: 36,
  targetTemp: 38,
  unit: 'C',
};

test('SYNC returns a thermostat device with both traits', async () => {
  const client = fakeClient(STATUS_C);
  const res = await handleSmartHomeRequest(
    { requestId: 'r1', inputs: [{ intent: 'action.devices.SYNC' }] },
    { client },
  );
  const dev = res.payload.devices[0];
  assert.equal(dev.id, 'spa-123');
  assert.equal(dev.type, 'action.devices.types.THERMOSTAT');
  assert.ok(dev.traits.includes('action.devices.traits.OnOff'));
  assert.ok(dev.traits.includes('action.devices.traits.TemperatureSetting'));
  assert.deepEqual(dev.attributes.availableThermostatModes, ['off', 'heat']);
});

test('QUERY maps status to Google state', async () => {
  const client = fakeClient(STATUS_C);
  const res = await handleSmartHomeRequest(
    {
      requestId: 'r2',
      inputs: [{ intent: 'action.devices.QUERY', payload: { devices: [{ id: 'spa-123' }] } }],
    },
    { client },
  );
  const state = res.payload.devices['spa-123'];
  assert.equal(state.on, true);
  assert.equal(state.thermostatMode, 'heat');
  assert.equal(state.thermostatTemperatureSetpoint, 38);
  assert.equal(state.thermostatTemperatureAmbient, 36);
});

test('EXECUTE OnOff calls setHeating', async () => {
  const client = fakeClient(STATUS_C);
  const res = await handleSmartHomeRequest(
    {
      requestId: 'r3',
      inputs: [
        {
          intent: 'action.devices.EXECUTE',
          payload: {
            commands: [
              {
                devices: [{ id: 'spa-123' }],
                execution: [{ command: 'action.devices.commands.OnOff', params: { on: false } }],
              },
            ],
          },
        },
      ],
    },
    { client },
  );
  assert.equal(res.payload.commands[0].status, 'SUCCESS');
  assert.deepEqual(client.calls[0], ['setHeating', false]);
});

test('EXECUTE setpoint converts Celsius to pump Fahrenheit', async () => {
  const statusF = { ...STATUS_C, unit: 'F', targetTemp: 100, currentTemp: 97 };
  const client = fakeClient(statusF);
  const res = await handleSmartHomeRequest(
    {
      requestId: 'r4',
      inputs: [
        {
          intent: 'action.devices.EXECUTE',
          payload: {
            commands: [
              {
                devices: [{ id: 'spa-123' }],
                execution: [
                  {
                    command: 'action.devices.commands.ThermostatTemperatureSetpoint',
                    params: { thermostatTemperatureSetpoint: 38 },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
    { client },
  );
  assert.equal(res.payload.commands[0].status, 'SUCCESS');
  // 38C -> 100F sent to pump in F
  assert.deepEqual(client.calls[0], ['setTargetTemperature', cToF(38), 'F']);
});

test('statusToState converts a Fahrenheit pump to Celsius for Google', () => {
  const state = statusToState({ ...STATUS_C, unit: 'F', targetTemp: 104, currentTemp: 95 });
  assert.equal(state.thermostatTemperatureSetpoint, 40); // 104F
  assert.equal(state.thermostatTemperatureAmbient, 35); // 95F
});
