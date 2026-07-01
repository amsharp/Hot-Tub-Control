// Temperature history, kept at two resolutions so both the widget and a
// long-term view stay cheap:
//   • `samples` — a rolling 1-hour-resolution buffer of the last 24 h, for the
//     widget/HUD chart.
//   • `daily`   — one min/max/avg rollup per calendar day, kept ~13 months, for
//     a year-long chart. A year of daily rollups is ~24 KB of JSON, so keeping
//     a full year costs essentially nothing on the data volume.
// Fed by the watchdog's status reads. Values are stored in Fahrenheit so charts
// don't have to reconcile unit changes.
import { JsonStore } from './store.js';

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;
const MAX_POINTS = 24; // 24 hours at 1/hour
const MAX_DAYS = 400; // ~13 months of daily rollups

function toF(v, unit) {
  if (v == null) return null;
  return unit === 'C' ? Math.round((v * 9) / 5 + 32) : Math.round(v);
}

export class History {
  /** @param {object} [opts] @param {JsonStore} [opts.store] injectable for tests */
  constructor({ store } = {}) {
    this.store = store || new JsonStore('history.json', { samples: [], daily: [] });
    if (!Array.isArray(this.store.data.samples)) this.store.data.samples = [];
    if (!Array.isArray(this.store.data.daily)) this.store.data.daily = [];
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

    // Long-term daily rollup: fold this reading into the current day's min/max/avg.
    const day = Math.floor(now / DAY_MS);
    const days = this.store.data.daily;
    const dlast = days[days.length - 1];
    if (dlast && dlast.d === day) {
      dlast.min = Math.min(dlast.min, f);
      dlast.max = Math.max(dlast.max, f);
      dlast.sum += f;
      dlast.n += 1;
    } else {
      days.push({ d: day, min: f, max: f, sum: f, n: 1 });
    }
    while (days.length > MAX_DAYS) days.shift();

    this.store.save();
    return sample;
  }

  list() {
    return this.store.data.samples;
  }

  /**
   * Daily rollups as chart-friendly points: `{ t, min, max, avg }` in °F, one
   * per day, oldest first. `t` is the day's start (ms). Up to ~13 months.
   */
  daily() {
    return this.store.data.daily.map((e) => ({
      t: e.d * DAY_MS,
      min: e.min,
      max: e.max,
      avg: Math.round(e.sum / e.n),
    }));
  }

  /** Overwrite the buffer (used to seed a synthetic 24h backfill). */
  replace(samples) {
    this.store.data.samples = samples.slice(-MAX_POINTS);
    this.store.save();
    return this.store.data.samples;
  }
}
