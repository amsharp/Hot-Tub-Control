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
  constructor({ model, targetF = 104, targetMin = 16 * 60, peaks = [{ start: 16 * 60, end: 21 * 60 }], safetyMin = 45, maxLeadHours = 7 } = {}) {
    this.model = model;
    this.targetF = targetF;
    this.targetMin = targetMin;
    this.peaks = peaks;
    this.safetyMin = safetyMin;
    // Hard cap on how far before the target the pre-heat may start. Without it,
    // a marginal heater (effective equilibrium barely above target) makes the
    // model predict 10-18h to gain the last couple degrees, ballooning the lead
    // window until it heats ~24/7 minus peak. Capping bounds heating to the
    // afternoon: on a hard day it gets as close to target as the window allows
    // and stops, rather than running all evening/night.
    this.maxLeadMin = maxLeadHours * 60;
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
   * @param {number} [nowMs] wall-clock ms — enables forecast-predictive sizing:
   *   the pre-heat is sized off the temperature the tub is forecast to cool to by
   *   the chosen start time, so a cold night starts the heater earlier.
   * @returns {{heat: (boolean|null), reason: string, startMin: number, needHours: number, targetMin: number, targetF: number, inPeak: boolean}}
   *   heat === true  -> ensure heater on;  false -> ensure off;  null -> no action.
   */
  plan(currentTemp, nowMin, dayKey, nowMs = null) {
    if (this._committed.day !== dayKey) this._committed = { day: dayKey, active: false };

    const inPeak = this.inPeak(nowMin);
    // Predictive sizing: the tub keeps cooling until we start, so heating sized
    // from the *current* temp underestimates on a cold night. Iterate a couple of
    // times — project cooling (via the forecast) to the candidate start, then
    // re-size the heat from that projected-lower temp.
    let needHours = this.model.hoursToHeat(currentTemp, this.targetF, nowMs);
    if (nowMs != null && Number.isFinite(needHours) && typeof this.model.projectCool === 'function') {
      for (let k = 0; k < 2; k++) {
        const startM = this.targetMin - needHours * 60 - this.safetyMin;
        if (startM <= nowMin) break; // start is now/past — no pre-start cooling to model
        const startTs = nowMs + (startM - nowMin) * 60_000;
        const tempAtStart = this.model.projectCool(currentTemp, nowMs, startTs);
        const nh = this.model.hoursToHeat(tempAtStart, this.targetF, startTs);
        if (!Number.isFinite(nh)) break;
        needHours = nh;
      }
    }
    const startMin = Number.isFinite(needHours) ? this.targetMin - needHours * 60 - this.safetyMin : -Infinity;
    // Circular minutes from now until the next target time (0..1439). Using
    // time-until (not a minutes-of-day comparison) is what makes a pre-heat that
    // must begin the previous evening — e.g. a lead window that crosses midnight
    // for an early-morning target — work correctly.
    const minsUntil = (((this.targetMin - nowMin) % 1440) + 1440) % 1440;
    // Lead window, capped: never begin more than maxLeadMin before the target.
    const rawLead = Number.isFinite(needHours) ? needHours * 60 + this.safetyMin : Infinity;
    const leadMin = Math.min(rawLead, this.maxLeadMin);

    // Outside the pre-heat/hold window the tub should be OFF (heat=false, so the
    // controller actively shuts it down), not left as-is (null) — otherwise a
    // heater somehow left on lingers all evening. Manual use outside the window
    // is respected via the controller's override detection.
    let heat = false;
    let reason;
    if (inPeak) {
      heat = false;
      reason = 'peak';
      this._committed.active = false;
    } else if (this._committed.active) {
      // Already pre-heating: hold (through the "at temp, maintain to target time"
      // phase) until we reach the target time. The window is FROZEN at commit
      // (but still capped) — needHours shrinks to 0 as the tub warms, so
      // recomputing it here would eject the latch and stop heating early.
      const lead = Math.min(this._committed.leadAtStart ?? leadMin, this.maxLeadMin);
      if (minsUntil > 0 && minsUntil <= lead) {
        heat = true;
        reason = currentTemp < this.targetF ? 'preheat' : 'holding';
      } else {
        // Reached/passed the target time (minsUntil hits 0 then wraps large).
        heat = false;
        reason = 'after-target';
        this._committed.active = false;
      }
    } else {
      // Not yet heating: start when we enter the lead window (which, for an early
      // target, can be the previous evening — minsUntil handles the wrap).
      const shouldStart = minsUntil > 0 && minsUntil <= leadMin && currentTemp < this.targetF;
      if (shouldStart) {
        this._committed.active = true;
        this._committed.leadAtStart = leadMin; // freeze the window for the hold phase
        heat = true;
        reason = 'preheat';
      } else {
        heat = false;
        reason = minsUntil > 0 && minsUntil <= leadMin ? 'ready' : 'waiting';
      }
    }
    return { heat, reason, startMin, needHours, minsUntil, targetMin: this.targetMin, targetF: this.targetF, inPeak };
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
