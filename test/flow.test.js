import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlowModel } from '../src/flow.js';

// Default mapping: inlet=word2 (÷10 -> °C), outlet=word7 (°C). At 1320 W the
// grounded relation is f(L/min) = P / (69.8 · ΔT°C).
test('estimates flow from ΔT while the element fires', () => {
  const m = new FlowModel({ heaterW: 1320 });
  const r = m.compute({ filter: true, raw: { heat: 3, filter: 2, word2: 380, word7: 41 } });
  assert.equal(r.reliable, true);
  assert.equal(r.dTc, 3); // 41 − 38.0
  // 1320 / (4186 · 3) · 60 ≈ 6.3 L/min
  assert.ok(Math.abs(r.lpm - 6.3) < 0.2, `~6.3 L/min (${r.lpm})`);
});

test('no estimate when the heater is idle (heat=2) — keeps last good reading', () => {
  const m = new FlowModel({ heaterW: 1320 });
  m.compute({ filter: true, raw: { heat: 3, filter: 2, word2: 380, word7: 41 } }); // prime last
  const r = m.compute({ filter: true, raw: { heat: 2, filter: 2, word2: 400, word7: 40 } });
  assert.equal(r.reliable, false);
  assert.equal(r.lpm, null);
  assert.ok(r.last && r.last.lpm > 0, 'last good reading retained');
});

test('no estimate when the pump is off', () => {
  const m = new FlowModel({ heaterW: 1320 });
  const r = m.compute({ filter: false, raw: { heat: 3, filter: 0, word2: 380, word7: 41 } });
  assert.equal(r.reliable, false);
  assert.equal(r.lpm, null);
});

test('rising ΔT (clogging filter) reads as lower flow', () => {
  const m = new FlowModel({ heaterW: 1320 });
  const clean = m.compute({ filter: true, raw: { heat: 3, filter: 2, word2: 380, word7: 41 } }).lpm; // ΔT 3
  const clogged = m.compute({ filter: true, raw: { heat: 3, filter: 2, word2: 350, word7: 41 } }).lpm; // ΔT 6
  assert.ok(clogged < clean, `lower flow when ΔT widens (${clogged} < ${clean})`);
});

test('respects a configurable register mapping and power', () => {
  const m = new FlowModel({ heaterW: 2000, inlet: { key: 'word3', scale: 1 }, outlet: { key: 'word4', scale: 1 } });
  const r = m.compute({ filter: true, raw: { heat: 3, filter: 2, word3: 36, word4: 40 } });
  assert.equal(r.dTc, 4);
  assert.ok(Math.abs(r.lpm - 7.2) < 0.2, `2000/(4186·4)·60 ≈ 7.2 (${r.lpm})`);
});
