/**
 * The approval gate, and what recovery makes of an interrupted command.
 *
 * One ordering property carries the whole design: permission is asked *before*
 * `TOOL_EXECUTING` is written. A refusal must therefore leave no trace that a
 * later restart could read as "this may have run" — denied has to mean provably
 * un-run, not probably un-run.
 *
 * The second half of the file covers the payoff of the effect log: three
 * distinguishable states after a crash, two of which no longer need to trouble
 * the user.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionLedger } from '../../src/continuity/ledger.js';
import { ToolRunner, type ApprovalRequest } from '../../src/tools/runner.js';
import { ToolRegistry, registerTool } from '../../src/tools/tool.js';
import { FileSystemProbe } from '../../src/workspace/probe.js';
import type { EffectLogReader, EffectRecord } from '../../src/recovery/replay.js';
import type { AttemptId, SideEffectKey, StepId, TaskId, ToolCallId } from '../../src/core/types.js';

const TASK = 'task-1' as TaskId;
const STEP = 'task-1#turn-1' as StepId;
const ATTEMPT = 'task-1#turn-1-attempt-1' as AttemptId;

/** A tool that records whether it ran, so "denied" can be proved. */
function spyTool(name: string, safety: 'pure' | 'idempotent' | 'unsafe') {
  const calls: unknown[] = [];
  const tool = registerTool<{ v: string }>({
    name,
    safety,
    parse: (a) => ({ v: String((a as Record<string, unknown>)?.['v'] ?? '') }),
    affectedPaths: () => [],
    predictPostState: () => null,
    async execute(args) {
      calls.push(args);
      return 'ran';
    },
  });
  return { tool, calls };
}

