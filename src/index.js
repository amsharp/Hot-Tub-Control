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
import { EnergyMeter } from './energy.js';
import { WeatherProvider } from './weather.js';
import { TouSchedule } from './rates.js';
import { SmartHeatController } from './thermal/controller.js';
import { notify } from './notify/notifier.js';
import { JsonStore } from './store.js';
import { RawLog } from './rawlog.js';
import { PumpHealth } from './pumphealth.js';
import { StallMonitor } from './stallmonitor.js';
import { ensureCloudFailsafe, utcHHMMForLocalMin } from './failsafe.js';

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

  // Diagnostic raw-register capture (for decoding the pump's extra temperature
  // registers into a flow/filter-health proxy). Diagnostic only.
  const rawlog = new RawLog();

  // Filter/circulation health from the pump's only real signals: E02 event
  // rate + morning settle time. (The valve-throttle trial proved there is no
  // analog flow signal on this hardware — see src/pumphealth.js.)
  const pumpHealth = new PumpHealth();

  // Detects the "firing but not gaining heat" failure (cover off / low water /
  // restricted flow) — physical, so it can only warn, not fix.
  const stall = new StallMonitor({ notify: (t, m) => notify(t, m, { level: 'alert' }), log });

  // Software energy estimator, priced by the TOU-D-PRIME schedule when enabled
  // (falls back to the flat rate/ratePeak pair otherwise).
  const tou = config.energy.tou;
  const touSchedule =
    tou.enabled && tou.summerOn > 0 ? new TouSchedule(tou) : null;
  const meter = new EnergyMeter({
    watts: {
      heater: config.energy.heaterW,
      pump: config.energy.pumpW,
      blower: config.energy.blowerW,
      idle: config.energy.idleW,
    },
    rate: config.energy.rate,
    ratePeak: config.energy.ratePeak || config.energy.rate,
    rateFor: touSchedule ? (nowMs) => touSchedule.rateAt(new Date(nowMs)) : undefined,
  });

  // Forecast-grounded ambient temperature (Open-Meteo). Feeds the cooling model
  // so overnight cooling is predicted from the real weather; no-op if no location
  // is configured (the model then uses its static prior ambient).
  const weather = new WeatherProvider({
    lat: config.weather.lat,
    lon: config.weather.lon,
    refreshMin: config.weather.refreshMin,
  });

  // Self-calibrating heat model + smart pre-heat planner. The heater ceiling is
  // grounded in physics: maxHeatRate = P/C = heaterW / (litres × 0.646 Wh/kg°F),
  // so the model can never predict heating faster than m·c·ΔT/P allows.
  const kwhPerF = config.smartHeat.tubLiters * 0.000646;
  const maxHeatRate = config.energy.heaterW / 1000 / kwhPerF; // °F/hr
  const model = new ThermalModel({ ambientFn: weather.ambientFn(), maxHeatRate });
  const planner = new SmartHeatPlanner({
    model,
    targetF: config.smartHeat.targetF,
    targetMin: config.smartHeat.targetMin,
    peaks: config.smartHeat.peaks,
    safetyMin: config.smartHeat.safetyMin,
  });
  // Cloud-path liveness: stamped on every successful status read; a separate
  // monitor alerts (once per outage) when reads have been failing for a while.
  const pollHealth = { okAt: null, notified: false };

  // Hardened control loop: confirm-before-override, bounded command retries,
  // offline-skip. See src/thermal/controller.js.
  const controller = new SmartHeatController({
    client,
    planner,
    targetF: config.smartHeat.targetF,
    notify: (title, message) => notify(title, message, { level: 'alert' }),
    log,
    // Persist override/command state so a redeploy mid-evening doesn't forget
    // that the user overrode us (and start fighting them again).
    store: new JsonStore('controller.json', {}),
  });

  function localNow() {
    const d = new Date(); // container TZ (set TZ=America/Los_Angeles)
    return {
      min: d.getHours() * 60 + d.getMinutes(),
      day: d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(),
    };
  }

  // Called on every status read: enforce unit, log history, learn the heat
  // model, and run the smart pre-heat controller.
  async function onStatus(status) {
    await enforceUnit(status);
    const now = Date.now();
    pollHealth.okAt = now; // a status made it through — the cloud path works
    pollHealth.notified = false;
    let tempF =
      status.currentTemp == null
        ? null
        : status.unit === 'C'
          ? Math.round((status.currentTemp * 9) / 5 + 32)
          : status.currentTemp;

    // Plausibility guard: a glitched sensor reading (0, 999, ...) must not
    // poison the model, the chart, or the planner. Treat it as "no reading" —
    // the model then projects from its last reliable temperature.
    if (tempF != null && (tempF < 40 || tempF > 115)) {
      log.warn(`Implausible temperature reading ${tempF}F — ignoring this cycle.`);
      tempF = null;
    }

    // The temp sensor only reads true bulk temp while the pump circulates AND has
    // settled (a few minutes). Determine reliability ONCE, from the model, and let
    // it gate every downstream use so a stagnant/unsettled reading is never taken
    // as a real temperature.
    const circulating = !!status.filter;
    let est = { tempF, reliable: false };
    if (tempF != null) {
      try {
        model.observe(tempF, status.heat, circulating, now); // learns only when settled
      } catch (err) {
        log.warn('Thermal observe failed:', err.message);
      }
      est = model.estimateTemp(tempF, circulating, now); // reliable only when settled
    }

    // Only store/chart a temperature the pump has actually settled at. Unsettled
    // readings are skipped entirely (the chart shows a gap) rather than logging a
    // stale value that looks like a real dip.
    try {
      if (est.reliable) history.record(status, now);
    } catch (err) {
      log.warn('History record failed:', err.message);
    }

    // Raw-register capture runs every cycle in every state (diagnostic only).
    try {
      rawlog.record(status, now);
    } catch (err) {
      log.warn('Raw log failed:', err.message);
    }

    // Track filter/circulation health (E02 transitions + settle times).
    try {
      pumpHealth.onStatus({
        e02Active: (status.faults || []).some((f) => f.code === 'E02'),
        tempF,
        circulating: !!status.filter,
        now,
      });
    } catch (err) {
      log.warn('Pump health failed:', err.message);
    }

    // Stall detection: element firing (heat=3) but water not rising.
    try {
      stall.update({ firing: Number(status.raw && status.raw.heat) === 3, tempF: est.tempF, reliable: est.reliable, now });
    } catch (err) {
      log.warn('Stall monitor failed:', err.message);
    }

    if (tempF != null && config.smartHeat.enabled) {
      try {
        const { min, day } = localNow();
        await controller.onCycle(status, est.tempF, est.reliable, { nowMs: now, min, day });
      } catch (err) {
        log.warn('SmartHeat failed:', err.message);
      }
    }

    // Energy accounting last, so peak/override context reflects this cycle.
    try {
      const { min, day } = localNow();
      const lp = controller.lastPlan;
      const ctx = { inPeak: planner.inPeak(min), overridden: !!(lp && lp.overridden) };
      meter.sample(status, Date.now(), day, Math.floor(day / 100), ctx);
    } catch (err) {
      log.warn('Energy sample failed:', err.message);
    }
  }

  const getPlan = () => {
    const now = Date.now();
    return {
      enabled: config.smartHeat.enabled,
      targetF: config.smartHeat.targetF,
      targetMin: config.smartHeat.targetMin,
      peaks: config.smartHeat.peaks,
      plan: controller.lastPlan,
      model: {
        cool: model.coolParams(now),
        ceiling: model.heatCeiling(now), // grounded P/C ceiling + effective equilibrium
        ...model.stats(),
      },
      weather: {
        ...weather.status(now),
        ambientNowF: weather.enabled ? weather.ambientAt(now) : null,
      },
      health: {
        lastPollAgeSec: pollHealth.okAt ? Math.round((now - pollHealth.okAt) / 1000) : null,
      },
    };
  };

  const getEnergy = () => meter.summary();

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
    onRecovered: (status) => {
      // The watchdog just changed pump state itself (restart circulation) —
      // machine action, not a user override; reset the controller's state
      // machine so it re-asserts the plan instead of standing down.
      controller.machineAction();
      return reportState(status);
    },
    onStatus,
  });

  const app = createServer({ client, scheduler, watchdog, history, rawlog, pumpHealth, getPlan, getEnergy });

  // Keep the outdoor forecast fresh (used as the cooling model's ambient). Runs
  // independently of the pump; a no-op when no location is configured.
  if (weather.enabled) {
    weather
      .refresh(true)
      .then((ok) => ok && log.info(`Weather forecast loaded (${weather.series.length} hourly points).`))
      .catch((err) => log.warn('Initial weather refresh failed:', err.message));
    // Tick every few minutes; refresh() self-gates (full TTL when populated, but
    // retries every ~10 min while the series is empty so a failed boot fetch
    // can't leave the planner blind for hours).
    setInterval(
      () => weather.refresh().catch((err) => log.warn('Weather refresh failed:', err.message)),
      5 * 60_000,
    ).unref?.();
  }

  // Outage monitor: if no status read has succeeded for 30 min, log an error
  // and notify once. Control resumes automatically on the next good read.
  if (hasBestwayCreds) {
    const STALE_MS = 30 * 60_000;
    setInterval(() => {
      if (!pollHealth.okAt || pollHealth.notified) return;
      const age = Date.now() - pollHealth.okAt;
      if (age > STALE_MS) {
        pollHealth.notified = true;
        log.error(`No successful pump status for ${Math.round(age / 60000)} min — Bestway cloud unreachable?`);
        notify(
          'Hot tub control degraded',
          `Haven't been able to read the pump for ${Math.round(age / 60000)} minutes. ` +
            'Scheduling is paused until the cloud connection recovers (it retries every cycle).',
          { level: 'alert' },
        ).catch(() => {});
      }
    }, 5 * 60_000).unref?.();
  }

  // Cloud failsafe: keep a daily all-off task in the Gizwits scheduler at the
  // start of peak (+2 min), so peak shutoff happens even if THIS service is
  // dead. Re-synced daily because Gizwits schedulers run on UTC (DST moves the
  // local->UTC mapping twice a year).
  if (hasBestwayCreds && config.smartHeat.enabled && config.smartHeat.peaks.length) {
    const syncFailsafe = () =>
      ensureCloudFailsafe({
        client,
        timeUtc: utcHHMMForLocalMin(config.smartHeat.peaks[0].start + 2),
        log,
      });
    syncFailsafe();
    setInterval(syncFailsafe, 12 * 3_600_000).unref?.();
  }

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

// Last-resort safety net: log with full context, then exit non-zero so the
// platform (Railway restartPolicy ON_FAILURE) restarts us with clean state.
// All persistent state (schedules, model, energy, history) lives in JsonStores
// on the volume, so a restart is cheap and safe.
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err.stack || err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', (reason && reason.stack) || String(reason));
  process.exit(1);
});

main().catch((err) => {
  log.error('Fatal:', err.stack || err.message);
  process.exit(1);
});
