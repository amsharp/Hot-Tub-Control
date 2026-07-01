// OAuth2 "authorization code" server for Google Account Linking.
//
// Google requires the Smart Home Action to be linked to an account via OAuth2.
// Because this is a personal, single-owner service, we implement a deliberately
// small OAuth provider: a consent screen gated by a username/password you set,
// issuing opaque access/refresh tokens stored on disk. Google calls:
//   1. GET  /oauth/authorize  -> consent screen -> redirect back with ?code
//   2. POST /oauth/token      -> exchange code (or refresh_token) for tokens
// Every fulfillment request then carries the access token as a Bearer header.
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { JsonStore } from '../store.js';
import { log } from '../log.js';

const ACCESS_TTL_MS = 24 * 3600 * 1000; // 1 day
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const store = new JsonStore('oauth.json', { codes: {}, access: {}, refresh: {} });

const newToken = (n = 32) => randomBytes(n).toString('hex');

function pruneExpired() {
  const now = Date.now();
  for (const [code, rec] of Object.entries(store.data.codes)) {
    if (rec.expiresAt < now) delete store.data.codes[code];
  }
  for (const [tok, rec] of Object.entries(store.data.access)) {
    if (rec.expiresAt < now) delete store.data.access[tok];
  }
}

/** Returns the linked user id for a valid access token, or null. */
export function userForAccessToken(token) {
  const rec = store.data.access[token];
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    delete store.data.access[token];
    store.save();
    return null;
  }
  return rec.user;
}

/** Express middleware that rejects requests without a valid Bearer token. */
export function requireBearer(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = userForAccessToken(token);
  if (!user) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }
  req.linkedUser = user;
  next();
}

function consentPage({ clientId, redirectUri, state, responseType, error }) {
  const err = error ? `<p style="color:#c00">${error}</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link hot tub to Google</title>
<style>body{font-family:system-ui,sans-serif;max-width:24rem;margin:3rem auto;padding:0 1rem}
input{display:block;width:100%;padding:.6rem;margin:.4rem 0;box-sizing:border-box}
button{padding:.7rem 1rem;width:100%;background:#1a73e8;color:#fff;border:0;border-radius:.4rem;font-size:1rem}</style>
</head><body>
<h2>Link your hot tub</h2>
<p>Sign in to allow Google Home to control your Bestway spa.</p>
${err}
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <input type="hidden" name="response_type" value="${escapeHtml(responseType)}">
  <input name="username" placeholder="Username" autocomplete="username" required>
  <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
  <button type="submit">Allow</button>
</form>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

/** Registers the OAuth routes on an Express app. */
export function registerOAuthRoutes(app) {
  // Step 1: consent screen.
  app.get('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, state, response_type } = req.query;
    if (client_id !== config.oauth.clientId) {
      res.status(400).send('Unknown client_id');
      return;
    }
    res.set('content-type', 'text/html').send(
      consentPage({
        clientId: client_id,
        redirectUri: redirect_uri || '',
        state: state || '',
        responseType: response_type || 'code',
      }),
    );
  });

  // Step 1b: consent form submission -> issue an auth code and redirect back.
  app.post('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, state, response_type, username, password } = req.body;
    if (client_id !== config.oauth.clientId) {
      res.status(400).send('Unknown client_id');
      return;
    }
    const ok =
      username === config.oauth.linkUsername && password === config.oauth.linkPassword;
    if (!ok) {
      res
        .status(401)
        .set('content-type', 'text/html')
        .send(
          consentPage({
            clientId: client_id,
            redirectUri: redirect_uri,
            state,
            responseType: response_type,
            error: 'Incorrect username or password.',
          }),
        );
      return;
    }
    pruneExpired();
    const code = newToken(24);
    store.data.codes[code] = {
      user: 'owner',
      clientId: client_id,
      redirectUri: redirect_uri,
      expiresAt: Date.now() + CODE_TTL_MS,
    };
    store.save();
    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    log.info('OAuth: issued auth code, redirecting to Google');
    res.redirect(url.toString());
  });

  // Step 2: token endpoint (authorization_code + refresh_token grants).
  app.post('/oauth/token', (req, res) => {
    const { client_id, client_secret, grant_type } = req.body;
    if (client_id !== config.oauth.clientId || client_secret !== config.oauth.clientSecret) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }
    pruneExpired();

    if (grant_type === 'authorization_code') {
      const rec = store.data.codes[req.body.code];
      if (!rec || rec.expiresAt < Date.now()) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      delete store.data.codes[req.body.code];
      const tokens = issueTokens(rec.user);
      store.save();
      res.json(tokens);
      return;
    }

    if (grant_type === 'refresh_token') {
      const rec = store.data.refresh[req.body.refresh_token];
      if (!rec) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      const access = newToken();
      store.data.access[access] = { user: rec.user, expiresAt: Date.now() + ACCESS_TTL_MS };
      store.save();
      res.json({ token_type: 'Bearer', access_token: access, expires_in: ACCESS_TTL_MS / 1000 });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });
}

function issueTokens(user) {
  const access = newToken();
  const refresh = newToken();
  store.data.access[access] = { user, expiresAt: Date.now() + ACCESS_TTL_MS };
  store.data.refresh[refresh] = { user };
  return {
    token_type: 'Bearer',
    access_token: access,
    refresh_token: refresh,
    expires_in: ACCESS_TTL_MS / 1000,
  };
}