async function harness(
  tool: ReturnType<typeof spyTool>['tool'],
  approve?: (r: ApprovalRequest) => Promise<{ t: 'allowed' } | { t: 'denied'; reason: string }>,
  effects?: EffectLogReader,
) {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-approve-'));
  const ledger = await ExecutionLedger.open(dir, TASK);
  const runner = new ToolRunner({
    ledger,
    tools: new ToolRegistry([tool]),
    probe: new FileSystemProbe(dir),
    root: dir,
    taskId: TASK,
    ...(approve === undefined ? {} : { approve }),
    ...(effects === undefined ? {} : { effects }),
  });
  return {
    dir,
    ledger,
    runner,
    entries: () => ExecutionLedger.readEntries(ledger.filePath),
    dispose: async () => {
      await ledger.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const call = (toolName: string): Parameters<ToolRunner['run']>[0] => ({
  toolCallId: 'c1' as ToolCallId,
  stepId: STEP,
  attemptId: ATTEMPT,
  toolName,
  args: { v: 'x' },
});

// --- the gate ---------------------------------------------------------------

test('a denied call never runs and never opens the ambiguous window', async () => {
  const { tool, calls } = spyTool('risky', 'unsafe');
  const h = await harness(tool, async () => ({ t: 'denied', reason: 'You declined this command.' }));
  try {
    const outcome = await h.runner.run(call('risky'));

    assert.equal(outcome.kind, 'FAILED');
    assert.equal(calls.length, 0, 'a denied tool must not execute');

    const entries = await h.entries();
    // The critical assertion: no TOOL_EXECUTING, so a crash right now cannot be
    // mistaken for "this may already have run".
    assert.equal(entries.filter((e) => e.type === 'TOOL_EXECUTING').length, 0);
    assert.equal(entries.filter((e) => e.type === 'TOOL_REQUESTED').length, 1);
    const completed = entries.find((e) => e.type === 'TOOL_COMPLETED');
    assert.ok(completed !== undefined && completed.type === 'TOOL_COMPLETED');
    assert.equal(completed.ok, false);
  } finally {
    await h.dispose();
  }
});

test('the denial reason reaches the model, so it can choose something else', async () => {
  const { tool } = spyTool('risky', 'unsafe');
  const h = await harness(tool, async () => ({ t: 'denied', reason: 'Read-only mode is on.' }));
  try {
    const outcome = await h.runner.run(call('risky'));
    assert.equal(outcome.kind, 'FAILED');
    if (outcome.kind === 'FAILED') {
      assert.match(outcome.message, /Read-only mode is on/);
    }
  } finally {
    await h.dispose();
  }
});

test('an allowed call proceeds exactly as before', async () => {
  const { tool, calls } = spyTool('risky', 'unsafe');
  const h = await harness(tool, async () => ({ t: 'allowed' }));
  try {
    const outcome = await h.runner.run(call('risky'));
    assert.equal(outcome.kind, 'EXECUTED');
    assert.equal(calls.length, 1);
  } finally {
    await h.dispose();
  }
});

test('a pure tool is never put behind a prompt', async () => {
  const { tool, calls } = spyTool('reader', 'pure');
  let asked = 0;
  const h = await harness(tool, async () => {
    asked += 1;
    return { t: 'allowed' };
  });
  try {
    await h.runner.run(call('reader'));
    assert.equal(asked, 0, 'reading has no effect to approve');
    assert.equal(calls.length, 1);
  } finally {
    await h.dispose();
  }
});

test('with no approver configured, behaviour is unchanged', async () => {
  const { tool, calls } = spyTool('risky', 'unsafe');
  const h = await harness(tool);
  try {
    assert.equal((await h.runner.run(call('risky'))).kind, 'EXECUTED');
    assert.equal(calls.length, 1);
  } finally {
    await h.dispose();
  }
});

test('the approval request describes the validated call, not raw text', async () => {
  const { tool } = spyTool('risky', 'unsafe');
  // Collected into an array rather than a closed-over variable: assignment
  // inside a callback is invisible to control-flow narrowing, so the `let`
  // form types as `never` after the null check.
  const seen: ApprovalRequest[] = [];
  const h = await harness(tool, async (r) => {
    seen.push(r);
    return { t: 'allowed' };
  });
  try {
    await h.runner.run(call('risky'));
    assert.equal(seen.length, 1);
    const request = seen[0]!;
    assert.equal(request.toolName, 'risky');
    assert.deepEqual(request.args, { v: 'x' });
    assert.ok(typeof request.sideEffectKey === 'string' && request.sideEffectKey.length > 0);
  } finally {
    await h.dispose();
  }
});

// --- recovery from an interrupted command -----------------------------------

/** An effect log with whatever the test wants it to say. */
const reader = (record: EffectRecord | null): EffectLogReader => ({
  read: async () => record,
});

async function interrupted(effects: EffectLogReader) {
  const { tool } = spyTool('risky', 'unsafe');
  const h = await harness(tool, undefined, effects);
  // A crash between TOOL_EXECUTING and TOOL_COMPLETED: the ambiguous window.
  await h.ledger.append({
    taskId: TASK,
    stepId: STEP,
    attemptId: ATTEMPT,
    type: 'TOOL_EXECUTING',
    toolCallId: 'c1' as ToolCallId,
    sideEffectKey: 'key-1' as SideEffectKey,
    safety: 'unsafe',
    preState: [],
    expectedPostState: null,
  });
  return h;
}

test('no log means the command provably never started, so it is simply run', async () => {
  const h = await interrupted(reader(null));
  try {
    const plan = await h.runner.resume();
    assert.equal(plan.kind, 'EXECUTE_TOOL');
    if (plan.kind === 'EXECUTE_TOOL') {
      assert.match(plan.reason, /provably never ran/);
    }
  } finally {
    await h.dispose();
  }
});

test('a recorded exit code settles the command without asking anyone', async () => {
  const h = await interrupted(reader({ t: 'finished', exitCode: 0 }));
  try {
    const plan = await h.runner.resume();
    assert.equal(plan.kind, 'ADOPT_COMPLETED_EFFECT');
    if (plan.kind === 'ADOPT_COMPLETED_EFFECT') {
      assert.match(plan.evidence, /exited 0/);
    }
  } finally {
    await h.dispose();
  }
});

test('a log with no outcome is genuinely unknown, so the user decides', async () => {
  const h = await interrupted(reader({ t: 'started' }));
  try {
    const plan = await h.runner.resume();
    assert.equal(plan.kind, 'ASK_USER');
    if (plan.kind === 'ASK_USER') {
      assert.match(plan.question, /never recorded finishing/);
    }
  } finally {
    await h.dispose();
  }
});

test('without an effect log reader an unsafe command still escalates, as it always did', async () => {
  const h = await interrupted(undefined as unknown as EffectLogReader);
  try {
    const plan = await h.runner.resume();
    assert.equal(plan.kind, 'ASK_USER', 'no evidence means no conclusion');
  } finally {
    await h.dispose();
  }
});
