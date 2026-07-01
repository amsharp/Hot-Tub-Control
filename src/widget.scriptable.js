// Served at /widget.js — the Scriptable widget body. `BASE` and `TOKEN` are
// provided by the tiny stub pasted into Scriptable, so this file can be updated
// server-side and the widget picks up changes on its next refresh (no
// re-pasting). No secrets live here.

// Google Home dark palette
const BG = new Color("#202124");
const PRIMARY = new Color("#e8eaed");
const SECOND = new Color("#9aa0a6");
const AMBER = new Color("#fdd663");
const GREEN = new Color("#81c995"); // "maintain" — at target, heater idling
const RED = new Color("#f28b82");

async function getJSON(path) {
  // Cache-bust so each widget refresh pulls fresh data (iOS/URLCache can
  // otherwise serve a stale response).
  const sep = path.indexOf("?") >= 0 ? "&" : "?";
  const r = new Request(BASE + path + sep + "_=" + Date.now());
  r.timeoutInterval = 15;
  r.headers = { "Cache-Control": "no-cache" };
  return await r.loadJSON();
}

const w = new ListWidget();
w.backgroundColor = BG;
// E*TRADE-style insets: comfortable equal top/side margins, a touch more at the
// bottom so the footer clears the rounded corner. The chart runs nearly
// full-width within these margins.
w.setPadding(16, 16, 18, 16);
w.url = BASE; // tap opens the full controls

let s = null;
let samples = [];
let energy = null;
try { s = await getJSON(`/api/status?token=${TOKEN}`); } catch (e) {}
try { const h = await getJSON(`/api/history?token=${TOKEN}`); samples = (h && h.samples) || []; } catch (e) {}
try { energy = await getJSON(`/api/energy?token=${TOKEN}`); } catch (e) {}

