import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawLog } from '../src/rawlog.js';

function fakeStore() {
  return { data: { samples: [] }, save() {} };
}

test('captures state, water temp and candidate registers', () => {
  const r = new RawLog({ store: fakeStore() });
  const s = r.record(
    { raw: { power: 1, heat: 3, filter: 2, wave: 0, Tnow: 104, word2: 371, word7: 41, option5: 27136 } },
    1000,
  );
  assert.equal(s.t, 1000);
  assert.deepEqual(s.st, [1, 3, 2, 0]); // power, heat, filter, wave
  assert.equal(s.T, 104);
  assert.equal(s.word[2], 371);
  assert.equal(s.word[7], 41);
  assert.equal(s.opt[5], 27136);
  assert.equal(s.word.length, 8);
  assert.equal(s.opt.length, 8);
});

test('ignores a status with no raw block', () => {
  const r = new RawLog({ store: fakeStore() });
  assert.equal(r.record({}, 1), null);
  assert.equal(r.list().length, 0);
});

test('caps the ring buffer', () => {
  const r = new RawLog({ store: fakeStore() });
  for (let i = 0; i < 2600; i++) r.record({ raw: { Tnow: 100 } }, i);
  assert.ok(r.list().length <= 2500, `capped (${r.list().length})`);
});
