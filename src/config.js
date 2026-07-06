// Loads configuration from environment variables (and a local .env file if
// present). No external dotenv dependency — we parse .env ourselves so the
// project stays lean.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

function loadDotEnv() {
  const envPath = join(projectRoot, '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Existing real env vars win over the .env file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

// Parse "HH:MM" into minutes-of-day; returns fallback if malformed.
function hhmm(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return fallback;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return min >= 0 && min < 1440 ? min : fallback;
}

// Parse "16:00-21:00,06:00-09:00" into [{start,end}] minutes-of-day windows.
function peaks(value, fallback) {
  const out = [];
  for (const part of String(value || '').split(',')) {
    const [a, b] = part.split('-');
    const start = hhmm(a, null);
    const end = hhmm(b, null);
    if (start != null && end != null) out.push({ start, end });
  }
  return out.length ? out : fallback;
}

export const config = {
  projectRoot,
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  displayUnit: (process.env.DISPLAY_UNIT || 'C').toUpperCase() === 'F' ? 'F' : 'C',

  bestway: {
    username: process.env.BESTWAY_USERNAME || '',
    password: process.env.BESTWAY_PASSWORD || '',
    region: (process.env.BESTWAY_REGION || 'eu').toLowerCase(),
    deviceId: process.env.BESTWAY_DEVICE_ID || '',
    // Keep the pump pinned to this display unit ("F" | "C"). A mains power-cycle
    // resets the pump to Celsius; when set, the service flips it back on startup
    // and on every watchdog cycle. Leave empty to leave the pump's unit alone.
    enforceUnit:
      (process.env.ENFORCE_UNIT || '').toUpperCase() === 'F'
        ? 'F'
        : (process.env.ENFORCE_UNIT || '').toUpperCase() === 'C'
          ? 'C'
          : null,
  },

  oauth: {
    clientId: process.env.OAUTH_CLIENT_ID || '',
    clientSecret: process.env.OAUTH_CLIENT_SECRET || '',
    linkUsername: process.env.LINK_USERNAME || 'owner',
    linkPassword: process.env.LINK_PASSWORD || '',
    // Allowed redirect_uri origins for the OAuth flow. Any redirect_uri whose
    // origin isn't listed is rejected, so a crafted authorize link can't exfil
    // an auth code to an attacker host. Defaults to Google's account-linking
    // origins; override (comma-separated) with OAUTH_REDIRECT_ALLOWLIST.
    redirectAllowlist: (
      process.env.OAUTH_REDIRECT_ALLOWLIST ||
      'https://oauth-redirect.googleusercontent.com,https://oauth-redirect-sandbox.googleusercontent.com'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  homegraph: {
    serviceAccountFile: process.env.HOMEGRAPH_SERVICE_ACCOUNT_FILE || '',
    enabled: !!process.env.HOMEGRAPH_SERVICE_ACCOUNT_FILE,
  },

  notify: {
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL || '',
  },

  // Smart pre-heat: model the tub's heat/cool rates and turn the heater on at
  // the latest off-peak time that still reaches targetF by targetMin, never
  // heating during a peak window.
  smartHeat: {
    enabled: bool(process.env.SMART_HEAT_ENABLED, false),
    targetF: Number(process.env.SMART_HEAT_TARGET_F) || 104,
    targetMin: hhmm(process.env.SMART_HEAT_BY, 16 * 60), // default 4:00 PM
    peaks: peaks(process.env.SMART_HEAT_PEAK, [{ start: 16 * 60, end: 21 * 60 }]), // default 4-9 PM
    safetyMin: Number(process.env.SMART_HEAT_SAFETY_MIN) || 45,
  },

  // Forecast-grounded ambient temperature. When a location is set, the thermal
  // model uses the real hourly outdoor forecast (Open-Meteo, no API key) as the
  // ambient in its cooling law instead of a static guess — so overnight cooling
  // is predicted from the actual weather, and the model learns only the tub's
  // insulation loss (which is season-stable). Unset lat/lon -> falls back to the
  // static prior ambient (behaves as before).
  weather: {
    lat:
      process.env.WEATHER_LAT !== undefined && process.env.WEATHER_LAT !== ''
        ? Number(process.env.WEATHER_LAT)
        : null,
    lon:
      process.env.WEATHER_LON !== undefined && process.env.WEATHER_LON !== ''
        ? Number(process.env.WEATHER_LON)
        : null,
    get enabled() {
      return Number.isFinite(this.lat) && Number.isFinite(this.lon);
    },
    refreshMin: Number(process.env.WEATHER_REFRESH_MIN) || 120,
  },

  // Software energy estimate (the pump has no meter). Grounded to the US 120V
  // Airjet NAMEPLATE (Coleman SaluSpa 90467E: 110-120V, 12A total, at 20°C):
  //   Heat element 11.3A -> ~1356W cold. PTC ceramic droops when hot, so 1320W
  //     is a fair operating average. Only counted while heat=3 (element firing).
  //   Water pump 0.7A -> ~84W wall draw (drives the 12V/50W DC circ pump via its
  //     PSU). ~60W is a conservative running value; it dominates the non-heating
  //     baseline, so it was the meaningful correction (was 40W ≈ half nameplate).
  //   Massage blower 6.5A -> ~780W. Mutually exclusive with the heater (11.3+6.5
  //     = 17.8A would exceed the 12A circuit), so it's never summed with it.
  //   Idle/standby ~5W: WiFi module + MCU + display + 12V PSU quiescent draw,
  //     always on while plugged in (no nameplate line for it — this is the least
  //     certain of the four; a Kill-A-Watt on "everything off" would pin it). It
  //     is the sole draw during idle/coast/overnight hours, so it matters for
  //     the baseline even though it's small.
  energy: {
    heaterW: Number(process.env.ENERGY_HEATER_W) || 1320,
    pumpW: Number(process.env.ENERGY_PUMP_W) || 60,
    blowerW: Number(process.env.ENERGY_BLOWER_W) || 780,
    idleW: Number(process.env.ENERGY_IDLE_W) || 5,
    rate: Number(process.env.ELECTRICITY_RATE) || 0.4, // $/kWh fallback (TOU disabled)
    ratePeak: Number(process.env.ELECTRICITY_RATE_PEAK) || 0, // $/kWh during peak (0 = same as rate)
    // SCE TOU-D-PRIME time-of-use pricing, bundled $/kWh as published on
    // sce.com's residential TOU rate-plans page (June 2026 tariff; SCE rounds
    // to whole cents there). PRIME has no baseline credit, so these ARE the
    // effective marginal prices. The $0.79/day Base Services Charge is not
    // modeled — it accrues with or without the tub. On by default; set
    // TOU_ENABLED=false to fall back to the flat rate/ratePeak pair; override
    // any single period via env.
    tou: {
      enabled: bool(process.env.TOU_ENABLED, true),
      summerOn: Number(process.env.TOU_SUMMER_ON) || 0.59, // Jun-Sep 4-9 PM weekdays
      summerMid: Number(process.env.TOU_SUMMER_MID) || 0.4, // Jun-Sep 4-9 PM weekends
      summerOff: Number(process.env.TOU_SUMMER_OFF) || 0.26, // Jun-Sep all other hours
      winterMid: Number(process.env.TOU_WINTER_MID) || 0.56, // Oct-May 4-9 PM
      winterSoff: Number(process.env.TOU_WINTER_SOFF) || 0.24, // Oct-May 8 AM-4 PM
      winterOff: Number(process.env.TOU_WINTER_OFF) || 0.24, // Oct-May 9 PM-8 AM
    },
  },

  watchdog: {
    // Auto-clear transient low-flow (E02) faults by restarting circulation.
    autoClear: bool(process.env.AUTO_CLEAR_LOW_FLOW, true),
    // Poll fairly often so a fault (and its repeated beeping) is caught quickly.
    intervalMs: (Number(process.env.WATCHDOG_INTERVAL_MIN) || 2) * 60_000,
    maxAttempts: Number(process.env.WATCHDOG_MAX_ATTEMPTS) || 3,
    cooldownMs: (Number(process.env.WATCHDOG_COOLDOWN_MIN) || 15) * 60_000,
    // React to faults in real time via the Gizwits push WebSocket (falls back
    // to polling if the socket can't connect).
    realtime: bool(process.env.REALTIME_ENABLED, true),
  },

  // Where runtime state (OAuth tokens, schedules) lives. On hosts with an
  // ephemeral filesystem (Railway, Fly, etc.) point DATA_DIR at a mounted
  // persistent volume so links and schedules survive redeploys.
  dataDir: process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(projectRoot, 'data'),
  verbose: bool(process.env.VERBOSE, false),
};

/**
 * Throws if required config for a given subsystem is missing. Lets the CLI and
 * server fail fast with a helpful message instead of a cryptic API error.
 */
export function requireBestwayConfig() {
  const missing = [];
  if (!config.bestway.username) missing.push('BESTWAY_USERNAME');
  if (!config.bestway.password) missing.push('BESTWAY_PASSWORD');
  if (missing.length) {
    throw new Error(
      `Missing required configuration: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill it in.',
    );
  }
}
