/**
 * Projection.
 *
 * These are the honesty tests for the interface. The ledger is an append-only
 * record whose whole purpose is to distinguish what happened from what might
 * have happened, and a view that flattens that distinction would undo the
 * property the rest of the codebase is built to preserve. So the assertions
 * below are mostly about what the UI must *not* claim:
 *
 * - four ledger entries describing one write are one card, not four rows;
 * - a reconciled effect is marked inferred, never presented as observed;
 * - a user cancellation is not reported as a failure;
 * - a file created and then deleted is not reported as a change;
 * - a question that has been superseded is no longer pending.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  projectChanges,
  projectStatus,
  projectTask,
  argumentPaths,
} from '../../src/ui/state/project.js';
import { KEY, callId, fp, history, stepId } from '../support/factories.js';

const MODEL = { providerId: 'anthropic', modelId: 'claude-x' };
const OTHER = { providerId: 'openai', modelId: 'gpt-x' };

/** The full lifecycle of one successful write, as the runner records it. */
const writeLifecycle = (path: string, before: string | null, after: string) =>
  [
    {
      type: 'TOOL_REQUESTED' as const,
      toolCallId: callId('c1'),
      toolName: 'write_file',
      args: { path, content: 'x' },
      sideEffectKey: KEY,
      safety: 'idempotent' as const,
    },
    {
      type: 'TOOL_EXECUTING' as const,
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      safety: 'idempotent' as const,
      preState: [fp(path, before)],
      expectedPostState: [fp(path, after)],
    },
    {
      type: 'TOOL_COMPLETED' as const,
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      ok: true,
      resultSummary: `wrote 3 bytes to ${path}`,
      postState: [fp(path, after)],
    },
  ] as const;

// --- one operation, one card ---

test('the three entries of one tool call collapse into a single card', () => {
  const entries = history(
    { type: 'TASK_STARTED', objective: 'edit auth' },
    ...writeLifecycle('src/auth.ts', 'old', 'new'),
  );

  const { nodes } = projectTask(entries);
  const tools = nodes.filter((n) => n.kind === 'tool');

  assert.equal(tools.length, 1, 'write-ahead bookkeeping must not appear as three rows');
  const [card] = tools;
  assert.ok(card && card.kind === 'tool');
  assert.equal(card.status, 'ok');
  assert.equal(card.toolName, 'write_file');
  assert.deepEqual(card.targets, ['src/auth.ts']);
  assert.match(card.summary ?? '', /wrote 3 bytes/);
});

test('a card keeps a stable id across its whole lifecycle, so the view can patch it', () => {
  const [requested, executing, completed] = writeLifecycle('a.ts', null, 'h');
  const atRequest = projectTask(history(requested!)).nodes[0];
  const atEnd = projectTask(history(requested!, executing!, completed!)).nodes[0];

  assert.ok(atRequest && atEnd);
  assert.equal(atRequest.id, atEnd.id, 'a changing id would force a full re-render');
});

test('a tool card advances through pending, running, then settled', () => {
  const [requested, executing, completed] = writeLifecycle('a.ts', null, 'h');

  const pending = projectTask(history(requested!)).nodes[0];
  const running = projectTask(history(requested!, executing!)).nodes[0];
  const done = projectTask(history(requested!, executing!, completed!)).nodes[0];

  assert.ok(pending?.kind === 'tool' && running?.kind === 'tool' && done?.kind === 'tool');
  assert.equal(pending.status, 'pending');
  assert.equal(running.status, 'running');
  assert.equal(done.status, 'ok');
});

test('a duration is measured from execution, not from the request', () => {
  // The fixture spaces entries one second apart. Executing is entry 1 and
  // completion is entry 2, so the tool itself took one second — the time spent
  // waiting for the model to finish asking is not the tool's duration.
  const entries = history(...writeLifecycle('a.ts', null, 'h'));
  const card = projectTask(entries).nodes[0];
  assert.ok(card?.kind === 'tool');
  assert.equal(card.durationMs, 1_000);
});

// --- observed vs inferred ---

