// EnergyMeter — a software power/energy estimator. The pump has no energy meter,
// but its raw state tells us which loads are drawing, and the `heat` datapoint
// distinguishes the element actively firing (3) from merely on/idle (2). We
// integrate grounded nameplate wattages over the polled states to estimate live
// power and daily/monthly kWh. Defaults are for a US 120V/12A SaluSpa Airjet.
import { JsonStore } from './store.js';

const round = (v) => Math.round(v * 1000) / 1000;

export class EnergyMeter {
  /**
   * @param {object} [opts]
   * @param {JsonStore} [opts.store]
   * @param {{heater:number,pump:number,blower:number}} [opts.watts]
   * @param {number} [opts.rate] $/kWh for the cost estimate
   */
  constructor({ store, watts = { heater: 1300, pump: 40, blower: 600 }, rate = 0.4 } = {}) {
    this.store = store || new JsonStore('energy.json', {});
    this.watts = watts;
    this.rate = rate;
    const d = this.store.data;
    d.todayKwh = d.todayKwh || 0;
    d.monthKwh = d.monthKwh || 0;
    d.totalKwh = d.totalKwh || 0;
    if (!('day' in d)) d.day = null;
    if (!('month' in d)) d.month = null;
    if (!('lastAt' in d)) d.lastAt = null;
    d.lastW = d.lastW || 0;
  }

  /** Instantaneous draw (W) from a status snapshot (uses the raw heat enum). */
  wattsFor(status) {
    const raw = status.raw || {};
    let w = 0;
    if (Number(raw.heat) >= 3) w += this.watts.heater; // element actively firing
    if (status.filter) w += this.watts.pump;
    if (status.bubbles) w += this.watts.blower;
    return w;
  }

  /**
   * Accumulate energy for the interval since the last sample (left-Riemann over
   * the previous draw). dayKey/monthKey drive the daily/monthly rollovers.
   */
  sample(status, now, dayKey, monthKey) {
    const d = this.store.data;
    const w = this.wattsFor(status);
    if (d.lastAt != null) {
      const dtH = (now - d.lastAt) / 3_600_000;
      if (dtH > 0 && dtH <= 2) {
        // ignore gaps > 2h (restart/outage — state during the gap is unknown)
        if (d.day !== dayKey) {
          d.day = dayKey;
          d.todayKwh = 0;
        }
        if (d.month !== monthKey) {
          d.month = monthKey;
          d.monthKwh = 0;
        }
        const kwh = (d.lastW / 1000) * dtH;
        d.todayKwh += kwh;
        d.monthKwh += kwh;
        d.totalKwh += kwh;
      }
    } else {
      d.day = dayKey;
      d.month = monthKey;
    }
    d.lastAt = now;
    d.lastW = w;
    this.store.save();
    return w;
  }

  summary() {
    const d = this.store.data;
    return {
      watts: d.lastW,
      todayKwh: round(d.todayKwh),
      monthKwh: round(d.monthKwh),
      totalKwh: round(d.totalKwh),
      todayCost: round(d.todayKwh * this.rate),
      monthCost: round(d.monthKwh * this.rate),
      rate: this.rate,
      loads: this.watts,
    };
  }
}
