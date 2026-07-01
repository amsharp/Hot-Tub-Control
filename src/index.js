// Entry point: wires the Bestway client, scheduler and HTTP server together and
// starts listening. This is the process you deploy behind HTTPS for Google.
import { config } from './config.js';
import { log } from './log.js';
import { BestwayClient } from './bestway/client.js';
import { Scheduler } from './scheduler/scheduler.js';
import { FaultWatchdog } from './recovery/watchdog.js';
import { GizwitsRealtime } from './bestway/realtime.js';
import { createServer } from './server.js';
import { reportState, requestSync } from './google/homegraph.js';

async function main() {
  // Degraded-boot contract: the HTTP server (and /healthz) must come up even
  // when the owner-only Bestway credentials aren't configured yet (e.g. a fresh
  // Railway deploy). Without creds we skip the pump-dependent background loops
  // instead of crash-looping, so the platform healthcheck still goes green.
  const hasBestwayCreds = Boolean(config.bestway.username && config.bestway.password);
  if (!hasBestwayCreds) {
    log.warn(
      'BESTWAY_USERNAME/BESTWAY_PASSWORD not set — starting in degraded mode: ' +
        'HTTP server and /healthz only, pump control/scheduling/watchdog disabled ' +
        'until credentials are configured.',
    );
  }

  const client = new BestwayClient({
    username: config.bestway.username,
    password: config.bestway.password,
    region: config.bestway.region,
    deviceId: config.bestway.deviceId,
  });

  const scheduler = new Scheduler({
    client,
    onAfterAction: (status) => reportState(status),
  });

  const watchdog = new FaultWatchdog({
    client,
    autoClear: config.watchdog.autoClear,
    intervalMs: config.watchdog.intervalMs,
    maxAttempts: config.watchdog.maxAttempts,
    cooldownMs: config.watchdog.cooldownMs,
    onRecovered: (status) => reportState(status),
  });

  const app = createServer({ client, scheduler, watchdog });

  // Everything below talks to the pump, so it only runs once credentials exist.
  if (hasBestwayCreds) {
    // Verify we can reach the pump before claiming we're up (non-fatal).
    try {
      const status = await client.getStatus();
      log.info('Connected to spa:', status.name, `(${status.deviceId})`);
    } catch (err) {
      log.warn('Could not read spa status on startup:', err.message);
    }

    scheduler.start();
    watchdog.start();

    // Real-time fault reaction via the Gizwits push socket (optional, best-effort).
    if (config.watchdog.realtime) {
      const realtime = new GizwitsRealtime({
        client,
        onAttrs: (_did, attrs) => watchdog.handleRealtimeAttrs(attrs),
      });
      realtime.start().catch((err) => log.warn('Real-time listener failed to start:', err.message));
    }

    // Ask Google to re-sync devices on boot (no-op if Home Graph not configured).
    requestSync().catch(() => {});
  }

  app.listen(config.port, () => {
    log.info(`Hot-Tub-Control listening on :${config.port}`);
    if (config.publicBaseUrl) {
      log.info(`Fulfillment URL:  ${config.publicBaseUrl}/fulfillment`);
      log.info(`OAuth authorize:  ${config.publicBaseUrl}/oauth/authorize`);
      log.info(`OAuth token:      ${config.publicBaseUrl}/oauth/token`);
    }
  });
}

main().catch((err) => {
  log.error('Fatal:', err.stack || err.message);
  process.exit(1);
});
