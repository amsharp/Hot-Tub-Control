import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, buildLoginFrame } from '../src/bestway/realtime.js';
import { FaultWatchdog } from '../src/recovery/watchdog.js';

test('parseMessage normalizes s2c_noti into an attrs event', () => {
  const evt = parseMessage(JSON.stringify({ cmd: 's2c_noti', data: { did: 'spa-1', attrs: { E02: 1 } } }));
  assert.deepEqual(evt, { type: 'attrs', did: 'spa-1', attrs: { E02: 1 } });
});

test('parseMessage handles login_res and pong', () => {
  assert.deepEqual(parseMessage(JSON.stringify({ cmd: 'login_res', data: { success: true } })), {
    type: 'login',
    success: true,
  });
  assert.deepEqual(parseMessage(JSON.stringify({ cmd: 'pong' })), { type: 'pong' });
});

test('parseMessage returns null on garbage', () => {
  assert.equal(parseMessage('not json'), null);
});

test('buildLoginFrame includes appid, uid, token and auto_subscribe', () => {
  const frame = JSON.parse(buildLoginFrame('uid-1', 'tok-1'));
  assert.equal(frame.cmd, 'login_req');
  assert.equal(frame.data.uid, 'uid-1');
  assert.equal(frame.data.token, 'tok-1');
  assert.equal(frame.data.auto_subscribe, true);
  assert.ok(frame.data.appid);
});

test('handleRealtimeAttrs triggers recovery only when a fault is present', async () => {
  const calls = [];
  let statuses = [
    { deviceId: 'd', name: 'Spa', online: true, heat: true, faults: [{ code: 'E02', meaning: 'x', autoClearable: true }] },
    { deviceId: 'd', name: 'Spa', online: true, heat: true, faults: [] },
  ];
  let i = 0;
  const client = {
    getStatus: async () => statuses[Math.min(i++, statuses.length - 1)],
    restartCirculation: async () => calls.push('restart'),
  };
  const wd = new FaultWatchdog({ client, wait: async () => {}, now: () => 0 });

  // Healthy push -> no action.
  const none = wd.handleRealtimeAttrs({ temp_now: 38 });
  assert.equal(none, null);
  assert.equal(calls.length, 0);

  // Fault push -> triggers a recovery cycle.
  await wd.handleRealtimeAttrs({ E02: 1 });
  assert.deepEqual(calls, ['restart']);
});

test('trigger() does not overlap concurrent checks', async () => {
  let active = 0;
  let maxActive = 0;
  const client = {
    getStatus: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { deviceId: 'd', name: 'Spa', online: true, heat: false, faults: [] };
    },
  };
  const wd = new FaultWatchdog({ client, wait: async () => {} });
  await Promise.all([wd.trigger(), wd.trigger(), wd.trigger()]);
  assert.equal(maxActive, 1, 'checks must not overlap');
});