test('a reconciled effect is marked inferred and never reads as observed', () => {
  const [requested, executing] = writeLifecycle('src/auth.ts', 'old', 'new');
  const entries = history(requested!, executing!, {
    type: 'TOOL_RECONCILED',
    toolCallId: callId('c1'),
    sideEffectKey: KEY,
    evidence: 'workspace already matches the expected post-state',
  });

  const card = projectTask(entries).nodes[0];
  assert.ok(card?.kind === 'tool');
  assert.equal(card.status, 'adopted');
  assert.equal(card.provenance, 'inferred', 'an inference must not be presented as a fact');
  assert.match(card.summary ?? '', /already matches/);
});

test('a completed tool is observed, because the tool itself reported', () => {
  const card = projectTask(history(...writeLifecycle('a.ts', null, 'h'))).nodes[0];
  assert.ok(card?.kind === 'tool');
  assert.equal(card.provenance, 'observed');
});

test('an unpredictable outcome is flagged, because that is what forces a question', () => {
  const entries = history({
    type: 'TOOL_EXECUTING',
    toolCallId: callId('c1'),
    sideEffectKey: KEY,
    safety: 'unsafe',
    preState: [fp('a.ts', 'h')],
    expectedPostState: null,
  });
  const card = projectTask(entries).nodes[0];
  assert.ok(card?.kind === 'tool');
  assert.equal(card.unpredictable, true);
});

// --- turns ---

test('streaming progress folds into its turn instead of adding rows', () => {
  const entries = history(
    { type: 'STREAMING', model: MODEL, credentialId: 'c' },
    { type: 'STREAM_PROGRESS', textSoFar: 'hello' },
    { type: 'STREAM_PROGRESS', textSoFar: 'hello world' },
  );

  const { nodes } = projectTask(entries);
  assert.equal(nodes.length, 1, 'one row per few hundred characters would bury everything else');
  assert.ok(nodes[0]?.kind === 'turn');
  assert.equal(nodes[0].streamedChars, 11);
  assert.equal(nodes[0].done, false);
});

test('a completed turn carries its stop reason and text', () => {
  const entries = history(
    { type: 'STREAMING', model: MODEL, credentialId: 'c' },
    { type: 'MODEL_RESPONSE_COMPLETED', model: MODEL, reason: 'truncated', text: 'half a th' },
  );
  const node = projectTask(entries).nodes[0];
  assert.ok(node?.kind === 'turn');
  assert.equal(node.done, true);
  assert.equal(node.stopReason, 'truncated');
  assert.equal(node.text, 'half a th');
});

// --- status ---

test('a user cancellation is reported as stopped, not as a failure', () => {
  // The loop records a cancellation as TASK_ABANDONED, which is right for the
  // ledger. Rendering it as "failed" would blame CodeRelay for the user's choice.
  const cancelled = history({ type: 'TASK_ABANDONED', reason: 'Cancelled by the user.' });
  const gaveUp = history({ type: 'TASK_ABANDONED', reason: 'no model can serve this task' });

  assert.equal(projectStatus(cancelled, false), 'stopped');
  assert.equal(projectStatus(gaveUp, false), 'failed');
});

test('an escalated task is awaiting a decision, which is a resting state not an error', () => {
  const entries = history({ type: 'ESCALATED', question: 'did it run?', sideEffectKey: KEY });
  assert.equal(projectStatus(entries, false), 'awaiting');
});

test('a ledger that stops mid-flight is interrupted, and resumable', () => {
  const entries = history(
    { type: 'TASK_STARTED', objective: 'o' },
    { type: 'STREAMING', model: MODEL, credentialId: 'c' },
  );
  assert.equal(projectStatus(entries, false), 'interrupted');
});

test('a task running in this window reads as running even though its ledger looks unfinished', () => {
  // Entries are written *ahead* of the actions they describe, so the ledger
  // always trails the loop. Trusting the file over the live session would show a
  // running task as interrupted.
  const entries = history({ type: 'STREAMING', model: MODEL, credentialId: 'c' });
  assert.equal(projectStatus(entries, true), 'running');
});

