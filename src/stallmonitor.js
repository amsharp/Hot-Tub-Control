// StallMonitor — detects the failure mode that was silent when the tub stalled:
// the element firing continuously but the water not gaining heat (cover off, low
// water, restricted circulation). It can only warn — the fix is physical.
//
// The threshold is NOT a fixed time: near the effective equilibrium the tub
// legitimately heats slower and slower (the grounded model's own ceiling is only
// ~1.3 °F/hr, and far less near target), so any fixed "1 °F in N minutes" rule
// would false-alarm on normal heating. Instead we compare the firing-with-no-gain
// duration to the model's OWN physically-expected time to gain `minGainF` at the
// current temperature, and only cry stall at `factor`× that. If the model says
// the next degree is unreachable at all (loss ≥ heater), that IS the stall — warn
// after a short grace.
export class StallMonitor {
  /**
   * @param {object} [opts]
   * @param {{hoursToHeat:Function}} [opts.model] thermal model (for expected rate)
   * @param {number} [opts.factor] multiple of the expected time before warning (default 2.5)
   * @param {number} [opts.graceMinutes] min firing-no-gain before any warning (default 30)
   * @param {number} [opts.minGainF] the gain that counts as progress, °F (default 1)
   * @param {Function} [opts.notify] async (title, message)
   * @param {object} [opts.log]
   */
  constructor({ model, factor = 2.5, graceMinutes = 30, minGainF = 1, notify, log } = {}) {
    this.model = model;
    this.factor = factor;
    this.graceMs = graceMinutes * 60_000;
    this.minGainF = minGainF;
    this.notify = notify || (async () => {});
    this.log = log || { info() {}, warn() {} };
    this.run = null; // { t0, temp0 } current firing-run baseline
    this.warned = false;
  }

  // Physically-expected time (ms) to gain minGainF at temp0. Infinity if the
  // model says that degree is unreachable; null if no model (fixed fallback).
  _expectedMs(temp0, now) {
    if (!this.model || typeof this.model.hoursToHeat !== 'function') return null;
    const h = this.model.hoursToHeat(temp0, temp0 + this.minGainF, now);
    return Number.isFinite(h) ? h * 3_600_000 : Infinity;
  }

  /**
   * Feed one status cycle. Returns true the cycle a stall warning fires.
   * @param {object} p @param {boolean} p.firing element actually firing (heat===3)
   * @param {number|null} p.tempF best temp estimate  @param {boolean} p.reliable settled/circulating
   */
  update({ firing, tempF, reliable, now = Date.now() }) {
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
    if (tempF - this.run.temp0 >= this.minGainF) {
      this.run = { t0: now, temp0: tempF }; // real progress -> re-baseline, re-arm
      this.warned = false;
      return false;
    }
    if (this.warned) return false;

    const noGainMs = now - this.run.t0;
    const expMs = this._expectedMs(this.run.temp0, now);
    let threshold;
    if (expMs === Infinity)
      threshold = this.graceMs; // model: next degree unreachable -> genuine stall
    else if (expMs == null)
      threshold = this.graceMs * 4; // no model -> conservative fixed ~2h
    else threshold = Math.max(this.graceMs, this.factor * expMs);

    if (noGainMs >= threshold) {
      this.warned = true;
      const mins = Math.round(noGainMs / 60_000);
      this.log.warn(`Heating stalled: firing ${mins} min without the expected temperature gain (stuck ~${Math.round(tempF)}F).`);
      this.notify(
        'Hot tub not heating',
        `The heater has run ${mins} min without gaining temperature (stuck around ${Math.round(tempF)}°F) — ` +
          'far slower than physics allows. Check the cover is on, the water is above the min line, ' +
          'and the return valve is fully open.',
      ).catch(() => {});
      return true;
    }
    return false;
  }
}
