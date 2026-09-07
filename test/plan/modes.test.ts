/**
 * Composer modes.
 *
 * This module exists because four of the six modes were decorative — they set a
 * label and changed nothing. So the load-bearing test here is the exhaustive
 * one: every mode the picker offers must have a real consequence, or the
 * control is lying about what it did.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyMode, behaviourFor, type Mode } from '../../src/plan/modes.js';
import { TASK_ROLES } from '../../src/policy/select.js';

/** Every mode the webview's picker can produce. */
const ALL_MODES: readonly Mode[] = [
  'code',
  'architect',
  'ask',
  'build',
  'plan',
  'debug',
  'review',
  'test',
];

test('every mode maps to a real role', () => {
  for (const mode of ALL_MODES) {
    const behaviour = behaviourFor(mode);
    assert.ok(
      TASK_ROLES.includes(behaviour.role),
      `${mode} maps to "${behaviour.role}", which is not a role the selector knows`,
    );
  }
});

test('every mode except the plain coding ones changes the objective', () => {
  // `code` and `build` deliberately add nothing: an unqualified instruction
  // should reach the model unqualified.
  const decorative = ALL_MODES.filter(
    (mode) => behaviourFor(mode).directive === null && mode !== 'code' && mode !== 'build',
  );
  assert.deepEqual(
    decorative,
    [],
    'a mode that changes nothing is a control that lies about what it did',
  );
});

test('the default mode adds no preamble at all', () => {
  assert.equal(applyMode('code', 'fix the bug'), 'fix the bug');
  assert.equal(applyMode('build', 'fix the bug'), 'fix the bug');
});

test('a directive is prepended, and the objective survives intact', () => {
  const applied = applyMode('debug', 'the signup form 500s');
  assert.match(applied, /^\[DEBUG MODE\]/);
  assert.ok(applied.endsWith('the signup form 500s'));
});

test('read-only modes are marked as such', () => {
  for (const mode of ['ask', 'review', 'plan', 'architect'] as const) {
    assert.equal(behaviourFor(mode).writes, false, `${mode} must not be marked as writing`);
  }
  for (const mode of ['code', 'build', 'debug', 'test'] as const) {
    assert.equal(behaviourFor(mode).writes, true, `${mode} writes`);
  }
});

// --- the roles actually differ per mode ------------------------------------

test('modes route to the role that matches what they are for', () => {
  assert.equal(behaviourFor('debug').role, 'debug');
  assert.equal(behaviourFor('test').role, 'test');
  assert.equal(behaviourFor('review').role, 'review');
  assert.equal(behaviourFor('plan').role, 'plan');
  assert.equal(behaviourFor('architect').role, 'plan');
  assert.equal(behaviourFor('code').role, 'code');
});

// --- the debug workflow is the point of debug mode ------------------------

test('debug mode requires reproduction before a hypothesis', () => {
  const directive = behaviourFor('debug').directive ?? '';

  // The order is the whole value: reading a trace, guessing, editing and
  // declaring success is the failure this mode exists to prevent.
  const reproduce = directive.indexOf('Reproduce');
  const hypothesis = directive.indexOf('hypothesis');
  const verify = directive.indexOf('Re-run');

  assert.ok(reproduce >= 0 && hypothesis >= 0 && verify >= 0);
  assert.ok(reproduce < hypothesis, 'reproduce before hypothesising');
  assert.ok(hypothesis < verify, 'verify after changing');
  assert.match(directive, /do not guess/i, 'an unreproducible bug must stop the workflow');
});

test('review mode forbids padding the findings list', () => {
  assert.match(behaviourFor('review').directive ?? '', /nothing worth reporting/i);
});

test('test mode forbids bending the code to make a test pass', () => {
  const directive = behaviourFor('test').directive ?? '';
  assert.match(directive, /Never change application code to make a test pass/i);
});

test('plan and architect modes both refuse to implement', () => {
  assert.match(behaviourFor('plan').directive ?? '', /do not implement/i);
  assert.match(behaviourFor('architect').directive ?? '', /Do NOT write or modify/);
});

test('directives stay short enough to be worth sending every turn', () => {
  for (const mode of ALL_MODES) {
    const directive = behaviourFor(mode).directive;
    if (directive === null) {
      continue;
    }
    assert.ok(
      directive.length < 900,
      `${mode}'s directive is ${directive.length} chars — tokens spent on every single turn`,
    );
  }
});
