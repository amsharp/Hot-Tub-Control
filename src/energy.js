// EnergyMeter — a software power/energy estimator. The pump has no energy meter,
// but its raw state tells us which loads are drawing, and the `heat` datapoint
// distinguishes the element actively firing (3) from merely on/idle (2). We
// integrate grounded nameplate wattages over the polled states to estimate live
// power, daily/monthly kWh, and cost. It also splits out energy consumed during
// peak hours and during a manual override (usually the expensive runs).
// Defaults are for a US 120V/12A SaluSpa Airjet.
import { JsonStore } from './store.js';

const round = (v) => Math.round(v * 1000) / 1000;

export class EnergyMeter {
  /**
   * @param {object} [opts]
   * @param {JsonStore} [opts.store]
   * @param {{heater:number,pump:number,blower:number}} [opts.watts]
   * @param {number} [opts.rate] $/kWh general/off-peak
   * @param {number} [opts.ratePeak] $/kWh during peak (defaults to rate)
   * @param {(nowMs:number)=>number} [opts.rateFor] time-of-use price function
   *   ($/kWh at a timestamp). When provided it takes precedence over the flat
   *   rate/ratePeak pair for pricing; the peak/off-peak *buckets* still come
   *   from the ctx.inPeak flag.
   */
  constructor({ store, watts = { heater: 1300, pump: 40, blower: 600 }, rate = 0.4, ratePeak, rateFor } = {}) {
    this.store = store || new JsonStore('energy.json', {});
    this.watts = watts;
    this.rate = rate;
    this.ratePeak = ratePeak == null ? rate : ratePeak;
    this.rateFor = typeof rateFor === 'function' ? rateFor : null;
    const d = this.store.data;
    for (const k of [
      'todayKwh', 'todayCost', 'monthKwh', 'monthCost', 'overrideKwh', 'overrideCost',
      'peakKwh', 'peakCost', 'totalKwh', 'totalCost', 'lastW',
    ]) {
      d[k] = d[k] || 0;
    }
    if (!('day' in d)) d.day = null;
    if (!('month' in d)) d.month = null;
    // Drop any persisted lastAt on load: the interval between the last pre-restart
    // sample and the first post-restart one covers unknown pump state (the process
    // was down), so billing it against the stale wattage would invent energy. The
    // first sample after a restart just re-primes.
    d.lastAt = null;
    d.lastInPeak = !!d.lastInPeak;
    d.lastOverridden = !!d.lastOverridden;
  }

  /** Instantaneous draw (W) from a status snapshot (uses the raw heat enum). */
  wattsFor(status) {
    const raw = status.raw || {};
    let w = 0;
    // heat enum observed live: 0=off, 2=on/idle, 3=element firing, 4=target
    // reached (standby — element OFF: the ΔT across the heater collapses to ~0
    // in this state). Count the heater ONLY in state 3.
    if (Number(raw.heat) === 3) w += this.watts.heater;
    if (status.filter) w += this.watts.pump;
    if (status.bubbles) w += this.watts.blower;
    return w;
  }

  /**
   * Accumulate energy for the interval since the last sample (left-Riemann over
   * the previous draw + context). ctx: { inPeak, overridden } describe the state
   * that prevailed during the interval.
   */
  sample(status, now, dayKey, monthKey, ctx = {}) {
    const d = this.store.data;
    const w = this.wattsFor(status);
    if (d.lastAt != null) {
      const dtH = (now - d.lastAt) / 3_600_000;
      if (dtH > 0 && dtH <= 2) {
        // ignore gaps > 2h (restart/outage — state during the gap is unknown)
        if (d.day !== dayKey) {
          d.day = dayKey;
          d.todayKwh = 0;
          d.todayCost = 0;
        }
        if (d.month !== monthKey) {
          d.month = monthKey;
          d.monthKwh = 0;
          d.monthCost = 0;
          d.overrideKwh = 0;
          d.overrideCost = 0;
          d.peakKwh = 0;
          d.peakCost = 0;
        }
        const kwh = (d.lastW / 1000) * dtH;
        // Price the interval at the tariff that prevailed when it started
        // (left-Riemann, like the wattage): the persisted lastRate if a TOU
        // function stamped one, else the flat peak/off-peak pair.
        const rate = d.lastRate != null ? d.lastRate : d.lastInPeak ? this.ratePeak : this.rate;
        const cost = kwh * rate;
        d.todayKwh += kwh;
        d.todayCost += cost;
        d.monthKwh += kwh;
        d.monthCost += cost;
        d.totalKwh += kwh;
        d.totalCost += cost;
        if (d.lastOverridden) {
          d.overrideKwh += kwh;
          d.overrideCost += cost;
        }
        if (d.lastInPeak) {
          d.peakKwh += kwh;
          d.peakCost += cost;
        }
      }
    } else {
      d.day = dayKey;
      d.month = monthKey;
    }
    d.lastAt = now;
    d.lastW = w;
    d.lastInPeak = !!ctx.inPeak;
    d.lastOverridden = !!ctx.overridden;
    d.lastRate = this.rateFor ? this.rateFor(now) : null;
    this.store.save();
    return w;
  }

  summary() {
    const d = this.store.data;
    return {
      watts: d.lastW,
      todayKwh: round(d.todayKwh),
      todayCost: round(d.todayCost),
      monthKwh: round(d.monthKwh),
      monthCost: round(d.monthCost),
      overrideKwh: round(d.overrideKwh),
      overrideCost: round(d.overrideCost),
      peakKwh: round(d.peakKwh),
      peakCost: round(d.peakCost),
      totalKwh: round(d.totalKwh),
      totalCost: round(d.totalCost),
      rate: this.rate,
      ratePeak: this.ratePeak,
      rateNow: this.rateFor ? this.rateFor(Date.now()) : d.lastInPeak ? this.ratePeak : this.rate,
      loads: this.watts,
    };
  }
}