test('a terminal entry outranks liveness, so a finished task is never shown as running', () => {
  assert.equal(projectStatus(history({ type: 'TASK_DONE' }), true), 'completed');
});

test('an empty ledger is empty, not running', () => {
  assert.equal(projectStatus([], false), 'empty');
});

// --- header ---

test('the header reports the objective, the current model and the step count', () => {
  const entries = history(
    { type: 'TASK_STARTED', objective: 'add pagination' },
    { type: 'STREAMING', model: MODEL, credentialId: 'c' },
    { type: 'PROVIDER_SWITCHED', from: MODEL, to: OTHER, reason: 'rate limited' },
    { type: 'STREAMING', model: OTHER, credentialId: 'c2', stepId: stepId('step-2') },
  );

  const { header } = projectTask(entries);
  assert.equal(header.title, 'add pagination');
  assert.deepEqual(header.model, OTHER, 'the header must name who is working now');
  assert.equal(header.turns, 2);
  assert.equal(header.attempts, 2);
});

test('token usage is absent rather than zero when it was never observed', () => {
  const { header } = projectTask(history({ type: 'TASK_DONE' }));
  assert.equal(header.inputTokens, null);
  assert.equal(header.outputTokens, null);
  assert.equal(header.costUsd, null);
});

test('a finished task stops its clock at the last entry', () => {
  const entries = history(
    { type: 'TASK_STARTED', objective: 'o' },
    { type: 'TASK_DONE' },
  );
  // Fixture entries are one second apart; `now` is deliberately far later, and
  // must not extend the duration of a task that already ended.
  const { header } = projectTask(entries, { now: Date.parse('2030-01-01T00:00:00Z') });
  assert.equal(header.elapsedMs, 1_000);
});

test('a running task measures to now', () => {
  const entries = history({ type: 'TASK_STARTED', objective: 'o' });
  const start = Date.parse(entries[0]!.at);
  const { header } = projectTask(entries, { live: true, now: start + 5_000 });
  assert.equal(header.elapsedMs, 5_000);
});

// --- changes ---

test('a write is reported as a modification, with the sizes it recorded', () => {
  const changes = projectChanges(history(...writeLifecycle('src/auth.ts', 'old', 'new')));
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], {
    path: 'src/auth.ts',
    kind: 'modified',
    bytesBefore: 42,
    bytesAfter: 42,
    provenance: 'observed',
  });
});

test('a file that did not exist before is an addition', () => {
  const changes = projectChanges(history(...writeLifecycle('src/new.ts', null, 'h')));
  assert.equal(changes[0]?.kind, 'added');
});

test('a file whose content ends absent is a deletion', () => {
  const entries = history(
    {
      type: 'TOOL_EXECUTING',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      safety: 'idempotent',
      preState: [fp('gone.ts', 'h')],
      expectedPostState: [fp('gone.ts', null)],
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'deleted gone.ts',
      postState: [fp('gone.ts', null)],
    },
  );
  assert.equal(projectChanges(entries)[0]?.kind, 'deleted');
});

test('a file created and then deleted is not reported as a change at all', () => {
  // Net effect, not event count: the workspace ends as it began, so claiming a
  // change would send the user to a diff with nothing in it.
  const entries = history(
    {
      type: 'TOOL_EXECUTING',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      safety: 'idempotent',
      preState: [fp('tmp.ts', null)],
      expectedPostState: [fp('tmp.ts', 'h')],
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'wrote tmp.ts',
      postState: [fp('tmp.ts', 'h')],
    },
    {
      type: 'TOOL_EXECUTING',
      toolCallId: callId('c2'),
      sideEffectKey: KEY,
      safety: 'idempotent',
      preState: [fp('tmp.ts', 'h')],
      expectedPostState: [fp('tmp.ts', null)],
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: callId('c2'),
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'deleted tmp.ts',
      postState: [fp('tmp.ts', null)],
    },
  );
  assert.deepEqual(projectChanges(entries), []);
});

