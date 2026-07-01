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
  },

  homegraph: {
    serviceAccountFile: process.env.HOMEGRAPH_SERVICE_ACCOUNT_FILE || '',
    enabled: !!process.env.HOMEGRAPH_SERVICE_ACCOUNT_FILE,
  },

  notify: {
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL || '',
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
