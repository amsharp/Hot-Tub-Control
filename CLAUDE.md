# CLAUDE.md

Guidance for an AI agent resuming work on this repo. Read this first.

## What this project is

**Hot-Tub-Control** lets the owner schedule, voice-control, and auto-recover a
**Bestway / Lay-Z-Spa "Airjet"** WiFi hot tub through **Google Home**. It is a
single long-running Node.js service that acts as a **standalone Google Smart
Home Action** (no Home Assistant). It also auto-clears the pump's **low-flow
(E02)** fault, which otherwise beeps until cleared.

> **History:** this codebase was originally developed in the `amsharp/Propulsion`
> repo and migrated here (the better-named home) on the
> `claude/hot-tub-railway-migration-xtdyt0` branch. The migration also fixed the
> Railway build (removed an unsupported Docker `VOLUME` instruction) and wired up
> Railway hosting. `amsharp/Propulsion` is now legacy.

Owner context (from the original conversation):
- Hardware: **Bestway Airjet** pump (classic Gizwits-cloud model, `product_name`
  `"Airjet"`). NOT the newer AWS-IoT "V02" models.
- Chosen approach: **standalone Google Smart Home Action** (not HA).
- Day-one scope: on/off scheduling, set temperature, status/notifications.
- Specifically requested: when it faults, **power-cycle to clear it and warn me**
  — and have the watchdog **trigger off the error in real time** (done via the
  Gizwits push WebSocket).
- Deployment target: **Railway** (Dockerfile + railway.json shipped).

## Critical constraints for the agent

- **Git branch:** develop and push ONLY to `claude/hot-tub-railway-migration-xtdyt0`.
  Always `git push -u origin claude/hot-tub-railway-migration-xtdyt0`.
- **GitHub scope:** this session's access is restricted to `amsharp/Hot-Tub-Control`,
  `amsharp/Propulsion`, and `amsharp/crespo-bot`. Do not read/search other repos.
- **Do NOT create a PR** unless the user explicitly asks.
- **Secrets:** never commit `.env`, tokens, or the Home Graph service-account
  JSON. Don't ask the user to paste account-level credentials into chat; prefer
  scoped tokens / dashboard entry. Never print/log/commit a secret value.
- **Model identity:** never put the model id in commits/PRs/code.

## Architecture (data flow)

```
Google Home ──HTTPS──▶ /fulfillment ─▶ google/smarthome.js ─▶ BestwayClient ─▶ Gizwits cloud ─▶ Spa
                       /oauth/*  (account linking, google/oauth.js)              ▲
Scheduler (node-cron) ─────────▶ BestwayClient ─────────────────────────────────┤
Gizwits push WebSocket ─▶ FaultWatchdog.handleRealtimeAttrs ─▶ restart + notify ─┘
Polling watchdog (every 2 min) ─▶ FaultWatchdog.check ───────────────────────────┘
```

## File map

| Path | Responsibility |
| --- | --- |
| `src/index.js` | Entrypoint: wires client + scheduler + watchdog + realtime + server, starts listening. |
| `src/server.js` | Express app: `/fulfillment` (Bearer), OAuth routes, `/api/*` admin (X-Admin-Token), `/healthz`. |
| `src/config.js` | Env/.env loader (no dotenv dep). All config in one object. `DATA_DIR` override for volumes. |
| `src/log.js` | Tiny leveled logger. |
| `src/store.js` | Atomic JSON-file persistence (used by oauth + schedules). Honors `config.dataDir`. |
| `src/bestway/constants.js` | Gizwits app id, regional roots, **Airjet attribute profile**, **fault codes + `detectFaults()`**. |
| `src/bestway/client.js` | `BestwayClient`: login/token, status (with faults), set temp/power/heat/filter/bubbles, `restartCirculation`. `fetchImpl` injectable. |
| `src/bestway/realtime.js` | `GizwitsRealtime` push WebSocket + pure `parseMessage`/`buildLoginFrame`. |
| `src/google/smarthome.js` | SYNC/QUERY/EXECUTE. Spa modeled as THERMOSTAT (OnOff + TemperatureSetting). C/F conversion. |
| `src/google/oauth.js` | Minimal OAuth2 auth-code server for Google account linking. |
| `src/google/homegraph.js` | Optional reportState/requestSync via service-account JWT. No-op if unconfigured. |
| `src/scheduler/scheduler.js` | `Scheduler`: cron jobs from `data/schedules.json`. Injectable `store` for tests. |
| `src/recovery/watchdog.js` | `FaultWatchdog`: detect → restart circulation → notify; back-off + cooldown; `trigger()` guard; `handleRealtimeAttrs`. |
| `src/notify/notifier.js` | `formatStatus` + webhook `notify`. |
| `src/cli.js` | CLI: devices/status/dump/on/off/temp/bubbles/faults/recover/schedule:*. |
| `test/*.test.js` | node:test suites (21 tests) with injected fakes; no network/account needed. |
| `Dockerfile`, `railway.json`, `.dockerignore` | Railway deploy. `DATA_DIR=/data`, healthcheck `/healthz`. |

## Reverse-engineered Bestway/Gizwits API (the crux — verify against real account)

Source of truth: community integration `github.com/cdpuk/ha-bestway`. The Bestway
cloud has no official public API and may change. Constants live in
`src/bestway/constants.js`.

