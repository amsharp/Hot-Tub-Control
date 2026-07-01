import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FaultWatchdog } from '../src/recovery/watchdog.js';
import { detectFaults } from '../src/bestway/constants.js';

// A fake client whose status is scripted across successive getStatus() calls.
function scriptedClient(statuses, calls = []) {
  let i = 0;
  return {
    calls,
    getStatus: async () => {
      const s = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      return s;
    },
    restartCirculation: async (opts) => {
      calls.push(['restartCirculation', opts?.restoreHeat]);
    },
  };
}

const faulty = (codes, extra = {}) => ({
  deviceId: 'd',
  name: 'Spa',
  online: true,
  heat: true,
  faults: codes.map((c) => ({ code: c, meaning: 'x', autoClearable: c === 'E02' })),
  ...extra,
});
const healthy = { deviceId: 'd', name: 'Spa', online: true, heat: true, faults: [] };

test('detectFaults flags E02 but ignores E32', () => {
  const faults = detectFaults({ E02: 1, E32: 1, temp_now: 30 });
  assert.equal(faults.length, 1);
  assert.equal(faults[0].code, 'E02');
  assert.equal(faults[0].autoClearable, true);
});

test('detectFaults reports earth fault as non-clearable', () => {
  const faults = detectFaults({ earth: 1 });
  assert.equal(faults[0].code, 'earth');
  assert.equal(faults[0].autoClearable, false);
});

test('watchdog restarts circulation and reports recovered when fault clears', async () => {
  const calls = [];
  // First read: E02 present. After restart, recheck read: healthy.
  const client = scriptedClient([faulty(['E02']), healthy], calls);
  const wd = new FaultWatchdog({ client, wait: async () => {}, now: () => 1000 });
  const result = await wd.check();
  assert.equal(result.action, 'recovered');
  assert.deepEqual(calls[0], ['restartCirculation', true]);
});

test('watchdog does not auto-clear a non-clearable fault', async () => {
  const calls = [];
  const client = scriptedClient([faulty(['earth'])], calls);
  const wd = new FaultWatchdog({ client, wait: async () => {} });
  const result = await wd.check();
  assert.equal(result.action, 'reported');
  assert.equal(calls.length, 0, 'must not restart for a ground fault');
});

test('watchdog backs off after maxAttempts', async () => {
  const calls = [];
  // Always faulting, so every attempt fails.
  const client = scriptedClient([faulty(['E02'])], calls);
  let clock = 0;
  const wd = new FaultWatchdog({
    client,
    wait: async () => {},
    now: () => clock,
    maxAttempts: 2,
    cooldownMs: 0,
  });
  await wd.check(); // attempt 1
  clock += 1;
  await wd.check(); // attempt 2
  clock += 1;
  const third = await wd.check(); // should back off, no further restart
  const restarts = calls.filter((c) => c[0] === 'restartCirculation').length;
  assert.equal(restarts, 2, 'should stop restarting after maxAttempts');
  assert.equal(third.action, 'reported');
});

test('watchdog respects cooldown between attempts', async () => {
  const calls = [];
  const client = scriptedClient([faulty(['E02'])], calls);
  let clock = 0;
  const wd = new FaultWatchdog({
    client,
    wait: async () => {},
    now: () => clock,
    maxAttempts: 5,
    cooldownMs: 1000,
  });
  await wd.check(); // attempt 1 at t=0
  clock = 500; // within cooldown
  await wd.check(); // should NOT attempt again
  const restarts = calls.filter((c) => c[0] === 'restartCirculation').length;
  assert.equal(restarts, 1, 'cooldown should prevent a second restart');
});
