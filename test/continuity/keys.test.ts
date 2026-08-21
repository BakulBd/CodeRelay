/**
 * Side-effect key determinism.
 *
 * The key is how "have I already done this?" is asked. Two failure modes matter
 * and both are silent: an unstable key makes a completed effect look new (it
 * gets repeated), and an over-broad key makes a legitimately repeated command
 * look like a duplicate (it gets skipped).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, computeSideEffectKey } from '../../src/continuity/entries.js';
import { stepId } from '../support/factories.js';

const STEP_A = stepId('step-1');
const STEP_B = stepId('step-2');

test('the key is stable across argument key ordering', async () => {
  // JSON.stringify would produce different bytes here; the key must not.
  const a = computeSideEffectKey(STEP_A, 'write_file', { path: 'a.ts', content: 'x' });
  const b = computeSideEffectKey(STEP_A, 'write_file', { content: 'x', path: 'a.ts' });
  assert.equal(a, b);
});

test('the key is stable across nested key ordering', async () => {
  const a = computeSideEffectKey(STEP_A, 'edit', { opts: { deep: 1, shallow: 2 }, path: 'a' });
  const b = computeSideEffectKey(STEP_A, 'edit', { path: 'a', opts: { shallow: 2, deep: 1 } });
  assert.equal(a, b);
});

test('array order is significant, since it changes the operation', async () => {
  const a = computeSideEffectKey(STEP_A, 'apply', { edits: ['x', 'y'] });
  const b = computeSideEffectKey(STEP_A, 'apply', { edits: ['y', 'x'] });
  assert.notEqual(a, b);
});

test('different content produces a different key', async () => {
  const a = computeSideEffectKey(STEP_A, 'write_file', { path: 'a.ts', content: 'x' });
  const b = computeSideEffectKey(STEP_A, 'write_file', { path: 'a.ts', content: 'y' });
  assert.notEqual(a, b);
});

test('different tools with identical args produce different keys', async () => {
  const a = computeSideEffectKey(STEP_A, 'write_file', { path: 'a.ts' });
  const b = computeSideEffectKey(STEP_A, 'delete_file', { path: 'a.ts' });
  assert.notEqual(a, b);
});

// The reason stepId is part of the hash: "run the tests again" is a real
// instruction, not a duplicate of the first run.
test('the same command in a later step is a distinct effect', async () => {
  const first = computeSideEffectKey(STEP_A, 'run_command', { cmd: 'pnpm test' });
  const second = computeSideEffectKey(STEP_B, 'run_command', { cmd: 'pnpm test' });
  assert.notEqual(first, second);
});

test('the key is a hex sha-256 digest', async () => {
  const key = computeSideEffectKey(STEP_A, 'write_file', { path: 'a.ts' });
  assert.match(key, /^[0-9a-f]{64}$/);
});

test('field boundaries cannot be forged by shifting text between fields', async () => {
  // Without a separator, ("ab", "c") and ("a", "bc") would hash identically.
  const a = computeSideEffectKey(stepId('ab'), 'c', null);
  const b = computeSideEffectKey(stepId('a'), 'bc', null);
  assert.notEqual(a, b);
});

test('canonicalJson sorts keys and normalizes undefined', async () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson([1, 'two', null]), '[1,"two",null]');
});

test('canonicalJson distinguishes an absent key from an explicit null', async () => {
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 1, b: null }));
});
