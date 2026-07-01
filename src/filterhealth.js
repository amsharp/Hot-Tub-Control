// FilterHealth — a slow-moving "filter %" derived from the ΔT flow estimate.
//
// The E02 paddle switch only drops when circulation has collapsed (~25-50% of
// normal), so it gives no early warning. Instead we trend the flow estimate:
// health = (24h moving average of estimated flow) / (clean-filter baseline).
// Because it's a ratio, constant errors in the absolute flow scale (heater
// wattage, register scale) cancel — it degrades exactly as fast as the filter
// clogs, even if the L/min numbers are off by a constant factor.
//
// Baseline handling: the baseline is the best window average ever observed and
// only ratchets upward. When the filter is cleaned and flow recovers, the next
// day's average exceeds the old baseline and re-anchors 100% automatically —
// no manual reset needed (an explicit reset() exists anyway).
//
// Samples come only from reliable flow estimates (element firing), so a day's
// window typically holds a few firing-hours' worth of 2-minute samples.
import { JsonStore } from './store.js';

const WINDOW_MS = 24 * 3_600_000; // "large moving average": one day
const KEEP_MS = 36 * 3_600_000; // retain a bit beyond the window
const MIN_SAMPLES = 8; // don't report health off a handful of readings
const MIN_SPAN_MS = 2 * 3_600_000; // ...or a burst shorter than 2h

const round1 = (v) => Math.round(v * 10) / 10;

export class FilterHealth {
  /** @param {object} [opts] @param {JsonStore} [opts.store] injectable for tests */
  constructor({ store } = {}) {
    this.store = store || new JsonStore('filterhealth.json', { samples: [], baseline: null, baselineAt: null });
    const d = this.store.data;
    if (!Array.isArray(d.samples)) d.samples = [];
    if (!('baseline' in d)) d.baseline = null;
  }

  /**
   * Feed one flow computation (from FlowModel.compute). Only reliable samples
   * (element firing, valid ΔT) are recorded. Returns true when recorded.
   */
  record(flow, now = Date.now()) {
    if (!flow || !flow.reliable || flow.lpm == null) return false;
    const d = this.store.data;
    d.samples.push({ t: now, lpm: flow.lpm });
    const cutoff = now - KEEP_MS;
    while (d.samples.length && d.samples[0].t < cutoff) d.samples.shift();

    // Ratchet the baseline up whenever the current window beats it.
    const w = this._window(now);
    if (w && (d.baseline == null || w.avg > d.baseline)) {
      d.baseline = w.avg;
      d.baselineAt = now;
    }
    this.store.save();
    return true;
  }

  /** Windowed average over the last 24h of reliable samples, or null. */
  _window(now) {
    const from = now - WINDOW_MS;
    const s = this.store.data.samples.filter((p) => p.t >= from);
    if (s.length < MIN_SAMPLES) return null;
    if (s[s.length - 1].t - s[0].t < MIN_SPAN_MS) return null;
    return { avg: s.reduce((a, p) => a + p.lpm, 0) / s.length, n: s.length };
  }

  /**
   * Current health summary: { pct, avgLpm, baselineLpm, samples } — pct is
   * 0-100 (clamped; a fresh baseline day reads 100), or null until there's a
   * meaningful window AND a baseline to compare against.
   */
  health(now = Date.now()) {
    const d = this.store.data;
    const w = this._window(now);
    if (!w || d.baseline == null || d.baseline <= 0) {
      return { pct: null, avgLpm: w ? round1(w.avg) : null, baselineLpm: d.baseline, samples: w ? w.n : 0 };
    }
    const pct = Math.max(0, Math.min(100, Math.round((w.avg / d.baseline) * 100)));
    return { pct, avgLpm: round1(w.avg), baselineLpm: round1(d.baseline), samples: w.n };
  }

  /** Manual re-anchor (e.g. after a filter change): next window sets 100%. */
  reset() {
    this.store.data.baseline = null;
    this.store.data.baselineAt = null;
    this.store.save();
  }
}
