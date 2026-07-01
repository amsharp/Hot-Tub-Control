// Google Smart Home fulfillment: handles the SYNC, QUERY and EXECUTE intents
// Google sends to our webhook, translating them to BestwayClient calls.
//
// We model the spa as a single THERMOSTAT device exposing two traits:
//   - OnOff            -> "turn the hot tub on/off" (power + heater + filter)
//   - TemperatureSetting -> set/read target & ambient temperature, heat/off mode
//
// Google always speaks Celsius for TemperatureSetting; the pump may be
// configured in C or F, so we convert at the boundary.
import { AIRJET_PROFILE } from '../bestway/constants.js';
import { log } from '../log.js';

const AGENT_USER_ID = 'owner';
const RANGE_C = AIRJET_PROFILE.tempRange.C;

const cToF = (c) => Math.round((c * 9) / 5 + 32);
const fToC = (f) => Math.round(((f - 32) * 5) / 9);

function syncPayload(deviceId, name) {
  return {
    agentUserId: AGENT_USER_ID,
    devices: [
      {
        id: deviceId,
        type: 'action.devices.types.THERMOSTAT',
        traits: ['action.devices.traits.OnOff', 'action.devices.traits.TemperatureSetting'],
        name: { name: name || 'Hot tub', defaultNames: ['Bestway Spa'], nicknames: ['hot tub', 'spa'] },
        willReportState: false,
        attributes: {
          availableThermostatModes: ['off', 'heat'],
          thermostatTemperatureUnit: 'C',
          thermostatTemperatureRange: {
            minThresholdCelsius: RANGE_C.min,
            maxThresholdCelsius: RANGE_C.max,
          },
          commandOnlyOnOff: false,
        },
        deviceInfo: { manufacturer: 'Bestway', model: 'Airjet' },
      },
    ],
  };
}

/** Translate a BestwayClient status into Google device state (Celsius). */
export function statusToState(status) {
  const toC = (v) => (v == null ? null : status.unit === 'F' ? fToC(v) : v);
  return {
    online: status.online,
    status: 'SUCCESS',
    on: status.power,
    thermostatMode: status.heat ? 'heat' : 'off',
    thermostatTemperatureSetpoint: toC(status.targetTemp),
    thermostatTemperatureAmbient: toC(status.currentTemp),
  };
}

async function handleExecuteCommand(client, command, status) {
  const name = command.command;
  const params = command.params || {};

  if (name === 'action.devices.commands.OnOff') {
    await client.setHeating(!!params.on);
    return { on: !!params.on };
  }

  if (name === 'action.devices.commands.ThermostatSetMode') {
    const heat = params.thermostatMode === 'heat';
    await client.setHeating(heat);
    return { thermostatMode: params.thermostatMode };
  }

  if (name === 'action.devices.commands.ThermostatTemperatureSetpoint') {
    const celsius = params.thermostatTemperatureSetpoint;
    const unit = status.unit; // pump's configured unit
    const valueInPumpUnit = unit === 'F' ? cToF(celsius) : celsius;
    const applied = await client.setTargetTemperature(valueInPumpUnit, unit);
    const appliedC = unit === 'F' ? fToC(applied) : applied;
    return { thermostatTemperatureSetpoint: appliedC };
  }

  throw new Error(`Unsupported command ${name}`);
}

/**
 * Main entry point. Given a parsed Google request body and a BestwayClient,
 * returns the JSON response object to send back.
 * @param {object} body Google fulfillment request
 * @param {object} deps
 * @param {import('../bestway/client.js').BestwayClient} deps.client
 * @param {Function} [deps.onStateChange] called with fresh status after EXECUTE
 */
export async function handleSmartHomeRequest(body, { client, onStateChange } = {}) {
  const requestId = body.requestId;
  const intent = body.inputs?.[0]?.intent;
  log.info('Smart Home intent:', intent);

  if (intent === 'action.devices.SYNC') {
    const status = await client.getStatus();
    return { requestId, payload: syncPayload(status.deviceId, status.name) };
  }

  if (intent === 'action.devices.QUERY') {
    const status = await client.getStatus();
    const devices = {};
    for (const d of body.inputs[0].payload.devices) {
      devices[d.id] = statusToState(status);
    }
    return { requestId, payload: { devices } };
  }

  if (intent === 'action.devices.EXECUTE') {
    const status = await client.getStatus();
    const results = [];
    for (const cmd of body.inputs[0].payload.commands) {
      const ids = cmd.devices.map((d) => d.id);
      try {
        let states = {};
        for (const exec of cmd.execution) {
          states = { ...states, ...(await handleExecuteCommand(client, exec, status)) };
        }
        results.push({ ids, status: 'SUCCESS', states: { online: true, ...states } });
      } catch (err) {
        log.error('EXECUTE failed:', err.message);
        results.push({ ids, status: 'ERROR', errorCode: 'hardError' });
      }
    }
    if (onStateChange) {
      // Fire-and-forget proactive state report.
      client
        .getStatus()
        .then((s) => onStateChange(s))
        .catch((e) => log.warn('onStateChange failed:', e.message));
    }
    return { requestId, payload: { commands: results } };
  }

  if (intent === 'action.devices.DISCONNECT') {
    return {};
  }

  return { requestId, payload: { errorCode: 'notSupported' } };
}

export { cToF, fToC };
