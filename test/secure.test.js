import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeEqual } from '../src/secure.js';

test('safeEqual matches equal strings, rejects any difference', () => {
  assert.equal(safeEqual('abc123def456', 'abc123def456'), true);
  assert.equal(safeEqual('abc123def456', 'abc123def457'), false);
  assert.equal(safeEqual('abc', 'abcd'), false); // different length
  assert.equal(safeEqual('x', undefined), false);
  assert.equal(safeEqual(undefined, ''), true); // both coerce to '' (callers must guard empties)
});
