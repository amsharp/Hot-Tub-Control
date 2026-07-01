// Express server that exposes:
//   - OAuth2 account-linking endpoints      (/oauth/authorize, /oauth/token)
//   - Google Smart Home fulfillment webhook (/fulfillment, Bearer-protected)
//   - A small admin REST API for schedules   (/api/*, X-Admin-Token-protected)
//   - Health + status                        (/healthz, /api/status)
import express from 'express';
import { config } from './config.js';
import { log } from './log.js';
import { registerOAuthRoutes, requireBearer } from './google/oauth.js';
import { handleSmartHomeRequest } from './google/smarthome.js';
import { reportState } from './google/homegraph.js';
import { formatStatus } from './notify/notifier.js';
import { ACTIONS } from './scheduler/scheduler.js';

// Admin token guards the schedule API. Defaults to the OAuth client secret so
// there's always *some* gate; override with ADMIN_TOKEN if you prefer.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || config.oauth.clientSecret;

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function createServer({ client, scheduler, watchdog }) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Force a watchdog cycle now (check faults, auto-clear if applicable).
  app.post('/api/recover', requireAdmin, async (_req, res) => {
    if (!watchdog) {
      res.status(503).json({ error: 'watchdog not enabled' });
      return;
    }
    try {
      res.json(await watchdog.check());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  registerOAuthRoutes(app);

  // Push state to Google after any change we make locally.
  const onStateChange = (status) => reportState(status);

  // Google Smart Home webhook.
  app.post('/fulfillment', requireBearer, async (req, res) => {
    try {
      const response = await handleSmartHomeRequest(req.body, { client, onStateChange });
      res.json(response);
    } catch (err) {
      log.error('Fulfillment error:', err.stack || err.message);
      res.status(500).json({
        requestId: req.body?.requestId,
        payload: { errorCode: 'hardError', debugString: err.message },
      });
    }
  });

  // --- Admin API: status -----------------------------------------------------
  app.get('/api/status', requireAdmin, async (_req, res) => {
    try {
      const status = await client.getStatus();
      res.json({ ...status, summary: formatStatus(status) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // --- Admin API: schedules --------------------------------------------------
  app.get('/api/schedules', requireAdmin, (_req, res) => {
    res.json({ schedules: scheduler.list(), actions: ACTIONS });
  });

  app.post('/api/schedules', requireAdmin, (req, res) => {
    try {
      res.status(201).json(scheduler.add(req.body));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/schedules/:id', requireAdmin, (req, res) => {
    res.json({ removed: scheduler.remove(req.params.id) });
  });

  app.post('/api/schedules/:id/enabled', requireAdmin, (req, res) => {
    res.json({ ok: scheduler.setEnabled(req.params.id, !!req.body.enabled) });
  });

  app.post('/api/schedules/:id/run', requireAdmin, async (req, res) => {
    const rec = scheduler.list().find((s) => s.id === req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    try {
      const status = await scheduler.runAction(rec);
      res.json({ ok: true, status });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // --- Admin API: direct control --------------------------------------------
  app.post('/api/control', requireAdmin, async (req, res) => {
    try {
      const { action, celsius } = req.body;
      if (action === 'on') await client.setHeating(true);
      else if (action === 'off') await client.setHeating(false);
      else if (action === 'temp') await client.setTargetTemperature(Number(celsius), 'C');
      else if (action === 'bubbles_on') await client.setBubbles(true);
      else if (action === 'bubbles_off') await client.setBubbles(false);
      else {
        res.status(400).json({ error: `unknown action ${action}` });
        return;
      }
      const status = await client.getStatus();
      onStateChange(status);
      res.json({ ok: true, status });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return app;
}
