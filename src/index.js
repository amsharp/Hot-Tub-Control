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
import { History } from './history.js';
import { ThermalModel } from './thermal/model.js';
import { SmartHeatPlanner } from './thermal/planner.js';

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

  // Rolling hourly temperature history for the widget/HUD chart.
  const history = new History();

  // Self-calibrating heat model + smart pre-heat planner.
  const model = new ThermalModel();
  const planner = new SmartHeatPlanner({
    model,
    targetF: config.smartHeat.targetF,
    targetMin: config.smartHeat.targetMin,
    peaks: config.smartHeat.peaks,
    safetyMin: config.smartHeat.safetyMin,
  });
  let lastPlan = null;

  function localNow() {
    const d = new Date(); // container TZ (set TZ=America/Los_Angeles)
    return {
      min: d.getHours() * 60 + d.getMinutes(),
      day: d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(),
    };
  }

  async function runSmartHeat(status, tempF) {
    const { min, day } = localNow();
    const p = planner.plan(tempF, min, day);
    lastPlan = { ...p, currentTemp: tempF, nowMin: min, at: Date.now() };
    if (p.heat === true && !status.heat) {
      log.info(
        `SmartHeat -> ON (${p.reason}); ~${Number.isFinite(p.needHours) ? p.needHours.toFixed(1) + 'h' : 'max'} to reach ${p.targetF}F`,
      );
      await client.setTargetTemperature(config.smartHeat.targetF, 'F');
      await client.setHeating(true);
    } else if (p.heat === false && status.heat) {
      log.info(`SmartHeat -> OFF (${p.reason})`);
      await client.setHeating(false);
    }
  }

  // Called on every status read: enforce unit, log history, learn the heat
  // model, and run the smart pre-heat controller.
  async function onStatus(status) {
    await enforceUnit(status);
    const tempF =
      status.currentTemp == null
        ? null
        : status.unit === 'C'
          ? Math.round((status.currentTemp * 9) / 5 + 32)
          : status.currentTemp;
    try {
      history.record(status);
    } catch (err) {
      log.warn('History record failed:', err.message);
    }
    if (tempF != null) {
      try {
        model.observe(tempF, status.heat, Date.now());
      } catch (err) {
        log.warn('Thermal observe failed:', err.message);
      }
      if (config.smartHeat.enabled) {
        try {
          await runSmartHeat(status, tempF);
        } catch (err) {
          log.warn('SmartHeat failed:', err.message);
        }
      }
    }
  }

  const getPlan = () => ({
    enabled: config.smartHeat.enabled,
    targetF: config.smartHeat.targetF,
    targetMin: config.smartHeat.targetMin,
    peaks: config.smartHeat.peaks,
    plan: lastPlan,
    model: { heat: model.heatParams(), cool: model.coolParams(), ...model.stats() },
  });

  // Keep the pump pinned to the preferred display unit (a power-cycle resets it
  // to Celsius). Fires on startup and on every watchdog cycle.
  async function enforceUnit(status) {
    if (!config.bestway.enforceUnit || !status) return;
    if (status.unit !== config.bestway.enforceUnit) {
      log.info(`Pump display unit is ${status.unit}; enforcing ${config.bestway.enforceUnit}.`);
      try {
        await client.setDisplayUnit(config.bestway.enforceUnit);
      } catch (err) {
        log.warn('Could not enforce display unit:', err.message);
      }
    }
  }

  const watchdog = new FaultWatchdog({
    client,
    autoClear: config.watchdog.autoClear,
    intervalMs: config.watchdog.intervalMs,
    maxAttempts: config.watchdog.maxAttempts,
    cooldownMs: config.watchdog.cooldownMs,
    onRecovered: (status) => reportState(status),
    onStatus,
  });

  const app = createServer({ client, scheduler, watchdog, history, getPlan });

  // Everything below talks to the pump, so it only runs once credentials exist.
  if (hasBestwayCreds) {
    // Verify we can reach the pump before claiming we're up (non-fatal).
    try {
      const status = await client.getStatus();
      log.info('Connected to spa:', status.name, `(${status.deviceId})`);
      await onStatus(status);
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
