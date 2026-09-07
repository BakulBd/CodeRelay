/**
 * Cross-provider handoff.
 *
 * The properties worth protecting here are not about formatting. They are:
 * partial output never becomes an assistant message; an inferred effect never
 * reads like an observed one; and an operation that may already have taken
 * effect is never described to the successor as something still to do.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHandoff, renderHandoff } from '../../src/policy/handoff.js';
import type { ModelRef } from '../../src/core/types.js';
import { CALL, KEY, callId, fp, history, sekId } from '../support/factories.js';

const SONNET: ModelRef = { providerId: 'anthropic', modelId: 'sonnet' };
const GPT: ModelRef = { providerId: 'openai', modelId: 'gpt' };

// --- objective -------------------------------------------------------------

test('the objective is carried across verbatim', () => {
  const packet = buildHandoff(
    history({ type: 'TASK_STARTED', objective: 'Add pagination to /users' }),
    GPT,
  );
  assert.equal(packet.objective, 'Add pagination to /users');
  assert.equal(packet.objectiveMissing, false);
  assert.equal(packet.to, GPT);
});

test('a missing objective is reported, never invented', () => {
  const packet = buildHandoff(
    history({ type: 'STREAMING', model: SONNET, credentialId: 'k1' }),
    GPT,
  );
  assert.equal(packet.objectiveMissing, true);
  assert.match(packet.objective, /not recorded/);
});

test('an unknown objective tells the successor not to cause side effects', () => {
  const text = renderHandoff(buildHandoff(history(), GPT));
  assert.match(text, /do not take any action with side effects/);
});

// --- completed effects -----------------------------------------------------

test('a completed tool becomes an observed fact with its files', () => {
  const packet = buildHandoff(
    history(
      { type: 'TASK_STARTED', objective: 'edit a file' },
      {
        type: 'TOOL_REQUESTED',
        toolCallId: CALL,
        toolName: 'write_file',
        args: { path: 'a.ts' },
        sideEffectKey: KEY,
        safety: 'idempotent',
      },
      {
        type: 'TOOL_COMPLETED',
        toolCallId: CALL,
        sideEffectKey: KEY,
        ok: true,
        resultSummary: 'wrote 12 lines',
        postState: [fp('a.ts', 'aaa')],
      },
    ),
    GPT,
  );

  assert.equal(packet.completed.length, 1);
  const effect = packet.completed[0]!;
  assert.equal(effect.toolName, 'write_file');
  assert.equal(effect.provenance, 'observed');
  assert.equal(effect.ok, true);
  assert.deepEqual(effect.paths, ['a.ts']);
  assert.equal(packet.pending.length, 0);
});

test('a failed tool is still reported as completed, and as failed', () => {
  const packet = buildHandoff(
    history(
      {
        type: 'TOOL_REQUESTED',
        toolCallId: CALL,
        toolName: 'run_tests',
        args: {},
        sideEffectKey: KEY,
        safety: 'unsafe',
      },
      {
        type: 'TOOL_COMPLETED',
        toolCallId: CALL,
        sideEffectKey: KEY,
        ok: false,
        resultSummary: '3 tests failed',
        postState: [],
      },
    ),
    GPT,
  );
  assert.equal(packet.completed[0]!.ok, false);
  assert.match(renderHandoff(packet), /failed: 3 tests failed/);
});

test('a reconciled effect is marked inferred, not observed', () => {
  const packet = buildHandoff(
    history(
      {
        type: 'TOOL_REQUESTED',
        toolCallId: CALL,
        toolName: 'write_file',
        args: { path: 'b.ts' },
        sideEffectKey: KEY,
        safety: 'idempotent',
      },
      {
        type: 'TOOL_EXECUTING',
        toolCallId: CALL,
        sideEffectKey: KEY,
        safety: 'idempotent',
        preState: [fp('b.ts', null)],
        expectedPostState: [fp('b.ts', 'bbb')],
      },
      {
        type: 'TOOL_RECONCILED',
        toolCallId: CALL,
        sideEffectKey: KEY,
        evidence: 'the file already matches the expected content',
      },
    ),
    GPT,
  );

  const effect = packet.completed[0]!;
  assert.equal(effect.provenance, 'inferred');
  assert.equal(effect.toolName, 'write_file');
  // Paths come from the expected post-state, since no tool result was recorded.
  assert.deepEqual(effect.paths, ['b.ts']);
  assert.equal(packet.pending.length, 0);
});

test('an inferred effect is worded as unverified, so the successor cannot read it as fact', () => {
  const text = renderHandoff(
    buildHandoff(
      history(
        {
          type: 'TOOL_REQUESTED',
          toolCallId: CALL,
          toolName: 'write_file',
          args: {},
          sideEffectKey: KEY,
          safety: 'idempotent',
        },
        {
          type: 'TOOL_EXECUTING',
          toolCallId: CALL,
          sideEffectKey: KEY,
          safety: 'idempotent',
          preState: [],
          expectedPostState: [fp('b.ts', 'bbb')],
        },
        { type: 'TOOL_RECONCILED', toolCallId: CALL, sideEffectKey: KEY, evidence: 'hash matches' },
      ),
      GPT,
    ),
  );
  assert.match(text, /not\*\* confirmed by the tool itself/);
  assert.match(text, /likely but unverified/);
  // The wording reserved for observed results must not appear for this effect.
  assert.ok(!/succeeded: /.test(text), text);
});

test('a completion with no matching request still names something rather than crashing', () => {
  const packet = buildHandoff(
    history({
      type: 'TOOL_COMPLETED',
      toolCallId: CALL,
      sideEffectKey: KEY,
      ok: true,
      resultSummary: 'done',
      postState: [],
    }),
    GPT,
  );
  assert.equal(packet.completed[0]!.toolName, 'unknown tool');
});

test('only the most recent completed effects are listed when the cap is reached', () => {
  const drafts = Array.from({ length: 5 }, (_, i) => [
    {
      type: 'TOOL_REQUESTED' as const,
      toolCallId: callId(`c${i}`),
      toolName: `tool_${i}`,
      args: {},
      sideEffectKey: sekId(`s${i}`),
      safety: 'pure' as const,
    },
    {
      type: 'TOOL_COMPLETED' as const,
      toolCallId: callId(`c${i}`),
      sideEffectKey: sekId(`s${i}`),
      ok: true,
      resultSummary: `result ${i}`,
      postState: [],
    },
  ]).flat();

  const packet = buildHandoff(history(...drafts), GPT, { maxCompletedListed: 2 });
  assert.deepEqual(
    packet.completed.map((e) => e.toolName),
    ['tool_3', 'tool_4'],
  );
});

// --- pending effects -------------------------------------------------------

test('a tool that was requested but never started is described as still to do', () => {
  const packet = buildHandoff(
    history({
      type: 'TOOL_REQUESTED',
      toolCallId: CALL,
      toolName: 'write_file',
      args: { path: 'c.ts' },
      sideEffectKey: KEY,
      safety: 'idempotent',
    }),
    GPT,
  );

  assert.equal(packet.pending.length, 1);
  assert.equal(packet.pending[0]!.mayHaveRun, false);
  assert.deepEqual(packet.pending[0]!.args, { path: 'c.ts' });
  assert.match(renderHandoff(packet), /provably never started/);
});

test('a tool interrupted at TOOL_EXECUTING is described as possibly already done', () => {
  const packet = buildHandoff(
    history(
      {
        type: 'TOOL_REQUESTED',
        toolCallId: CALL,
        toolName: 'run_command',
        args: { cmd: 'npm publish' },
        sideEffectKey: KEY,
        safety: 'unsafe',
      },
      {
        type: 'TOOL_EXECUTING',
        toolCallId: CALL,
        sideEffectKey: KEY,
        safety: 'unsafe',
        preState: [],
        expectedPostState: null,
      },
    ),
    GPT,
  );

  assert.equal(packet.pending[0]!.mayHaveRun, true);
  const text = renderHandoff(packet);
  assert.match(text, /outcome is unknown/);
  assert.match(text, /Do not run it again/);
  // The safe-to-run wording must be absent, or the successor could re-publish.
  assert.ok(!/provably never started/.test(text), text);
});

test('pending and settled tools in the same task are separated correctly', () => {
  const packet = buildHandoff(
    history(
      {
        type: 'TOOL_REQUESTED',
        toolCallId: callId('done'),
        toolName: 'read_file',
        args: {},
        sideEffectKey: sekId('s1'),
        safety: 'pure',
      },
      {
        type: 'TOOL_COMPLETED',
        toolCallId: callId('done'),
        sideEffectKey: sekId('s1'),
        ok: true,
        resultSummary: 'read 40 lines',
        postState: [],
      },
      {
        type: 'TOOL_REQUESTED',
        toolCallId: callId('open'),
        toolName: 'write_file',
        args: {},
        sideEffectKey: sekId('s2'),
        safety: 'idempotent',
      },
    ),
    GPT,
  );

  assert.deepEqual(
    packet.completed.map((e) => e.toolName),
    ['read_file'],
  );
  assert.deepEqual(
    packet.pending.map((e) => e.toolName),
    ['write_file'],
  );
});

test('with nothing executed the successor is told the workspace is untouched', () => {
  const text = renderHandoff(
    buildHandoff(history({ type: 'TASK_STARTED', objective: 'do a thing' }), GPT),
  );
  assert.match(text, /No files have been changed/);
  assert.ok(!/Unfinished operations/.test(text), text);
});

// --- narrative and truncation ---------------------------------------------

test('text from a cleanly completed turn becomes narrative, not truncated output', () => {
  const packet = buildHandoff(
    history(
      { type: 'STREAMING', model: SONNET, credentialId: 'k1' },
      { type: 'STREAM_PROGRESS', textSoFar: 'I will start by' },
      {
        type: 'MODEL_RESPONSE_COMPLETED',
        model: SONNET,
        reason: 'stop',
        text: 'I will start by reading the router.',
      },
    ),
    GPT,
  );

  assert.deepEqual(packet.narrative, ['I will start by reading the router.']);
  // The checkpoint was superseded by the completed turn; carrying it forward
  // would duplicate the same sentence as both finished and unfinished.
  assert.equal(packet.truncatedText, null);
});

test('a stream checkpoint with no completion is carried as truncated output', () => {
  const packet = buildHandoff(
    history(
      { type: 'STREAMING', model: SONNET, credentialId: 'k1' },
      { type: 'STREAM_PROGRESS', textSoFar: 'Now I will edit the' },
    ),
    GPT,
  );
  assert.equal(packet.truncatedText, 'Now I will edit the');
  assert.deepEqual(packet.narrative, []);
});

test('a turn that completed with reason truncated is not treated as narrative', () => {
  const packet = buildHandoff(
    history(
      { type: 'STREAMING', model: SONNET, credentialId: 'k1' },
      {
        type: 'MODEL_RESPONSE_COMPLETED',
        model: SONNET,
        reason: 'truncated',
        text: 'The next step is to modify',
      },
    ),
    GPT,
  );
  assert.deepEqual(packet.narrative, []);
  assert.equal(packet.truncatedText, 'The next step is to modify');
});

test('a truncated completion with no text keeps the last checkpoint', () => {
  const packet = buildHandoff(
    history(
      { type: 'STREAM_PROGRESS', textSoFar: 'partial words' },
      { type: 'MODEL_RESPONSE_COMPLETED', model: SONNET, reason: 'truncated', text: '' },
    ),
    GPT,
  );
  assert.equal(packet.truncatedText, 'partial words');
});

test('cut-off output is framed as incomplete and non-authoritative', () => {
  const text = renderHandoff(
    buildHandoff(history({ type: 'STREAM_PROGRESS', textSoFar: 'half a thought' }), GPT),
  );
  assert.match(text, /incomplete and was never finished/);
  assert.match(text, /not a decision/);
  assert.match(text, /half a thought/);
});

test('an overlong partial keeps the tail, because that is where work stopped', () => {
  const long = `${'a'.repeat(50)}THE-END`;
  const packet = buildHandoff(history({ type: 'STREAM_PROGRESS', textSoFar: long }), GPT, {
    maxTruncatedChars: 10,
  });
  assert.equal(packet.truncatedText, '\u2026aaaTHE-END');
  assert.equal(packet.truncatedText!.length, 11); // ellipsis + 10 chars
});

test('a zero character budget drops the partial rather than emitting a bare ellipsis', () => {
  const packet = buildHandoff(history({ type: 'STREAM_PROGRESS', textSoFar: 'anything' }), GPT, {
    maxTruncatedChars: 0,
  });
  assert.equal(packet.truncatedText, '');
});

test('multiple completed turns are kept in order', () => {
  const packet = buildHandoff(
    history(
      { type: 'MODEL_RESPONSE_COMPLETED', model: SONNET, reason: 'tool_use', text: 'first' },
      { type: 'MODEL_RESPONSE_COMPLETED', model: SONNET, reason: 'stop', text: 'second' },
    ),
    GPT,
  );
  assert.deepEqual(packet.narrative, ['first', 'second']);
});

test('an empty completed turn adds nothing to the narrative', () => {
  const packet = buildHandoff(
    history({ type: 'MODEL_RESPONSE_COMPLETED', model: SONNET, reason: 'tool_use', text: '' }),
    GPT,
  );
  assert.deepEqual(packet.narrative, []);
});

// --- provenance of the model chain ----------------------------------------

test('every model the task has run on is recorded once, in order', () => {
  const packet = buildHandoff(
    history(
      { type: 'STREAMING', model: SONNET, credentialId: 'k1' },
      { type: 'MODEL_RESPONSE_COMPLETED', model: SONNET, reason: 'stop', text: 'x' },
      { type: 'PROVIDER_SWITCHED', from: SONNET, to: GPT, reason: 'rate limited' },
      { type: 'STREAMING', model: GPT, credentialId: 'k9' },
    ),
    GPT,
  );
  assert.deepEqual(packet.priorModels, [SONNET, GPT]);
  assert.deepEqual(packet.from, GPT);
});

test('the origin model is the last one seen, or null when none was recorded', () => {
  assert.equal(buildHandoff(history(), GPT).from, null);
  assert.deepEqual(
    buildHandoff(history({ type: 'STREAMING', model: SONNET, credentialId: 'k1' }), GPT).from,
    SONNET,
  );
});

test('compactions are counted from recovery decisions', () => {
  const packet = buildHandoff(
    history(
      { type: 'RECOVERING', decision: 'COMPACT_CONTEXT: request exceeded the window' },
      { type: 'RECOVERING', decision: 'SWITCH_MODEL: moving to a larger window' },
      { type: 'RECOVERING', decision: 'COMPACT_CONTEXT: again' },
    ),
    GPT,
  );
  assert.equal(packet.compactionsApplied, 2);
});

// --- entries the handoff deliberately ignores -----------------------------

test('failures and escalations do not leak into what the successor is told', () => {
  const packet = buildHandoff(
    history(
      { type: 'TASK_STARTED', objective: 'refactor' },
      {
        type: 'FAILED',
        errorClass: 'AUTH',
        message: 'provider rejected the credential',
        hadStreamedTokens: false,
      },
      { type: 'ESCALATED', question: 'add a valid key?', sideEffectKey: null },
    ),
    GPT,
  );
  const text = renderHandoff(packet);
  assert.ok(!/rejected the credential/.test(text), text);
  assert.ok(!/add a valid key/.test(text), text);
  assert.equal(packet.completed.length, 0);
  assert.equal(packet.pending.length, 0);
});

// --- rendering contract ----------------------------------------------------

test('the rendered prompt states up front that the transcript is not replayed', () => {
  const text = renderHandoff(
    buildHandoff(history({ type: 'TASK_STARTED', objective: 'do work' }), GPT),
  );
  assert.match(text, /^# Continuing an interrupted task/);
  assert.match(text, /transcript is not replayed/);
  assert.match(text, /## Objective/);
  assert.match(text, /## How to continue/);
});

test('completed work is followed by an explicit instruction not to repeat it', () => {
  const text = renderHandoff(
    buildHandoff(
      history(
        {
          type: 'TOOL_REQUESTED',
          toolCallId: CALL,
          toolName: 'write_file',
          args: {},
          sideEffectKey: KEY,
          safety: 'idempotent',
        },
        {
          type: 'TOOL_COMPLETED',
          toolCallId: CALL,
          sideEffectKey: KEY,
          ok: true,
          resultSummary: 'wrote the file',
          postState: [fp('a.ts', 'aaa')],
        },
      ),
      GPT,
    ),
  );
  assert.match(text, /Do not repeat any of the above/);
});

test('the handoff never contains a provider tool-call id, which has no meaning elsewhere', () => {
  const text = renderHandoff(
    buildHandoff(
      history(
        {
          type: 'TOOL_REQUESTED',
          toolCallId: callId('toolu_01XYZ'),
          toolName: 'write_file',
          args: {},
          sideEffectKey: sekId('sek'),
          safety: 'idempotent',
        },
        {
          type: 'TOOL_EXECUTING',
          toolCallId: callId('toolu_01XYZ'),
          toolName: 'write_file',
          sideEffectKey: sekId('sek'),
          safety: 'idempotent',
          preState: [],
          expectedPostState: null,
        } as any,
      ),
      GPT,
    ),
  );
  assert.ok(!text.includes('toolu_01XYZ'), text);
});

// --- structured recovery state ---------------------------------------------

test('the handoff packet extracts structured plan steps and requirements', () => {
  const planMarkdown = [
    '# Implementation Plan: Auth',
    '## Steps',
    '- [x] Implement JWT token signing in `src/auth.ts`',
    '- [ ] Add refresh token rotation',
    '- [ ] Verify with integration tests',
    '## Requirements',
    '- Tokens must expire after 15m',
    '- Refresh tokens must be single-use',
  ].join('\n');

  const packet = buildHandoff(
    history(
      { type: 'TASK_STARTED', objective: 'Secure auth flow' },
      { type: 'PLAN_PROPOSED', title: 'Auth Plan', planMarkdown },
      {
        type: 'TOOL_REQUESTED',
        toolCallId: CALL,
        toolName: 'write_file',
        args: { path: 'src/auth.ts' },
        sideEffectKey: KEY,
        safety: 'idempotent',
      },
      {
        type: 'TOOL_COMPLETED',
        toolCallId: CALL,
        sideEffectKey: KEY,
        ok: true,
        resultSummary: 'wrote auth.ts',
        postState: [fp('src/auth.ts', 'abc')],
      },
      {
        type: 'FAILED',
        errorClass: 'RETRYABLE',
        message: 'Anthropic 429 Rate Limit',
        hadStreamedTokens: false,
      },
    ),
    GPT,
    {
      checkpointRef: { id: 'cp-18', sequenceNumber: 18, commitSha: 'a1b2c3d4e5' },
      gitState: { branch: 'feature/auth', isClean: true },
      testResults: { total: 42, passed: 42, failed: 0 },
      buildResults: { status: 'passed', summary: 'TypeScript 0 errors' },
      diagnostics: [],
    },
  );

  assert.equal(packet.goal, 'Secure auth flow');
  assert.equal(packet.plan?.title, 'Auth Plan');
  assert.deepEqual(packet.completedSteps, ['Implement JWT token signing in `src/auth.ts`']);
  assert.deepEqual(packet.remainingSteps, [
    'Add refresh token rotation',
    'Verify with integration tests',
  ]);
  assert.equal(packet.currentStep, 'Add refresh token rotation');
  assert.equal(packet.requirements.length, 5);
  assert.deepEqual(packet.filesChanged, ['src/auth.ts']);
  assert.equal(packet.checkpointRef?.sequenceNumber, 18);
  assert.equal(packet.testResults?.passed, 42);
  assert.equal(packet.errors.length, 1);
  assert.equal(packet.errors[0]?.errorClass, 'RETRYABLE');

  const rendered = renderHandoff(packet);
  assert.match(rendered, /## Architectural Plan & Steps/);
  assert.match(rendered, /\[x\] Implement JWT token signing/);
  assert.match(rendered, /\[ \] Add refresh token rotation/);
  assert.match(rendered, /\*\*Active Interrupted Step\*\*: Add refresh token rotation/);
  assert.match(rendered, /Preserved Checkpoint: #18/);
  assert.match(rendered, /Tests: 42\/42 passed/);
  assert.match(rendered, /Build: PASSED/);
  assert.match(rendered, /Diagnostics: 0 errors/);
  assert.match(rendered, /Verified modified files \(1\): src\/auth\.ts/);
});

