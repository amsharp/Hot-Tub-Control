import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureCloudFailsafe, clearCloudFailsafe, utcHHMMForLocalMin, FAILSAFE_REMARK } from '../src/failsafe.js';

const quiet = { info() {}, warn() {} };

function fakeClient(entries = []) {
  const calls = { created: [], deleted: [] };
  return {
    calls,
    async listSchedulers() {
      return entries;
    },
    async createScheduler(body) {
      calls.created.push(body);
      return { id: 'new' };
    },
    async deleteScheduler(id) {
      calls.deleted.push(id);
    },
  };
}

test('creates the entry when none exists', async () => {
  const c = fakeClient([]);
  const r = await ensureCloudFailsafe({ client: c, timeUtc: '23:02', log: quiet });
  assert.equal(r, 'created');
  assert.equal(c.calls.created[0].timeUtc, '23:02');
  assert.equal(c.calls.created[0].remark, FAILSAFE_REMARK);
});

test('no-op when the entry matches', async () => {
  const c = fakeClient([{ id: 'a', remark: FAILSAFE_REMARK, time: '23:02' }]);
  const r = await ensureCloudFailsafe({ client: c, timeUtc: '23:02', log: quiet });
  assert.equal(r, 'ok');
  assert.equal(c.calls.created.length, 0);
  assert.equal(c.calls.deleted.length, 0);
});

test('replaces the entry when the UTC time drifts (DST)', async () => {
  const c = fakeClient([{ id: 'a', remark: FAILSAFE_REMARK, time: '23:02' }]);
  const r = await ensureCloudFailsafe({ client: c, timeUtc: '00:02', log: quiet });
  assert.equal(r, 'replaced');
  assert.deepEqual(c.calls.deleted, ['a']);
  assert.equal(c.calls.created[0].timeUtc, '00:02');
});

test('collapses duplicates and ignores unrelated entries', async () => {
  const c = fakeClient([
    { id: 'a', remark: FAILSAFE_REMARK, time: '23:02' },
    { id: 'b', remark: FAILSAFE_REMARK, time: '22:02' },
    { id: 'x', remark: 'someone-else', time: '10:00' },
  ]);
  await ensureCloudFailsafe({ client: c, timeUtc: '23:02', log: quiet });
  assert.deepEqual(c.calls.deleted.sort(), ['a', 'b']);
  assert.equal(c.calls.created.length, 1);
});

test('API failure returns error without throwing', async () => {
  const c = {
    async listSchedulers() {
      throw new Error('cloud down');
    },
  };
  const r = await ensureCloudFailsafe({ client: c, timeUtc: '23:02', log: quiet });
  assert.equal(r, 'error');
});

test('clearCloudFailsafe deletes only our entries and leaves others alone', async () => {
  const c = fakeClient([
    { id: 'a', remark: FAILSAFE_REMARK, time: '23:02' },
    { id: 'b', remark: FAILSAFE_REMARK, time: '22:02' },
    { id: 'x', remark: 'someone-else', time: '10:00' },
  ]);
  const r = await clearCloudFailsafe({ client: c, log: quiet });
  assert.equal(r, 'removed');
  assert.deepEqual(c.calls.deleted.sort(), ['a', 'b']);
  assert.equal(c.calls.created.length, 0);
});

test('clearCloudFailsafe is a no-op when nothing of ours is parked', async () => {
  const c = fakeClient([{ id: 'x', remark: 'someone-else', time: '10:00' }]);
  const r = await clearCloudFailsafe({ client: c, log: quiet });
  assert.equal(r, 'ok');
  assert.equal(c.calls.deleted.length, 0);
});

test('clearCloudFailsafe returns error without throwing when the cloud is down', async () => {
  const c = {
    async listSchedulers() {
      throw new Error('cloud down');
    },
  };
  const r = await clearCloudFailsafe({ client: c, log: quiet });
  assert.equal(r, 'error');
});

test('utcHHMMForLocalMin converts using the ambient timezone', () => {
  // Rather than pin a TZ (env-dependent), verify the round trip: the computed
  // UTC HH:MM must equal what Date reports for local 16:02 today.
  const now = new Date();
  const d = new Date(now);
  d.setHours(16, 2, 0, 0);
  const expect = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  assert.equal(utcHHMMForLocalMin(16 * 60 + 2, now), expect);
});