test('two writes to one file are a single change against the original state', () => {
  const entries = history(
    {
      type: 'TOOL_EXECUTING',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      safety: 'idempotent',
      preState: [fp('a.ts', 'v0')],
      expectedPostState: [fp('a.ts', 'v1')],
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'w',
      postState: [fp('a.ts', 'v1')],
    },
    {
      type: 'TOOL_EXECUTING',
      toolCallId: callId('c2'),
      sideEffectKey: KEY,
      safety: 'idempotent',
      preState: [fp('a.ts', 'v1')],
      expectedPostState: [fp('a.ts', 'v2')],
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: callId('c2'),
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'w',
      postState: [fp('a.ts', 'v2')],
    },
  );

  const changes = projectChanges(entries);
  assert.equal(changes.length, 1, 'one file is one row however many times it was written');
  assert.equal(changes[0]?.kind, 'modified');
});

test('a read leaves no change, because a pure tool records no post-state', () => {
  const entries = history(
    {
      type: 'TOOL_REQUESTED',
      toolCallId: callId('c1'),
      toolName: 'read_file',
      args: { path: 'a.ts' },
      sideEffectKey: KEY,
      safety: 'pure',
    },
    {
      type: 'TOOL_EXECUTING',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      safety: 'pure',
      preState: [],
      expectedPostState: null,
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'contents',
      postState: [],
    },
  );
  assert.deepEqual(projectChanges(entries), []);
});

test('a change known only from reconciliation is marked inferred', () => {
  const [requested, executing] = writeLifecycle('src/auth.ts', 'old', 'new');
  const entries = history(requested!, executing!, {
    type: 'TOOL_RECONCILED',
    toolCallId: callId('c1'),
    sideEffectKey: KEY,
    evidence: 'workspace already matches',
  });

  const changes = projectChanges(entries);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.provenance, 'inferred');
});

test('changes are grouped additions, then edits, then deletions', () => {
  const entries = history(
    {
      type: 'TOOL_EXECUTING',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      safety: 'idempotent',
      preState: [fp('z-mod.ts', 'a'), fp('a-new.ts', null)],
      expectedPostState: [fp('z-mod.ts', 'b'), fp('a-new.ts', 'c')],
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'w',
      postState: [fp('z-mod.ts', 'b'), fp('a-new.ts', 'c')],
    },
  );

  assert.deepEqual(
    projectChanges(entries).map((c) => c.kind),
    ['added', 'modified'],
  );
});

// --- questions and failures ---

test('a pending question is surfaced only while it is still unanswered', () => {
  const asked = history(
    { type: 'TASK_STARTED', objective: 'o' },
    { type: 'ESCALATED', question: 'did the command run?', sideEffectKey: KEY },
  );
  assert.equal(projectTask(asked).pendingQuestion, 'did the command run?');

  // Once anything else is recorded the task has moved on, and inviting the user
  // to answer a superseded question would be worse than showing nothing.
  const settled = history(
    { type: 'TASK_STARTED', objective: 'o' },
    { type: 'ESCALATED', question: 'did the command run?', sideEffectKey: KEY },
    { type: 'TASK_ABANDONED', reason: 'the user abandoned the task' },
  );
  assert.equal(projectTask(settled).pendingQuestion, null);
});

test('the newest failure is kept for the recovery panel, and cleared once the task succeeds', () => {
  const failed = history(
    { type: 'FAILED', errorClass: 'NETWORK', message: 'socket died', hadStreamedTokens: true },
  );
  assert.deepEqual(projectTask(failed).lastFailure, {
    errorClass: 'NETWORK',
    message: 'socket died',
  });

  const recovered = history(
    { type: 'FAILED', errorClass: 'NETWORK', message: 'socket died', hadStreamedTokens: true },
    { type: 'RECOVERING', decision: 'RETRY_SAME: transient' },
    { type: 'TASK_DONE' },
  );
  assert.equal(
    projectTask(recovered).lastFailure,
    null,
    'a task that recovered and finished must not still show an error',
  );
});

