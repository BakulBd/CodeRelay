/**
 * Formatting.
 *
 * These look trivial, and one property in here is not: an absent value must
 * never render as a zero. Token usage is only observable on a live stream and is
 * deliberately never persisted, so a projection of a finished ledger has no
 * count — and a header that says "0 tokens" would be stating a measurement that
 * was never taken.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baseName,
  computeCost,
  formatCost,
  formatDuration,
  formatLineDelta,
  formatRelative,
  formatTokens,
  oneLine,
  plural,
  shortPath,
} from '../../src/ui/state/format.js';

test('an absent duration stays absent instead of becoming zero', () => {
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(Number.NaN), null);
  assert.equal(formatDuration(-1), null);
});

test('durations shorten as they grow, and never round up past the real time', () => {
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(940), '940ms');
  assert.equal(formatDuration(1_240), '1.2s');
  // Floored, not rounded: an elapsed clock must not display a time the task has
  // not reached yet.
  assert.equal(formatDuration(59_900), '59s');
  assert.equal(formatDuration(61_000), '1m 01s');
  assert.equal(formatDuration(3_661_000), '1h 01m');
});

test('an absent token count stays absent, and a real zero is still shown', () => {
  assert.equal(formatTokens(null), null);
  // Zero *observed* tokens is a measurement, unlike null, so it renders.
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(9_999), '9,999');
  assert.equal(formatTokens(12_500), '12.5K');
  assert.equal(formatTokens(2_400_000), '2.40M');
});

test('an undeclared price produces no cost rather than a free-looking zero', () => {
  // `resolveCapabilities` defaults costPerMTok* to 0 when the user declared no
  // price, so "$0.00" would present a missing declaration as a free model.
  assert.equal(computeCost(1_000, 1_000, 0, 0), null);
  assert.equal(formatCost(null), null);
  assert.equal(formatCost(0), null);
});

test('a declared price is applied per million tokens', () => {
  assert.equal(computeCost(1_000_000, 0, 3, 15), 3);
  assert.equal(computeCost(0, 1_000_000, 3, 15), 15);
  // One side declared is enough to make the total meaningful.
  assert.equal(computeCost(1_000_000, 1_000_000, 0, 15), 15);
});

test('a small cost keeps enough precision to be visible', () => {
  assert.equal(formatCost(0.0042), '$0.0042');
  assert.equal(formatCost(1.5), '$1.50');
});

test('relative times are coarse, and a skewed clock never reads as the future', () => {
  const now = Date.parse('2026-01-02T12:00:00.000Z');
  assert.equal(formatRelative(null, now), null);
  assert.equal(formatRelative('not a date', now), null);
  assert.equal(formatRelative('2026-01-02T11:59:30.000Z', now), 'just now');
  assert.equal(formatRelative('2026-01-02T11:30:00.000Z', now), '30m ago');
  assert.equal(formatRelative('2026-01-02T09:00:00.000Z', now), '3h ago');
  assert.equal(formatRelative('2026-01-01T09:00:00.000Z', now), 'yesterday');
  assert.equal(formatRelative('2025-12-28T09:00:00.000Z', now), '5d ago');
  // A ledger written by a machine whose clock is ahead. "in 3 hours" would be
  // absurd; "just now" is merely imprecise.
  assert.equal(formatRelative('2026-01-02T15:00:00.000Z', now), 'just now');
});

test('plurals agree with their count', () => {
  assert.equal(plural(1, 'file'), '1 file');
  assert.equal(plural(2, 'file'), '2 files');
  assert.equal(plural(0, 'file'), '0 files');
  assert.equal(plural(2, 'entry', 'entries'), '2 entries');
});

test('a line delta always shows both halves, so a zero is not ambiguous', () => {
  assert.equal(formatLineDelta(12, 5), '+12 \u22125');
  assert.equal(formatLineDelta(12, 0), '+12 \u22120');
  assert.equal(formatLineDelta(-3, -3), '+0 \u22120');
});

test('one-lining collapses newlines and marks its own clipping', () => {
  assert.equal(oneLine('a\n\n  b\t c '), 'a b c');
  const clipped = oneLine('x'.repeat(400), 40);
  assert.equal(clipped.length, 40);
  assert.ok(clipped.endsWith('\u2026'), 'clipping must be visible to the reader');
});

test('paths shorten to their tail, which is what identifies a file', () => {
  assert.equal(shortPath('src/auth.ts'), 'src/auth.ts');
  assert.equal(shortPath('a/b/c/d/auth.ts'), '\u2026/d/auth.ts');
  assert.equal(baseName('a/b/c/auth.ts'), 'auth.ts');
  assert.equal(baseName('auth.ts'), 'auth.ts');
});
