// FaultWatchdog — periodically reads spa status and, when it sees an
// auto-clearable fault (notably E02 "low flow"), tries to clear it by
// restarting circulation. Physical causes (low water, dirty filter) can't be
// fixed remotely, so after a few failed attempts it backs off and notifies you.
import { notify } from '../notify/notifier.js';
import { detectFaults } from '../bestway/constants.js';
import { log } from '../log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FaultWatchdog {
  /**
   * @param {object} opts
   * @param {import('../bestway/client.js').BestwayClient} opts.client
   * @param {boolean} [opts.autoClear] attempt automatic recovery (default true)
   * @param {number} [opts.intervalMs] poll interval (default 5 min)
   * @param {number} [opts.maxAttempts] max auto-clears before backing off (default 3)
   * @param {number} [opts.cooldownMs] min gap between attempts (default 15 min)
   * @param {number} [opts.recheckDelayMs] wait before confirming a clear (default 60s)
   * @param {Function} [opts.onRecovered] called with fresh status after a successful clear
   * @param {Function} [opts.wait] injectable delay (tests)
   * @param {Function} [opts.now] injectable clock (tests)
   */
  constructor({
    client,
    autoClear = true,
    intervalMs = 5 * 60_000,
    maxAttempts = 3,
    cooldownMs = 15 * 60_000,
    recheckDelayMs = 60_000,
    onRecovered,
    wait = sleep,
    now = () => Date.now(),
  } = {}) {
    this.client = client;
    this.autoClear = autoClear;
    this.intervalMs = intervalMs;
    this.maxAttempts = maxAttempts;
    this.cooldownMs = cooldownMs;
    this.recheckDelayMs = recheckDelayMs;
    this.onRecovered = onRecovered;
    this.wait = wait;
    this.now = now;
    // Per-code recovery state: code -> { attempts, lastAttemptAt, notified }
    this.state = new Map();
    this.timer = null;
    this._inFlight = null; // promise guard so checks don't overlap
  }

  /**
   * Run a check, but never overlap with one already in progress (a real-time
   * push and a poll tick can race). Returns the in-flight check if one exists.
   */
  trigger() {
    if (this._inFlight) return this._inFlight;
    this._inFlight = this.check().finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  /**
   * Entry point for the real-time WebSocket: given freshly pushed attributes,
   * immediately run a check if they contain a fault. This is what lets the
   * watchdog react within seconds of the spa starting to beep.
   */
  handleRealtimeAttrs(attrs) {
    if (detectFaults(attrs).length) {
      log.info('Real-time fault detected — triggering watchdog immediately.');
      return this.trigger();
    }
    return null;
  }

  start() {
    if (this.timer) return this;
    log.info(
      `Fault watchdog started (every ${Math.round(this.intervalMs / 60000)} min, ` +
        `auto-clear ${this.autoClear ? 'on' : 'off'}).`,
    );
    this.timer = setInterval(() => {
      this.check().catch((err) => log.warn('Watchdog check failed:', err.message));
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    // Kick an immediate check too.
    this.check().catch((err) => log.warn('Watchdog check failed:', err.message));
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _stateFor(code) {
    if (!this.state.has(code)) this.state.set(code, { attempts: 0, lastAttemptAt: 0, notified: false });
    return this.state.get(code);
  }

  /**
   * One watchdog cycle. Returns a small summary describing what happened —
   * handy for tests and the /api/health endpoint.
   */
  async check() {
    const status = await this.client.getStatus();
    const faults = status.faults || [];

    if (!faults.length) {
      // All clear: reset state and clear any "notified" latches.
      if (this.state.size) this.state.clear();
      return { faults: [], action: 'none' };
    }

    let action = 'reported';
    for (const fault of faults) {
      const handled = await this._handleFault(fault, status);
      if (handled === 'recovered') action = 'recovered';
      else if (handled === 'attempted' && action !== 'recovered') action = 'attempted';
    }
    return { faults, action };
  }

  async _handleFault(fault, status) {
    const st = this._stateFor(fault.code);

    if (!this.autoClear || !fault.autoClearable) {
      if (!st.notified) {
        await notify(
          'Hot tub fault',
          `${fault.code}: ${fault.meaning}. ${
            fault.autoClearable ? '' : 'This needs hands-on attention (check water level and filter).'
          }`,
          { level: 'alert', data: { code: fault.code } },
        );
        st.notified = true;
      }
      return 'reported';
    }

    // Respect attempt cap and cooldown.
    const since = this.now() - st.lastAttemptAt;
    if (st.attempts >= this.maxAttempts) {
      if (!st.notified) {
        await notify(
          'Hot tub fault needs attention',
          `${fault.code}: ${fault.meaning}. Tried restarting circulation ${st.attempts} times ` +
            'without success — please check the water level and clean/replace the filter.',
          { level: 'alert', data: { code: fault.code } },
        );
        st.notified = true;
      }
      return 'reported';
    }
    if (st.attempts > 0 && since < this.cooldownMs) {
      return 'reported'; // still cooling down from the last attempt
    }

    // Attempt recovery.
    st.attempts += 1;
    st.lastAttemptAt = this.now();
    log.info(`Watchdog: attempting to clear ${fault.code} (attempt ${st.attempts}/${this.maxAttempts})`);
    await notify('Clearing hot tub fault', `${fault.code}: ${fault.meaning} — restarting circulation…`, {
      level: 'warn',
      data: { code: fault.code, attempt: st.attempts },
    });

    const restoreHeat = !!status.heat;
    await this.client.restartCirculation({ restoreHeat, wait: this.wait });

    // Wait, then confirm.
    await this.wait(this.recheckDelayMs);
    const after = await this.client.getStatus();
    const stillFaulting = (after.faults || []).some((f) => f.code === fault.code);
    if (!stillFaulting) {
      log.info(`Watchdog: ${fault.code} cleared.`);
      await notify('Hot tub fault cleared', `${fault.code} cleared automatically.`, {
        level: 'info',
        data: { code: fault.code },
      });
      this.state.delete(fault.code);
      if (this.onRecovered) await this.onRecovered(after);
      return 'recovered';
    }
    log.warn(`Watchdog: ${fault.code} still present after restart.`);
    return 'attempted';
  }
}
