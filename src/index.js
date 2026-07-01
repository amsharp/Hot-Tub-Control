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
import { RawLog } from './rawlog.js';
import { FlowModel } from './flow.js';
import { FilterHealth } from './filterhealth.js';

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

  // Filter health: 24h moving average of the flow estimate vs its best-ever
  // baseline. Ratio-based, so absolute flow-scale errors cancel.
  const filterHealth = new FilterHealth();

  // Flow-rate estimate from the heater energy balance (inlet/outlet ΔT + power).
  const flowModel = new FlowModel({
    heaterW: config.flow.heaterW,
    inlet: { key: config.flow.inletKey, scale: config.flow.inletScale },
    outlet: { key: config.flow.outletKey, scale: config.flow.outletScale },
    minDeltaC: config.flow.minDeltaC,
  });

  // Software energy estimator, priced by the TOU-D-PRIME schedule when enabled
  // (falls back to the flat rate/ratePeak pair otherwise).
  const tou = config.energy.tou;
  const touSchedule =
    tou.enabled && tou.summerOn > 0 ? new TouSchedule(tou) : null;
  const meter = new EnergyMeter({
    watts: { heater: config.energy.heaterW, pump: config.energy.pumpW, blower: config.energy.blowerW },
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

  // Self-calibrating heat model + smart pre-heat planner.
  const model = new ThermalModel({ ambientFn: weather.ambientFn() });
  const planner = new SmartHeatPlanner({
    model,
    targetF: config.smartHeat.targetF,
    targetMin: config.smartHeat.targetMin,
    peaks: config.smartHeat.peaks,
    safetyMin: config.smartHeat.safetyMin,
  });
  let lastPlan = null;
  let smartLastAction = null; // 'on' | 'off' | null — the last command WE issued
  let overrideUntil = 0; // ms; while now < this, defer to a manual override

  function localNow() {
    const d = new Date(); // container TZ (set TZ=America/Los_Angeles)
    return {
      min: d.getHours() * 60 + d.getMinutes(),
      day: d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(),
    };
  }

  async function runSmartHeat(status, tempF, tempReliable = true) {
    const now = Date.now();
    const { min, day } = localNow();
    const p = planner.plan(tempF, min, day, now);
    const running = !!(status.power || status.heat || status.filter);

    // Detect a manual override (SaluSpa app / Google Home / HUD) that contradicts
    // our last command, and stand down until the end of the current window so we
    // don't fight the user.
    let overrideDetected = false;
    if (p.heat === false && running && smartLastAction === 'off') {
      overrideDetected = true; // user turned it on during peak
    } else if (p.heat === true && !status.heat && smartLastAction === 'on') {
      overrideDetected = true; // user turned it off during pre-heat
    }
    if (overrideDetected) {
      const endMin = p.inPeak ? planner.peakEndMin(min) : p.targetMin;
      const untilMs = Math.max(2, (endMin ?? min) - min) * 60_000;
      overrideUntil = now + untilMs;
      log.info(`SmartHeat: manual override detected (${p.reason}) — standing down`);
    }
    const overridden = now < overrideUntil;

    lastPlan = {
      ...p,
      currentTemp: tempF,
      tempReliable,
      nowMin: min,
      overridden,
      reason: overridden ? 'override' : p.reason,
      at: now,
    };

    if (overridden) return; // respect the user

    if (p.heat === true && !status.heat) {
      log.info(
        `SmartHeat -> ON (${p.reason}); ~${Number.isFinite(p.needHours) ? p.needHours.toFixed(1) + 'h' : 'max'} to reach ${p.targetF}F`,
      );
      await client.setTargetTemperature(config.smartHeat.targetF, 'F');
      await client.setHeating(true);
      smartLastAction = 'on';
    } else if (p.heat === false && running) {
      // Peak: kill everything (heater AND pump/circulation).
      log.info(`SmartHeat -> ALL OFF (${p.reason})`);
      await client.setAllOff();
      smartLastAction = 'off';
    }
  }

  // Called on every status read: enforce unit, log history, learn the heat
  // model, and run the smart pre-heat controller.
  async function onStatus(status) {
    await enforceUnit(status);
    const now = Date.now();
    const tempF =
      status.currentTemp == null
        ? null
        : status.unit === 'C'
          ? Math.round((status.currentTemp * 9) / 5 + 32)
          : status.currentTemp;

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

    // Update the flow estimate's last-good reading from the 2-min stream, and
    // feed reliable samples into the filter-health moving average.
    try {
      const f = flowModel.compute(status, now);
      filterHealth.record(f, now);
    } catch (err) {
      log.warn('Flow compute failed:', err.message);
    }

    if (tempF != null && config.smartHeat.enabled) {
      try {
        await runSmartHeat(status, est.tempF, est.reliable);
      } catch (err) {
        log.warn('SmartHeat failed:', err.message);
      }
    }

    // Energy accounting last, so peak/override context reflects this cycle.
    try {
      const { min, day } = localNow();
      const ctx = { inPeak: planner.inPeak(min), overridden: !!(lastPlan && lastPlan.overridden) };
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
      plan: lastPlan,
      model: { heat: model.heatParams(), cool: model.coolParams(now), ...model.stats() },
      weather: {
        enabled: weather.enabled,
        ambientNowF: weather.enabled ? weather.ambientAt(now) : null,
        forecastPoints: weather.series.length,
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
    onRecovered: (status) => reportState(status),
    onStatus,
  });

  const app = createServer({ client, scheduler, watchdog, history, rawlog, flowModel, filterHealth, getPlan, getEnergy });

  // Keep the outdoor forecast fresh (used as the cooling model's ambient). Runs
  // independently of the pump; a no-op when no location is configured.
  if (weather.enabled) {
    weather
      .refresh(true)
      .then((ok) => ok && log.info(`Weather forecast loaded (${weather.series.length} hourly points).`))
      .catch((err) => log.warn('Initial weather refresh failed:', err.message));
    setInterval(
      () => weather.refresh().catch((err) => log.warn('Weather refresh failed:', err.message)),
      config.weather.refreshMin * 60_000,
    ).unref?.();
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

main().catch((err) => {
  log.error('Fatal:', err.stack || err.message);
  process.exit(1);
});
