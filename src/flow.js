// FlowModel — estimate the circulation flow rate from the heater energy balance.
//
// While the element fires at (roughly) constant electrical power P, the water's
// temperature rise across the heater is ΔT = P / (ṁ·c). So the mass flow is
// ṁ = P / (c·ΔT) and the volumetric flow Q = ṁ/ρ. We read the inlet and outlet
// temperatures from the pump's extra registers (decoded empirically). The
// estimate is only valid while the heater is actively firing (heat=3) and the
// pump circulates — otherwise there's no known heat input to divide by, so flow
// is reported unavailable (we keep the last good reading for display).
//
// Heater power P should be anchored to the model's nameplate; the register→temp
// mapping is configurable because it was decoded empirically — correcting either
// is an env change, not a code change.
const C_WATER_J = 4186; // specific heat of water, J/(kg·°C)
const RHO = 1.0; // water density, kg/L

const round1 = (v) => Math.round(v * 10) / 10;

export class FlowModel {
  /**
   * @param {object} [opts]
   * @param {number} [opts.heaterW] element power while firing (W)
   * @param {{key:string,scale:number}} [opts.inlet] register + scale -> inlet °C
   * @param {{key:string,scale:number}} [opts.outlet] register + scale -> outlet °C
   * @param {number} [opts.minDeltaC] ignore ΔT below this (noise floor), °C
   */
  constructor({ heaterW = 1320, inlet = { key: 'word2', scale: 0.1 }, outlet = { key: 'word7', scale: 1 }, minDeltaC = 0.5 } = {}) {
    this.heaterW = heaterW;
    this.inlet = inlet;
    this.outlet = outlet;
    this.minDeltaC = minDeltaC;
    this.last = null; // { lpm, dTc, at } — most recent valid estimate
  }

  /** Inlet/outlet temps in °C from a raw attribute dict, or null if absent. */
  temps(raw) {
    const tin = raw[this.inlet.key];
    const tout = raw[this.outlet.key];
    if (tin == null || tout == null) return null;
    return { inC: Number(tin) * this.inlet.scale, outC: Number(tout) * this.outlet.scale };
  }

  /**
   * Estimate flow (L/min) from a status snapshot. Returns:
   *   { lpm, dTc, inC, outC, firing, pumpOn, reliable, last }
   * `lpm` is null when not measurable (heater idle / no flow / ΔT below floor);
   * `last` carries the most recent valid reading for continuity on the widget.
   */
  compute(status, now = Date.now()) {
    const raw = (status && status.raw) || {};
    const firing = Number(raw.heat) >= 3;
    const pumpOn = !!(status && status.filter) || Number(raw.filter) > 0;
    const t = this.temps(raw);
    const base = { lpm: null, dTc: t ? round1(t.outC - t.inC) : null, firing, pumpOn, reliable: false, last: this.last };
    if (!firing || !pumpOn || !t) return base;

    const dTc = t.outC - t.inC;
    if (!(dTc > this.minDeltaC)) return { ...base, dTc: round1(dTc) };

    // ṁ = P/(c·ΔT) [kg/s]; Q = ṁ/ρ [L/s]; ×60 -> L/min.
    const lpm = round1(((this.heaterW / (C_WATER_J * dTc)) / RHO) * 60);
    this.last = { lpm, dTc: round1(dTc), at: now };
    return { lpm, dTc: round1(dTc), inC: round1(t.inC), outC: round1(t.outC), firing, pumpOn, reliable: true, last: this.last };
  }
}
