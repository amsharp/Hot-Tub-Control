// TouSchedule — SCE TOU-D-PRIME time-of-use electricity pricing.
//
// Structure:
//   Summer (Jun 1 - Sep 30):  on-peak 4-9 PM weekdays, mid-peak 4-9 PM
//                             weekends, off-peak all other hours.
//   Winter (Oct 1 - May 31):  mid-peak 4-9 PM every day, super-off-peak
//                             8 AM - 4 PM, off-peak 9 PM - 8 AM.
// The winter super-off-peak window (8 AM-4 PM) is exactly when the smart-heat
// pre-heat runs, so most winter consumption lands on the cheapest rate.
//
// Rates are bundled totals ($/kWh); override any of them via env. The fixed
// daily basic charge and the baseline credit are intentionally NOT modeled —
// the basic charge accrues regardless of the tub, and the credit shifts the
// average (not marginal) price; we care about the marginal cost of tub energy.
const HOUR = { PEAK_START: 16, PEAK_END: 21, SOFF_START: 8 }; // 4-9 PM, 8 AM

export class TouSchedule {
  /**
   * @param {object} rates $/kWh by period
   * @param {number} rates.summerOn     summer 4-9 PM weekdays
   * @param {number} [rates.summerMid]  summer 4-9 PM weekends (defaults to summerOn)
   * @param {number} rates.summerOff    summer all other hours
   * @param {number} rates.winterMid    winter 4-9 PM
   * @param {number} rates.winterSoff   winter 8 AM - 4 PM
   * @param {number} rates.winterOff    winter 9 PM - 8 AM
   */
  constructor(rates) {
    this.rates = rates;
  }

  /** Season for a local Date: summer = June-September. */
  isSummer(d) {
    const m = d.getMonth() + 1;
    return m >= 6 && m <= 9;
  }

  /** Bundled $/kWh at a local Date (defaults to now). */
  rateAt(d = new Date()) {
    const h = d.getHours();
    const inPeakWindow = h >= HOUR.PEAK_START && h < HOUR.PEAK_END;
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const r = this.rates;
    if (this.isSummer(d)) {
      if (!inPeakWindow) return r.summerOff;
      return weekend ? (r.summerMid ?? r.summerOn) : r.summerOn;
    }
    if (inPeakWindow) return r.winterMid;
    if (h >= HOUR.SOFF_START && h < HOUR.PEAK_START) return r.winterSoff;
    return r.winterOff;
  }

  /** Human label for the period at a local Date (for display/diagnostics). */
  periodAt(d = new Date()) {
    const h = d.getHours();
    const inPeakWindow = h >= HOUR.PEAK_START && h < HOUR.PEAK_END;
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    if (this.isSummer(d)) {
      if (!inPeakWindow) return 'summer off-peak';
      return weekend ? 'summer mid-peak (weekend)' : 'summer on-peak';
    }
    if (inPeakWindow) return 'winter mid-peak';
    if (h >= HOUR.SOFF_START && h < HOUR.PEAK_START) return 'winter super-off-peak';
    return 'winter off-peak';
  }
}
