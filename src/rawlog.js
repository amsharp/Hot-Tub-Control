// RawLog — a rolling capture of the pump's raw Gizwits attributes plus its
// power/heat/filter state, for reverse-engineering the undocumented registers.
//
// Motivation: the Airjet's flow sensor is a binary paddle switch (E01/E02), so
// it can't report *degrading* flow. But the pump exposes extra temperature-like
// registers (a reading just above water temp that looks like the heater
// element/outlet, and one below it that looks like the inlet). While the heater
// fires at fixed power, the rise across it ΔT = P/(ṁ·c) is inversely
// proportional to flow — so (outlet − inlet) is a continuous flow proxy that
// widens as the filter clogs, well before E02 ever trips.
//
// This log records the candidate registers across every pump state so those
// fields can be decoded (which is inlet vs element) and the flow proxy
// calibrated. It is diagnostic-only and does not gate any control decision.
import { JsonStore } from './store.js';

const MAX_RAW = 2500; // ~3.5 days at a 2-min watchdog cadence

function nums(raw, prefix, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(raw[`${prefix}${i}`] ?? null);
  return out;
}

export class RawLog {
  /** @param {object} [opts] @param {JsonStore} [opts.store] injectable for tests */
  constructor({ store } = {}) {
    this.store = store || new JsonStore('rawlog.json', { samples: [] });
    if (!Array.isArray(this.store.data.samples)) this.store.data.samples = [];
  }

  /**
   * Append one sample from a status read. Captures the state (power/heat/filter/
   * wave), the water temp, and the raw word/option registers — every cycle and
   * every state (we WANT off/on and heat-firing/idle transitions to decode the
   * registers), so this is intentionally not gated on sensor-settle.
   */
  record(status, now = Date.now()) {
    if (!status || !status.raw) return null;
    const r = status.raw;
    const sample = {
      t: now,
      st: [r.power ?? null, r.heat ?? null, r.filter ?? null, r.wave ?? null],
      T: r.Tnow ?? null,
      word: nums(r, 'word', 8),
      opt: nums(r, 'option', 8),
      // bit2..bit7 flags — undecoded; one may be the live flow-paddle state,
      // which would give a real-time flow-OK bit (and possible pre-E02
      // flutter). Captured across states to decode against events.
      bit: [r.bit2 ?? null, r.bit3 ?? null, r.bit4 ?? null, r.bit5 ?? null, r.bit6 ?? null, r.bit7 ?? null],
    };
    const arr = this.store.data.samples;
    arr.push(sample);
    while (arr.length > MAX_RAW) arr.shift();
    this.store.save();
    return sample;
  }

  list() {
    return this.store.data.samples;
  }
}
