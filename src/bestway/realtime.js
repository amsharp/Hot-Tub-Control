// GizwitsRealtime — subscribes to the Gizwits push WebSocket so we react to spa
// state changes (especially faults) within seconds instead of waiting for the
// next poll. Connects to wss://{host}:{wss_port}/ws/app/v1 (host/port come from
// the device binding), logs in with auto_subscribe, and emits attribute
// updates from s2c_noti messages.
//
// The WebSocket implementation is injectable so the message handling can be
// unit tested without a live socket. Falls back gracefully: if the socket can't
// connect, the polling watchdog still covers us.
import { GIZWITS_APP_ID } from './constants.js';
import { log } from '../log.js';

const HEARTBEAT_SECONDS = 180;

/** Pure parser for incoming frames. Returns a normalized event or null. */
export function parseMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  switch (msg.cmd) {
    case 'login_res':
      return { type: 'login', success: !!msg.data?.success };
    case 's2c_noti':
      return { type: 'attrs', did: msg.data?.did, attrs: msg.data?.attrs || {} };
    case 's2c_online_status':
      return { type: 'online', did: msg.data?.did, online: !!msg.data?.online };
    case 's2c_invalid_msg':
      return { type: 'error', data: msg.data };
    case 'pong':
      return { type: 'pong' };
    default:
      return { type: 'other', cmd: msg.cmd };
  }
}

export function buildLoginFrame(uid, token) {
  return JSON.stringify({
    cmd: 'login_req',
    data: {
      appid: GIZWITS_APP_ID,
      uid,
      token,
      p0_type: 'attrs_v4',
      heartbeat_interval: HEARTBEAT_SECONDS,
      auto_subscribe: true,
    },
  });
}

export class GizwitsRealtime {
  /**
   * @param {object} opts
   * @param {import('./client.js').BestwayClient} opts.client
   * @param {(did:string, attrs:object)=>void} opts.onAttrs called on every push
   * @param {typeof WebSocket} [opts.WebSocketImpl] defaults to global WebSocket
   * @param {boolean} [opts.autoReconnect]
   */
  constructor({ client, onAttrs, WebSocketImpl, autoReconnect = true } = {}) {
    this.client = client;
    this.onAttrs = onAttrs;
    this.WebSocketImpl = WebSocketImpl || globalThis.WebSocket;
    this.autoReconnect = autoReconnect;
    this.ws = null;
    this.heartbeat = null;
    this.reconnectDelay = 1000;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    if (!this.WebSocketImpl) {
      log.warn('No WebSocket implementation available; real-time disabled (polling still active).');
      return;
    }
    await this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearHeartbeat();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  async _connect() {
    let url;
    try {
      await this.client.ensureToken();
      const dev = await this.client.resolveDevice();
      if (!dev.host || !dev.wss_port) {
        throw new Error('device binding has no websocket host/port');
      }
      url = `wss://${dev.host}:${dev.wss_port}/ws/app/v1`;
    } catch (err) {
      log.warn('Real-time setup failed, will retry:', err.message);
      this._scheduleReconnect();
      return;
    }

    log.info('Real-time: connecting to', url);
    const ws = new this.WebSocketImpl(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectDelay = 1000;
      ws.send(buildLoginFrame(this.client.uid, this.client.token));
    });

    ws.addEventListener('message', (event) => {
      this._handleFrame(typeof event.data === 'string' ? event.data : String(event.data));
    });

    ws.addEventListener('close', () => {
      log.warn('Real-time: socket closed.');
      this._clearHeartbeat();
      this._scheduleReconnect();
    });

    ws.addEventListener('error', (err) => {
      log.warn('Real-time: socket error:', err?.message || 'unknown');
      // 'close' will follow and handle reconnect.
    });
  }

  _handleFrame(raw) {
    const evt = parseMessage(raw);
    if (!evt) return;
    if (evt.type === 'login') {
      if (evt.success) {
        log.info('Real-time: logged in, listening for updates.');
        this._startHeartbeat();
      } else {
        log.warn('Real-time: login rejected; forcing token refresh.');
        this.client.token = null; // force re-login on reconnect
        this.ws?.close();
      }
    } else if (evt.type === 'attrs') {
      try {
        this.onAttrs?.(evt.did, evt.attrs);
      } catch (err) {
        log.warn('Real-time onAttrs handler failed:', err.message);
      }
    } else if (evt.type === 'error') {
      log.warn('Real-time: server error frame:', JSON.stringify(evt.data));
    }
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    this.heartbeat = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ cmd: 'ping' }));
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_SECONDS * 1000);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  _clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  _scheduleReconnect() {
    if (this.stopped || !this.autoReconnect) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    const t = setTimeout(() => this._connect(), delay);
    if (t.unref) t.unref();
  }
}
