// Cloud failsafe — a dead-man's backstop for peak hours.
//
// The smart-heat controller shuts everything off at the start of peak (4 PM),
// but only while the Railway service is alive. This module parks a daily
// "all off" task in the *Gizwits cloud scheduler*, which executes from
// Gizwits' own infrastructure — so even if our service dies at 3:59 PM, the
// tub still goes dark for peak.
//
// Gizwits schedulers run on UTC wall time, so the entry must move with DST
// (16:02 local is 23:02 UTC in summer, 00:02 in winter). ensureCloudFailsafe()
// recomputes the target UTC time from the local schedule and replaces the
// entry when it drifts; the service calls it on boot and daily.
//
// The +2 min offset (16:02, not 16:00) lets the controller's own 4 PM all-off
// land first — when the service is healthy the failsafe writes "off" to an
// already-off tub, a no-op. Manual evening overrides are unaffected: the
// failsafe fires once at 16:02, before typical override time, and anything the
// user turns on afterwards stays on (the controller's transition detection
// registers it as an override like any other press).

export const FAILSAFE_REMARK = 'railway-failsafe';

// All-off attribute payload. The scheduler validator is strict about datapoint
// types: `power` is a bool in the vendor schema (true/false), the rest uint8.
export const FAILSAFE_ATTRS = { power: false, heat: 0, filter: 0, wave: 0 };

/**
 * UTC "HH:MM" corresponding to local minutes-of-day `localMin` today (container
 * TZ). Injectable `now` for tests.
 */
export function utcHHMMForLocalMin(localMin, now = new Date()) {
  const d = new Date(now);
  d.setHours(Math.floor(localMin / 60), localMin % 60, 0, 0);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Ensure exactly one cloud failsafe entry exists at `timeUtc`. Creates it if
 * missing; replaces it (delete + create) when the stored time drifts (DST) or
 * duplicates exist. Never throws — a failed sync is logged and retried on the
 * next call; the previous entry (±1h) keeps guarding meanwhile.
 * @returns {'ok'|'created'|'replaced'|'error'}
 */
export async function ensureCloudFailsafe({ client, timeUtc, log = console }) {
  try {
    const entries = (await client.listSchedulers()) || [];
    const ours = entries.filter((e) => e.remark === FAILSAFE_REMARK);
    if (ours.length === 1 && ours[0].time === timeUtc) return 'ok';

    for (const e of ours) {
      try {
        await client.deleteScheduler(e.id);
      } catch (err) {
        log.warn(`Failsafe: could not delete stale entry ${e.id}: ${err.message}`);
      }
    }
    await client.createScheduler({ timeUtc, attrs: FAILSAFE_ATTRS, remark: FAILSAFE_REMARK });
    const action = ours.length ? 'replaced' : 'created';
    log.info(`Cloud failsafe ${action}: daily all-off at ${timeUtc} UTC.`);
    return action;
  } catch (err) {
    log.warn(`Cloud failsafe sync failed: ${err.message}`);
    return 'error';
  }
}

/**
 * Remove every cloud failsafe entry we previously parked. Used when automatic
 * scheduling is turned off: otherwise the daily all-off task keeps executing
 * from Gizwits' infrastructure and would turn the tub off mid-afternoon,
 * fighting a user who now controls it by hand / on-device timer. Idempotent and
 * never throws — a partial failure is logged and cleaned up on the next boot.
 * @returns {'ok'|'removed'|'error'} 'ok' = nothing of ours was parked.
 */
export async function clearCloudFailsafe({ client, log = console }) {
  try {
    const entries = (await client.listSchedulers()) || [];
    const ours = entries.filter((e) => e.remark === FAILSAFE_REMARK);
    if (!ours.length) return 'ok';
    for (const e of ours) {
      try {
        await client.deleteScheduler(e.id);
      } catch (err) {
        log.warn(`Failsafe: could not delete entry ${e.id}: ${err.message}`);
      }
    }
    log.info(`Cloud failsafe removed (${ours.length} entr${ours.length === 1 ? 'y' : 'ies'}) — scheduling disabled.`);
    return 'removed';
  } catch (err) {
    log.warn(`Cloud failsafe teardown failed: ${err.message}`);
    return 'error';
  }
}
