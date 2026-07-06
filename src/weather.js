// WeatherProvider — fetches the hourly outdoor-temperature forecast for the
// tub's location and answers "what's the ambient temperature at time T?" for any
// past-day or next-2-day timestamp. The thermal model uses this as the `ambient`
// in its cooling law, so overnight cooling is projected from the *actual*
// forecast rather than a static guess.
//
// Source: Open-Meteo (https://open-meteo.com) — free, no API key. We keep the
// series in memory and refresh it on a timer; `ambientAt` is synchronous so the
// 2-minute control loop can call it without awaiting a network round-trip.
import { log } from './log.js';

const HOUR_MS = 3_600_000;

export class WeatherProvider {
  /**
   * @param {object} opts
   * @param {number|null} opts.lat
   * @param {number|null} opts.lon
   * @param {number} [opts.refreshMin] cache TTL in minutes (default 120)
   * @param {Function} [opts.fetchImpl] injectable fetch for tests
   * @param {Function} [opts.now] injectable clock for tests
   */
  constructor({ lat, lon, refreshMin = 120, fetchImpl, now, wait, attempts = 3, backoffMs = 3_000, emptyRetryMin = 10 } = {}) {
    this.lat = lat;
    this.lon = lon;
    this.enabled = Number.isFinite(lat) && Number.isFinite(lon);
    this.ttlMs = refreshMin * 60_000;
    this.emptyRetryMs = emptyRetryMin * 60_000;
    this.attempts = attempts;
    this.backoffMs = backoffMs;
    this.fetchImpl = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.now = now || (() => Date.now());
    this.wait = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.series = []; // [{ t: ms, f: °F }] sorted ascending
    this.fetchedAt = 0;
    this.lastAttemptAt = null; // spaces retries (updated every attempt, ok or not)
    this.lastError = null;
  }

  /** URL for the Open-Meteo hourly-temperature forecast (past day + next 2 days). */
  url() {
    return (
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${this.lat}&longitude=${this.lon}` +
      '&hourly=temperature_2m&temperature_unit=fahrenheit' +
      '&past_days=1&forecast_days=2&timezone=UTC'
    );
  }

  /**
   * Fetch a fresh forecast if the cache is stale (or `force`). Never throws.
   * While we have NO series at all (fresh boot / after failures), refresh far
   * more aggressively (every `emptyRetryMs`, default 10 min) instead of waiting
   * the full TTL — the forecast is in-memory, so a redeploy plus one failed boot
   * fetch would otherwise leave the planner blind for hours. `attempts` retries
   * the fetch itself with a short backoff.
   */
  async refresh(force = false) {
    if (!this.enabled) return false;
    const now = this.now();
    const haveData = this.series.length > 0;
    // Space retries by time-since-last-ATTEMPT (not last success): full TTL once
    // we have a forecast, but every emptyRetryMs while the series is still empty.
    const sinceAttempt = this.lastAttemptAt == null ? Infinity : now - this.lastAttemptAt;
    const window = haveData ? this.ttlMs : this.emptyRetryMs;
    if (!force && sinceAttempt < window) return false;
    this.lastAttemptAt = now;

    let lastErr = null;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      try {
        const res = await this.fetchImpl(this.url());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const times = (data && data.hourly && data.hourly.time) || [];
        const temps = (data && data.hourly && data.hourly.temperature_2m) || [];
        const series = [];
        for (let i = 0; i < times.length; i++) {
          const iso = String(times[i]);
          const t = Date.parse(iso.endsWith('Z') ? iso : iso + 'Z');
          const f = Number(temps[i]);
          if (Number.isFinite(t) && Number.isFinite(f)) series.push({ t, f });
        }
        series.sort((a, b) => a.t - b.t);
        if (series.length) {
          this.series = series;
          this.fetchedAt = now;
          this.lastError = null;
          return true;
        }
        throw new Error('empty forecast series');
      } catch (err) {
        lastErr = err;
        if (attempt < this.attempts - 1) await this.wait(this.backoffMs * (attempt + 1));
      }
    }
    this.lastError = lastErr ? lastErr.message : 'unknown';
    log.warn(`Weather refresh failed (${this.attempts} attempts): ${this.lastError}`);
    return false;
  }

  /** Freshness/health for /api/plan. */
  status(now = this.now()) {
    return {
      enabled: this.enabled,
      points: this.series.length,
      ageSec: this.fetchedAt ? Math.round((now - this.fetchedAt) / 1000) : null,
      lastError: this.lastError || null,
    };
  }

  /**
   * Forecast ambient (°F) at timestamp `ts` (ms), linearly interpolated between
   * hourly points. Clamps to the ends of the known series; returns null when no
   * forecast is loaded (callers then fall back to a static prior).
   */
  ambientAt(ts) {
    const s = this.series;
    if (!s.length) return null;
    if (ts <= s[0].t) return s[0].f;
    if (ts >= s[s.length - 1].t) return s[s.length - 1].f;
    let lo = 0;
    let hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t <= ts) lo = mid;
      else hi = mid;
    }
    const a = s[lo];
    const b = s[hi];
    const frac = (ts - a.t) / (b.t - a.t);
    return a.f + (b.f - a.f) * frac;
  }

  /** Bound ambient lookup for injecting into the thermal model. */
  ambientFn() {
    return (ts) => this.ambientAt(ts);
  }
}

export { HOUR_MS };
