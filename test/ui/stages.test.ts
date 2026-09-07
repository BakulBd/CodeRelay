/**
 * The task pipeline view.
 *
 * A diagram that can drift from what happened is worse than no diagram, so the
 * tests here are all about the derivation: which evidence produces which state,
 * and — most importantly — which states cannot be reached by the agent simply
 * asserting it has finished.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveStages,
  stagesWorthShowing,
  type StageId,
  type StageInput,
  type StageState,
} from '../../src/ui/state/stages.js';
import type { TaskProjection } from '../../src/ui/state/project.js';

function projection(over: Partial<TaskProjection> = {}): TaskProjection {
  return {
    header: {
      title: 'Add input validation',
      status: 'running',
      model: null,
      elapsedMs: 1_000,
      turns: 1,
      attempts: 1,
      filesChanged: 0,
      lastActivity: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    },
    nodes: [],
    changes: [],
    pendingQuestion: null,
    lastFailure: null,
    requirements: [],
    recovery: {
      events: [],
      switchCount: 0,
      failureCount: 0,
      modelsUsed: [],
      checkpointCount: null,
    },
    ...over,
  } as TaskProjection;
}

const input = (over: Partial<StageInput> = {}): StageInput => ({
  projection: projection(),
  live: false,
  contextFileCount: null,
  verdict: null,
  ...over,
});

const stateOf = (stages: readonly { id: StageId; state: StageState }[], id: StageId) =>
  stages.find((s) => s.id === id)?.state;

const change = (path: string): TaskProjection['changes'][number] => ({
  path,
  kind: 'modified',
  bytesBefore: 100,
  bytesAfter: 120,
  provenance: 'observed',
});

test('no task means no pipeline', () => {
  assert.deepEqual(deriveStages(input({ projection: null })), []);
});

test('the six stages appear in order', () => {
  assert.deepEqual(
    deriveStages(input()).map((s) => s.id),
    ['understand', 'plan', 'context', 'execute', 'verify', 'complete'],
  );
});

// --- what cannot be asserted away -----------------------------------------

test('a finished task with nothing verified is not complete', () => {
  const stages = deriveStages(
    input({
      projection: projection({ header: { ...projection().header, status: 'completed' } }),
      verdict: null,
    }),
  );

  assert.equal(
    stateOf(stages, 'complete'),
    'active',
    'the agent saying it finished is an assertion, not evidence',
  );
  assert.match(stages.find((s) => s.id === 'complete')?.detail ?? '', /Nothing has verified/);
});

test('a finished task that passed verification is complete', () => {
  const stages = deriveStages(
    input({
      projection: projection({ header: { ...projection().header, status: 'completed' } }),
      verdict: 'verified',
    }),
  );
  assert.equal(stateOf(stages, 'complete'), 'done');
});

test('a finished task whose checks failed is not complete', () => {
  const stages = deriveStages(
    input({
      projection: projection({ header: { ...projection().header, status: 'completed' } }),
      verdict: 'failed',
    }),
  );
  assert.equal(stateOf(stages, 'complete'), 'active');
  assert.equal(stateOf(stages, 'verify'), 'failed');
});

test('a project with no checks leaves verify pending, not skipped', () => {
  const stages = deriveStages(input({ verdict: 'unverifiable' }));
  assert.equal(
    stateOf(stages, 'verify'),
    'pending',
    'nobody chose to skip it; the project simply declares none',
  );
});

test('a cancelled verification does not mark verify done', () => {
  assert.equal(stateOf(deriveStages(input({ verdict: 'cancelled' })), 'verify'), 'pending');
});

// --- skipped vs pending ----------------------------------------------------

test('a task with no plan shows planning as not needed, not incomplete', () => {
  const stages = deriveStages(input());
  assert.equal(
    stateOf(stages, 'plan'),
    'skipped',
    'most tasks are one edit; drawing that as deficient is wrong',
  );
});

test('requirements from a plan mark planning done and count them', () => {
  const stages = deriveStages(
    input({
      projection: projection({
        requirements: [
          { id: 'r1', text: 'Login works', mentions: [] },
          { id: 'r2', text: 'Logout works', mentions: [] },
        ],
      }),
    }),
  );
  assert.equal(stateOf(stages, 'plan'), 'done');
  assert.match(stages.find((s) => s.id === 'plan')?.detail ?? '', /2 requirements/);
});

// --- execute and context ---------------------------------------------------

test('execute is pending until a file actually changes', () => {
  assert.equal(stateOf(deriveStages(input()), 'execute'), 'pending');
  assert.equal(
    stateOf(deriveStages(input({ projection: projection({ changes: [change('a.ts')] }) })), 'execute'),
    'done',
  );
});

test('a running task with no writes yet is active, not pending', () => {
  const stages = deriveStages(input({ live: true }));
  assert.equal(stateOf(stages, 'execute'), 'active');
  assert.match(stages.find((s) => s.id === 'execute')?.detail ?? '', /nothing written yet/);
});

test('context is pending until a set is built, never inferred from reads', () => {
  assert.equal(stateOf(deriveStages(input()), 'context'), 'pending');
  assert.equal(stateOf(deriveStages(input({ contextFileCount: 8 })), 'context'), 'done');
});

test('a context set of zero files is still a set that was built', () => {
  const stages = deriveStages(input({ contextFileCount: 0 }));
  assert.equal(stateOf(stages, 'context'), 'done');
  assert.match(stages.find((s) => s.id === 'context')?.detail ?? '', /0 files selected/);
});

// --- terminal states -------------------------------------------------------

test('a stopped task and a failed task do not read alike', () => {
  const stopped = deriveStages(
    input({ projection: projection({ header: { ...projection().header, status: 'stopped' } }) }),
  );
  assert.equal(stateOf(stopped, 'complete'), 'failed');
  assert.match(stopped.find((s) => s.id === 'complete')?.detail ?? '', /You stopped/);

  const failed = deriveStages(
    input({ projection: projection({ header: { ...projection().header, status: 'failed' } }) }),
  );
  assert.match(
    failed.find((s) => s.id === 'complete')?.detail ?? '',
    /did not finish/,
    'pressing stop and CodeRelay giving up are different events',
  );
});

test('a task still going after a recovery says so', () => {
  const stages = deriveStages(
    input({
      projection: projection({
        recovery: { ...projection().recovery, failureCount: 1, switchCount: 1 },
      }),
    }),
  );
  assert.match(stages.find((s) => s.id === 'complete')?.detail ?? '', /after recovering/);
});

// --- shape and honesty -----------------------------------------------------

test('every stage carries a glyph and a spoken sentence, and only done is a tick', () => {
  const stages = deriveStages(input({ contextFileCount: 3, verdict: 'verified' }));
  for (const stage of stages) {
    assert.equal(stage.glyph.length, 1, `${stage.id} needs one glyph character`);
    assert.ok(stage.spoken.length > 0, `${stage.id} needs a spoken sentence`);
    assert.ok(stage.detail.length > 0, `${stage.id} needs a detail`);
    if (stage.glyph === '✓') {
      assert.equal(stage.state, 'done', `${stage.id} is ticked without being done`);
    }
  }
});

test('the understand stage claims only that an objective was recorded', () => {
  const detail = deriveStages(input())[0]?.detail ?? '';
  assert.match(detail, /Objective recorded/);
  assert.ok(!/understood/i.test(detail), 'CodeRelay cannot observe comprehension');
});

test('a long objective is truncated rather than overflowing the row', () => {
  const stages = deriveStages(
    input({
      projection: projection({
        header: { ...projection().header, title: 'x'.repeat(200) },
      }),
    }),
  );
  assert.ok((stages[0]?.detail.length ?? 0) < 100);
  assert.match(stages[0]?.detail ?? '', /…/);
});

// --- when it is worth showing at all --------------------------------------

test('a simple task does not get a pipeline diagram', () => {
  assert.equal(stagesWorthShowing(input()), false);
  assert.equal(
    stagesWorthShowing(input({ projection: projection({ changes: [change('a.ts')] }) })),
    false,
    'one edit is not worth six rows of diagram',
  );
});

test('a plan, a recovery, several files or a verification all make it worth showing', () => {
  assert.equal(
    stagesWorthShowing(
      input({ projection: projection({ requirements: [{ id: 'r1', text: 'x', mentions: [] }] }) }),
    ),
    true,
  );
  assert.equal(
    stagesWorthShowing(
      input({
        projection: projection({ recovery: { ...projection().recovery, failureCount: 1 } }),
      }),
    ),
    true,
  );
  assert.equal(
    stagesWorthShowing(
      input({
        projection: projection({ changes: [change('a.ts'), change('b.ts'), change('c.ts')] }),
      }),
    ),
    true,
  );
  assert.equal(stagesWorthShowing(input({ verdict: 'verified' })), true);
});
