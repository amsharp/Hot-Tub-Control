# iOS widgets for the hot tub

A web page (the HUD) can't itself be an iOS Home Screen **widget** — widgets need
a native app. But you can get the tub into your widgets two ways, both driven by
the service's plain-URL API:

- `GET /api/status?token=TOKEN` → JSON status (for a **display** widget)
- `GET /api/q?token=TOKEN&action=...` → run a command (for **control** buttons)

Replace `BASE` and `TOKEN` below with your service URL and admin token.

## A) Control buttons — Apple Shortcuts (built-in)

Each control is a one-action shortcut you can drop in the **Shortcuts widget** or
onto the Home Screen.

1. Shortcuts app → **+** → **Add Action** → **Get Contents of URL**.
2. Set the URL (method stays GET), e.g. turn the heater on:
   `BASE/api/q?token=TOKEN&action=heat&on=1`
3. Rename the shortcut (e.g. "Heater On") and pick an icon/color.
4. Repeat for the others:

| Shortcut | URL query |
| --- | --- |
| Power on / off | `action=power&on=1` / `action=power&on=0` |
| Heater on / off | `action=heat&on=1` / `action=heat&on=0` |
| Filter on / off | `action=filter&on=1` / `action=filter&on=0` |
| Heat everything on | `action=on` |
| Everything off | `action=off` |
| Set 104 °F | `action=temp&f=104` |

Add them via the **Shortcuts** widget (long-press Home Screen → **+** →
Shortcuts) — tapping a tile runs it. They also work as Home Screen icons.

## B) Status widget — Scriptable (free App Store app)

Install **Scriptable**, make a new script, paste this (set `BASE`/`TOKEN`), then
add a Scriptable widget to your Home Screen and point it at this script.

```javascript
const BASE = "https://propulsion-production.up.railway.app";
const TOKEN = "PUT-YOUR-ADMIN-TOKEN-HERE";

const w = new ListWidget();
w.backgroundColor = new Color("#e7e2d9");
w.url = BASE; // tapping the widget opens the full HUD
try {
  const req = new Request(`${BASE}/api/status?token=${TOKEN}`);
  req.timeoutInterval = 15;
  const s = await req.loadJSON();

  const title = w.addText((s.name || "Hot Tub").toUpperCase());
  title.font = Font.mediumSystemFont(12);
  title.textColor = new Color("#8a8378");
  w.addSpacing(6);

  const t = w.addText(`${Math.round(s.currentTemp)}°F`);
  t.font = Font.boldSystemFont(34);
  t.textColor = new Color("#6d675e");

  const tgt = w.addText(`target ${Math.round(s.targetTemp)}°F`);
  tgt.font = Font.systemFont(11);
  tgt.textColor = new Color("#8a8378");
  w.addSpacing(6);

  const faulted = s.faults && s.faults.length;
  const row = w.addText(
    `${s.heat ? "🔥 heating" : "heat off"} · ${s.filter ? "filter on" : "filter off"}`
  );
  row.font = Font.systemFont(11);
  row.textColor = faulted ? new Color("#a23a30") : new Color("#1f9d9d");
  if (faulted) {
    const f = w.addText("⚠ " + s.faults.map((x) => x.code).join(", "));
    f.font = Font.boldSystemFont(11);
    f.textColor = new Color("#a23a30");
  }
} catch (e) {
  const err = w.addText("Hot tub: offline");
  err.textColor = new Color("#a23a30");
}
w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
Script.setWidget(w);
if (config.runsInApp) w.presentSmall();
Script.complete();
```

> Keep `TOKEN` private — anyone with the URL + token can control the tub. Rotate
> it by changing `ADMIN_TOKEN` in the Railway dashboard.
