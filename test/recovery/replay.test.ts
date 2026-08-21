/**
 * The recovery decision matrix.
 *
 * CodeRelay's entire claim is that a task interrupted mid-tool-call resumes
 * without re-running the side effect. `planRecovery` is where that claim lives,
 * so every reachable interrupted state gets a case here — including the ones
 * whose correct answer is "ask the user", because silently guessing is the bug
 * this design exists to avoid.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRecovery, unresolvedSteps } from '../../src/recovery/replay.js';
import {
  CALL,
  KEY,
  StubProbe,
  callId,
  fp,
  history,
  sekId,
  stepId,
} from '../support/factories.js';

const MODEL = { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' };
const BEFORE = 'a'.repeat(64);
const AFTER = 'b'.repeat(64);
const FOREIGN = 'c'.repeat(64);

const started = { type: 'TASK_STARTED', objective: 'add a test' } as const;
const streaming = { type: 'STREAMING', model: MODEL, credentialId: 'key-1' } as const;

test('a fresh task starts a turn', async () => {
  const plan = await planRecovery([], new StubProbe());
  assert.equal(plan.kind, 'START_TURN');
});

test('interrupted before any output starts a turn rather than regenerating nothing', async () => {
  const plan = await planRecovery(history(started, streaming), new StubProbe());
  assert.equal(plan.kind, 'START_TURN');
});

test('interrupted mid-text regenerates the turn and carries the partial text', async () => {
  const entries = history(started, streaming, {
    type: 'STREAM_PROGRESS',
    textSoFar: 'I will start by reading',
  });

  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(plan.kind, 'REGENERATE_TURN');
  assert.equal(
    plan.kind === 'REGENERATE_TURN' ? plan.partialText : null,
    'I will start by reading',
  );
});

test('a completed turn is not regenerated', async () => {
  const entries = history(
    started,
    streaming,
    { type: 'STREAM_PROGRESS', textSoFar: 'partial' },
    { type: 'MODEL_RESPONSE_COMPLETED', model: MODEL, reason: 'stop', text: 'done' },
  );

  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(plan.kind, 'START_TURN');
});

test('a truncated turn is regenerated, not treated as a finished one', async () => {
  // The loop records MODEL_RESPONSE_COMPLETED for a truncated turn so the
  // timeline shows what arrived, and only then routes it as a failure. If the
  // process dies in that window, reading the entry as a clean step boundary
  // would start a fresh turn and throw the output away — which is the exact
  // case REGENERATE_TURN was written for.
  const entries = history(started, streaming, {
    type: 'MODEL_RESPONSE_COMPLETED',
    model: MODEL,
    reason: 'truncated',
    text: 'I will edit src/a.ts by',
  });

  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(plan.kind, 'REGENERATE_TURN');
  assert.equal(
    plan.kind === 'REGENERATE_TURN' ? plan.partialText : null,
    'I will edit src/a.ts by',
  );
});

test('a truncated turn prefers its own recorded text over older progress', async () => {
  // STREAM_PROGRESS is only flushed every N characters, so the completed entry
  // is the fuller account. Carrying the stale progress text forward would hand
  // the next model less than we actually received.
  const entries = history(
    started,
    streaming,
    { type: 'STREAM_PROGRESS', textSoFar: 'I will' },
    {
      type: 'MODEL_RESPONSE_COMPLETED',
      model: MODEL,
      reason: 'truncated',
      text: 'I will edit src/a.ts by',
    },
  );

  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(
    plan.kind === 'REGENERATE_TURN' ? plan.partialText : null,
    'I will edit src/a.ts by',
  );
});

test('a truncated turn with no text falls back to the last progress entry', async () => {
  const entries = history(
    started,
    streaming,
    { type: 'STREAM_PROGRESS', textSoFar: 'I will start by' },
    { type: 'MODEL_RESPONSE_COMPLETED', model: MODEL, reason: 'truncated', text: '' },
  );

  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(plan.kind === 'REGENERATE_TURN' ? plan.partialText : 'unset', 'I will start by');
});

test('a truncated turn that produced nothing at all reports no partial text', async () => {
  // `null` rather than `''`, so the loop can tell "there is a hint" from "there
  // is nothing worth showing the next model".
  const entries = history(started, streaming, {
    type: 'MODEL_RESPONSE_COMPLETED',
    model: MODEL,
    reason: 'truncated',
    text: '',
  });

  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(plan.kind, 'REGENERATE_TURN');
  assert.equal(plan.kind === 'REGENERATE_TURN' ? plan.partialText : 'unset', null);
});

test('a truncated turn followed by a clean one is not regenerated', async () => {
  // The retry already happened and succeeded. Regenerating here would repeat a
  // turn the model has since finished properly.
  const entries = history(
    started,
    streaming,
    { type: 'MODEL_RESPONSE_COMPLETED', model: MODEL, reason: 'truncated', text: 'half' },
    { type: 'RECOVERING', decision: 'RETRY_SAME: transient' },
    { type: 'MODEL_RESPONSE_COMPLETED', model: MODEL, reason: 'stop', text: 'whole' },
  );

  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(plan.kind, 'START_TURN');
});

test('a settled tool after a truncated turn still ends the scan', async () => {
  // Reaching a truncated completion must not override newer, more decisive
  // evidence: the tool call is what the scan is looking for.
  const entries = history(
    started,
    streaming,
    { type: 'MODEL_RESPONSE_COMPLETED', model: MODEL, reason: 'truncated', text: 'half' },
    {
      type: 'TOOL_REQUESTED',
      toolCallId: CALL,
      toolName: 'write_file',
      args: { path: 'a.ts' },
      sideEffectKey: KEY,
      safety: 'idempotent',
    },
  );

  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(plan.kind, 'EXECUTE_TOOL');
});

test('a tool requested but never started is executed', async () => {
  const entries = history(started, streaming, {
    type: 'TOOL_REQUESTED',
    toolCallId: CALL,
    toolName: 'write_file',
    args: { path: 'a.ts' },
    sideEffectKey: KEY,
    safety: 'idempotent',
  });

  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(plan.kind, 'EXECUTE_TOOL');
  assert.equal(plan.kind === 'EXECUTE_TOOL' ? plan.sideEffectKey : null, KEY);
});

test('a pure tool is always re-executed, and no probing is needed to decide', async () => {
  const probe = new StubProbe();
  const entries = history(started, streaming, {
    type: 'TOOL_EXECUTING',
    toolCallId: CALL,
    sideEffectKey: KEY,
    safety: 'pure',
    preState: [],
    expectedPostState: null,
  });

  const plan = await planRecovery(entries, probe);
  assert.equal(plan.kind, 'EXECUTE_TOOL');
  assert.deepEqual(probe.queried, []);
});

// The headline property. Interrupted at the one ambiguous point, with the write
// already on disk: the effect must be adopted, never repeated.
test('an idempotent write whose result is already on disk is adopted, not repeated', async () => {
  const probe = new StubProbe({ 'a.ts': AFTER });
  const entries = history(started, streaming, {
    type: 'TOOL_EXECUTING',
    toolCallId: CALL,
    sideEffectKey: KEY,
    safety: 'idempotent',
    preState: [fp('a.ts', BEFORE)],
    expectedPostState: [fp('a.ts', AFTER)],
  });

  const plan = await planRecovery(entries, probe);
  assert.equal(plan.kind, 'ADOPT_COMPLETED_EFFECT');
  assert.ok(probe.queried.includes('a.ts'), 'the decision must rest on observed state');
});

test('an idempotent write that provably did not land is executed', async () => {
  const probe = new StubProbe({ 'a.ts': BEFORE });
  const entries = history(started, streaming, {
    type: 'TOOL_EXECUTING',
    toolCallId: CALL,
    sideEffectKey: KEY,
    safety: 'idempotent',
    preState: [fp('a.ts', BEFORE)],
    expectedPostState: [fp('a.ts', AFTER)],
  });

  const plan = await planRecovery(entries, probe);
  assert.equal(plan.kind, 'EXECUTE_TOOL');
});

test('a file changed outside CodeRelay escalates instead of clobbering it', async () => {
  const probe = new StubProbe({ 'a.ts': FOREIGN });
  const entries = history(started, streaming, {
    type: 'TOOL_EXECUTING',
    toolCallId: CALL,
    sideEffectKey: KEY,
    safety: 'idempotent',
    preState: [fp('a.ts', BEFORE)],
    expectedPostState: [fp('a.ts', AFTER)],
  });

  const plan = await planRecovery(entries, probe);
  assert.equal(plan.kind, 'ASK_USER');
});

test('a file creation is adopted when the new file exists', async () => {
  const probe = new StubProbe({ 'new.ts': AFTER });
  const entries = history(started, streaming, {
    type: 'TOOL_EXECUTING',
    toolCallId: CALL,
    sideEffectKey: KEY,
    safety: 'idempotent',
    preState: [fp('new.ts', null)],
    expectedPostState: [fp('new.ts', AFTER)],
  });

  const plan = await planRecovery(entries, probe);
  assert.equal(plan.kind, 'ADOPT_COMPLETED_EFFECT');
});

test('a file creation that did not happen is executed, absence being real evidence', async () => {
  const probe = new StubProbe({});
  const entries = history(started, streaming, {
    type: 'TOOL_EXECUTING',
    toolCallId: CALL,
    sideEffectKey: KEY,
    safety: 'idempotent',
    preState: [fp('new.ts', null)],
    expectedPostState: [fp('new.ts', AFTER)],
  });

  const plan = await planRecovery(entries, probe);
  assert.equal(plan.kind, 'EXECUTE_TOOL');
});

test('a multi-file edit that only half landed escalates', async () => {
  const probe = new StubProbe({ 'a.ts': AFTER, 'b.ts': BEFORE });
  const entries = history(started, streaming, {
    type: 'TOOL_EXECUTING',
    toolCallId: CALL,
    sideEffectKey: KEY,
    safety: 'idempotent',
    preState: [fp('a.ts', BEFORE), fp('b.ts', BEFORE)],
    expectedPostState: [fp('a.ts', AFTER), fp('b.ts', AFTER)],
  });

  const plan = await planRecovery(entries, probe);
  assert.equal(plan.kind, 'ASK_USER');
});

test('an unsafe tool always escalates, whatever the workspace looks like', async () => {
  const states: Record<string, string>[] = [{}, { 'a.ts': AFTER }, { 'a.ts': BEFORE }];
  for (const state of states) {

    const entries = history(started, streaming, {
      type: 'TOOL_EXECUTING',
      toolCallId: CALL,
      sideEffectKey: KEY,
      safety: 'unsafe',
      preState: [fp('a.ts', BEFORE)],
      // Even with a post-state supplied, an arbitrary command's completion is
      // not decidable from file contents.
      expectedPostState: [fp('a.ts', AFTER)],
    });

    const plan = await planRecovery(entries, new StubProbe(state));
    assert.equal(plan.kind, 'ASK_USER');
  }
});

test('an idempotent tool with no predictable post-state escalates', async () => {
  const entries = history(started, streaming, {
    type: 'TOOL_EXECUTING',
    toolCallId: CALL,
    sideEffectKey: KEY,
    safety: 'idempotent',
    preState: [fp('a.ts', BEFORE)],
    expectedPostState: null,
  });

  const plan = await planRecovery(entries, new StubProbe({ 'a.ts': BEFORE }));
  assert.equal(plan.kind, 'ASK_USER');
});

test('an empty expected post-state is treated as no evidence, not as a match', async () => {
  const entries = history(started, streaming, {
    type: 'TOOL_EXECUTING',
    toolCallId: CALL,
    sideEffectKey: KEY,
    safety: 'idempotent',
    preState: [],
    expectedPostState: [],
  });

  // Both comparisons are vacuous, so neither may be allowed to "match".
  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(plan.kind, 'ASK_USER');
});

test('a tool that reported completion is not reconsidered', async () => {
  const entries = history(
    started,
    streaming,
    {
      type: 'TOOL_EXECUTING',
      toolCallId: CALL,
      sideEffectKey: KEY,
      safety: 'idempotent',
      preState: [fp('a.ts', BEFORE)],
      expectedPostState: [fp('a.ts', AFTER)],
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: CALL,
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'wrote 12 lines',
      postState: [fp('a.ts', AFTER)],
    },
  );

  // Deliberately hostile probe: the file now looks like the pre-state. A durable
  // TOOL_COMPLETED outranks later workspace drift, otherwise a user's own undo
  // would cause the edit to be silently re-applied.
  const plan = await planRecovery(entries, new StubProbe({ 'a.ts': BEFORE }));
  assert.equal(plan.kind, 'START_TURN');
});

test('an effect already reconciled by a previous recovery is not reconsidered', async () => {
  const entries = history(
    started,
    streaming,
    {
      type: 'TOOL_EXECUTING',
      toolCallId: CALL,
      sideEffectKey: KEY,
      safety: 'idempotent',
      preState: [fp('a.ts', BEFORE)],
      expectedPostState: [fp('a.ts', AFTER)],
    },
    {
      type: 'TOOL_RECONCILED',
      toolCallId: CALL,
      sideEffectKey: KEY,
      evidence: 'post-state present on restart',
    },
  );

  const plan = await planRecovery(entries, new StubProbe({ 'a.ts': BEFORE }));
  assert.equal(plan.kind, 'START_TURN');
});

test('a failure recorded after a completed tool does not resurrect that tool', async () => {
  const entries = history(
    started,
    streaming,
    {
      type: 'TOOL_REQUESTED',
      toolCallId: CALL,
      toolName: 'write_file',
      args: { path: 'a.ts' },
      sideEffectKey: KEY,
      safety: 'idempotent',
    },
    {
      type: 'TOOL_EXECUTING',
      toolCallId: CALL,
      sideEffectKey: KEY,
      safety: 'idempotent',
      preState: [fp('a.ts', BEFORE)],
      expectedPostState: [fp('a.ts', AFTER)],
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: CALL,
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'ok',
      postState: [fp('a.ts', AFTER)],
    },
    { type: 'FAILED', errorClass: 'NETWORK', message: 'ECONNRESET', hadStreamedTokens: true },
  );

  const plan = await planRecovery(entries, new StubProbe({ 'a.ts': AFTER }));
  assert.equal(plan.kind, 'START_TURN');
});

test('the newest unresolved tool wins when an earlier one is already settled', async () => {
  const first = callId('call-1');
  const second = callId('call-2');
  const entries = history(
    started,
    streaming,
    {
      type: 'TOOL_EXECUTING',
      toolCallId: first,
      sideEffectKey: sekId('sek-1'),
      safety: 'idempotent',
      preState: [fp('a.ts', BEFORE)],
      expectedPostState: [fp('a.ts', AFTER)],
    },
    {
      type: 'TOOL_COMPLETED',
      toolCallId: first,
      sideEffectKey: sekId('sek-1'),
      ok: true,
      resultSummary: 'ok',
      postState: [fp('a.ts', AFTER)],
    },
    {
      type: 'TOOL_REQUESTED',
      stepId: stepId('step-2'),
      toolCallId: second,
      toolName: 'run_tests',
      args: {},
      sideEffectKey: sekId('sek-2'),
      safety: 'unsafe',
    },
  );

  const plan = await planRecovery(entries, new StubProbe({ 'a.ts': AFTER }));
  assert.equal(plan.kind, 'EXECUTE_TOOL');
  assert.equal(plan.kind === 'EXECUTE_TOOL' ? plan.toolCallId : null, second);
});

test('a provider switch mid-task does not change the recovery decision', async () => {
  const executing = {
    type: 'TOOL_EXECUTING',
    toolCallId: CALL,
    sideEffectKey: KEY,
    safety: 'idempotent',
    preState: [fp('a.ts', BEFORE)],
    expectedPostState: [fp('a.ts', AFTER)],
  } as const;

  const sameStateOnAnotherProvider = history(
    started,
    streaming,
    executing,
    {
      type: 'FAILED',
      errorClass: 'STREAM',
      message: 'stream ended early',
      hadStreamedTokens: true,
    },
    { type: 'RECOVERING', decision: 'switch provider' },
    {
      type: 'PROVIDER_SWITCHED',
      from: MODEL,
      to: { providerId: 'openai', modelId: 'gpt-5' },
      reason: 'anthropic overloaded',
    },
  );

  // Recovery is a function of durable facts and observed state, not of which
  // model happens to be answering next. This is what makes handoff sound.
  const plan = await planRecovery(sameStateOnAnotherProvider, new StubProbe({ 'a.ts': AFTER }));
  assert.equal(plan.kind, 'ADOPT_COMPLETED_EFFECT');
});

test('a finished task is left alone', async () => {
  const plan = await planRecovery(history(started, { type: 'TASK_DONE' }), new StubProbe());
  assert.equal(plan.kind, 'NOTHING_TO_DO');
});

test('an abandoned task is left alone and reports why', async () => {
  const entries = history(started, { type: 'TASK_ABANDONED', reason: 'user cancelled' });
  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(plan.kind, 'NOTHING_TO_DO');
  assert.match(plan.kind === 'NOTHING_TO_DO' ? plan.reason : '', /user cancelled/);
});

test('an escalation left unanswered still resolves to the same question', async () => {
  const entries = history(
    started,
    streaming,
    {
      type: 'TOOL_EXECUTING',
      toolCallId: CALL,
      sideEffectKey: KEY,
      safety: 'unsafe',
      preState: [],
      expectedPostState: null,
    },
    { type: 'ESCALATED', question: 'did the migration run?', sideEffectKey: KEY },
  );

  // Closing the window and reopening it must not lose the question.
  const plan = await planRecovery(entries, new StubProbe());
  assert.equal(plan.kind, 'ASK_USER');
});

test('unresolvedSteps reports only steps with outstanding tool calls', async () => {
  const entries = history(
    started,
    {
      type: 'TOOL_REQUESTED',
      stepId: stepId('step-1'),
      toolCallId: callId('call-1'),
      toolName: 'read_file',
      args: {},
      sideEffectKey: sekId('sek-1'),
      safety: 'pure',
    },
    {
      type: 'TOOL_COMPLETED',
      stepId: stepId('step-1'),
      toolCallId: callId('call-1'),
      sideEffectKey: sekId('sek-1'),
      ok: true,
      resultSummary: 'ok',
      postState: [],
    },
    {
      type: 'TOOL_REQUESTED',
      stepId: stepId('step-2'),
      toolCallId: callId('call-2'),
      toolName: 'write_file',
      args: {},
      sideEffectKey: sekId('sek-2'),
      safety: 'idempotent',
    },
  );

  assert.deepEqual(unresolvedSteps(entries), [stepId('step-2')]);
});
