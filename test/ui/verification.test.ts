/**
 * Verification wording.
 *
 * One assertion here matters more than the rest: "nothing to verify" must never
 * read as success. A project with no test script has not passed its tests, and
 * a panel implying otherwise would be believed exactly when it is least earned.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkGlyph,
  checkTone,
  describeUnavailable,
  describeVerdict,
} from '../../src/ui/state/verification.js';
import type { CheckResult, VerificationRun } from '../../src/verify/run.js';

const check = (over: Partial<CheckResult> = {}): CheckResult => ({
  id: 'test',
  label: 'Tests',
  command: 'npm test',
  status: 'passed',
  durationMs: 1_200,
  summary: 'Tests passed.',
  output: '',
  ...over,
});

const run = (over: Partial<VerificationRun> = {}): VerificationRun => ({
  verdict: 'verified',
  checks: [check()],
  unavailable: [],
  totalDurationMs: 1_200,
  ...over,
});

test('only a complete pass is a green tick', () => {
  const model = describeVerdict(run());
  assert.equal(model.label, 'Verified');
  assert.equal(model.tone, 'ok');
  assert.equal(model.glyph, '✓');
});

test('nothing to verify is an absence, never a pass', () => {
  const model = describeVerdict(
    run({ verdict: 'unverifiable', checks: [], unavailable: [{ id: 'test', reason: 'no script' }] }),
  );

  assert.equal(model.tone, 'muted', 'a muted tone, never the success colour');
  assert.notEqual(model.glyph, '✓');
  assert.match(model.label, /Nothing to verify/);
  assert.match(model.detail, /nothing it can run/i);
  assert.match(
    model.spoken,
    /has not been verified/i,
    'the spoken sentence must not let a screen reader hear this as success',
  );
});

test('a cancelled run is not verified even when nothing failed', () => {
  const model = describeVerdict(
    run({
      verdict: 'cancelled',
      checks: [check(), check({ id: 'build', label: 'Build', status: 'skipped' })],
    }),
  );

  assert.equal(model.label, 'Incomplete');
  assert.equal(model.tone, 'muted');
  assert.match(model.detail, /1 check passed, but one was never run/);
  assert.match(model.spoken, /has not been verified/i);
});

test('a stopped run that finished nothing says so plainly', () => {
  const model = describeVerdict(
    run({ verdict: 'cancelled', checks: [check({ status: 'skipped' })] }),
  );
  assert.match(model.detail, /stopped before anything finished/);
});

test('one failure names the check that failed', () => {
  const model = describeVerdict(
    run({ verdict: 'failed', checks: [check({ status: 'failed' })] }),
  );

  assert.equal(model.label, 'Not verified');
  assert.equal(model.tone, 'problem');
  assert.equal(model.detail, 'The tests check failed.');
});

test('several failures are listed, and unrun checks are mentioned', () => {
  const model = describeVerdict(
    run({
      verdict: 'failed',
      checks: [
        check({ id: 'typecheck', label: 'Types', status: 'failed' }),
        check({ status: 'errored' }),
        check({ id: 'build', label: 'Build', status: 'skipped' }),
      ],
    }),
  );

  assert.match(model.detail, /2 checks failed: types, tests/);
  assert.match(model.detail, /One later check was not run/);
});

test('a single passing check is phrased in the singular', () => {
  assert.match(describeVerdict(run()).detail, /The one check this project declares passed\./);
  assert.match(
    describeVerdict(run({ checks: [check(), check({ id: 'build', label: 'Build' })] })).detail,
    /All 2 checks/,
  );
});

test('undeclared checks are reported separately, and only when there are any', () => {
  assert.equal(describeUnavailable(run()), null, '"nothing missing" is noise');
  assert.equal(
    describeUnavailable(run({ unavailable: [{ id: 'lint', reason: 'no "lint" script' }] })),
    'Not declared by this project: lint',
  );
});

test('every status has a distinct glyph, and only a pass is the tick', () => {
  const glyphs = (['passed', 'failed', 'errored', 'skipped'] as const).map(checkGlyph);
  assert.equal(new Set(glyphs).size, 4, 'statuses must be distinguishable without colour');
  assert.equal(checkGlyph('passed'), '✓');
  assert.notEqual(checkGlyph('skipped'), '✓');

  assert.equal(checkTone('passed'), 'ok');
  assert.equal(checkTone('failed'), 'problem');
  assert.equal(checkTone('errored'), 'problem');
  assert.equal(checkTone('skipped'), 'muted');
});
