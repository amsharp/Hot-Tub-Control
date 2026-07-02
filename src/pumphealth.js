// PumpHealth — filter/circulation health from the ONLY two signals this pump
// actually provides.
//
// The 2026-07-02 valve-throttle trial settled it: there is no analog flow
// signal. The temperature registers stay pinned to incoming-water temp right up
// to the moment the E02 paddle drops (zero warning, binary trip, hard latch),
// and the extra registers decoded to a runtime counter (word2/word5) and a °C
// twin of Tnow (word7). The earlier ΔT-based flow estimate was built on the
// counter and has been removed.
//
// What remains, and what this tracks:
//  1. E02 event rate — each latch is a data point. A clean system trips ~never;
//     a clogging filter trips occasionally, then often. Rising rate = warning.
//  2. Morning settle time — how long after circulation starts until the temp
//     reading stops moving. A loading filter slows the mixing loop, so this
//     creeps up BEFORE flow degrades enough to drop the paddle.
import { JsonStore } from './store.js';

const WEEK_MS = 7 * 86_400_000;
const KEEP_E02_MS = 120 * 86_400_000; // ~4 months of events
const MAX_SETTLES = 90; // ~3 months of daily settles
const STABLE_DELTA_F = 1; // reading considered stable within ±1°F
const STABLE_SAMPLES = 2; // ...for this many consecutive samples
const MAX_SETTLE_MS = 45 * 60_000; // give up measuring beyond this

export class PumpHealth {
  /** @param {object} [opts] @param {JsonStore} [opts.store] injectable for tests */
  constructor({ store } = {}) {
    this.store = store || new JsonStore('pumphealth.json', { e02: [], settles: [] });
    const d = this.store.data;
    if (!Array.isArray(d.e02)) d.e02 = [];
    if (!Array.isArray(d.settles)) d.settles = [];
    this.lastE02 = false;
    this.lastCirculating = null;
    this.settling = null; // { t0, lastT, stable }
  }

  /**
   * Feed one status cycle. `e02Active` is whether E02 is currently latched;
   * only the inactive->active transition records an event (a latch persists
   * across many polls).
   */
  onStatus({ e02Active, tempF, circulating, now = Date.now() }) {
    const d = this.store.data;
    let changed = false;

    if (e02Active && !this.lastE02) {
      d.e02.push(now);
      while (d.e02.length && d.e02[0] < now - KEEP_E02_MS) d.e02.shift();
      changed = true;
    }
    this.lastE02 = !!e02Active;

    // Settle-time measurement across each circulation start.
    if (circulating && this.lastCirculating === false) {
      this.settling = { t0: now, lastT: tempF, stable: 0 };
    } else if (this.settling && circulating) {
      if (now - this.settling.t0 > MAX_SETTLE_MS) {
        this.settling = null; // too noisy to call — skip this one
      } else if (tempF != null) {
        if (Math.abs(tempF - this.settling.lastT) <= STABLE_DELTA_F) {
          this.settling.stable += 1;
          if (this.settling.stable >= STABLE_SAMPLES) {
            d.settles.push({ t: now, sec: Math.round((now - this.settling.t0) / 1000) });
            while (d.settles.length > MAX_SETTLES) d.settles.shift();
            this.settling = null;
            changed = true;
          }
        } else {
          this.settling.stable = 0;
        }
        if (this.settling) this.settling.lastT = tempF;
      }
    } else if (!circulating) {
      this.settling = null; // pump stopped mid-measurement
    }
    if (circulating != null) this.lastCirculating = !!circulating;

    if (changed) this.store.save();
  }

  /** Summary for the API/widget. */
  summary(now = Date.now()) {
    const d = this.store.data;
    const e02Week = d.e02.filter((t) => t > now - WEEK_MS).length;
    const e02Month = d.e02.filter((t) => t > now - 30 * 86_400_000).length;
    const s = d.settles;
    const recent = s.slice(-7);
    const baseline = s.slice(0, Math.max(1, s.length - 7));
    const avg = (a) => (a.length ? a.reduce((x, p) => x + p.sec, 0) / a.length : null);
    const recentAvg = avg(recent);
    const baselineAvg = avg(baseline);
    return {
      e02Week,
      e02Month,
      e02LastAt: d.e02.length ? d.e02[d.e02.length - 1] : null,
      settleRecentSec: recentAvg == null ? null : Math.round(recentAvg),
      settleBaselineSec: baselineAvg == null ? null : Math.round(baselineAvg),
      // Degrading when settles run >50% over baseline, or E02s are recurring.
      warning:
        e02Week >= 2 ||
        (recentAvg != null && baselineAvg != null && s.length >= 14 && recentAvg > baselineAvg * 1.5),
    };
  }
}
