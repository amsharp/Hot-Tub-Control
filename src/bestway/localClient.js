// LocalPumpClient — a drop-in replacement for BestwayClient that talks to a
// LOCALLY-flashed pump instead of the Gizwits cloud.
//
// Why this exists: no firmware can be uploaded to this pump to gain new
// capability (the CIO safety MCU is a sealed black box; the flow sensor is a
// binary paddle). The one workable "own your hardware" path is the community
// mod — a separate ESP on the CIO↔display 6-wire bus running open firmware
// (visualapproach BWC) that mirrors the panel over local MQTT. This client
// speaks that MQTT instead of Gizwits HTTPS, so the ENTIRE existing service —
// smart-heat controller, watchdog, energy meter, scheduler, Google Home — runs
// unchanged and cloud-free just by swapping which client is injected.
//
// It implements the same interface the app consumes from BestwayClient:
//   getStatus, setPower, setHeat, setFilter, setBubbles, setTargetTemperature,
//   setDisplayUnit, setHeating, setAllOff, restartCirculation.
//
// Transport is injected (publish/subscribe), so this is dependency-free and
// unit-testable without a broker. The exact BWC topic names and state-JSON keys
// vary by firmware/protocol variant and MUST be confirmed against the live bus
// (like AIRJET_PROFILE was) — hence `mapState`/`buildCommand` are overridable.
import { AIRJET_PROFILE, normalizeStatus } from './constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_TOPICS = {
  state: 'bwc/device/message', // firmware publishes the pump state JSON here
  command: 'bwc/device/command', // we publish control commands here
};

/**
 * Default BWC-state -> raw-attr mapping. BWC exposes the same semantic fields
 * the cloud does; we translate them onto our AIRJET_PROFILE attr keys so
 * normalizeStatus() can do the rest. VERIFY these keys against the live bus.
 */
function defaultMapState(json, profile = AIRJET_PROFILE) {
  const a = profile.attrs;
  const g = (...keys) => keys.map((k) => json[k]).find((v) => v !== undefined);
  const attr = {};
  attr[a.currentTemp] = g('temp', 'temperature', 'Tnow', 'CurrentTemp');
  attr[a.targetTemp] = g('target', 'temp_set', 'Tset', 'TargetTemp');
  attr[a.tempUnit] = g('unit', 'Tunit');
  attr[a.power] = g('power', 'locked_power', 'Power') ? 1 : 0;
  attr[a.heat] = g('heat', 'heater', 'Heat');
  attr[a.filter] = g('pump', 'filter', 'filter_power', 'Filter');
  attr[a.bubbles] = g('air', 'bubbles', 'wave', 'Wave') ? 1 : 0;
  attr[a.locked] = g('locked', 'lock', 'Locked') ? 1 : 0;
  // Error field -> Exx fault flag the shared detectFaults() understands.
  const err = g('error', 'errorCode', 'fault', 'Error');
  if (err) {
    const code = typeof err === 'string' && /^E\d{2}$/i.test(err) ? err.toUpperCase() : `E${String(err).padStart(2, '0')}`;
    attr[code] = 1;
  }
  return attr;
}

/** Default command builder: one attr write. Confirm BWC's real command schema. */
function defaultBuildCommand(action, value, profile = AIRJET_PROFILE) {
  const a = profile.attrs;
  const key = { power: a.power, heat: a.heat, filter: a.filter, bubbles: a.bubbles, temp: a.targetTemp, unit: a.tempUnit }[action];
  return { attrs: { [key]: value } };
}

export class LocalPumpClient {
  /**
   * @param {object} opts
   * @param {{publish:Function, subscribe:Function}} opts.transport MQTT-like transport
   * @param {object} [opts.topics] { state, command }
   * @param {string} [opts.deviceName]
   * @param {object} [opts.profile] attribute profile (defaults to Airjet)
   * @param {Function} [opts.mapState] (json,profile) -> raw attrs
   * @param {Function} [opts.buildCommand] (action,value,profile) -> payload object
   * @param {Function} [opts.wait] injectable delay (tests)
   */
  constructor({ transport, topics = {}, deviceName = 'Hot tub', profile = AIRJET_PROFILE, mapState, buildCommand, wait = sleep } = {}) {
    this.transport = transport;
    this.topics = { ...DEFAULT_TOPICS, ...topics };
    this.deviceName = deviceName;
    this.profile = profile;
    this.mapState = mapState || defaultMapState;
    this.buildCommand = buildCommand || defaultBuildCommand;
    this.wait = wait;
    this._raw = null; // latest raw attrs
    this._lastSeen = 0;
    if (transport && transport.subscribe) {
      transport.subscribe(this.topics.state, (msg) => this._onState(msg));
    }
  }

  _onState(message) {
    try {
      const json = typeof message === 'string' ? JSON.parse(message) : message;
      this._raw = this.mapState(json, this.profile);
      this._lastSeen = Date.now();
    } catch {
      /* ignore malformed state frames */
    }
  }

  /** Same shape as BestwayClient.getStatus, served from the latest local frame. */
  async getStatus() {
    if (!this._raw) throw new Error('No local pump state received yet (is the bridge connected?)');
    return {
      deviceId: 'local',
      name: this.deviceName,
      online: Date.now() - this._lastSeen < 60_000,
      ...normalizeStatus(this._raw, this.profile),
    };
  }

  _send(action, value) {
    const payload = this.buildCommand(action, value, this.profile);
    return this.transport.publish(this.topics.command, JSON.stringify(payload));
  }

  setPower(on) {
    return this._send('power', on ? this.profile.on : this.profile.off);
  }
  setHeat(on) {
    return this._send('heat', on ? this.profile.on : this.profile.off);
  }
  setFilter(on) {
    return this._send('filter', on ? this.profile.on : this.profile.off);
  }
  setBubbles(on) {
    return this._send('bubbles', on ? this.profile.on : this.profile.off);
  }
  setDisplayUnit(unit) {
    const uv = this.profile.tempUnitValues || { C: 0, F: 1 };
    return this._send('unit', uv[unit === 'C' ? 'C' : 'F']);
  }

  setTargetTemperature(value, unit = 'C') {
    const u = unit === 'F' ? 'F' : 'C';
    const range = this.profile.tempRange[u];
    const clamped = Math.round(Math.min(range.max, Math.max(range.min, value)));
    return Promise.resolve(this._send('temp', clamped)).then(() => clamped);
  }

  async setHeating(on, { keepFilterOn = true } = {}) {
    await this._send('power', on ? this.profile.on : this.profile.off);
    await this._send('heat', on ? this.profile.on : this.profile.off);
    if (on || keepFilterOn) await this._send('filter', this.profile.on);
  }

  async setAllOff() {
    await this._send('power', this.profile.off);
    await this._send('heat', this.profile.off);
    await this._send('filter', this.profile.off);
    await this._send('bubbles', this.profile.off);
  }

  /** Local E02 recovery: identical power-cycle sequence to the cloud client. */
  async restartCirculation({ settleMs = 15_000, restoreHeat = true, wait = this.wait } = {}) {
    await this._send('heat', this.profile.off);
    await this._send('filter', this.profile.off);
    await wait(settleMs);
    await this._send('power', this.profile.on);
    await this._send('filter', this.profile.on);
    if (restoreHeat) {
      await wait(2_000);
      await this._send('heat', this.profile.on);
    }
  }
}
