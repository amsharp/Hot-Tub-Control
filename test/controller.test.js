import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartHeatController } from '../src/thermal/controller.js';
import { SmartHeatPlanner } from '../src/thermal/planner.js';

// Planner with a fixed 2h heat-up and the default 4-9 PM peak.
function planner() {
  return new SmartHeatPlanner({
    model: { hoursToHeat: (from, to) => (from >= to ? 0 : 2) },
    targetF: 104,
    targetMin: 16 * 60,
    peaks: [{ start: 16 * 60, end: 21 * 60 }],
    safetyMin: 30,
  });
}

// Fake client that can be told to fail; records commands.
function fakeClient({ failing = false } = {}) {
  const calls = [];
  const c = {
    failing,
    calls,
    async setTargetTemperature() {
      if (c.failing) throw new Error('cloud down');
      calls.push('temp');
    },
    async setHeating() {
      if (c.failing) throw new Error('cloud down');
      calls.push('on');
    },
    async setAllOff() {
      if (c.failing) throw new Error('cloud down');
      calls.push('off');
    },
  };
  return c;
}

const RUNNING = { online: true, power: true, heat: true, filter: true };
const OFF = { online: true, power: false, heat: false, filter: false };
const PEAK = { nowMs: 0, min: 17 * 60, day: 1 }; // 5 PM
const PREHEAT = { nowMs: 0, min: 14 * 60, day: 1 }; // 2 PM, past 1:30 start

test('failed OFF command is retried, NOT treated as a manual override', async () => {
  const client = fakeClient({ failing: true });
  const ctl = new SmartHeatController({ client, planner: planner(), targetF: 104 });

  // Peak, tub running, command fails — cycle 1..3 keep retrying.
  for (let i = 1; i <= 3; i++) {
    const plan = await ctl.onCycle(RUNNING, 100, true, { ...PEAK, nowMs: i * 120_000 });
    assert.equal(plan.overridden, false, `cycle ${i} must not read as override`);
  }
  // Cloud recovers: the off command finally goes through.
  client.failing = false;
  await ctl.onCycle(RUNNING, 100, true, { ...PEAK, nowMs: 8 * 120_000 });
  assert.ok(client.calls.includes('off'), 'off re-issued after recovery');
});

test('command give-up notifies once and does not spam', async () => {
  const client = fakeClient({ failing: true });
  let notices = 0;
  const ctl = new SmartHeatController({
    client,
    planner: planner(),
    targetF: 104,
    maxRetries: 2,
    notify: async () => {
      notices += 1;
    },
  });
  for (let i = 1; i <= 6; i++) {
    await ctl.onCycle(RUNNING, 100, true, { ...PEAK, nowMs: i * 120_000 });
  }
  assert.equal(notices, 1, 'exactly one give-up notification');
});

test('a CONFIRMED off later contradicted IS a manual override', async () => {
  const client = fakeClient();
  const ctl = new SmartHeatController({ client, planner: planner(), targetF: 104 });

  await ctl.onCycle(RUNNING, 100, true, { ...PEAK, nowMs: 0 }); // issues off
  await ctl.onCycle(OFF, 100, true, { ...PEAK, nowMs: 120_000 }); // confirms
  // User turns it back on mid-peak via the SaluSpa app:
  const plan = await ctl.onCycle(RUNNING, 100, true, { ...PEAK, nowMs: 240_000 });
  assert.equal(plan.overridden, true, 'stands down for the user');
  // And it must NOT issue another off while overridden.
  const offCount = client.calls.filter((x) => x === 'off').length;
  assert.equal(offCount, 1);
});

test('failed ON during pre-heat keeps retrying instead of cancelling the day', async () => {
  const client = fakeClient({ failing: true });
  const ctl = new SmartHeatController({ client, planner: planner(), targetF: 104 });
  await ctl.onCycle(OFF, 100, true, { ...PREHEAT, nowMs: 0 }); // issue fails
  const plan = await ctl.onCycle(OFF, 100, true, { ...PREHEAT, nowMs: 120_000 });
  assert.equal(plan.overridden, false, 'no phantom override');
  client.failing = false;
  await ctl.onCycle(OFF, 100, true, { ...PREHEAT, nowMs: 240_000 });
  assert.ok(client.calls.includes('on'), 'heating re-issued after recovery');
});

test('device offline: no commands are sent and nothing is inferred', async () => {
  const client = fakeClient();
  const ctl = new SmartHeatController({ client, planner: planner(), targetF: 104 });
  const plan = await ctl.onCycle({ ...RUNNING, online: false }, 100, true, PEAK);
  assert.equal(client.calls.length, 0, 'no control writes while offline');
  assert.equal(plan.overridden, false);
});

test('machineAction() prevents watchdog recovery from reading as an override', async () => {
  const client = fakeClient();
  const ctl = new SmartHeatController({ client, planner: planner(), targetF: 104 });
  await ctl.onCycle(RUNNING, 100, true, { ...PEAK, nowMs: 0 }); // off issued
  await ctl.onCycle(OFF, 100, true, { ...PEAK, nowMs: 120_000 }); // confirmed
  ctl.machineAction(); // watchdog restarted circulation to clear a fault
  const plan = await ctl.onCycle(RUNNING, 100, true, { ...PEAK, nowMs: 240_000 });
  assert.equal(plan.overridden, false, 'machine action is not a user override');
  assert.equal(client.calls.filter((x) => x === 'off').length, 2, 're-asserts the plan');
});
