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

test('FIRST app press during peak registers as an override (transition detection)', async () => {
  const client = fakeClient();
  const ctl = new SmartHeatController({ client, planner: planner(), targetF: 104 });
  // 4 PM: controller kills everything for peak, confirmed next cycle.
  await ctl.onCycle(RUNNING, 104, true, { ...PEAK, nowMs: 0, min: 16 * 60 });
  await ctl.onCycle(OFF, 104, true, { ...PEAK, nowMs: 120_000, min: 16 * 60 + 2 });
  client.calls.length = 0;
  // 6 PM: the user turns it on in the Bestway app — ONE press.
  const plan = await ctl.onCycle(RUNNING, 102, true, { ...PEAK, nowMs: 2 * 3_600_000, min: 18 * 60 });
  assert.equal(plan.overridden, true, 'first press respected');
  assert.equal(client.calls.length, 0, 'nothing issued against the user');
});

test('our own ON taking effect is not misread as a user transition', async () => {
  const client = fakeClient();
  const ctl = new SmartHeatController({ client, planner: planner(), targetF: 104 });
  // Pre-heat window: controller issues ON while the pump is off.
  await ctl.onCycle(OFF, 100, true, { ...PREHEAT, nowMs: 0 });
  assert.ok(client.calls.includes('on'));
  // Next poll the pump is running — that's OUR command taking effect.
  const plan = await ctl.onCycle(RUNNING, 100, true, { ...PREHEAT, nowMs: 120_000 });
  assert.equal(plan.overridden, false, 'own command is not an override');
});

test('override state survives a restart via the injected store', async () => {
  const store = { data: {}, save() {} };
  const client = fakeClient();
  const ctl = new SmartHeatController({ client, planner: planner(), targetF: 104, store });
  await ctl.onCycle(RUNNING, 104, true, { ...PEAK, nowMs: 0, min: 16 * 60 });
  await ctl.onCycle(OFF, 104, true, { ...PEAK, nowMs: 120_000, min: 16 * 60 + 2 });
  await ctl.onCycle(RUNNING, 102, true, { ...PEAK, nowMs: 240_000, min: 16 * 60 + 4 }); // user override
  assert.ok(store.data.overrideUntil > 240_000, 'override persisted');

  // "Redeploy": a fresh controller from the same store must keep standing down.
  const client2 = fakeClient();
  const ctl2 = new SmartHeatController({ client: client2, planner: planner(), targetF: 104, store });
  const plan = await ctl2.onCycle(RUNNING, 102, true, { ...PEAK, nowMs: 360_000, min: 16 * 60 + 6 });
  assert.equal(plan.overridden, true, 'override remembered across restart');
  assert.equal(client2.calls.length, 0, 'does not fight the user after restart');
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
