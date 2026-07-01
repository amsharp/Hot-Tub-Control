#!/usr/bin/env node
// Command-line control for the hot tub. Useful for setup, verifying the API
// works against your account, and managing schedules without the HTTP layer.
//
//   npm run cli -- devices              list devices on the account
//   npm run cli -- status               show current spa status
//   npm run cli -- dump                 print the raw attribute dictionary
//   npm run cli -- on                   power + heater + filter on
//   npm run cli -- off                  heater off (filter stays on)
//   npm run cli -- temp 38              set target temperature (°C)
//   npm run cli -- bubbles on|off       toggle bubbles
//   npm run cli -- schedules            list schedules
//   npm run cli -- schedule:add "Evening warmup" "0 17 * * *" on
//   npm run cli -- schedule:add "Night temp" "0 22 * * *" temp 36
//   npm run cli -- schedule:rm <id>
//   npm run cli -- schedule:run <id>
import { config, requireBestwayConfig } from './config.js';
import { BestwayClient } from './bestway/client.js';
import { Scheduler } from './scheduler/scheduler.js';
import { formatStatus } from './notify/notifier.js';

function makeClient() {
  requireBestwayConfig();
  return new BestwayClient({
    username: config.bestway.username,
    password: config.bestway.password,
    region: config.bestway.region,
    deviceId: config.bestway.deviceId,
  });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help') {
    printHelp();
    return;
  }

  // Schedule commands don't all need the network.
  if (cmd === 'schedules' || cmd.startsWith('schedule:')) {
    const scheduler = new Scheduler({ client: makeClient() });
    if (cmd === 'schedules') {
      const list = scheduler.list();
      if (!list.length) console.log('No schedules.');
      for (const s of list) {
        console.log(
          `${s.enabled ? '●' : '○'} ${s.id}  [${s.cron}]  ${s.action}` +
            `${s.action === 'temp' ? ` ${s.params.celsius}°C` : ''}  — ${s.name}`,
        );
      }
      return;
    }
    if (cmd === 'schedule:add') {
      const [name, expr, action, value] = args;
      const params = action === 'temp' ? { celsius: Number(value) } : {};
      const rec = scheduler.add({ name, cron: expr, action, params });
      console.log('Added schedule', rec.id);
      return;
    }
    if (cmd === 'schedule:rm') {
      console.log(scheduler.remove(args[0]) ? 'Removed.' : 'Not found.');
      return;
    }
    if (cmd === 'schedule:run') {
      const rec = scheduler.list().find((s) => s.id === args[0]);
      if (!rec) return console.log('Not found.');
      const status = await scheduler.runAction(rec);
      console.log(status ? formatStatus(status) : 'Ran (no status).');
      return;
    }
  }

  const client = makeClient();

  switch (cmd) {
    case 'devices': {
      const devices = await client.listDevices();
      for (const d of devices) {
        console.log(`${d.did}  ${d.product_name}  "${d.dev_alias}"  ${d.is_online ? 'online' : 'offline'}`);
      }
      if (!devices.length) console.log('No devices found on this account.');
      break;
    }
    case 'status': {
      const status = await client.getStatus();
      console.log(formatStatus(status));
      break;
    }
    case 'dump': {
      const status = await client.getStatus();
      console.log('Device:', status.deviceId, status.name);
      console.log('Raw attributes:');
      console.log(JSON.stringify(status.raw, null, 2));
      break;
    }
    case 'on':
      await client.setHeating(true);
      console.log('Heating on.');
      break;
    case 'off':
      await client.setHeating(false);
      console.log('Heating off.');
      break;
    case 'temp': {
      const applied = await client.setTargetTemperature(Number(args[0]), 'C');
      console.log(`Target temperature set to ${applied}°C.`);
      break;
    }
    case 'bubbles':
      await client.setBubbles(args[0] !== 'off');
      console.log(`Bubbles ${args[0] !== 'off' ? 'on' : 'off'}.`);
      break;
    case 'faults': {
      const status = await client.getStatus();
      if (!status.faults.length) console.log('No active faults.');
      for (const f of status.faults) {
        console.log(`${f.code}: ${f.meaning}${f.autoClearable ? ' (auto-clearable)' : ''}`);
      }
      break;
    }
    case 'recover': {
      console.log('Restarting circulation to clear a low-flow fault…');
      await client.restartCirculation();
      const status = await client.getStatus();
      console.log(formatStatus(status));
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp() {
  console.log(`Hot-Tub-Control CLI — control your Bestway Airjet hot tub.

  devices                       list devices on the account
  status                        show current spa status
  dump                          print the raw attribute dictionary
  on                            power + heater + filter on
  off                           heater off (filter stays on)
  temp <celsius>                set target temperature
  bubbles <on|off>              toggle bubbles
  faults                        list any active fault codes
  recover                       restart circulation to clear a low-flow fault
  schedules                     list schedules
  schedule:add <name> <cron> <action> [value]
  schedule:rm <id>              remove a schedule
  schedule:run <id>             run a schedule now

  actions: on | off | temp <c> | bubbles_on | bubbles_off
  cron is standard 5-field syntax, e.g. "0 17 * * *" = 17:00 daily`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exitCode = 1;
});
