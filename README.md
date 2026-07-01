# Hot-Tub-Control — Bestway Airjet hot tub on Google Home

Schedule your **Bestway / Lay-Z-Spa Airjet** hot tub, set its temperature, and
control it by voice through **Google Home / Google Assistant** — plus an
automatic **low-flow (E02) fault watchdog** that restarts circulation and warns
you instead of letting the pump beep.

It's a small Node.js service that:

- Talks to your spa through the Bestway cloud (the same backend the **Bestway
  Smart Hub** app uses, which runs on the Gizwits IoT platform).
- Exposes itself to Google as a **standalone Smart Home Action** (a thermostat
  device with on/off + temperature), so no Home Assistant is required.
- Runs **schedules** (cron) to warm up / cool down / change temperature.
- Watches for faults in **real time** and auto-clears transient low-flow trips.

---

## What you can do

| Capability | How |
| --- | --- |
| "Hey Google, turn the hot tub on/off" | OnOff trait → power + heater + filter |
| "Hey Google, set the hot tub to 38 degrees" | TemperatureSetting trait |
| "Hey Google, what's the hot tub temperature?" | QUERY → current/target temp |
| Schedule warm-up / temperature changes | `schedule:add` (cron) |
| Auto-clear "low flow" (E02) beeping | Fault watchdog (real-time + polling) |
| Status + fault notifications | Webhook (ntfy/Slack/Discord/HA) |

---

## 1. Install & configure

```bash
npm install
cp .env.example .env      # then edit .env
```

### Tie *your* spa to the service

The service signs in to the Bestway cloud with **the same account you use in the
Bestway Smart Hub app**, then finds your spa automatically. In `.env`:

```ini
BESTWAY_USERNAME=you@example.com
BESTWAY_PASSWORD=your-app-password
BESTWAY_REGION=eu          # "eu" for UK/Europe, "us" for North America
```

If your account has **more than one device** (e.g. a spa and a pool filter), or
you just want to be explicit, pin the exact one by its device id:

```bash
npm run cli -- devices
# spa-abc123   Airjet   "Garden Spa"   online
# pool-def456  泳池过滤器  "Pool"        online
```

```ini
BESTWAY_DEVICE_ID=spa-abc123
```

Verify it all works before going further:

```bash
npm run cli -- status
# Garden Spa: 36°C (target 38°C) — power on, heating, filter on
```

> **If a value looks wrong** (some firmware uses slightly different attribute
> names), run `npm run cli -- dump` to print the raw attributes your pump
> reports and adjust `AIRJET_PROFILE.attrs` in `src/bestway/constants.js`.

---

## 2. Control & schedule from the command line

```bash
npm run cli -- on                 # power + heater + filter on
npm run cli -- off                # heater off (filter stays on)
npm run cli -- temp 38            # set target to 38°C
npm run cli -- bubbles on|off
npm run cli -- faults             # show any active fault codes
npm run cli -- recover            # manually restart circulation (clear E02)

# Schedules (standard 5-field cron):
npm run cli -- schedule:add "Evening warmup" "0 17 * * *" on
npm run cli -- schedule:add "Cool overnight" "0 23 * * *" temp 34
npm run cli -- schedules
npm run cli -- schedule:rm <id>
```

Schedules are stored in `data/schedules.json` and run by the long-lived server
(`npm start`).

---

## 3. Run the server

```bash
npm start
```

This starts the HTTP server (OAuth + Google fulfillment + admin API), the
scheduler, the fault watchdog, and the real-time listener. Deploy it somewhere
with a **public HTTPS URL** (a small VPS, a Raspberry Pi behind a tunnel like
Cloudflare Tunnel/ngrok, etc.) and set `PUBLIC_BASE_URL` to that URL.

Endpoints:

- `POST /fulfillment` — Google Smart Home webhook (Bearer-protected)
- `GET /oauth/authorize`, `POST /oauth/token` — account linking
- `GET /api/status`, `POST /api/control`, `…/api/schedules…`, `POST /api/recover`
  — admin API, protected by the `X-Admin-Token` header (defaults to
  `OAUTH_CLIENT_SECRET`, override with `ADMIN_TOKEN`)

---

## 3b. Deploy to Railway

