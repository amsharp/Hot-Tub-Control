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
  constructor({ client, planner, targetF, notify, log, maxRetries = 3, store } = {}) {
    this.client = client;
    this.planner = planner;
    this.targetF = targetF;
    this.notify = notify || (async () => {});
    this.log = log || { info() {}, warn() {} };
    this.maxRetries = maxRetries;
    // Optional persistence (JsonStore-shaped): survives redeploys so an active
    // override or in-flight command isn't forgotten by a restart mid-evening.
    this.store = store || { data: {}, save() {} };
    const d = this.store.data;

    this.lastPlan = null;
    this.overrideUntil = d.overrideUntil || 0; // ms epoch; defer to the user until then
    // Command state machine: null | { action:'on'|'off', attempts, confirmed }
    this.cmd = d.cmd || null;
    // Pump running-state at the previous poll (null = unknown). A running-state
    // transition we didn't command is a human acting — the FIRST app press
    // registers as an override, not just a contradiction of our own command.
    this.lastRunning = 'lastRunning' in d ? d.lastRunning : null;
  }

  _persist() {
    this.store.data.overrideUntil = this.overrideUntil;
    this.store.data.cmd = this.cmd;
    this.store.data.lastRunning = this.lastRunning;
    this.store.save();
  }

  /** Reset after machine-initiated state changes (e.g. watchdog recovery). */
  machineAction() {
    this.cmd = null;
    this.lastRunning = null; // next transition is machine-made — don't read it as human
    this._persist();
  }

  /** Single exit for onCycle: remember the observed state and persist. */
  _finish(running) {
    this.lastRunning = running;
    this._persist();
    return this.lastPlan;
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

    // Device offline: the reported state is stale — infer nothing from it and
    // send nothing at it. lastRunning is deliberately NOT updated (a stale
    // snapshot must not seed transition detection either).
    if (status.online === false) {
      this.log.warn('SmartHeat: device offline — skipping control cycle.');
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
      return this.lastPlan;
    }

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

    // Transition-based detection: the pump changed running-state between polls
    // and no command of ours explains it -> a human did it. This registers the
    // FIRST app press as an override (the confirmed-contradiction path above
    // otherwise needs the user to fight us twice). Only relevant when the plan
    // would fight the change; agreeing transitions are just absorbed.
    if (!overrideDetected && this.lastRunning != null && running !== this.lastRunning) {
      const explainedByUs = this.cmd && this.cmd.action === (running ? 'on' : 'off');
      const wouldFight = running ? p.heat === false : p.heat === true;
      if (!explainedByUs && wouldFight) overrideDetected = true;
    }

    // Boot grace: first-ever cycle (no persisted state) finding the pump
    // RUNNING during peak. The controller can't have left it that way — its
    // peak policy is all-off — so someone wanted it on. Stand down rather than
    // kill a soak seconds after a restart. (A mid-peak restart with the tub
    // legitimately off doesn't hit this: running would be false.)
    // (lastPlan === null distinguishes a true fresh boot from machineAction(),
    // which also clears lastRunning mid-run — recovery must re-assert the plan.)
    if (!overrideDetected && this.lastPlan === null && this.lastRunning == null && this.overrideUntil === 0 && running && p.inPeak && p.heat === false) {
      overrideDetected = true;
      this.log.info('SmartHeat: found pump running during peak on first cycle — assuming manual use.');
    }

    if (overrideDetected) {
      // Stand down until the end of the relevant window. In peak: the peak end.
      // Otherwise: until the next target time (circular — an evening/overnight
      // override must NOT collapse to ~0 the way targetMin−nowMin does once the
      // target has passed), capped at 12h so it re-asserts by the next morning.
      let untilMs;
      if (p.inPeak) {
        const end = this.planner.peakEndMin(min);
        untilMs = Math.max(2, (end ?? min) - min) * 60_000;
      } else {
        const minsToTarget = (((p.targetMin - min) % 1440) + 1440) % 1440;
        untilMs = Math.min(Math.max(2, minsToTarget), 12 * 60) * 60_000;
      }
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
    if (overridden) return this._finish(running);

    // Desired action this cycle (null = leave as-is).
    const want =
      p.heat === true && !status.heat ? 'on' : p.heat === false && running ? 'off' : null;

    if (!want) {
      // State agrees with the plan. Keep a confirmed command in memory — it is
      // exactly what lets a later contradiction register as a user override.
      return this._finish(running);
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
    if (a > this.maxRetries && (a - this.maxRetries - 1) % 5 !== 0) return this._finish(running);

    this.log.info(
      `SmartHeat -> ${want.toUpperCase()} (${p.reason})` + (a > 1 ? ` [attempt ${a}]` : ''),
    );
    try {
      await this._issue(want);
    } catch (err) {
      // Leave this.cmd unconfirmed; the next cycle retries on the cadence above.
      this.log.warn(`SmartHeat: '${want}' command failed: ${err.message}`);
    }
    return this._finish(running);
  }
}
