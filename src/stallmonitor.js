// StallMonitor — detects the failure mode that was silent today: the element
// firing continuously but the water not gaining heat. That means heat loss has
// overtaken the heater (cover off, low water level, or restricted circulation),
// and no amount of software can fix it — the owner must be told.
//
// Logic: while the element is actually firing (heat=3) with a reliable reading,
// track the temperature at which the current firing run began. If it has fired
// for >= stallMinutes with < minGainF of rise, raise a one-shot warning. Any
// real progress (>= minGainF) re-baselines; the element stopping resets it.
export class StallMonitor {
  /**
   * @param {object} [opts]
   * @param {number} [opts.stallMinutes] firing time with no gain before warning (default 40)
   * @param {number} [opts.minGainF] rise that counts as progress (default 1)
   * @param {Function} [opts.notify] async (title, message)
   * @param {object} [opts.log]
   */
  constructor({ stallMinutes = 40, minGainF = 1, notify, log } = {}) {
    this.stallMs = stallMinutes * 60_000;
    this.minGainF = minGainF;
    this.notify = notify || (async () => {});
    this.log = log || { info() {}, warn() {} };
    this.run = null; // { t0, temp0 } current firing run baseline
    this.warned = false;
  }

  /**
   * Feed one status cycle.
   * @param {object} p
   * @param {boolean} p.firing  element actively firing (raw heat === 3)
   * @param {number|null} p.tempF  best temperature estimate
   * @param {boolean} p.reliable  is the reading trustworthy (settled/circulating)
   * @param {number} [p.now]
   * @returns {boolean} true when a stall warning fired this cycle
   */
  update({ firing, tempF, reliable, now = Date.now() }) {
    // Only reason about firing with a reliable temperature. If the element isn't
    // firing, there's nothing to stall — reset.
    if (!firing) {
      this.run = null;
      this.warned = false;
      return false;
    }
    if (tempF == null || !reliable) return false;

    if (!this.run) {
      this.run = { t0: now, temp0: tempF };
      return false;
    }
    // Real progress re-baselines and clears any prior warning.
    if (tempF - this.run.temp0 >= this.minGainF) {
      this.run = { t0: now, temp0: tempF };
      this.warned = false;
      return false;
    }
    // Firing long enough with no gain -> stalled. Warn once per episode.
    if (!this.warned && now - this.run.t0 >= this.stallMs) {
      this.warned = true;
      const mins = Math.round((now - this.run.t0) / 60_000);
      this.log.warn(`Heating stalled: firing ${mins} min with no temp gain (stuck ~${Math.round(tempF)}F).`);
      this.notify(
        'Hot tub not heating',
        `The heater has run ${mins} min with no temperature gain (stuck around ${Math.round(tempF)}°F). ` +
          'Heat loss is matching the heater — check the cover is on, the water is above the min line, ' +
          'and the return valve is fully open.',
      ).catch(() => {});
      return true;
    }
    return false;
  }
}
