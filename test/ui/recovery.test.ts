/**
 * The recovery log.
 *
 * `buildRecoveryLog` is pure, so every line it produces is asserted exactly.
 * The cases are the claims CodeRelay makes about itself — "this task survived
 * three provider failures" — and a log that overstated them would be worse than
 * no log, because it would be believed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRecoveryLog,
  clockTime,
  summarizeRecovery,
} from '../../src/ui/state/recovery.js';
import type { LedgerEntry } from '../../src/continuity/entries.js';
import type { AttemptId, ModelRef, StepId, TaskId } from '../../src/core/types.js';

const TASK = 'task-1' as TaskId;
const SONNET: ModelRef = { providerId: 'anthropic', modelId: 'claude-sonnet-4' };
const GPT: ModelRef = { providerId: 'openai', modelId: 'gpt-5' };

let seq = 0;

/** A ledger entry with the bookkeeping filled in. */
function entry<T extends LedgerEntry['type']>(
  type: T,
  rest: Omit<Extract<LedgerEntry, { type: T }>, keyof BaseFields | 'type'>,
  at = '2026-09-06T09:41:00.000Z',
): LedgerEntry {
  seq += 1;
  return {
    taskId: TASK,
    stepId: `${TASK}#turn-1` as StepId,
    attemptId: `${TASK}#turn-1-attempt-1` as AttemptId,
    seq,
    at,
    type,
    ...rest,
  } as LedgerEntry;
}

interface BaseFields {
  taskId: TaskId;
  stepId: StepId;
  attemptId: AttemptId;
  seq: number;
  at: string;
}

/** A local time string for a given hour and minute, whatever the runner's zone. */
function localAt(hour: number, minute: number): string {
  const d = new Date(2026, 8, 6, hour, minute, 0);
  return d.toISOString();
}

const streaming = (model: ModelRef, credentialId = 'k1', at?: string): LedgerEntry =>
  entry('STREAMING', { model, credentialId }, at);

// --- the headline claims ---------------------------------------------------

test('a clean task produces no recovery headline', () => {
  const log = buildRecoveryLog({
    entries: [streaming(SONNET), entry('TASK_DONE', {})],
  });

  assert.equal(log.failureCount, 0);
  assert.equal(log.switchCount, 0);
  assert.equal(
    summarizeRecovery(log),
    null,
    'manufacturing "0 recoveries" draws attention to the absence of a problem',
  );
});

test('a task that survived a failover says so, exactly', () => {
  const log = buildRecoveryLog({
    entries: [
      streaming(SONNET),
      entry('FAILED', { errorClass: 'RETRYABLE', message: '429', hadStreamedTokens: false }),
      entry('RECOVERING', { decision: 'SWITCH_MODEL' }),
      entry('PROVIDER_SWITCHED', { from: SONNET, to: GPT, reason: 'Rate limited.' }),
      streaming(GPT, 'k2'),
      entry('TASK_DONE', {}),
    ],
  });

  assert.equal(log.failureCount, 1);
  assert.equal(log.switchCount, 1);
  assert.deepEqual(log.modelsUsed, ['claude-sonnet-4', 'gpt-5']);
  assert.equal(summarizeRecovery(log), 'Survived 1 failure · 1 model switch · 2 models');
});

test('counts are pluralised correctly', () => {
  const log = buildRecoveryLog({
    entries: [
      streaming(SONNET),
      entry('FAILED', { errorClass: 'NETWORK', message: 'reset', hadStreamedTokens: false }),
      entry('PROVIDER_SWITCHED', { from: SONNET, to: GPT, reason: 'Unreachable.' }),
      streaming(GPT, 'k2'),
      entry('FAILED', { errorClass: 'NETWORK', message: 'reset', hadStreamedTokens: false }),
      entry('PROVIDER_SWITCHED', { from: GPT, to: SONNET, reason: 'Also unreachable.' }),
      streaming(SONNET),
    ],
  });
  assert.equal(summarizeRecovery(log), 'Survived 2 failures · 2 model switches · 2 models');
});

