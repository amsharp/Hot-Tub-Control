import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalPumpClient } from '../src/bestway/localClient.js';
import { FaultWatchdog } from '../src/recovery/watchdog.js';

// Fake MQTT transport: records publishes, lets tests push state frames.
function fakeTransport() {
  let handler = null;
  const published = [];
  return {
    published,
    publish(topic, msg) {
      published.push({ topic, msg: JSON.parse(msg) });
    },
    subscribe(_topic, h) {
      handler = h;
    },
    pushState(json) {
      handler(JSON.stringify(json));
    },
  };
}

test('getStatus throws until a state frame arrives, then mirrors the pump', async () => {
  const t = fakeTransport();
  const c = new LocalPumpClient({ transport: t });
  await assert.rejects(() => c.getStatus(), /No local pump state/);

  t.pushState({ temp: 102, target: 104, unit: 0, power: 1, heat: 3, pump: 2, air: 0 });
  const s = await c.getStatus();
  assert.equal(s.currentTemp, 102);
  assert.equal(s.targetTemp, 104);
  assert.equal(s.unit, 'F'); // Airjet inverted mapping: 0 -> F
  assert.equal(s.heat, true); // enum 3 -> on
  assert.equal(s.filter, true); // enum 2 -> on
  assert.equal(s.bubbles, false);
  assert.equal(s.online, true);
  assert.equal(s.deviceId, 'local');
});

test('an error field surfaces as a normalized fault (E02)', async () => {
  const t = fakeTransport();
  const c = new LocalPumpClient({ transport: t });
  t.pushState({ temp: 100, target: 104, unit: 0, power: 1, heat: 0, pump: 0, error: 'E02' });
  const s = await c.getStatus();
  assert.equal(s.faults.length, 1);
  assert.equal(s.faults[0].code, 'E02');
  assert.equal(s.faults[0].autoClearable, true);
});

test('control methods publish to the command topic; temp clamps to range', async () => {
  const t = fakeTransport();
  const c = new LocalPumpClient({ transport: t });
  await c.setHeating(true);
  const topics = new Set(t.published.map((p) => p.topic));
  assert.deepEqual([...topics], ['bwc/device/command']);
  const clamped = await c.setTargetTemperature(120, 'F'); // above 104 max
  assert.equal(clamped, 104);
});

test('restartCirculation runs the same off->settle->on->heat sequence as the cloud client', async () => {
  const t = fakeTransport();
  const order = [];
  // mapState not needed; assert on published attr writes in order.
  const c = new LocalPumpClient({ transport: t, wait: async () => {} });
  await c.restartCirculation({ settleMs: 1, restoreHeat: true });
  const attrs = t.published.map((p) => Object.keys(p.msg.attrs)[0] + '=' + Object.values(p.msg.attrs)[0]);
  // heat off, filter off, power on, filter on, heat on
  assert.deepEqual(attrs, ['heat=0', 'filter=0', 'power=1', 'filter=1', 'heat=1']);
});

test('drop-in: the FaultWatchdog drives the local client and auto-clears E02', async () => {
  const t = fakeTransport();
  const c = new LocalPumpClient({ transport: t, wait: async () => {} });
  // First read faults E02, restart clears it (we flip the state after the restart
  // sequence by watching for the power-on publish).
  t.pushState({ temp: 100, target: 104, unit: 0, power: 1, heat: 3, pump: 2, error: 'E02' });
  const origPublish = t.publish.bind(t);
  t.publish = (topic, msg) => {
    origPublish(topic, msg);
    const parsed = JSON.parse(msg);
    if (parsed.attrs && parsed.attrs.power === 1) {
      // circulation restarted -> pump clears the fault
      t.pushState({ temp: 100, target: 104, unit: 0, power: 1, heat: 3, pump: 2 });
    }
  };
  const wd = new FaultWatchdog({ client: c, autoClear: true, recheckDelayMs: 0, wait: async () => {} });
  const result = await wd.check();
  assert.equal(result.action, 'recovered');
});