The repo ships a `Dockerfile` and `railway.json`, so Railway builds and runs it
as an always-on service (it must stay up for the scheduler, watchdog, and the
real-time socket — don't use a platform that sleeps).

1. **Create the service** — in Railway: *New Project → Deploy from GitHub repo*
   and pick this repo/branch. It auto-detects the `Dockerfile`.
2. **Add a persistent volume** — *Service → Settings → Volumes → New Volume*,
   mount path **`/data`**. This is essential: without it, your Google link
   tokens and schedules are wiped on every redeploy. The Dockerfile already sets
   `DATA_DIR=/data`.
3. **Set environment variables** — *Service → Variables*, paste the contents of
   your `.env` (everything from `.env.example`). Notes:
   - **Don't set `PORT`** — Railway injects it; the app reads it automatically.
   - Leave `DATA_DIR=/data` (already the image default).
   - For Home Graph, the simplest path is to paste the service-account JSON into
     a variable and write it to a file at boot, or skip it (optional).
4. **Get your public URL** — *Settings → Networking → Generate Domain*. Use that
   `https://…up.railway.app` as `PUBLIC_BASE_URL` (add it as a variable and
   redeploy).
5. **Verify** — open `https://YOUR-URL/healthz` → `{"ok":true}`, then check the
   deploy logs for `Connected to spa: …`.

Then do the Google account-linking step below using your Railway domain.

> Rough cost: Railway's usage-based plan runs this tiny always-on service for a
> few dollars a month. Fly.io and a small VPS work the same way — attach a
> volume for `/data` and point `PUBLIC_BASE_URL` at the HTTPS domain.

## 4. Connect it to Google Home

This is a standard [Google Smart Home Action](https://developers.home.google.com/cloud-to-cloud).
One-time setup in the [Actions on Google Console](https://console.actions.google.com):

1. **Create a project** → type **Smart Home**.
2. **Build > Actions**: set the **Fulfillment URL** to
   `https://YOUR_DOMAIN/fulfillment`.
3. **Develop > Account linking**:
   - Linking type: **OAuth** / **Authorization code**.
   - **Client ID / Secret**: the values you put in `OAUTH_CLIENT_ID` /
     `OAUTH_CLIENT_SECRET`.
   - **Authorization URL**: `https://YOUR_DOMAIN/oauth/authorize`
   - **Token URL**: `https://YOUR_DOMAIN/oauth/token`
   - Scopes: a single scope, e.g. `spa`.
4. On your phone: **Google Home app → + → Works with Google → [test] your
   action**. Sign in with the `LINK_USERNAME` / `LINK_PASSWORD` you set. The
   "Hot tub" thermostat appears.

> The consent screen is a single-owner gate (just you). `LINK_USERNAME` /
> `LINK_PASSWORD` are what you type when linking; they are **not** your Bestway
> credentials.

### Optional: proactive state + auto re-sync (Home Graph)

To have the Google Home app reflect changes instantly (schedules, auto-recovery)
without re-querying, enable the **HomeGraph API** in Google Cloud, create a
service account, download its JSON key, and point `HOMEGRAPH_SERVICE_ACCOUNT_FILE`
at it. Everything works without this — it just makes the app feel live.

---

## 5. The low-flow (E02) fault watchdog

Airjet pumps throw **E02 "low flow"** when water isn't circulating fast enough
through the heater — and they **beep until it clears**. Often it's a transient
trip that a circulation restart fixes; sometimes it's physical (low water level
or a dirty filter), which software can't fix.

The watchdog handles both:

1. **Detects** the fault — in **real time** via the Gizwits push WebSocket
   (reacts within seconds), and as a safety net by **polling** every couple of
   minutes.
2. **Power-cycles circulation** — stops the heater + filter pump, pauses, then
   restarts the pump (and the heater if it was on). This clears transient trips
   and stops the beeping.
3. **Warns you** — sends a notification when it's clearing a fault, when it
   succeeds, and — after a few failed attempts — tells you it needs hands-on
   attention (check the water level and clean/replace the filter).

Tunable in `.env`:

```ini
AUTO_CLEAR_LOW_FLOW=true
WATCHDOG_INTERVAL_MIN=2     # polling backstop
WATCHDOG_MAX_ATTEMPTS=3     # auto-restarts before backing off
WATCHDOG_COOLDOWN_MIN=15    # min gap between attempts
REALTIME_ENABLED=true       # instant reaction via push socket
```

Only **E02** is auto-cleared by default; other faults (e.g. `earth`/ground
fault) are reported but never auto-actioned, since restarting won't help and
could be unsafe. Adjust `AUTO_CLEARABLE_CODES` in `src/bestway/constants.js` if
you want different behavior.

---

## Tests

```bash
npm test
```

Unit tests cover the Bestway client (status parsing, control payloads, token
reuse), the Google fulfillment (SYNC/QUERY/EXECUTE, unit conversion), the
watchdog (auto-clear, back-off, cooldown), and the real-time message handling —
all with injected fakes, so no network or real account is needed.

---

## How it's wired

```
Google Home ──HTTPS──▶ /fulfillment ─▶ smarthome.js ─▶ BestwayClient ─▶ Gizwits cloud ─▶ Spa
                       /oauth/*  (account linking)                         ▲
Scheduler (cron) ───────────────▶ BestwayClient ──────────────────────────┘
Gizwits push WebSocket ─▶ FaultWatchdog ─▶ restart circulation + notify
```

| Path | Responsibility |
| --- | --- |
| `src/bestway/client.js` | Bestway/Gizwits API (login, status, control, restart) |
| `src/bestway/constants.js` | API endpoints, Airjet attribute profile, fault codes |
| `src/bestway/realtime.js` | Gizwits push WebSocket listener |
| `src/google/smarthome.js` | SYNC / QUERY / EXECUTE fulfillment |
| `src/google/oauth.js` | OAuth2 account-linking server |
| `src/google/homegraph.js` | Optional proactive state / re-sync |
| `src/scheduler/scheduler.js` | Cron schedules |
| `src/recovery/watchdog.js` | Fault detection + auto-recovery |
| `src/server.js` / `src/index.js` | HTTP wiring / entrypoint |
| `src/cli.js` | Command-line control |

## Notes

The Bestway cloud has no official public API; the endpoints and attribute names
here were derived from the community
[`ha-bestway`](https://github.com/cdpuk/ha-bestway) integration. They can change
without notice — if something stops working, `npm run cli -- dump` is your
friend.