// --- collapsing the noise --------------------------------------------------

test('a model working many turns produces one line, not one per turn', () => {
  const log = buildRecoveryLog({
    entries: [streaming(SONNET), streaming(SONNET), streaming(SONNET), streaming(SONNET)],
  });

  const working = log.events.filter((e) => e.kind === 'working');
  assert.equal(working.length, 1, 'twenty "still working" lines would bury the ones that matter');
  assert.equal(working[0]?.detail, 'started work');
});

test('the worker is re-announced after a failure, even on the same model', () => {
  const log = buildRecoveryLog({
    entries: [
      streaming(SONNET),
      entry('FAILED', { errorClass: 'RETRYABLE', message: '503', hadStreamedTokens: false }),
      entry('RECOVERING', { decision: 'RETRY_SAME' }),
      streaming(SONNET),
    ],
  });

  const working = log.events.filter((e) => e.kind === 'working');
  assert.equal(working.length, 2, 'a reader needs to be told the task was picked back up');
  assert.equal(working[1]?.detail, 'picked the task up');
});

test('a change of key is a change of worker', () => {
  const log = buildRecoveryLog({
    entries: [streaming(SONNET, 'k1'), streaming(SONNET, 'k2')],
  });
  assert.equal(log.events.filter((e) => e.kind === 'working').length, 2);
});

test('ordinary progress entries never reach the recovery log', () => {
  const log = buildRecoveryLog({
    entries: [
      entry('TASK_STARTED', { objective: 'do a thing' }),
      streaming(SONNET),
      entry('STREAM_PROGRESS', { textSoFar: 'half a thought' }),
      entry('MODEL_RESPONSE_COMPLETED', { model: SONNET, reason: 'stop', text: 'done' }),
    ],
  });

  assert.deepEqual(
    log.events.map((e) => e.kind),
    ['working'],
    'the recovery log is not a second copy of the timeline',
  );
});

// --- the distinctions that must never blur ---------------------------------

test('a cancellation is never presented as a failure', () => {
  const log = buildRecoveryLog({
    entries: [streaming(SONNET), entry('TASK_ABANDONED', { reason: 'Cancelled by the user.' })],
  });

  const last = log.events.at(-1);
  assert.equal(last?.kind, 'cancelled');
  assert.equal(last?.tone, 'muted');
  assert.equal(last?.label, 'Stopped by you');
  assert.equal(log.failureCount, 0, 'pressing stop is not a provider failure');
  assert.match(last?.spoken ?? '', /you stopped the task/i);
});

test('giving up is presented as a failure, with the reason', () => {
  const log = buildRecoveryLog({
    entries: [
      streaming(SONNET),
      entry('TASK_ABANDONED', { reason: 'No model could be reached.' }),
    ],
  });

  const last = log.events.at(-1);
  assert.equal(last?.kind, 'abandoned');
  assert.equal(last?.tone, 'problem');
  assert.equal(last?.detail, 'No model could be reached.');
});

test('a failure that had already streamed output says so', () => {
  const log = buildRecoveryLog({
    entries: [
      streaming(SONNET),
      entry('FAILED', { errorClass: 'NETWORK', message: 'reset', hadStreamedTokens: true }),
    ],
  });

  const failure = log.events.find((e) => e.kind === 'failed');
  assert.equal(failure?.detail, 'partial output had already arrived');
});

test('a switch names both models and carries the reason', () => {
  const log = buildRecoveryLog({
    entries: [
      entry('PROVIDER_SWITCHED', {
        from: SONNET,
        to: GPT,
        reason: 'Every key for this provider is rate limited.',
      }),
    ],
  });

  const switched = log.events[0];
  assert.equal(switched?.label, 'claude-sonnet-4 → gpt-5');
  assert.equal(switched?.detail, 'Every key for this provider is rate limited.');
  assert.match(switched?.spoken ?? '', /moved from claude-sonnet-4 to gpt-5/);
});