- **Gizwits app id:** `98754e684ec045528b073876c34c7348` (header `X-Gizwits-Application-Id`).
- **API roots:** EU `https://euapi.gizwits.com`, US `https://usapi.gizwits.com`.
- **Login:** `POST /app/login` → `{uid, token, expire_at}`.
- **List devices:** `GET /app/bindings` → `{devices:[{did, product_name, ...}]}`.
- **Status:** `GET /app/devdata/{did}/latest` → `{attr:{...}}`.
- **Control:** `POST /app/control/{did}` body `{attrs:{key:value}}`.
- **Push WebSocket:** `wss://{host}:{wss_port}/ws/app/v1` (host/port from binding).

**Airjet attribute keys** (`AIRJET_PROFILE.attrs`): `temp_now`, `temp_set`,
`temp_set_unit` (0/C, 1/F), `power`, `heat_power`, `filter_power`, `wave_power`
(bubbles), `locked`. On/off values are 1/0. Temp clamps: C 20–40, F 68–104.

**Undocumented registers (original reverse-engineering, partially decoded):**
`word2`/`word5` ÷10 → °C and `word7` (°C) look like an inlet/outlet pair WHILE
the element fires (word2 ≈ 3 °C below water, word7 above; ΔT collapses to ~0.2 °C
at element-off) — the basis of the flow estimate (`src/flow.js`, ṁ = P/(c·ΔT),
P ≈ 1320 W nameplate, computed only at heat=3). **BUT the "word2 = bulk inlet"
reading was falsified live**: after element-off it kept climbing to 44.6 °C
(≈112 °F, tub at ~104 °F) with a negative "ΔT" — outside the firing state it
behaves like an internal/enclosure temp. `currentTemp` MUST come from `Tnow`
(which merely overshoots ~2 °F briefly after heater cutoff). The rawlog
(`/api/raw`) keeps capturing all states to finish the decode.
`heat` enum: 0=off, 2=on/idle, **3=element firing** (the only state drawing
heater watts), **4=target reached, element off** (E32=1 accompanies it).

**Fault codes** (`detectFaults`): keys matching `E\d{2}`, `system_err\d+`, or
`earth` that are truthy. **`E32` is NOT a fault** (means "target reached").
**`E02` = low water flow**, the only `AUTO_CLEARABLE_CODES` member by default.

## Commands

```bash
npm install
npm test                       # 21 tests, all pass, no network needed
npm start                      # run the full service
npm run cli -- status          # quick check against the real account (needs .env)
npm run cli -- dump            # print raw attrs — verify/fix attribute keys
npm run cli -- faults | recover
```

Config: copy `.env.example` → `.env`. Key vars: `BESTWAY_USERNAME/PASSWORD/REGION`,
optional `BESTWAY_DEVICE_ID`; `PUBLIC_BASE_URL`; `OAUTH_CLIENT_ID/SECRET`,
`LINK_USERNAME/PASSWORD`; watchdog (`AUTO_CLEAR_LOW_FLOW`, `WATCHDOG_*`,
`REALTIME_ENABLED`); `DATA_DIR` (point at a volume in prod); optional
`HOMEGRAPH_SERVICE_ACCOUNT_FILE`, `NOTIFY_WEBHOOK_URL`.

## Deployment (Railway)

Hosted on Railway via the account token documented in the `crespo-bot` repo's
CLAUDE.md (same Railway account). The token is **project/account-scoped** — it
can list and mutate projects but the GraphQL `me` query returns Not Authorized.
API endpoint: `https://backboard.railway.app/graphql/v2`, header
`Authorization: Bearer $RAILWAY_TOKEN`.

- **Project:** `incredible-solace` (id `fca5efd6-9bf8-480e-880d-381629b434af`).
- **Service:** hosts this repo (`amsharp/Hot-Tub-Control`), builder = Dockerfile.
- **Environment:** `production` (id `6a52b1ca-1ada-436a-b41b-d9c03be8a825`).

Setup steps performed by the migration:
1. Repointed the service source from `amsharp/Propulsion` → `amsharp/Hot-Tub-Control`.
2. Removed the unsupported Docker `VOLUME` line (Railway rejects it — that was the
   cause of the earlier `FAILED` builds).
3. Attach a **Railway Volume mounted at `/data`** so OAuth tokens + schedules
   survive redeploys (`DATA_DIR=/data` is set in the Dockerfile).
4. Set env vars (do NOT set `PORT`, Railway injects it), generate a domain, set
   `PUBLIC_BASE_URL` to it. Health check: `GET /healthz`.

**Bestway credentials are NOT set in Railway** (owner-only). Until
`BESTWAY_USERNAME/PASSWORD` are added in the Railway dashboard, the service boots
in degraded mode (no cloud login) but `/healthz` still returns 200, so the
deployment goes green. Add them + `PUBLIC_BASE_URL` to make it fully functional.

## Conventions

- ESM, Node ≥18.17 (Railway image uses node:22). No TypeScript.
- Minimal deps (only `express`, `node-cron`); tests use built-in `node:test`.
- Inject collaborators (`fetchImpl`, `store`, `wait`, `now`, `WebSocketImpl`) to
  keep units testable without network/timers — keep this pattern when extending.
- Run `npm test` before committing. End commit messages with the required
  Co-Authored-By / Claude-Session trailers.