if (!s) {
  const t = w.addText("Hot tub — offline");
  t.textColor = RED;
  t.font = Font.semiboldSystemFont(15);
} else {
  // Distinguish the element actively firing (raw heat 3 -> HEATING) from merely
  // holding at target (raw heat 2, or 4 = "target reached, element off" ->
  // MAINTAIN, low draw). The pump/circulation is the "filter" datapoint — PUMP.
  const rawHeat = s.raw && s.raw.heat != null ? Number(s.raw.heat) : s.heat ? 3 : 0;
  const firing = rawHeat === 3;
  const maintaining = rawHeat === 2 || rawHeat === 4;
  const pumpOn = s.raw && s.raw.filter != null ? Number(s.raw.filter) > 0 : !!s.filter;
  const faulted = s.faults && s.faults.length;

  const top = w.addStack();
  const left = top.addStack();
  left.layoutVertically();
  const name = left.addText((s.name || "HOT TUB").toUpperCase());
  name.font = Font.boldSystemFont(16);
  name.textColor = PRIMARY;
  const stateTxt = faulted
    ? "FAULT " + s.faults.map((f) => f.code).join(",")
    : firing
      ? "HEATING"
      : maintaining
        ? "MAINTAIN"
        : "IDLE";
  const st = left.addText(stateTxt + "   ·   PUMP " + (pumpOn ? "ON" : "OFF"));
  st.font = Font.semiboldSystemFont(10);
  st.textColor = faulted ? RED : firing ? AMBER : maintaining ? GREEN : SECOND;

  top.addSpacer();

  const right = top.addStack();
  right.layoutVertically();
  // currentTemp is bulk-accurate at the source now: the client derives it from
  // the inlet register (water drawn from the tub) and only falls back to the
  // overshoot-prone element-side Tnow if the register is unavailable.
  const big = right.addText(`${Math.round(s.currentTemp)}°F`);
  big.font = Font.boldSystemFont(28);
  big.textColor = PRIMARY;
  big.rightAlignText();
  const set = right.addText(`Set ${Math.round(s.targetTemp)}°F`);
  set.font = Font.semiboldSystemFont(11);
  set.textColor = SECOND;
  set.rightAlignText();

  // Size the chart to the widget: medium and large are the same width, large is
  // taller — so grow the chart height and let a flexible spacer bottom-align.
  const fam = typeof config !== "undefined" && config.widgetFamily ? config.widgetFamily : "medium";
  // Chart height tuned via the tools/widget-preview harness so the medium widget
  // fills vertically without the footer (power+flow line AND money line)
  // overflowing the rounded bottom corner.
  const chartH = fam === "large" ? 150 : 60;

  w.addSpacer(8);
  const img = samples.length >= 2 ? chartImage(samples, Math.round(s.targetTemp), 600, chartH * 2) : null;
  if (img) {
    const wi = w.addImage(img);
    wi.imageSize = new Size(300, chartH);
    wi.centerAlignImage();
  } else {
    w.addSpacer(Math.max(4, chartH / 2 - 8));
    const ph = w.addText("collecting hourly history…");
    ph.font = Font.systemFont(12);
    ph.textColor = SECOND;
    ph.centerAlignText();
    w.addSpacer(Math.max(4, chartH / 2 - 8));
  }

  w.addSpacer(); // push footer to the bottom edge

  // Live draw + estimated circulation flow on one line. Watts jump to ~1.3 kW
  // while the element fires and fall to the ~40 W pump at "maintain". Flow (from
  // the heater ΔT) is only measurable while firing; `shown` holds the last good
  // reading while idle but drops to 0 when the pump is off (no circulation).
  const powerParts = [];
  if (energy && energy.watts != null) powerParts.push(Math.round(energy.watts) + " W");
  if (s.flow && s.flow.shown != null) powerParts.push(s.flow.shown.toFixed(1) + " L/min");
  if (powerParts.length) {
    const pw = w.addText(powerParts.join("   ·   "));
    pw.font = Font.semiboldSystemFont(10);
    pw.textColor = energy && energy.watts >= 1000 ? AMBER : PRIMARY;
  }

  let footText;
  if (energy && energy.monthKwh != null) {
    footText = Math.round(energy.monthKwh) + " kWh · $" + (energy.monthCost || 0).toFixed(0) + " this month";
    if (energy.overrideCost >= 0.5) footText += "  ·  $" + energy.overrideCost.toFixed(0) + " override";
  } else {
    footText = samples.length >= 2 ? "last 24h" : "24h chart builds hourly";
  }
  const foot = w.addText(footText);
  foot.font = Font.systemFont(9);
  foot.textColor = SECOND;
}

// Hint iOS to refresh sooner (it still enforces its own budget/cadence).
w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);
Script.setWidget(w);
if (config.runsInApp) w.presentMedium();
Script.complete();

// Smooth (Catmull-Rom spline) temperature chart with a dashed target line.
function chartImage(samples, target, W, H) {
  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const n = samples.length;
  if (n < 2) return null;
  const fs = samples.map((p) => p.f);
  let lo = Math.min.apply(null, fs.concat([target]));
  let hi = Math.max.apply(null, fs.concat([target]));
  if (hi - lo < 6) { hi += 3; lo -= 3; }
  const padX = 6, padTop = 12, padBot = 10;
  const X = (i) => padX + (W - 2 * padX) * (i / (n - 1));
  const Y = (v) => padTop + (H - padTop - padBot) * (1 - (v - lo) / (hi - lo));
  const pts = samples.map((p, i) => new Point(X(i), Y(p.f)));

  const ty = Y(target);
  ctx.setStrokeColor(new Color("#5f6368"));
  ctx.setLineWidth(1.5);
  for (let x = padX; x < W - padX; x += 16) {
    const seg = new Path();
    seg.move(new Point(x, ty));
    seg.addLine(new Point(Math.min(x + 8, W - padX), ty));
    ctx.addPath(seg);
    ctx.strokePath();
  }

  const path = new Path();
  path.move(pts[0]);
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || pts[i + 1];
    const c1 = new Point(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6);
    const c2 = new Point(p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6);
    path.addCurve(p2, c1, c2);
  }
  ctx.setStrokeColor(AMBER);
  ctx.setLineWidth(3);
  ctx.addPath(path);
  ctx.strokePath();
  return ctx.getImage();
}
