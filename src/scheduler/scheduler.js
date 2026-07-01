// Cron-based scheduler for the hot tub. Schedules persist to data/schedules.json
// and are (re)registered as node-cron jobs. Each schedule runs one ACTION at a
// cron time, optionally in a given timezone.
//
// ACTIONS:
//   on    -> power + heater + filter on        (warm up)
//   off   -> heater off (filter kept on)       (stop heating)
//   temp  -> set target temperature (params.celsius)
//   bubbles_on / bubbles_off
import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { JsonStore } from '../store.js';
import { notify, formatStatus } from '../notify/notifier.js';
import { log } from '../log.js';

export const ACTIONS = ['on', 'off', 'temp', 'bubbles_on', 'bubbles_off'];

export class Scheduler {
  /**
   * @param {object} deps
   * @param {import('../bestway/client.js').BestwayClient} deps.client
   * @param {Function} [deps.onAfterAction] called with fresh status after a run
   */
  constructor({ client, onAfterAction, store } = {}) {
    this.client = client;
    this.onAfterAction = onAfterAction;
    // `store` is injectable for tests; defaults to the on-disk JSON store.
    this.store = store || new JsonStore('schedules.json', { schedules: [] });
    this.jobs = new Map(); // id -> cron task
  }

  list() {
    return this.store.data.schedules;
  }

  /** Validate + persist a new schedule, then register it. Returns the record. */
  add({ name, cron: expr, action, params = {}, timezone, enabled = true }) {
    if (!cron.validate(expr)) throw new Error(`Invalid cron expression: ${expr}`);
    if (!ACTIONS.includes(action)) {
      throw new Error(`Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}`);
    }
    if (action === 'temp' && typeof params.celsius !== 'number') {
      throw new Error('temp action requires params.celsius (number)');
    }
    const record = {
      id: randomUUID(),
      name: name || `${action} @ ${expr}`,
      cron: expr,
      action,
      params,
      timezone: timezone || undefined,
      enabled: !!enabled,
    };
    this.store.data.schedules.push(record);
    this.store.save();
    if (record.enabled) this._register(record);
    log.info(`Schedule added: ${record.name} [${record.cron}]`);
    return record;
  }

  remove(id) {
    const idx = this.store.data.schedules.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this._unregister(id);
    this.store.data.schedules.splice(idx, 1);
    this.store.save();
    return true;
  }

  setEnabled(id, enabled) {
    const rec = this.store.data.schedules.find((s) => s.id === id);
    if (!rec) return false;
    rec.enabled = !!enabled;
    this.store.save();
    this._unregister(id);
    if (rec.enabled) this._register(rec);
    return true;
  }

  /** Register all enabled schedules. Call once on startup. */
  start() {
    for (const rec of this.store.data.schedules) {
      if (rec.enabled) this._register(rec);
    }
    log.info(`Scheduler started with ${this.jobs.size} active schedule(s).`);
  }

  stop() {
    for (const id of [...this.jobs.keys()]) this._unregister(id);
  }

  _register(rec) {
    this._unregister(rec.id);
    const task = cron.schedule(
      rec.cron,
      () => {
        this.runAction(rec).catch((err) => log.error(`Schedule ${rec.name} failed:`, err.message));
      },
      { timezone: rec.timezone },
    );
    this.jobs.set(rec.id, task);
  }

  _unregister(id) {
    const task = this.jobs.get(id);
    if (task) {
      task.stop();
      this.jobs.delete(id);
    }
  }

  /** Execute a schedule's action immediately (also used by "run now"). */
  async runAction(rec) {
    log.info(`Running schedule "${rec.name}" -> ${rec.action}`);
    switch (rec.action) {
      case 'on':
        await this.client.setHeating(true);
        break;
      case 'off':
        await this.client.setHeating(false);
        break;
      case 'temp':
        await this.client.setTargetTemperature(rec.params.celsius, 'C');
        break;
      case 'bubbles_on':
        await this.client.setBubbles(true);
        break;
      case 'bubbles_off':
        await this.client.setBubbles(false);
        break;
      default:
        throw new Error(`Unknown action ${rec.action}`);
    }
    let status;
    try {
      status = await this.client.getStatus();
      await notify('Schedule ran', `${rec.name}\n${formatStatus(status)}`, { level: 'info' });
    } catch (err) {
      log.warn('Post-action status read failed:', err.message);
    }
    if (status && this.onAfterAction) {
      try {
        await this.onAfterAction(status);
      } catch (err) {
        log.warn('onAfterAction failed:', err.message);
      }
    }
    return status;
  }
}
