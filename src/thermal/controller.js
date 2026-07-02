// SmartHeatController — the smart-heat control loop, hardened against the
// failure modes that bit or could bite:
//
//  * Failed/unapplied commands must NOT read as manual overrides. A command is
//    only "ours" once CONFIRMED (observed to have taken effect). Until then a
//    state mismatch triggers bounded retries; only a confirmed command that the
//    pump later contradicts counts as the user overriding us.
//  * Watchdog fault-recovery turns the pump on; that's machine action, not a
//    user override — machineAction() resets the state machine.
//  * If the device is reported offline, control writes are skipped (they would
//    silently do nothing) and nothing is inferred from the stale state.
//  * After MAX_RETRIES failed attempts it stops re-issuing (avoids hammering a
//    broken cloud) but leaves the plan latched, so the next successful cycle
//    resumes; a notification is emitted once per give-up.
export class SmartHeatController {
  /**
   * @param {object} opts
   * @param {import('../bestway/client.js').BestwayClient} opts.client
   * @param {import('./planner.js').SmartHeatPlanner} opts.planner
   * @param {number} opts.targetF
   * @param {Function} [opts.notify] async (title, message) — optional alerting
   * @param {object} [opts.log] logger (defaults to console-compatible no-op)
   * @param {number} [opts.maxRetries] command re-issues before giving up (default 3)
   */
  constructor({ client, planner, targetF, notify, log, maxRetries = 3 } = {}) {
    this.client = client;
    this.planner = planner;
    this.targetF = targetF;
    this.notify = notify || (async () => {});
    this.log = log || { info() {}, warn() {} };
    this.maxRetries = maxRetries;

    this.lastPlan = null;
    this.overrideUntil = 0; // ms epoch; while now < this, defer to the user
    // Command state machine: null | { action:'on'|'off', attempts, confirmed }
    this.cmd = null;
  }

  /** Reset after machine-initiated state changes (e.g. watchdog recovery). */
  machineAction() {
    this.cmd = null;
  }

  /** True when the pump state matches what `action` should have produced. */
  _matches(action, status) {
    return action === 'on' ? !!status.heat : !(status.power || status.heat || status.filter);
  }

  async _issue(action) {
    if (action === 'on') {
      await this.client.setTargetTemperature(this.targetF, 'F');
      await this.client.setHeating(true);
    } else {
      await this.client.setAllOff();
    }
  }

  /**
   * One control cycle. `status` is the fresh pump status, `tempF` the best
   * temperature estimate, `nowCtx` = { nowMs, min, day }.
   */
  async onCycle(status, tempF, tempReliable, { nowMs, min, day }) {
    const p = this.planner.plan(tempF, min, day, nowMs);
    const running = !!(status.power || status.heat || status.filter);

    // Reconcile any outstanding command before drawing conclusions.
    let overrideDetected = false;
    if (this.cmd) {
      if (this._matches(this.cmd.action, status)) {
        this.cmd.confirmed = true; // took effect — now it's truly "our" state
      } else if (this.cmd.confirmed) {
        // Was applied, then contradicted -> a human (app/Google/HUD) flipped it.
        overrideDetected = true;
      }
      // Unconfirmed mismatch: command may not have applied — retry below, and
      // do NOT treat it as an override.
    }

    if (overrideDetected) {
      const endMin = p.inPeak ? this.planner.peakEndMin(min) : p.targetMin;
      const untilMs = Math.max(2, (endMin ?? min) - min) * 60_000;
      this.overrideUntil = nowMs + untilMs;
      this.cmd = null;
      this.log.info(`SmartHeat: manual override detected (${p.reason}) — standing down`);
    }
    const overridden = nowMs < this.overrideUntil;

    this.lastPlan = {
      ...p,
      currentTemp: tempF,
      tempReliable,
      nowMin: min,
      overridden,
      reason: overridden ? 'override' : p.reason,
      at: nowMs,
    };
    if (overridden) return this.lastPlan;

    // Device offline: commands would silently no-op and the reported state is
    // stale — skip the cycle rather than act (or infer) from fiction.
    if (status.online === false) {
      this.log.warn('SmartHeat: device offline — skipping control cycle.');
      return this.lastPlan;
    }

    // Desired action this cycle (null = leave as-is).
    const want =
      p.heat === true && !status.heat ? 'on' : p.heat === false && running ? 'off' : null;

    if (!want) {
      // State agrees with the plan. Keep a confirmed command in memory — it is
      // exactly what lets a later contradiction register as a user override.
      return this.lastPlan;
    }

    if (!this.cmd || this.cmd.action !== want) this.cmd = { action: want, attempts: 0, confirmed: false };
    this.cmd.attempts += 1;
    const a = this.cmd.attempts;

    if (a === this.maxRetries + 1) {
      // Crossed the fast-retry budget: tell the owner once, then keep trying
      // quietly on a slow cadence (never give up — the plan stays latched).
      this.log.warn(`SmartHeat: '${want}' not taking effect after ${this.maxRetries} attempts.`);
      await this.notify(
        'Hot tub control issue',
        `The "${want === 'on' ? 'start heating' : 'turn off for peak'}" command hasn't taken effect ` +
          `after ${this.maxRetries} attempts — pump unreachable or refusing commands. Still retrying.`,
      );
    }
    // Fast retries up to maxRetries, then every 5th cycle (~10 min at 2-min polls).
    if (a > this.maxRetries && (a - this.maxRetries - 1) % 5 !== 0) return this.lastPlan;

    this.log.info(
      `SmartHeat -> ${want.toUpperCase()} (${p.reason})` + (a > 1 ? ` [attempt ${a}]` : ''),
    );
    try {
      await this._issue(want);
    } catch (err) {
      // Leave this.cmd unconfirmed; the next cycle retries on the cadence above.
      this.log.warn(`SmartHeat: '${want}' command failed: ${err.message}`);
    }
    return this.lastPlan;
  }
}
