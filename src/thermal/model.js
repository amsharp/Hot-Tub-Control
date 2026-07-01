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
const PRIOR = {
  heat: { loss: 0.2, teq: 106 }, // ~8h from 95->104 °F
  cool: { loss: 0.12, ambient: 62 },
};
const MIN_SAMPLES = 8; // observations before trusting a learned regression
const MIN_DT_HOURS = 1 / 6; // ignore intervals < 10 min
const MIN_DTEMP = 1; // require >= 1 °F change (the pump reports whole degrees)

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
   * Feed a temperature reading with the current heater state. Accumulates a
   * learning observation once enough time/temperature has passed (to beat the
   * pump's 1 °F quantization). Returns true when an observation was recorded.
   */
  observe(tempF, heatOn, now) {
    const d = this.store.data;
    const last = d.last;
    // Reset the baseline whenever the heater state flips (rates aren't comparable
    // across a transition) or on the very first reading.
    if (!last || last.heat !== !!heatOn) {
      d.last = { t: now, T: tempF, heat: !!heatOn };
      this.store.save();
      return false;
    }
    const dtH = (now - last.t) / 3_600_000;
    const dT = tempF - last.T;
    if (dtH >= MIN_DT_HOURS && Math.abs(dT) >= MIN_DTEMP) {
      add(heatOn ? d.heat : d.cool, (tempF + last.T) / 2, dT / dtH);
      d.last = { t: now, T: tempF, heat: !!heatOn };
      this.store.save();
      return true;
    }
    // Not enough change yet — keep the baseline and accumulate.
    return false;
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
