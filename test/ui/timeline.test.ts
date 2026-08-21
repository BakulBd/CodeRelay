/**
 * Timeline wording.
 *
 * These read like UI tests but they guard an honesty property: a conclusion
 * CodeRelay *inferred* must never be presented in the same tone as something it
 * observed. That distinction is the difference between a trustworthy recovery
 * log and a plausible-looking one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LedgerEntry } from '../../src/continuity/entries.js';
import { describeEntry, renderTimeline, renderTimelineText } from '../../src/ui/timeline.js';
import { KEY, callId, fp, history } from '../support/factories.js';

const MODEL = { providerId: 'anthropic', modelId: 'claude-x' };

test('an empty ledger renders as a sentence, not a blank string', () => {
  assert.equal(renderTimelineText([]), 'This ledger is empty.');
  assert.deepEqual(renderTimeline([]), []);
});

test('every entry variant produces a non-empty description', () => {
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
      resultSummary: 'wrote 3 bytes',
      postState: [fp('a.ts', 'h')],
    },
    {
      type: 'TOOL_RECONCILED',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      evidence: 'file matches expected post-state',
    },
    { type: 'MODEL_RESPONSE_COMPLETED', model: MODEL, reason: 'stop', text: 't' },
    { type: 'FAILED', errorClass: 'NETWORK', message: 'socket died', hadStreamedTokens: true },
    { type: 'RECOVERING', decision: 'switch provider' },
    { type: 'PROVIDER_SWITCHED', from: MODEL, to: MODEL, reason: 'rate limited' },
    { type: 'ESCALATED', question: 'did the command run?', sideEffectKey: KEY },
    { type: 'TASK_DONE' },
    { type: 'TASK_ABANDONED', reason: 'gave up' },
  );

  const rows = renderTimeline(entries);
  assert.equal(rows.length, entries.length);
  for (const row of rows) {
    assert.ok(row.detail.length > 0, `${row.type} rendered nothing`);
  }

  // A guard against adding a ledger variant and forgetting the renderer: the
  // switch is exhaustive, so every declared type must appear here.
  const covered = new Set(rows.map((r) => r.type));
  const declared: LedgerEntry['type'][] = [
    'TASK_STARTED',
    'STREAMING',
    'STREAM_PROGRESS',
    'TOOL_REQUESTED',
    'TOOL_EXECUTING',
    'TOOL_COMPLETED',
    'TOOL_RECONCILED',
    'MODEL_RESPONSE_COMPLETED',
    'FAILED',
    'RECOVERING',
    'PROVIDER_SWITCHED',
    'ESCALATED',
    'TASK_DONE',
    'TASK_ABANDONED',
  ];
  for (const type of declared) {
    assert.ok(covered.has(type), `no timeline coverage for ${type}`);
  }
});

test('a reconciled effect is marked as inferred, never as observed', () => {
  const [entry] = history({
    type: 'TOOL_RECONCILED',
    toolCallId: callId('c1'),
    sideEffectKey: KEY,
    evidence: 'file already matches',
  });
  assert.ok(entry);

  const { detail, tone } = describeEntry(entry);
  assert.equal(tone, 'inferred');
  assert.match(detail, /already done/);
});

test('an unpredictable outcome says so, because that is what forces a question', () => {
  const [entry] = history({
    type: 'TOOL_EXECUTING',
    toolCallId: callId('c1'),
    sideEffectKey: KEY,
    safety: 'unsafe',
    preState: [fp('a.ts', 'h')],
    expectedPostState: null,
  });
  assert.ok(entry);

  const { detail, tone } = describeEntry(entry);
  assert.equal(tone, 'effect');
  assert.match(detail, /not predictable/);
});

test('a failed tool reads as a problem, a successful one does not', () => {
  const [okEntry, badEntry] = history(
    {
      type: 'TOOL_COMPLETED',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'fine',
      postState: [],
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: callId('c2'),
      sideEffectKey: KEY,
      ok: false,
      resultSummary: 'failed: disk on fire',
      postState: [],
    },
  );
  assert.ok(okEntry && badEntry);

  assert.equal(describeEntry(okEntry).tone, 'effect');
  assert.equal(describeEntry(badEntry).tone, 'problem');
});

test('a truncated turn is a problem even though the request succeeded', () => {
  const [entry] = history({
    type: 'MODEL_RESPONSE_COMPLETED',
    model: MODEL,
    reason: 'truncated',
    text: 'half',
  });
  assert.ok(entry);
  assert.equal(describeEntry(entry).tone, 'problem');
});

test('long text is collapsed to one clipped line so the layout cannot break', () => {
  const [entry] = history({ type: 'TASK_STARTED', objective: `a\n\n${'b'.repeat(500)}` });
  assert.ok(entry);

  const { detail } = describeEntry(entry);
  assert.ok(!detail.includes('\n'), 'newlines must be collapsed');
  assert.ok(detail.length <= 200, `detail was ${detail.length} chars`);
  assert.ok(detail.endsWith('…'), 'clipping should be visible to the reader');
});

test('the text rendering is one padded line per entry, in ledger order', () => {
  const entries = history({ type: 'TASK_STARTED', objective: 'first' }, { type: 'TASK_DONE' });
  const lines = renderTimelineText(entries).split('\n');

  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^0000 {2}\S+ {2}TASK_STARTED {2}first$/);
  assert.match(lines[1]!, /^0001 {2}\S+ {2}TASK_DONE {2}task finished$/);
});