test('a model switch records both endpoints and its stated reason', () => {
  const entries = history({
    type: 'PROVIDER_SWITCHED',
    from: MODEL,
    to: OTHER,
    reason: 'every key for this provider was rejected',
  });
  const node = projectTask(entries).nodes[0];
  assert.ok(node?.kind === 'switch');
  assert.deepEqual(node.from, MODEL);
  assert.deepEqual(node.to, OTHER);
  assert.match(node.reason, /rejected/);
});

// --- bounds and robustness ---

test('the timeline is capped, keeping the newest activity and the terminal state', () => {
  const drafts = Array.from({ length: 40 }, () => ({
    type: 'RECOVERING' as const,
    decision: 'RETRY_SAME: transient',
  }));
  const entries = history(...drafts, { type: 'TASK_DONE' });

  const { nodes } = projectTask(entries, { maxNodes: 10 });
  assert.equal(nodes.length, 10, 'an unbounded DOM is the failure mode this cap prevents');
  assert.equal(nodes[nodes.length - 1]?.kind, 'terminal');
});

test('every ledger variant produces a node, so no event is silently dropped', () => {
  const entries = history(
    { type: 'TASK_STARTED', objective: 'o' },
    { type: 'STREAMING', model: MODEL, credentialId: 'c' },
    { type: 'STREAM_PROGRESS', textSoFar: 'abc' },
    {
      type: 'TOOL_REQUESTED',
      toolCallId: callId('c1'),
      toolName: 'write_file',
      args: {},
      sideEffectKey: KEY,
      safety: 'idempotent',
    },
    {
      type: 'TOOL_EXECUTING',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      safety: 'idempotent',
      preState: [fp('a.ts', null)],
      expectedPostState: [fp('a.ts', 'h')],
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'ok',
      postState: [fp('a.ts', 'h')],
    },
    {
      type: 'TOOL_RECONCILED',
      toolCallId: callId('c2'),
      sideEffectKey: KEY,
      evidence: 'already applied',
    },
    { type: 'MODEL_RESPONSE_COMPLETED', model: MODEL, reason: 'stop', text: 't' },
    { type: 'FAILED', errorClass: 'NETWORK', message: 'm', hadStreamedTokens: false },
    { type: 'RECOVERING', decision: 'RETRY_SAME: m' },
    { type: 'PROVIDER_SWITCHED', from: MODEL, to: OTHER, reason: 'r' },
    { type: 'ESCALATED', question: 'q', sideEffectKey: KEY },
    { type: 'TASK_DONE' },
  );

  const kinds = new Set(projectTask(entries).nodes.map((n) => n.kind));
  for (const expected of [
    'objective',
    'turn',
    'tool',
    'failure',
    'recovery',
    'switch',
    'escalation',
    'terminal',
  ]) {
    assert.ok(kinds.has(expected as never), `no node produced for ${expected}`);
  }
});

test('an orphaned completion is still shown rather than discarded', () => {
  // Reachable with a ledger whose head was lost, or one written by another
  // build. Dropping the entry would hide a side effect that really happened.
  const entries = history({
    type: 'TOOL_COMPLETED',
    toolCallId: callId('lonely'),
    sideEffectKey: KEY,
    ok: true,
    resultSummary: 'wrote something',
    postState: [fp('a.ts', 'h')],
  });
  const node = projectTask(entries).nodes[0];
  assert.ok(node?.kind === 'tool');
  assert.equal(node.status, 'ok');
});

test('an empty ledger projects to nothing, without throwing', () => {
  const projection = projectTask([]);
  assert.deepEqual(projection.nodes, []);
  assert.deepEqual(projection.changes, []);
  assert.equal(projection.header.status, 'empty');
  assert.equal(projection.header.elapsedMs, null);
  assert.equal(projection.header.title, 'Untitled task');
});

test('hostile tool arguments yield no target rather than a rendered object', () => {
  assert.deepEqual(argumentPaths({ path: 'src/a.ts' }), ['src/a.ts']);
  assert.deepEqual(argumentPaths({ path: { nested: true } }), []);
  assert.deepEqual(argumentPaths(null), []);
  assert.deepEqual(argumentPaths('a string'), []);
  assert.deepEqual(argumentPaths([1, 2]), []);
  assert.deepEqual(argumentPaths({ path: '' }), []);
});
