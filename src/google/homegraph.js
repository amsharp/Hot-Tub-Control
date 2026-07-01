// Optional Google Home Graph client: lets us push state changes to Google
// proactively (reportState) and ask Google to re-run SYNC (requestSync) — e.g.
// after a schedule fires or the temperature changes outside of a Google command.
//
// Requires a Google Cloud service-account JSON (with the Home Graph API
// enabled) pointed to by HOMEGRAPH_SERVICE_ACCOUNT_FILE. If not configured,
// every method here is a no-op so the rest of the app runs unchanged.
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { config } from '../config.js';
import { statusToState } from './smarthome.js';
import { log } from '../log.js';

const HOMEGRAPH_BASE = 'https://homegraph.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/homegraph';
const AGENT_USER_ID = 'owner';

let sa = null; // parsed service account
let cachedToken = null; // { token, expiresAt }

function loadServiceAccount() {
  if (sa) return sa;
  sa = JSON.parse(readFileSync(config.homegraph.serviceAccountFile, 'utf8'));
  return sa;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;
  const acct = loadServiceAccount();
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: acct.client_email,
    scope: SCOPE,
    aud: acct.token_uri || 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  };
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = base64url(signer.sign(acct.private_key));
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(claims.aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Home Graph token error: ${JSON.stringify(json)}`);
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.token;
}

async function call(path, body) {
  if (!config.homegraph.enabled) return null;
  try {
    const token = await getAccessToken();
    const res = await fetch(`${HOMEGRAPH_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) log.warn(`Home Graph ${path} -> ${res.status} ${await res.text()}`);
    return res.ok;
  } catch (err) {
    log.warn(`Home Graph ${path} failed:`, err.message);
    return false;
  }
}

/** Ask Google to re-run SYNC (e.g. after adding/removing a device). */
export function requestSync() {
  return call('/devices:requestSync', { agentUserId: AGENT_USER_ID, async: true });
}

/** Push the current spa state to Google proactively. */
export function reportState(status) {
  const requestId = `${Date.now()}`;
  return call('/devices:reportStateAndNotification', {
    requestId,
    agentUserId: AGENT_USER_ID,
    payload: { devices: { states: { [status.deviceId]: statusToState(status) } } },
  });
}
