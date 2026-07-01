// BestwayClient — a thin, well-typed wrapper over the Bestway/Gizwits cloud API
// for an Airjet hot tub. Handles login, token refresh, status reads and
// control writes. Network access is injected (`fetchImpl`) so it can be unit
// tested without hitting the real cloud.
import {
  GIZWITS_APP_ID,
  apiRootForRegion,
  AIRJET_PROFILE,
  SPA_PRODUCT_NAMES,
  detectFaults,
} from './constants.js';
import { log } from '../log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BestwayApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'BestwayApiError';
    this.status = status;
    this.body = body;
  }
}

export class BestwayClient {
  /**
   * @param {object} opts
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {string} [opts.region]  "eu" | "us"
   * @param {string} [opts.deviceId] pin a specific pump (DID)
   * @param {typeof fetch} [opts.fetchImpl] injectable fetch (defaults to global)
   * @param {object} [opts.profile] device attribute profile (defaults to Airjet)
   */
  constructor({ username, password, region = 'eu', deviceId = '', fetchImpl, profile } = {}) {
    this.username = username;
    this.password = password;
    this.apiRoot = apiRootForRegion(region);
    this.pinnedDeviceId = deviceId;
    this.fetch = fetchImpl || globalThis.fetch;
    this.profile = profile || AIRJET_PROFILE;

    this.token = null;
    this.uid = null;
    this.tokenExpiresAt = 0; // epoch ms
  }

  // --- Low-level HTTP -------------------------------------------------------

  _headers(extra = {}) {
    return {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Gizwits-Application-Id': GIZWITS_APP_ID,
      ...extra,
    };
  }

