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
  /** @param {object} [opts] @param {JsonStore} [opts.store] injectable for tests */
  constructor({ store } = {}) {
    this.store = store || new JsonStore('thermal.json', { heat: emptySums(), cool: emptySums(), last: null });
    const d = this.store.data;
    if (!d.heat) d.heat = emptySums();
    if (!d.cool) d.cool = emptySums();
    if (!('last' in d)) d.last = null;
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
        add(d.cool, (tempF + d.offFrom.T) / 2, dT / dtH);
        learned = true;
      }
      d.offFrom = null;
      d.last = { t: now, T: tempF, heat: !!heatOn };
    } else {
      const last = d.last;
      const sums = heatOn ? d.heat : d.cool;
      if (last && last.heat === !!heatOn) {
        const dtH = (now - last.t) / 3_600_000;
        const dT = tempF - last.T;
        if (dtH >= MIN_DT_HOURS && Math.abs(dT) >= MIN_DTEMP) {
          add(sums, (tempF + last.T) / 2, dT / dtH);
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
    const { loss, ambient } = this.coolParams();
    const dtH = Math.max(0, (now - d.lastReliable.t) / 3_600_000);
    const T = ambient + (d.lastReliable.T - ambient) * Math.exp(-loss * dtH);
    return { tempF: Math.round(T), reliable: false };
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

  /** Learned (or prior) cooling parameters: { loss (per hr), ambient (°F) }. */
  coolParams() {
    const s = this.store.data.cool;
    const r = regress(s);
    if (s.n >= MIN_SAMPLES && r && r.slope < 0) {
      const loss = -r.slope;
      const ambient = r.intercept / loss;
      if (loss > 0.005 && ambient > 20 && ambient < 100) return { loss, ambient };
    }
    return { ...PRIOR.cool };
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