test('an escalation shows the question it is waiting on', () => {
  const log = buildRecoveryLog({
    entries: [entry('ESCALATED', { question: 'Overwrite the existing file?', sideEffectKey: null })],
  });

  assert.equal(log.events[0]?.kind, 'escalated');
  assert.equal(log.events[0]?.detail, 'Overwrite the existing file?');
});

// --- checkpoints -----------------------------------------------------------

test('checkpoints are counted, never interleaved into the sequence', () => {
  const log = buildRecoveryLog({
    entries: [streaming(SONNET), entry('TASK_DONE', {})],
    checkpointCount: 12,
  });

  assert.equal(log.checkpointCount, 12);
  assert.ok(
    log.events.every((e) => e.kind !== 'completed' || e.label === 'Task complete'),
  );
  assert.equal(
    log.events.some((e) => /checkpoint/i.test(e.label)),
    false,
    'a Checkpoint carries no timestamp, so placing one between two entries would be invented',
  );
});

test('no repository and no checkpoints are different answers', () => {
  const noGit = buildRecoveryLog({ entries: [] });
  const gitButNone = buildRecoveryLog({ entries: [], checkpointCount: 0 });

  assert.equal(noGit.checkpointCount, null, '"cannot be asked" is not "none were taken"');
  assert.equal(gitButNone.checkpointCount, 0);
});

// --- time ------------------------------------------------------------------

test('times are shown as local HH:MM', () => {
  const log = buildRecoveryLog({ entries: [streaming(SONNET, 'k1', localAt(9, 41))] });
  assert.equal(log.events[0]?.time, '09:41');
});

test('an unreadable timestamp yields no time rather than an invented one', () => {
  assert.equal(clockTime('not-a-date'), '');
  assert.equal(clockTime(''), '');

  const log = buildRecoveryLog({ entries: [streaming(SONNET, 'k1', 'nonsense')] });
  assert.equal(
    log.events[0]?.time,
    '',
    'a line reading 00:00 would state a time nobody recorded',
  );
});

test('midnight and single-digit times are zero-padded', () => {
  assert.equal(clockTime(localAt(0, 5)), '00:05');
  assert.equal(clockTime(localAt(23, 59)), '23:59');
});

// --- shape -----------------------------------------------------------------

test('every event carries a glyph, a tone and a spoken sentence', () => {
  const log = buildRecoveryLog({
    entries: [
      streaming(SONNET),
      entry('FAILED', { errorClass: 'RETRYABLE', message: '429', hadStreamedTokens: false }),
      entry('RECOVERING', { decision: 'SWITCH_MODEL' }),
      entry('PROVIDER_SWITCHED', { from: SONNET, to: GPT, reason: 'Rate limited.' }),
      entry('ESCALATED', { question: 'Continue?', sideEffectKey: null }),
      entry('TASK_DONE', {}),
    ],
  });

  assert.ok(log.events.length >= 6);
  const ids = new Set<string>();
  for (const event of log.events) {
    assert.equal(event.glyph.length, 1, `${event.kind} needs exactly one glyph character`);
    assert.ok(event.label.length > 0, `${event.kind} needs a label`);
    assert.ok(event.spoken.length > 0, `${event.kind} needs a spoken sentence`);
    assert.equal(ids.has(event.id), false, 'ids must be unique so the client can patch rows');
    ids.add(event.id);
  }
});

test('modelsUsed counts models that did work, not models merely named in a switch', () => {
  const log = buildRecoveryLog({
    entries: [entry('PROVIDER_SWITCHED', { from: SONNET, to: GPT, reason: 'Rate limited.' })],
  });

  assert.deepEqual(
    log.modelsUsed,
    [],
    'a model the task moved to but never streamed from has not done any work',
  );
  assert.equal(log.switchCount, 1);
});
