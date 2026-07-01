// Notifications: formats spa status for humans and (optionally) POSTs events to
// a webhook (ntfy / Slack / Discord / Home Assistant). Disabled cleanly when
// NOTIFY_WEBHOOK_URL is unset.
import { config } from '../config.js';
import { log } from '../log.js';

export function formatStatus(status, unit = config.displayUnit) {
  const t = (v) => {
    if (v == null) return '—';
    if (unit === status.unit) return `${v}°${unit}`;
    const conv = unit === 'F' ? Math.round((v * 9) / 5 + 32) : Math.round(((v - 32) * 5) / 9);
    return `${conv}°${unit}`;
  };
  const flags = [
    status.power ? 'power on' : 'power off',
    status.heat ? 'heating' : 'not heating',
    status.filter ? 'filter on' : 'filter off',
    status.bubbles ? 'bubbles on' : null,
    status.locked ? 'locked' : null,
    status.online ? null : 'OFFLINE',
  ].filter(Boolean);
  const faults = (status.faults || []).length
    ? ` ⚠ FAULT: ${status.faults.map((f) => `${f.code} (${f.meaning})`).join('; ')}`
    : '';
  return `${status.name}: ${t(status.currentTemp)} (target ${t(status.targetTemp)}) — ${flags.join(', ')}${faults}`;
}

/** Send a notification event. `level` is "info" | "warn" | "alert". */
export async function notify(title, message, { level = 'info', data } = {}) {
  log.info(`notify[${level}] ${title}: ${message}`);
  if (!config.notify.webhookUrl) return;
  try {
    await fetch(config.notify.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message, level, data, at: new Date().toISOString() }),
    });
  } catch (err) {
    log.warn('notify webhook failed:', err.message);
  }
}