  async _request(method, path, { body, auth = true } = {}) {
    if (auth) await this.ensureToken();
    const headers = this._headers(
      auth && this.token ? { 'X-Gizwits-User-token': this.token } : {},
    );
    const url = `${this.apiRoot}${path}`;
    log.debug(`${method} ${url}`);
    const res = await this.fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      throw new BestwayApiError(
        `Bestway API ${method} ${path} failed: ${res.status} ${json.error_message || text}`,
        res.status,
        json,
      );
    }
    return json;
  }

  // --- Auth -----------------------------------------------------------------

  async login() {
    if (!this.username || !this.password) {
      throw new BestwayApiError('Bestway username/password not configured', 0);
    }
    const json = await this._request('POST', '/app/login', {
      auth: false,
      body: { username: this.username, password: this.password, lang: 'en' },
    });
    if (!json.token) {
      throw new BestwayApiError('Login succeeded but no token returned', 200, json);
    }
    this.token = json.token;
    this.uid = json.uid || this.uid;
    // Gizwits returns expire_at as epoch seconds; refresh a bit early.
    const expSeconds = Number(json.expire_at) || 0;
    this.tokenExpiresAt = expSeconds ? expSeconds * 1000 : Date.now() + 6 * 3600 * 1000;
    log.debug('Bestway login OK, token expires', new Date(this.tokenExpiresAt).toISOString());
    return this.token;
  }

  async ensureToken() {
    // Refresh 60s before expiry.
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return;
    await this.login();
  }

  // --- Devices --------------------------------------------------------------

  /** Returns the raw device list bound to the account. */
  async listDevices() {
    const json = await this._request('GET', '/app/bindings');
    return json.devices || [];
  }

  /** Finds the spa device to control (pinned id, else first recognised spa). */
  async resolveDevice() {
    const devices = await this.listDevices();
    if (this.pinnedDeviceId) {
      const match = devices.find((d) => d.did === this.pinnedDeviceId);
      if (!match) {
        throw new BestwayApiError(
          `Configured BESTWAY_DEVICE_ID ${this.pinnedDeviceId} not found on account`,
          404,
        );
      }
      return match;
    }
    const spa = devices.find((d) => SPA_PRODUCT_NAMES.has(d.product_name));
    if (!spa) {
      throw new BestwayApiError(
        `No Airjet spa found on account (devices: ${devices
          .map((d) => d.product_name)
          .join(', ') || 'none'})`,
        404,
      );
    }
    return spa;
  }

  async deviceId() {
    if (this._cachedDeviceId) return this._cachedDeviceId;
    const dev = await this.resolveDevice();
    this._cachedDeviceId = dev.did;
    this._cachedDevice = dev;
    return dev.did;
  }

  // --- Status (read) --------------------------------------------------------

  /** Raw latest attribute dictionary as reported by the pump. */
  async rawAttrs(did) {
    const id = did || (await this.deviceId());
    const json = await this._request('GET', `/app/devdata/${id}/latest`);
    return json.attr || {};
  }

  /**
   * Normalised spa status. `online` reflects the binding; the rest is parsed
   * from the raw attribute dictionary using the device profile.
   */
  async getStatus() {
    const dev = await this.resolveDevice();
    this._cachedDeviceId = dev.did;
    const attr = await this.rawAttrs(dev.did);
    const a = this.profile.attrs;
    const unitRaw = attr[a.tempUnit];
    const unit = unitRaw === 1 || unitRaw === '1' || unitRaw === 'F' ? 'F' : 'C';
    return {
      deviceId: dev.did,
      name: dev.dev_alias || dev.product_name || 'Hot tub',
      online: !!dev.is_online,
      power: toBool(attr[a.power]),
      heat: toBool(attr[a.heat]),
      filter: toBool(attr[a.filter]),
      bubbles: toBool(attr[a.bubbles]),
      locked: toBool(attr[a.locked]),
      currentTemp: numOrNull(attr[a.currentTemp]),
      targetTemp: numOrNull(attr[a.targetTemp]),
      unit,
      faults: detectFaults(attr),
      raw: attr,
    };
  }

  // --- Control (write) ------------------------------------------------------

  /** Sends a raw {attrs:{...}} control payload. */
  async control(attrs, did) {
    const id = did || (await this.deviceId());
    return this._request('POST', `/app/control/${id}`, { body: { attrs } });
  }

  setPower(on) {
    return this.control({ [this.profile.attrs.power]: on ? this.profile.on : this.profile.off });
  }

  setHeat(on) {
    return this.control({ [this.profile.attrs.heat]: on ? this.profile.on : this.profile.off });
  }

  setFilter(on) {
    return this.control({ [this.profile.attrs.filter]: on ? this.profile.on : this.profile.off });
  }

  setBubbles(on) {
    return this.control({ [this.profile.attrs.bubbles]: on ? this.profile.on : this.profile.off });
  }

  /**
   * Set target temperature. `value` is in `unit` ("C" | "F"); it is clamped to
   * the profile's safe range for that unit before being sent.
   */
  setTargetTemperature(value, unit = 'C') {
    const u = unit === 'F' ? 'F' : 'C';
    const range = this.profile.tempRange[u];
    const clamped = Math.round(clamp(value, range.min, range.max));
    return this.control({ [this.profile.attrs.targetTemp]: clamped }).then(() => clamped);
  }

  /**
   * Convenience used by scheduling/voice: turn the spa "on" means power on +
   * heater on; "off" means heater off (keep filter/pump per `keepFilter`).
   */
  async setHeating(on, { keepFilterOn = true } = {}) {
    const attrs = {};
    attrs[this.profile.attrs.power] = on ? this.profile.on : this.profile.off;
    attrs[this.profile.attrs.heat] = on ? this.profile.on : this.profile.off;
    if (on || keepFilterOn) attrs[this.profile.attrs.filter] = this.profile.on;
    return this.control(attrs);
  }

  /**
   * Restart water circulation to try to clear a transient low-flow (E02) trip:
   * stop the heater + filter pump, pause, then start the filter pump again and
   * restore the heater if it was on. This only helps with transient/sensor
   * trips; a genuinely dirty filter or low water level needs hands-on fixing.
   * @param {object} [opts]
   * @param {number} [opts.settleMs] pause with the pump off (default 15s)
   * @param {boolean} [opts.restoreHeat] turn the heater back on afterwards
   * @param {(ms:number)=>Promise<void>} [opts.wait] injectable delay (tests)
   */
  async restartCirculation({ settleMs = 15_000, restoreHeat = true, wait = sleep } = {}) {
    const a = this.profile.attrs;
    // Stop heater + filter pump.
    await this.control({ [a.heat]: this.profile.off, [a.filter]: this.profile.off });
    await wait(settleMs);
    // Start the filter pump (and ensure the unit is powered).
    await this.control({ [a.power]: this.profile.on, [a.filter]: this.profile.on });
    if (restoreHeat) {
      await wait(2_000);
      await this.control({ [a.heat]: this.profile.on });
    }
  }
}

// --- helpers ----------------------------------------------------------------

function toBool(v) {
  return v === 1 || v === '1' || v === true;
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export { toBool, numOrNull, clamp };
