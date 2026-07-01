// Express server that exposes:
//   - OAuth2 account-linking endpoints      (/oauth/authorize, /oauth/token)
//   - Google Smart Home fulfillment webhook (/fulfillment, Bearer-protected)
//   - A small admin REST API for schedules   (/api/*, X-Admin-Token-protected)
//   - Health + status                        (/healthz, /api/status)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
  // Accept the token via header (HUD) or ?token= query (iOS Shortcuts/Scriptable
  // widgets, which send plain URLs without custom headers).
  const token = req.get('x-admin-token') || req.query.token;
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function truthyParam(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

// The web control panel (a SaluSpa-style HUD). The HTML shell is public; every
// control/read call it makes is gated by the admin token entered in the page.
const HUD_DIR = dirname(fileURLToPath(import.meta.url));
const HUD_HTML = readFileSync(join(HUD_DIR, 'hud.html'), 'utf8');
const SETUP_HTML = readFileSync(join(HUD_DIR, 'setup.html'), 'utf8');
// The Scriptable widget body, served so the pasted stub can load it fresh each
// refresh (update the widget without re-pasting). Contains no secrets.
const WIDGET_JS = readFileSync(join(HUD_DIR, 'widget.scriptable.js'), 'utf8');
const HUD_ICON = readFileSync(join(HUD_DIR, 'icon.png'));
// Web-app manifest so the HUD installs to the home screen as a standalone app.
const HUD_MANIFEST = {
  name: 'Hot Tub',
  short_name: 'Hot Tub',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#b5aa9c',
  theme_color: '#b5aa9c',
  icons: [
    { src: '/icon.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon.png', sizes: '512x512', type: 'image/png' },
  ],
};

export function createServer({ client, scheduler, watchdog, history }) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Web HUD (control panel) + its home-screen app assets.
  app.get(['/', '/hud'], (_req, res) => res.type('html').send(HUD_HTML));
  app.get('/setup', (_req, res) => res.type('html').send(SETUP_HTML));
  app.get('/widget.js', (_req, res) => res.type('application/javascript').send(WIDGET_JS));
  app.get('/icon.png', (_req, res) => res.type('png').send(HUD_ICON));
  app.get('/manifest.json', (_req, res) => res.json(HUD_MANIFEST));

  // 24h temperature history for the widget/HUD chart.
  app.get('/api/history', requireAdmin, (_req, res) =>
    res.json({ samples: history ? history.list() : [] }),
  );

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
  // Granular, independent controls (used by the web HUD) + the original
  // convenience actions (on/off = whole-unit heating) for back-compat.
  async function applyControl({ action, on, celsius, fahrenheit }) {
    if (action === 'power') await client.setPower(truthyParam(on));
    else if (action === 'heat') await client.setHeat(truthyParam(on));
    else if (action === 'filter') await client.setFilter(truthyParam(on));
    else if (action === 'on') await client.setHeating(true);
    else if (action === 'off') await client.setHeating(false);
    else if (action === 'temp') {
      if (fahrenheit != null && fahrenheit !== '') {
        await client.setTargetTemperature(Number(fahrenheit), 'F');
      } else {
        await client.setTargetTemperature(Number(celsius), 'C');
      }
    } else if (action === 'bubbles_on') await client.setBubbles(true);
    else if (action === 'bubbles_off') await client.setBubbles(false);
    else {
      const e = new Error(`unknown action ${action}`);
      e.status = 400;
      throw e;
    }
  }

  // Respond as soon as the command is accepted; refresh state + push to Google
  // asynchronously so callers aren't blocked on a second cloud round-trip.
  function afterControl(res) {
    res.json({ ok: true });
    client
      .getStatus()
      .then((status) => onStateChange(status))
      .catch(() => {});
  }

  app.post('/api/control', requireAdmin, async (req, res) => {
    try {
      await applyControl(req.body || {});
      afterControl(res);
    } catch (err) {
      if (!res.headersSent) res.status(err.status || 502).json({ error: err.message });
    }
  });

  // GET convenience for iOS Shortcuts / Scriptable widgets — a plain URL, e.g.
  //   /api/q?token=XXX&action=heat&on=1
  //   /api/q?token=XXX&action=temp&f=104
  app.get('/api/q', requireAdmin, async (req, res) => {
    try {
      await applyControl({
        action: req.query.action,
        on: req.query.on,
        celsius: req.query.c,
        fahrenheit: req.query.f,
      });
      afterControl(res);
    } catch (err) {
      if (!res.headersSent) res.status(err.status || 502).json({ error: err.message });
    }
  });

  return app;
}
