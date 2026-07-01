// Served at /widget.js — the Scriptable widget body. `BASE` and `TOKEN` are
// provided by the tiny stub pasted into Scriptable, so this file can be updated
// server-side and the widget picks up changes on its next refresh (no
// re-pasting). No secrets live here.

// Google Home dark palette
const BG = new Color("#202124");
const PRIMARY = new Color("#e8eaed");
const SECOND = new Color("#9aa0a6");
const AMBER = new Color("#fdd663");
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
// One uniform inset on every side so all elements sit inside a safe rounded box
// and the top-right temp has equal whitespace to the top and side edges.
const PAD = 20;
w.setPadding(PAD, PAD, PAD, PAD);
w.url = BASE; // tap opens the full controls

let s = null;
let samples = [];
try { s = await getJSON(`/api/status?token=${TOKEN}`); } catch (e) {}
try { const h = await getJSON(`/api/history?token=${TOKEN}`); samples = (h && h.samples) || []; } catch (e) {}

if (!s) {
  const t = w.addText("Hot tub — offline");
  t.textColor = RED;
  t.font = Font.semiboldSystemFont(15);
} else {
  const heating = !!s.heat;
  const faulted = s.faults && s.faults.length;

  const top = w.addStack();
  const left = top.addStack();
  left.layoutVertically();
  const name = left.addText((s.name || "HOT TUB").toUpperCase());
  name.font = Font.boldSystemFont(16);
  name.textColor = PRIMARY;
  const statusTxt =
    (faulted ? "FAULT " + s.faults.map((f) => f.code).join(",") : heating ? "HEATING" : "IDLE") +
    "   ·   FILTER " + (s.filter ? "ON" : "OFF");
  const st = left.addText(statusTxt);
  st.font = Font.semiboldSystemFont(10);
  st.textColor = faulted ? RED : heating ? AMBER : SECOND;

  top.addSpacer();

  const right = top.addStack();
  right.layoutVertically();
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
  const chartH = fam === "large" ? 148 : 54;

  w.addSpacer(8);
  const img = samples.length >= 2 ? chartImage(samples, Math.round(s.targetTemp), 570, chartH * 2) : null;
  if (img) {
    const wi = w.addImage(img);
    wi.imageSize = new Size(285, chartH);
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
  const foot = w.addText(samples.length >= 2 ? "last 24h · set " + Math.round(s.targetTemp) + "°F" : "24h chart builds hourly");
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
