// Tiny temperature history — a rolling buffer at 1-hour resolution (last 24
// hours), persisted to the data volume. Fed by the watchdog's status reads;
// served to the widget/HUD for a temperature chart. Values are stored in
// Fahrenheit so the chart doesn't have to reconcile unit changes.
import { JsonStore } from './store.js';

const HOUR_MS = 3600_000;
const MAX_POINTS = 24; // 24 hours at 1/hour

function toF(v, unit) {
  if (v == null) return null;
  return unit === 'C' ? Math.round((v * 9) / 5 + 32) : Math.round(v);
}

export class History {
  /** @param {object} [opts] @param {JsonStore} [opts.store] injectable for tests */
  constructor({ store } = {}) {
    this.store = store || new JsonStore('history.json', { samples: [] });
    if (!Array.isArray(this.store.data.samples)) this.store.data.samples = [];
  }

  /**
   * Record a reading, at most one point per clock hour (the current hour's
   * point is updated in place until the hour rolls over). `now` is injectable.
   */
  record(status, now = Date.now()) {
    if (!status) return;
    const f = toF(status.currentTemp, status.unit);
    if (f == null) return;
    const s = toF(status.targetTemp, status.unit);
    const arr = this.store.data.samples;
    const sample = { t: now, f, s };
    const last = arr[arr.length - 1];
    if (last && Math.floor(last.t / HOUR_MS) === Math.floor(now / HOUR_MS)) {
      arr[arr.length - 1] = sample; // same hour — update in place
    } else {
      arr.push(sample);
    }
    while (arr.length > MAX_POINTS) arr.shift();
    this.store.save();
    return sample;
  }

  list() {
    return this.store.data.samples;
  }

  /** Overwrite the buffer (used to seed a synthetic 24h backfill). */
  replace(samples) {
    this.store.data.samples = samples.slice(-MAX_POINTS);
    this.store.save();
    return this.store.data.samples;
  }
}
