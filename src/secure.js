// Constant-time secret comparison. `a !== b` short-circuits on the first
// differing byte, which is a (weak) timing oracle; timingSafeEqual avoids it.
// Length is compared first (unavoidably non-constant-time, but only leaks length,
// which for our high-entropy tokens is not sensitive).
import { timingSafeEqual } from 'node:crypto';

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
