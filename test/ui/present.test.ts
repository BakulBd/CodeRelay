/**
 * Presentation.
 *
 * The client paints whatever these functions return, so this is where the
 * interface's promises are actually kept. Three of them are worth stating as
 * tests rather than as comments:
 *
 * - a failure never reads as the word "Error", and always says what happened and
 *   what already succeeded;
 * - an inference is labelled in words, in both the visible tag and the sentence a
 *   screen reader hears;
 * - a model switch is never silent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeFailure,
  describeRelayInterruption,
  explainErrorClass,
  present,
  presentRow,
  summarizeChanges,
} from '../../src/ui/webview/present.js';
import { projectTask } from '../../src/ui/state/project.js';
import type { TimelineNode } from '../../src/ui/state/project.js';
import { KEY, callId, fp, history } from '../support/factories.js';

const MODEL = { providerId: 'anthropic', modelId: 'claude-x' };
const OTHER = { providerId: 'openai', modelId: 'gpt-x' };

const row = (node: TimelineNode) => presentRow(node);

// --- observed vs inferred ---

test('a reconciled tool call is labelled inferred, visibly and audibly', () => {
  const projection = projectTask(
    history(
      {
        type: 'TOOL_REQUESTED',
        toolCallId: callId('c1'),
        toolName: 'write_file',
        args: { path: 'src/auth.ts' },
        sideEffectKey: KEY,
        safety: 'idempotent',
      },
      {
        type: 'TOOL_EXECUTING',
        toolCallId: callId('c1'),
        sideEffectKey: KEY,
        safety: 'idempotent',
        preState: [fp('src/auth.ts', 'old')],
        expectedPostState: [fp('src/auth.ts', 'new')],
      },
      {
        type: 'TOOL_RECONCILED',
        toolCallId: callId('c1'),
        sideEffectKey: KEY,
        evidence: 'workspace already matches the expected post-state',
      },
    ),
  );

  const presented = row(projection.nodes[0]!);
  assert.equal(presented.tone, 'inferred');
  assert.equal(presented.tag, 'inferred', 'the tag must carry the word, not only a colour');
  assert.equal(presented.tagKind, 'inferred');
  assert.match(
    presented.spoken,
    /inferred by recovery/,
    'a screen reader must hear the distinction too',
  );
});

test('an observed tool call carries no inference tag', () => {
  const projection = projectTask(
    history(
      {
        type: 'TOOL_REQUESTED',
        toolCallId: callId('c1'),
        toolName: 'write_file',
        args: { path: 'a.ts' },
        sideEffectKey: KEY,
        safety: 'idempotent',
      },
      {
        type: 'TOOL_COMPLETED',
        toolCallId: callId('c1'),
        sideEffectKey: KEY,
        ok: true,
        resultSummary: 'wrote 12 bytes to a.ts',
        postState: [fp('a.ts', 'h')],
      },
    ),
  );

  const presented = row(projection.nodes[0]!);
  assert.equal(presented.tag, null);
  assert.equal(presented.tone, 'ok');
  assert.match(presented.spoken, /succeeded/);
});

test('an unverifiable operation is marked so, because that is what forces a question', () => {
  const projection = projectTask(
    history({
      type: 'TOOL_EXECUTING',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      safety: 'unsafe',
      preState: [fp('a.ts', 'h')],
      expectedPostState: null,
    }),
  );
  assert.equal(row(projection.nodes[0]!).tag, 'unverifiable');
});

// --- tool cards ---

test('a tool card uses a verb the user recognises, in the right tense', () => {
  const requested = history({
    type: 'TOOL_REQUESTED',
    toolCallId: callId('c1'),
    toolName: 'write_file',
    args: { path: 'src/auth.ts' },
    sideEffectKey: KEY,
    safety: 'idempotent',
  });
  assert.equal(row(projectTask(requested).nodes[0]!).label, 'Editing');

  const completed = history(...requested.map((e) => e), {
    type: 'TOOL_COMPLETED',
    toolCallId: callId('c1'),
    sideEffectKey: KEY,
    ok: true,
    resultSummary: 'wrote it',
    postState: [fp('src/auth.ts', 'h')],
  });
  assert.equal(row(projectTask(completed).nodes[0]!).label, 'Edited');
});

test('an unknown tool falls back to its own name rather than inventing a verb', () => {
  const projection = projectTask(
    history({
      type: 'TOOL_REQUESTED',
      toolCallId: callId('c1'),
      toolName: 'run_terminal',
      args: {},
      sideEffectKey: KEY,
      safety: 'unsafe',
    }),
  );
  // `run_terminal` is not a tool this build has — `run_command` is. An unknown
  // name must degrade to itself rather than to a guessed verb, so a tool added
  // later cannot be mislabelled by a stale table.
  assert.equal(row(projection.nodes[0]!).label, 'run_terminal');
});

test('the shell tool is named with a verb, in the right tense', () => {
  const requested = history({
    type: 'TOOL_REQUESTED',
    toolCallId: callId('c1'),
    toolName: 'run_command',
    args: { command: 'npm test' },
    sideEffectKey: KEY,
    safety: 'unsafe',
  });
  assert.equal(row(projectTask(requested).nodes[0]!).label, 'Running');

  const completed = history(...requested.map((e) => e), {
    type: 'TOOL_COMPLETED',
    toolCallId: callId('c1'),
    sideEffectKey: KEY,
    ok: true,
    resultSummary: '42 passing',
    postState: [],
  });
  assert.equal(row(projectTask(completed).nodes[0]!).label, 'Ran');
});

test('a tool card offers each touched file as an openable path', () => {
  const projection = projectTask(
    history(
      {
        type: 'TOOL_REQUESTED',
        toolCallId: callId('c1'),
        toolName: 'write_file',
        args: { path: 'src/deep/nested/auth.ts' },
        sideEffectKey: KEY,
        safety: 'idempotent',
      },
      {
        type: 'TOOL_EXECUTING',
        toolCallId: callId('c1'),
        sideEffectKey: KEY,
        safety: 'idempotent',
        preState: [fp('src/deep/nested/auth.ts', null)],
        expectedPostState: [fp('src/deep/nested/auth.ts', 'h')],
      },
    ),
  );

  const presented = row(projection.nodes[0]!);
  assert.deepEqual(presented.paths, [
    { label: 'auth.ts', path: 'src/deep/nested/auth.ts' },
  ]);
  // The visible target is shortened; the full path stays available for opening.
  assert.match(presented.target ?? '', /nested\/auth\.ts/);
});

test('a long tool result is collapsed into a body rather than filling the timeline', () => {
  const long = 'x'.repeat(5_000);
  const projection = projectTask(
    history(
      {
        type: 'TOOL_REQUESTED',
        toolCallId: callId('c1'),
        toolName: 'read_file',
        args: { path: 'a.ts' },
        sideEffectKey: KEY,
        safety: 'pure',
      },
      {
        type: 'TOOL_COMPLETED',
        toolCallId: callId('c1'),
        sideEffectKey: KEY,
        ok: true,
        resultSummary: long,
        postState: [],
      },
    ),
  );

  const presented = row(projection.nodes[0]!);
  assert.ok(presented.body !== null, 'large output must be expandable');
  assert.ok(presented.body!.length < long.length, 'the body must be bounded');
  assert.match(presented.body!, /more character/, 'the clipping must be visible');
  // A whole file is not a summary, so the one-line form reports its size.
  assert.match(presented.text ?? '', /characters read/);
});

// --- turns ---

test('a truncated response is called cut off, and reads as a problem', () => {
  const projection = projectTask(
    history(
      { type: 'STREAMING', model: MODEL, credentialId: 'c' },
      { type: 'MODEL_RESPONSE_COMPLETED', model: MODEL, reason: 'truncated', text: 'half' },
    ),
  );
  const presented = row(projection.nodes[0]!);
  assert.equal(presented.label, 'Response cut off');
  assert.equal(presented.tone, 'problem');
});

test('a turn in flight reports how much has arrived, not a fake percentage', () => {
  const projection = projectTask(
    history(
      { type: 'STREAMING', model: MODEL, credentialId: 'c' },
      { type: 'STREAM_PROGRESS', textSoFar: 'hello world' },
    ),
  );
  const presented = row(projection.nodes[0]!);
  assert.equal(presented.tone, 'running');
  assert.equal(presented.aside, '11 chars');
});

// --- switches are never silent ---

test('a model switch names both endpoints and states its reason', () => {
  const projection = projectTask(
    history({
      type: 'PROVIDER_SWITCHED',
      from: MODEL,
      to: OTHER,
      reason: 'every configured key for this provider was rejected',
    }),
  );
  const presented = row(projection.nodes[0]!);
  assert.equal(presented.label, 'Switched model');
  assert.match(presented.target ?? '', /claude-x → gpt-x/);
  assert.match(presented.text ?? '', /rejected/);
  assert.match(presented.spoken, /from anthropic claude-x to openai gpt-x/);
});

test('a recovery decision is translated out of its enum name', () => {
  for (const [decision, expected] of [
    ['RETRY_SAME: transient failure', 'Retrying the same model'],
    ['SWITCH_CREDENTIAL: rate limited', 'Trying another key'],
    ['SWITCH_MODEL: exhausted', 'Moving to another model'],
    ['COMPACT_CONTEXT: too long', 'Compacting the context'],
  ] as const) {
    const projection = projectTask(history({ type: 'RECOVERING', decision }));
    const presented = row(projection.nodes[0]!);
    assert.equal(presented.label, expected);
    // A recovery decision is CodeRelay's inference, not an observation.
    assert.equal(presented.tagKind, 'inferred');
  }
});

// --- failures explain themselves ---

test('every error class has an explanation that is not its own name', () => {
  for (const errorClass of [
    'RETRYABLE',
    'NETWORK',
    'TLS_UNTRUSTED',
    'AUTH',
    'FORBIDDEN',
    'CONFIG',
    'CONTEXT',
    'STREAM',
    'TOOL',
    'FILESYSTEM',
    'UNKNOWN',
  ]) {
    const explained = explainErrorClass(errorClass);
    assert.ok(explained.short.length > 0, `${errorClass} has no short form`);
    assert.ok(explained.advice.length > 20, `${errorClass} has no usable advice`);
    assert.ok(
      !explained.short.includes(errorClass),
      `${errorClass} leaks its enum name into the UI`,
    );
    assert.notEqual(explained.short, 'Error');
  }
});

test('an unrecognised class still explains itself rather than showing a blank', () => {
  const explained = explainErrorClass('SOMETHING_NEW');
  assert.match(explained.short, /Unexplained/);
  assert.ok(explained.advice.length > 20);
});

test('a certificate failure gives the actionable diagnosis, not a generic retry message', () => {
  // This is the one failure where the real cause is a machine setting, and where
  // failing over would hide it. The advice must name the proxy.
  assert.match(explainErrorClass('TLS_UNTRUSTED').advice, /proxy/i);
  assert.match(explainErrorClass('TLS_UNTRUSTED').advice, /certificate/i);
});

test('the recovery card states what already succeeded, so a failure is not lost work', () => {
  const projection = projectTask(
    history(
      { type: 'TASK_STARTED', objective: 'add validation' },
      { type: 'STREAMING', model: MODEL, credentialId: 'c' },
      {
        type: 'TOOL_REQUESTED',
        toolCallId: callId('c1'),
        toolName: 'write_file',
        args: { path: 'a.ts' },
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
        resultSummary: 'wrote a.ts',
        postState: [fp('a.ts', 'h')],
      },
      {
        type: 'FAILED',
        errorClass: 'NETWORK',
        message: 'the stream stopped sending data for 120s',
        hadStreamedTokens: true,
      },
    ),
  );

  const card = describeFailure(projection);
  assert.equal(card.title, 'Connection lost');
  assert.match(card.message, /connection to the provider/i);
  // The provider's own redacted detail is kept: it names the specific limit.
  assert.match(card.message, /120s/);

  const facts = card.facts.join('\n');
  assert.match(facts, /step/, 'progress in steps must be stated');
  assert.match(facts, /1 file written/, 'work that landed must be stated as fact');
  assert.match(facts, /checkpointed/, 'the user must be told the progress is durable');
  assert.match(facts, /✗ Connection lost/, 'the failure itself is the last line, not the only one');
});

test('a task that recovered and finished shows no failure card at all', () => {
  const projection = projectTask(
    history(
      { type: 'FAILED', errorClass: 'NETWORK', message: 'dropped', hadStreamedTokens: false },
      { type: 'RECOVERING', decision: 'RETRY_SAME: transient' },
      { type: 'TASK_DONE' },
    ),
  );
  assert.equal(projection.lastFailure, null);
  assert.equal(present({
    taskId: 't',
    projection,
    live: false,
    blocked: null,
    selectedModel: null,
  }).lastFailure, null);
});

// --- the whole view model ---

test('a stopped task is reported as stopped by the user, not as a failure', () => {
  const projection = projectTask(
    history(
      { type: 'TASK_STARTED', objective: 'o' },
      { type: 'TASK_ABANDONED', reason: 'Cancelled by the user.' },
    ),
  );
  const model = present({
    taskId: 't',
    projection,
    live: false,
    blocked: null,
    selectedModel: null,
  });

  assert.equal(model.header?.status, 'stopped');
  const terminal = model.nodes[model.nodes.length - 1];
  assert.equal(terminal?.label, 'Stopped by you');
  // The loop's own phrasing adds nothing the label has not said.
  assert.equal(terminal?.text, null);
});

test('token usage is omitted rather than shown as zero when never observed', () => {
  const projection = projectTask(history({ type: 'TASK_DONE' }));
  const model = present({
    taskId: 't',
    projection,
    live: false,
    blocked: null,
    selectedModel: null,
  });
  assert.equal(model.header?.tokensLabel, null);
  assert.equal(model.header?.costLabel, null);
});

test('a live task gets a trailing activity row, so the panel never looks frozen', () => {
  // The ledger is written ahead of the action it describes, so between entries
  // there is a real gap where the agent is working and the timeline cannot show
  // it yet.
  const projection = projectTask(history({ type: 'TASK_STARTED', objective: 'o' }), {
    live: true,
  });
  const model = present({
    taskId: 't',
    projection,
    live: true,
    blocked: null,
    selectedModel: null,
    activity: 'Reading src/auth.ts',
  });

  const last = model.nodes[model.nodes.length - 1];
  assert.equal(last?.id, 'activity');
  assert.equal(last?.label, 'Reading src/auth.ts');
  assert.equal(last?.tone, 'running');
});

test('a finished task gets no activity row', () => {
  const projection = projectTask(history({ type: 'TASK_DONE' }));
  const model = present({
    taskId: 't',
    projection,
    live: false,
    blocked: null,
    selectedModel: null,
    activity: 'stale',
  });
  assert.ok(!model.nodes.some((n) => n.id === 'activity'));
});

test('each blocked reason gets its own guidance and its own actions', () => {
  const base = { taskId: null, projection: null, live: false, selectedModel: null } as const;

  const noFolder = present({ ...base, blocked: 'no-folder' });
  assert.match(noFolder.emptyTitle, /Open a folder/);
  assert.deepEqual(noFolder.emptyActions, [], 'opening a folder is a VS Code action, not ours');

  const noModels = present({ ...base, blocked: 'no-models' });
  assert.match(noModels.emptyTitle, /Connect an AI provider/);
  // Guided setup leads to in-panel setup, and manage providers is offered
  assert.deepEqual(
    noModels.emptyActions.map((a) => a.command),
    ['setUp', 'setupOpenManage'],
  );
  assert.equal(noModels.emptyActions[0]?.primary, true);

  const badConfig = present({ ...base, blocked: 'config-error' });
  assert.match(badConfig.emptyTitle, /settings/i);
  assert.deepEqual(
    badConfig.emptyActions.map((a) => a.command),
    ['setupOpenManage'],
  );

  const ready = present({ ...base, blocked: null });
  assert.match(ready.emptyTitle, /Start your first coding task/);
});

test('every row carries a spoken sentence, so no row is announced as fragments', () => {
  const projection = projectTask(
    history(
      { type: 'TASK_STARTED', objective: 'add pagination' },
      { type: 'STREAMING', model: MODEL, credentialId: 'c' },
      {
        type: 'TOOL_REQUESTED',
        toolCallId: callId('c1'),
        toolName: 'read_file',
        args: { path: 'a.ts' },
        sideEffectKey: KEY,
        safety: 'pure',
      },
      { type: 'FAILED', errorClass: 'AUTH', message: 'rejected', hadStreamedTokens: false },
      { type: 'RECOVERING', decision: 'SWITCH_MODEL: no keys left' },
      { type: 'PROVIDER_SWITCHED', from: MODEL, to: OTHER, reason: 'r' },
      { type: 'ESCALATED', question: 'did it run?', sideEffectKey: KEY },
      { type: 'TASK_DONE' },
    ),
  );

  for (const node of projection.nodes) {
    const presented = presentRow(node);
    assert.ok(
      presented.spoken.trim().length > 0,
      `${node.kind} produced no accessible sentence`,
    );
    assert.ok(presented.glyph.length > 0, `${node.kind} produced no glyph`);
  }
});

test('change counts read as a sentence, including the empty case', () => {
  assert.equal(summarizeChanges([]), 'No files changed.');
  assert.equal(
    summarizeChanges([
      { path: 'a', kind: 'added', bytesBefore: null, bytesAfter: 1, provenance: 'observed' },
      { path: 'b', kind: 'modified', bytesBefore: 1, bytesAfter: 2, provenance: 'observed' },
      { path: 'c', kind: 'deleted', bytesBefore: 1, bytesAfter: null, provenance: 'observed' },
    ]),
    '3 files: 1 added, 1 modified, 1 deleted.',
  );
});

test('present supports agent modes, context window percentage, sound, and sessions', () => {
  const projection = projectTask(
    history(
      { type: 'TASK_STARTED', objective: 'architect a new feature' },
      { type: 'STREAMING', model: MODEL, credentialId: 'c' },
    ),
  );

  const model = present({
    taskId: 't-101',
    projection,
    live: true,
    blocked: null,
    selectedModel: MODEL,
    mode: 'architect',
    soundEnabled: true,
    contextWindowLimit: 100_000,
    sessions: [
      {
        id: 't-100',
        title: 'Past Task',
        status: 'completed',
        timeAgo: '5m ago',
        turns: 4,
        filesChanged: 2,
        isCurrent: false,
      },
    ],
  });

  assert.equal(model.mode, 'architect');
  assert.equal(model.soundEnabled, true);
  assert.equal(model.sessions.length, 1);
  assert.equal(model.header?.mode, 'architect');
  assert.equal(model.header?.contextWindowLimit, 100_000);
  assert.match(model.promptPlaceholder, /architectural problem/i);
});

test('present generates RelayInterruptionModel with progress and verified evidence', () => {
  const projection = projectTask(
    history(
      { type: 'TASK_STARTED', objective: 'Add JWT auth' },
      {
        type: 'PLAN_PROPOSED',
        title: 'Auth Plan',
        planMarkdown: '- [x] Sign JWT\n- [ ] Refresh token\n- [ ] Tests',
      },
      {
        type: 'TOOL_REQUESTED',
        toolCallId: callId('c1'),
        toolName: 'write_file',
        args: { path: 'src/auth.ts' },
        sideEffectKey: KEY,
        safety: 'idempotent',
      },
      {
        type: 'TOOL_COMPLETED',
        toolCallId: callId('c1'),
        sideEffectKey: KEY,
        ok: true,
        resultSummary: 'wrote auth.ts',
        postState: [fp('src/auth.ts', 'abc')],
      },
      {
        type: 'FAILED',
        errorClass: 'NETWORK',
        message: 'Connection timeout after 30s',
        hadStreamedTokens: true,
      },
    ),
  );

  const model = present({
    taskId: 't-102',
    projection,
    live: false,
    blocked: null,
    selectedModel: { providerId: 'anthropic', modelId: 'claude-3-7-sonnet' },
  });

  assert.ok(model.relayInterruption !== null);
  assert.equal(model.relayInterruption?.interruptedModel.providerId, 'anthropic');
  assert.ok(model.relayInterruption?.progressPercent > 0);
  assert.ok(model.relayInterruption?.verifiedFacts.some((f) => f.label.includes('Checkpoint')));
  assert.ok(model.relayInterruption?.verifiedFacts.some((f) => f.label.includes('verified on disk')));
  assert.equal(model.relayInterruption?.recommendedModel.providerId, 'google');
  assert.match(model.relayInterruption?.recommendationReason, /1M\+ context capacity/);
  assert.ok(model.relayInterruption?.pipelineSteps.length > 4);
});

