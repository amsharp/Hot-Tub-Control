# Local control (cloud-free) — the "own your pump" path

This is the honest conclusion of the firmware investigation (2026-07-03,
adversarially verified): **you cannot upload firmware to this pump to gain any
new capability.** There are two brains — the **CIO MCU** (mains, heater, temp
sensor, the E02 flow paddle; a sealed, non-reflashable black box) and the
**ESP32-C3 WiFi module** (only speaks the display-bus vocabulary the CIO
exposes). Every upload path is a dead end:

| Path | Verdict |
| --- | --- |
| MITM the Gizwits OTA / spoof an edited image | Refuted. Reaches only the C3 module (never the CIO); no staged image exists for legacy `Airjet_V01`; MQTTS+likely-signed blocks the MITM. |
| Reflash the ESP32-C3 in place | Refuted. May be eFuse-locked; even if done, never touches the CIO → no new E02 behavior, no new sensors. |
| Gizwits MCU-OTA to the CIO | Impossible. The CIO doesn't run the Gizwits MCU-OTA bootloader; bricking it kills the sole 120V/heater/safety controller. |

And goal "richer flow data" is dead at the hardware level regardless: the flow
sensor is a **binary reed/paddle switch**, not an analog transducer. The only
way to get analog flow is to add a physical flow meter (see the ifm/turbine
notes in chat).

## What actually works

Insert a **separate ESP8266** running **visualapproach BWC**
(`WiFi-remote-for-Bestway-Lay-Z-SPA`) **inline on the CIO↔display 6-wire bus**.
It emulates the panel: reads all display state, injects button presses, exposes
everything over local MQTT. It reflashes nothing; the CIO and every safety
interlock stay untouched.

Delivers: **local instant E02 power-cycle clearing** and **full cloud-free
control**. Does NOT deliver analog flow (hardware ceiling) and is not privileged
CIO access (it can only power-cycle, same as our cloud `restartCirculation`).

**Unconfirmed for this SKU:** BWC's proven protocol variants are EU/UK 230V
models. A US 120V `Airjet_V01` (CIO `D4H10603`) is *not* confirmed — the bus
dialect must be captured and matched live before this is known-good.

## BOM

- **ESP8266** (NodeMCU 1.0 / Wemos D1 mini). BWC is ESP8266-only — you cannot
  reuse the pump's ESP32-C3.
- **Bidirectional level shifter** (BSS138-based red LLC; avoid the TXS0108E blue
  one). Cleanest: visualapproach's "Bestway Wireless Controller 2" PCB (OSHWLab).
- Two 6-pin 2.54mm/JST-SM connectors matching the pump's display ribbon.
- 5V+GND tapped from the CIO; data-line pull-ups per the BWC build doc.

## Wiring & firmware

Unplug the 6-wire ribbon between CIO and display. `CIO → ESP-in`,
`ESP-out → display`. Flash BWC via PlatformIO; in its web UI select the 6-wire
model and let it auto-detect CIO_2021 / CIO_2021_HJT / CIO_54149E. **First real
step: capture the bus and confirm one variant decodes this pump.**

Mains-adjacent work: unplug from the wall before opening the enclosure. Voids
warranty.

## Integrating with this service (already built + tested)

The transport is the only thing that changes; the whole model stays.
`src/bestway/localClient.js` (`LocalPumpClient`) implements the **same interface**
as `BestwayClient` (`getStatus`, `setHeating`, `setTargetTemperature`,
`setBubbles`, `setAllOff`, `restartCirculation`, …) but over an injected
MQTT-like transport instead of Gizwits HTTPS. Status normalization is shared
with the cloud client via `normalizeStatus()` in `constants.js`, so unit
inversion, on/off enums, and fault detection are identical. `test/localclient.test.js`
proves a `FaultWatchdog` drives it and auto-clears E02 unchanged.

Remaining work when hardware is on the bench:
1. Point `transport` at the BWC MQTT broker (add a small `mqtt` wiring at the
   edge — the client itself stays dependency-free).
2. Confirm BWC's real **state-JSON keys** and **command schema** against the
   live device and adjust `mapState` / `buildCommand` (defaults are best-guess,
   like `AIRJET_PROFILE` was before it was verified).
3. Inject `LocalPumpClient` where `BestwayClient` is constructed in `index.js`.
   Everything above the client interface (scheduler, Google Home, energy,
   PumpHealth, smart-heat controller) needs no change.

## Safety (non-negotiable)

Every interlock — mains switching, heater/pump relays, dry-fire/overheat
protection, the E02 latch — stays in the untouched CIO. That's *why* this path
is low-risk. Never pursue reflashing the CIO. Keep the watchdog's
back-off/cooldown/notify-on-repeat: a rapidly re-latching E02 is a real low-flow
condition (clog / low water / failing pump), and the heater must stay off — do
not blind-loop the power-cycle. If a bus toggle can't fully reset a hard E02 the
way a mains disconnect does, add an ESP-driven relay on the wall plug rather
than touching CIO firmware.

Sources: visualapproach/WiFi-remote-for-Bestway-Lay-Z-SPA (README, DeepWiki,
discussions #111/#428, OSHWLab BWC2 PCB); Gizwits MCU-OTA/GAgent-OTA docs;
Espressif ESP32-C3 Secure Boot v2 + flash-encryption; cdpuk/ha-bestway.
