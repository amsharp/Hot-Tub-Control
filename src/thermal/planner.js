// SmartHeatPlanner — decides when to run the heater so the tub reaches `targetF`
// by `targetMin` (local minutes-of-day), starting as late as possible to save
// energy, while never heating during a peak window. Once it commits to a day's
// pre-heat it latches on until the target time (or a peak) so the heater isn't
// rapidly toggled as the temperature drifts.
export class SmartHeatPlanner {
  /**
   * @param {object} opts
   * @param {import('./model.js').ThermalModel} opts.model
   * @param {number} [opts.targetF] target temperature (default 104)
   * @param {number} [opts.targetMin] target time in minutes-of-day (default 16:00)
   * @param {{start:number,end:number}[]} [opts.peaks] no-heat windows (minutes-of-day)
   * @param {number} [opts.safetyMin] head-start buffer in minutes (default 45)
   */
  constructor({ model, targetF = 104, targetMin = 16 * 60, peaks = [{ start: 16 * 60, end: 21 * 60 }], safetyMin = 45 } = {}) {
    this.model = model;
    this.targetF = targetF;
    this.targetMin = targetMin;
    this.peaks = peaks;
    this.safetyMin = safetyMin;
    this._committed = { day: null, active: false };
  }

  inPeak(min) {
    return this.peaks.some((p) => min >= p.start && min < p.end);
  }

  /** End (minutes-of-day) of the peak window containing `min`, else null. */
  peakEndMin(min) {
    const w = this.peaks.find((p) => min >= p.start && min < p.end);
    return w ? w.end : null;
  }

  /**
   * @param {number} currentTemp current water temp (°F)
   * @param {number} nowMin minutes since local midnight
   * @param {string|number} dayKey stable id for the local day (resets the latch)
   * @returns {{heat: (boolean|null), reason: string, startMin: number, needHours: number, targetMin: number, targetF: number, inPeak: boolean}}
   *   heat === true  -> ensure heater on;  false -> ensure off;  null -> no action.
   */
  plan(currentTemp, nowMin, dayKey) {
    if (this._committed.day !== dayKey) this._committed = { day: dayKey, active: false };

    const inPeak = this.inPeak(nowMin);
    const needHours = this.model.hoursToHeat(currentTemp, this.targetF);
    const startMin = Number.isFinite(needHours) ? this.targetMin - needHours * 60 - this.safetyMin : -Infinity;

    let heat = null;
    let reason;
    if (inPeak) {
      heat = false;
      reason = 'peak';
      this._committed.active = false;
    } else if (nowMin >= this.targetMin) {
      heat = null;
      reason = 'after-target';
      this._committed.active = false;
    } else {
      const shouldStart = nowMin >= startMin && currentTemp < this.targetF;
      if (this._committed.active || shouldStart) {
        this._committed.active = true;
        heat = true;
        reason = currentTemp < this.targetF ? 'preheat' : 'holding';
      } else {
        heat = null;
        reason = 'waiting';
      }
    }
    return { heat, reason, startMin, needHours, targetMin: this.targetMin, targetF: this.targetF, inPeak };
  }
}

/** Format minutes-of-day as h:MM AM/PM (for display). Infinity/NaN -> '—'. */
export function fmtMin(min) {
  if (!Number.isFinite(min)) return '—';
  let m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${ap}`;
}
