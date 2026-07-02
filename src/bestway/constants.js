// Constants for the Bestway cloud API, which is built on the Gizwits IoT
// platform. These values were derived from the community Home Assistant
// integration (github.com/cdpuk/ha-bestway) and the Gizwits app protocol.
//
// If a key name turns out to be wrong for your specific firmware, run
// `npm run cli -- dump` to print the raw attribute dictionary your pump
// reports, then adjust AIRJET_PROFILE.attrs below to match.

// The Gizwits "application id" the Bestway Smart Hub app authenticates with.
export const GIZWITS_APP_ID = '98754e684ec045528b073876c34c7348';

// Regional API roots. Pick via BESTWAY_REGION ("eu" | "us").
export const API_ROOTS = {
  eu: 'https://euapi.gizwits.com',
  us: 'https://usapi.gizwits.com',
};

export function apiRootForRegion(region) {
  return API_ROOTS[region] || API_ROOTS.eu;
}

// Attribute profile for the WiFi "Airjet" pump on the Gizwits backend. The
// `attrs` map translates our internal field names to the raw Gizwits attribute
// keys used in /devdata and /control payloads.
//
// Verified against a live `Airjet_V01` pump ("Cedar Tub"): this firmware uses
// short keys (Tnow/Tset/Tunit/heat/filter/wave/power), NOT the longer
// temp_now/temp_set/heat_power/... keys some older docs list.
//
// The display unit lives in `Tunit`, but INVERTED from the usual convention on
// this firmware: Tunit=0 -> Fahrenheit, Tunit=1 -> Celsius (verified live —
// Tunit=0 read Tnow=102/Tset=104 °F; Tunit=1 read Tnow=39/Tset=40 °C). Tnow/Tset
// are always in the active unit; `tempUnitValues` maps our unit name to the raw
// Tunit value so we can both read and *write* it (a power-cycle resets it to C).
export const AIRJET_PROFILE = {
  productName: 'Airjet_V01',
  tempUnitValues: { F: 0, C: 1 }, // raw Tunit value for each unit (this firmware)
  // Undocumented registers — DECODED via the 2026-07-02 valve-throttle trial:
  //   word2/word5 = runtime counter, MINUTES since power-on (resets to 0 at
  //                 mains/app power-off; ticks 1/min). NOT a temperature — the
  //                 earlier "inlet ÷10 °C" reading was this counter coinciding
  //                 with plausible values.
  //   word7       = the water temperature sensor in °C; Tnow is its rounded °F
  //                 twin (Tnow = round(word7*9/5+32) matched every sample).
  //   No register behaves as a downstream/outlet temperature: with the return
  //   valve heavily throttled and the element firing, all temps stayed pinned
  //   to incoming-water values until the E02 paddle dropped (binary, hard
  //   latch, ~zero warning). There is NO analog flow signal on this hardware.
  attrs: {
    currentTemp: 'Tnow', // current water temperature (integer, °F on V01)
    targetTemp: 'Tset', // target temperature (integer, °F on V01)
    tempUnit: 'Tunit', // display-unit flag (see tempUnitValues: 0=F, 1=C on V01)
    power: 'power', // pump unit power 0/1
    heat: 'heat', // heater 0/1
    filter: 'filter', // filter/circulation pump 0/1
    bubbles: 'wave', // bubble massage (AirJet) 0/1
    locked: 'locked', // child lock 0/1 (not exposed on V01 → undefined/false)
  },
  on: 1,
  off: 0,
  // Safe target-temperature limits for an Airjet spa, in each unit.
  tempRange: {
    C: { min: 20, max: 40 },
    F: { min: 68, max: 104 },
  },
};

// Product names that we recognise as a spa we can drive with AIRJET_PROFILE.
export const SPA_PRODUCT_NAMES = new Set(['Airjet', 'Airjet_V01']);

// Human-readable meanings for the common Lay-Z-Spa error codes.
export const ERROR_MEANINGS = {
  E01: 'Water flow sensor (flow paddle) fault',
  E02: 'Low water flow — circulation too low (often dirty filter / low water)',
  E03: 'Dry-fire / water temperature sensor fault',
  E04: 'Water temperature sensor fault',
  E05: 'Water over-temperature',
  E07: 'Heater / control fault',
  E09: 'Communication fault',
  earth: 'Ground (earth) fault detected',
};

// "E32" is not a fault — it signals the heater is on but the target has already
// been reached. We must never treat it as an error.
const NON_FAULT_CODES = new Set(['E32']);

// Faults we will attempt to clear automatically with a pump restart. E02
// (low flow) is the classic one that a circulation restart often clears.
export const AUTO_CLEARABLE_CODES = new Set(['E02']);

/**
 * Scan a raw attribute dictionary for active faults.
 * @returns {{code:string,meaning:string,autoClearable:boolean}[]}
 */
export function detectFaults(attr = {}) {
  const faults = [];
  for (const [key, value] of Object.entries(attr)) {
    const isErrorKey =
      /^E\d{2}$/.test(key) || /^system_err\d+$/.test(key) || key === 'earth';
    if (!isErrorKey) continue;
    if (NON_FAULT_CODES.has(key)) continue;
    if (!truthy(value)) continue;
    faults.push({
      code: key,
      meaning: ERROR_MEANINGS[key] || 'Unknown fault',
      autoClearable: AUTO_CLEARABLE_CODES.has(key),
    });
  }
  return faults;
}

function truthy(v) {
  return v === 1 || v === '1' || v === true;
}
