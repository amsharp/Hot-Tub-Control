// ThermalModel — a self-calibrating heat-transfer model of the tub, used to
// predict how long the heater needs to reach a target temperature.
//
// Physics (Newton's law of heating/cooling):
//   heating (heater on):  dT/dt = lossH * (teq - T)      -> approaches teq
//   cooling (heater off): dT/dt = -lossC * (T - ambient) -> approaches ambient
// Both give dT/dt linear in T, so we learn the parameters by regressing observed
// rate (dT/dt) against temperature — one regression for heating, one for cooling
// — blended with conservative priors until enough real data has accumulated.
// Everything is in Fahrenheit and hours.
import { JsonStore } from '../store.js';

// Priors err on the slow side (a Bestway Airjet heats ~1-1.5 °F/hr) so the
// planner starts pre-heating early enough before it has learned the real rates.
// The cooling prior is grounded in measured overnight retention: with the cover
// on, a real night dropped ~4 °F over ~8 h (103->99 °F), i.e. a cooling
// coefficient near 0.013/hr. We use 0.02/hr — a safety margin above the measured
// loss so the planner never starts *too late*, but ~6x gentler than the original
// 0.12/hr, which wrongly imagined the tub crashing to ~75 °F by dawn and kicked
// the heater on before 5 AM for a rebound that was never needed.
const PRIOR = {
  heat: { loss: 0.2, teq: 106 }, // ~8h from 95->104 °F
  cool: { loss: 0.02, ambient: 62 }, // covered tub barely cools overnight
};
const MIN_SAMPLES = 8; // observations before trusting a learned regression
const MIN_DT_HOURS = 1 / 6; // ignore intervals < 10 min
const MIN_DTEMP = 1; // require >= 1 °F change (the pump reports whole degrees)
// The temp sensor only reads true bulk water temp while the pump circulates;
// after circulation starts it takes a few minutes to settle. Readings while the
// pump is off (or not yet settled) are untrustworthy and never used for learning.
const SETTLE_MS = 5 * 60_000;

function emptySums() {
  return { n: 0, x: 0, y: 0, xx: 0, xy: 0 };
}
function add(s, x, y) {
  s.n += 1;
  s.x += x;
  s.y += y;
  s.xx += x * x;
  s.xy += x * y;
}
function regress(s) {
  if (s.n < 2) return null;
  const denom = s.n * s.xx - s.x * s.x;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (s.n * s.xy - s.x * s.y) / denom;
  const intercept = (s.y - slope * s.x) / s.n;
  return { slope, intercept };
}

export class ThermalModel {
  /**
   * @param {object} [opts]
   * @param {JsonStore} [opts.store] injectable for tests
   * @param {(ts:number)=>(number|null)} [opts.ambientFn] forecast ambient (°F) at
   *   a timestamp; when it returns a number the cooling law is grounded to the
   *   real outdoor forecast and the model learns only the tub's insulation loss.
   *   Returning null (or omitting it) falls back to the static prior ambient.
   */
  constructor({ store, ambientFn } = {}) {
    this.store = store || new JsonStore('thermal.json', { heat: emptySums(), cool: emptySums(), last: null });
    this.ambientFn = typeof ambientFn === 'function' ? ambientFn : () => null;
    const d = this.store.data;
    if (!d.heat) d.heat = emptySums();
    if (!d.cool) d.cool = emptySums();
    // Reset wall-clock-relative transient state on load. circSince/last/offFrom
    // only mean anything relative to a continuously-running clock; after a restart
    // the persisted timestamps are stale, and trusting them would mark a freshly
    // resumed, physically-unsettled sensor as "settled" (defeating the settle
    // gate) or bank a bogus rate across the downtime. The learned heat/cool sums
    // ARE valid across restarts and are kept; lastReliable is kept (it only
    // projects cooling forward, which errs safely cold).
    d.circSince = null;
    d.last = null;
    d.offFrom = null;
  }

  /** Forecast ambient at `ts`, falling back to the static prior when unknown. */
  _ambientAt(ts) {
    const a = this.ambientFn(ts);
    return Number.isFinite(a) ? a : PRIOR.cool.ambient;
  }

  /**
   * Feed a reading with the heater state AND whether the pump is circulating.
   * Only settled, circulating readings are trusted:
   *  - continuous circulation + heater on  -> heating-rate observation
   *  - continuous circulation + heater off  -> cooling-rate observation
   *  - a settled reading right after an off period -> one cooling observation
   *    across the whole off gap (settle-to-settle delta), since stagnant off-time
   *    readings are unusable.
   * Returns true when a learning observation was recorded.
   */
  observe(tempF, heatOn, circulating, now) {
    const d = this.store.data;

    if (!circulating) {
      // Pump off -> stagnant sensor. Bank the last trustworthy temp as the start
      // of a cooling gap and stop learning until circulation resumes and settles.
      if (d.lastReliable && !d.offFrom) d.offFrom = { ...d.lastReliable };
      d.circSince = null;
      d.last = null; // break any continuous streak
      this.store.save();
      return false;
    }

    if (d.circSince == null) d.circSince = now;
    if (now - d.circSince < SETTLE_MS) {
      this.store.save(); // still settling — don't trust the reading yet
      return false;
    }

    let learned = false;
    if (d.offFrom) {
      // First settled reading after an off period: one cooling observation across
      // the gap (the heater was off, so this captures overnight/coast cooling).
      const dtH = (now - d.offFrom.t) / 3_600_000;
      const dT = tempF - d.offFrom.T;
      if (dtH >= MIN_DT_HOURS && Math.abs(dT) >= MIN_DTEMP) {
        // Regress rate against the driving ΔT (T − ambient) so we learn the loss
        // coefficient alone; ambient comes from the forecast at the gap midpoint.
        const amb = this._ambientAt((d.offFrom.t + now) / 2);
        add(d.cool, (tempF + d.offFrom.T) / 2 - amb, dT / dtH);
        learned = true;
      }
      d.offFrom = null;
      d.last = { t: now, T: tempF, heat: !!heatOn };
    } else {
      const last = d.last;
      if (last && last.heat === !!heatOn) {
        const dtH = (now - last.t) / 3_600_000;
        const dT = tempF - last.T;
        if (dtH >= MIN_DT_HOURS && Math.abs(dT) >= MIN_DTEMP) {
          const meanT = (tempF + last.T) / 2;
          const rate = dT / dtH;
          if (heatOn) {
            add(d.heat, meanT, rate); // heating: learn loss + equilibrium (teq)
          } else {
            const amb = this._ambientAt((last.t + now) / 2);
            add(d.cool, meanT - amb, rate); // cooling: learn loss vs (T − ambient)
          }
          d.last = { t: now, T: tempF, heat: !!heatOn };
          learned = true;
        }
      } else {
        d.last = { t: now, T: tempF, heat: !!heatOn };
      }
    }
    d.lastReliable = { t: now, T: tempF };
    this.store.save();
    return learned;
  }

  /**
   * Best estimate of the current bulk temperature. If the pump is circulating and
   * settled the raw reading is trusted; otherwise the last trustworthy reading is
   * projected forward with the cooling model (so a stale, stagnant sensor value
   * can't fool the planner into starting late).
   */
  estimateTemp(rawTemp, circulating, now) {
    const d = this.store.data;
    const reliable = circulating && d.circSince != null && now - d.circSince >= SETTLE_MS;
    if (reliable || !d.lastReliable) return { tempF: rawTemp, reliable: !!reliable };
    const T = this.projectCool(d.lastReliable.T, d.lastReliable.t, now);
    return { tempF: Math.round(T), reliable: false };
  }

  /**
   * Project a temperature forward under the cooling law from `fromTs` to `toTs`,
   * integrating hour-by-hour so a *time-varying* forecast ambient is honoured
   * (an overnight projection follows the night's actual temperature dip and
   * morning rise). Falls back to a constant prior ambient when no forecast.
   */
  projectCool(fromTemp, fromTs, toTs) {
    const { loss } = this.coolParams(fromTs);
    const STEP = 3_600_000;
    // A projection over more than ~2 days is meaningless (the tub has long since
    // reached ambient) and, after a long outage, fromTs can be far in the past —
    // clamp the window so we never walk thousands of hourly steps.
    const end = Math.min(toTs, fromTs + 48 * STEP);
    let T = fromTemp;
    let t = fromTs;
    let guard = 0;
    while (t < end && guard++ < 100_000) {
      const dt = Math.min(STEP, end - t);
      const amb = this._ambientAt(t + dt / 2);
      T = amb + (T - amb) * Math.exp(-loss * (dt / 3_600_000));
      t += dt;
    }
    return T;
  }

  /** Learned (or prior) heating parameters: { loss (per hr), teq (°F) }. */
  heatParams() {
    const s = this.store.data.heat;
    const r = regress(s);
    if (s.n >= MIN_SAMPLES && r && r.slope < 0) {
      const loss = -r.slope;
      const teq = r.intercept / loss;
      if (loss > 0.01 && teq > 90 && teq < 140) return { loss, teq };
    }
    return { ...PRIOR.heat };
  }

  /**
   * Cooling parameters: { loss (per hr), ambient (°F) }. `loss` is learned from a
   * through-origin fit of cooling rate against the driving ΔT (T − ambient), so
   * it isolates the tub's insulation — a season-stable property. `ambient` is NOT
   * learned: it comes from the forecast at `atTs` (or the static prior when no
   * forecast/timestamp is available).
   */
  coolParams(atTs) {
    const s = this.store.data.cool;
    let loss = PRIOR.cool.loss;
    if (s.n >= MIN_SAMPLES && s.xx > 1e-9) {
      const l = -(s.xy / s.xx); // through-origin slope of rate vs (T − ambient)
      if (l > 0.005 && l < 1) loss = l;
    }
    const forecast = atTs != null ? this.ambientFn(atTs) : null;
    const ambient = Number.isFinite(forecast) ? forecast : PRIOR.cool.ambient;
    return { loss, ambient };
  }

  /**
   * Hours of continuous heating to go from `fromF` to `toF`. Returns 0 if already
   * at/above target, or Infinity if the target is above the heating equilibrium
   * (the pump can't reach it under current conditions).
   */
  hoursToHeat(fromF, toF) {
    if (toF <= fromF) return 0;
    const { loss, teq } = this.heatParams();
    if (teq <= toF) return Infinity;
    return (1 / loss) * Math.log((teq - fromF) / (teq - toF));
  }

  /** Sample counts, for diagnostics. */
  stats() {
    return { heatSamples: this.store.data.heat.n, coolSamples: this.store.data.cool.n };
  }
}
