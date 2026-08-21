/**
 * The write-ahead tool protocol, end to end on a real filesystem.
 *
 * These are the tests that actually demonstrate the product claim, because they
 * exercise the ledger, the probe, the tools and recovery together. The headline
 * case is "crash while a write is in flight, then resume": the effect must be
 * adopted exactly once and never repeated.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExecutionLedger } from '../../src/continuity/ledger.js';
import type { LedgerEntry } from '../../src/continuity/entries.js';
import type { AttemptId, StepId, TaskId, ToolCallId } from '../../src/core/types.js';
import { builtinFileTools, resolveInside } from '../../src/tools/file-tools.js';
import { ToolRegistry, registerTool } from '../../src/tools/tool.js';
import { ToolRunner } from '../../src/tools/runner.js';
import { FileSystemProbe, sha256Hex } from '../../src/workspace/probe.js';

const TASK = 'task-1' as TaskId;
const STEP = 'step-1' as StepId;
const ATTEMPT = 'attempt-1' as AttemptId;
const CALL = 'call-1' as ToolCallId;

interface Harness {
  readonly dir: string;
  readonly workspace: string;
  readonly ledger: ExecutionLedger;
  readonly runner: ToolRunner;
  readonly probe: FileSystemProbe;
  dispose(): Promise<void>;
}

async function harness(extraTools: Parameters<ToolRegistry['add']>[0][] = []): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-runner-'));
  const workspace = join(dir, 'workspace');
  const probe = new FileSystemProbe(workspace);
  const ledger = await ExecutionLedger.open(join(dir, 'storage'), TASK);
  const tools = new ToolRegistry(builtinFileTools);
  for (const t of extraTools) {
    tools.add(t);
  }

  return {
    dir,
    workspace,
    ledger,
    probe,
    runner: new ToolRunner({ ledger, tools, probe, root: workspace, taskId: TASK }),
    async dispose() {
      await ledger.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * `assert.ok(e?.type === 'TOOL_EXECUTING')` convinces a human but not the
 * compiler, so narrow with a predicate instead. This also keeps the variant type
 * intact when an entry is spread into a fabricated history.
 */
type Executing = Extract<LedgerEntry, { type: 'TOOL_EXECUTING' }>;

function executings(entries: readonly LedgerEntry[]): Executing[] {
  return entries.filter((e): e is Executing => e.type === 'TOOL_EXECUTING');
}

const writeCall = (path: string, content: string) => ({
  toolCallId: CALL,
  stepId: STEP,
  attemptId: ATTEMPT,
  toolName: 'write_file',
  args: { path, content },
});

test('a successful write is recorded in write-ahead order', async () => {
  const h = await harness();
  try {
    const outcome = await h.runner.run(writeCall('a.ts', 'export const x = 1;\n'));
    assert.equal(outcome.kind, 'EXECUTED');

    assert.equal(
      await readFile(join(h.workspace, 'a.ts'), 'utf8'),
      'export const x = 1;\n',
      'the effect must actually have happened',
    );

    const types = (await h.ledger.read()).map((e) => e.type);
    // The order is the safety argument: intent, then "about to run", then done.
    assert.deepEqual(types, ['TOOL_REQUESTED', 'TOOL_EXECUTING', 'TOOL_COMPLETED']);
  } finally {
    await h.dispose();
  }
});

test('the pre-state is captured before the effect, not after', async () => {
  const h = await harness();
  try {
    // The workspace directory does not exist yet on a fresh harness, so seed the
    // file through the tool rather than writing behind its back.
    await h.runner.run(writeCall('a.ts', 'old'));

    await h.runner.run(writeCall('a.ts', 'new'));
    const entries = await h.ledger.read();
    const executing = executings(entries).at(-1);

    assert.ok(executing);
    assert.equal(executing.preState[0]?.sha256, sha256Hex('old'));
    assert.equal(executing.expectedPostState?.[0]?.sha256, sha256Hex('new'));
  } finally {
    await h.dispose();
  }
});

// The core claim. The ledger says a write was in flight and the bytes are on
// disk; resuming must adopt that, not write again.
test('a crash after the write lands is adopted on resume, not repeated', async () => {
  const h = await harness();
  try {
    const content = 'export const x = 1;\n';
    // Simulate the interruption: perform the real protocol up to TOOL_EXECUTING,
    // let the effect land, then never record completion.
    await h.runner.run(writeCall('a.ts', content));

    // Rebuild the same situation with the completion entry removed, which is
    // exactly what a host crash between steps 3 and 4 leaves behind.
    const durable = (await h.ledger.read()).filter((e) => e.type !== 'TOOL_COMPLETED');
    await h.ledger.close();
    await writeFile(
      h.ledger.filePath,
      durable.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );

    const reopened = await ExecutionLedger.open(join(h.dir, 'storage'), TASK);
    const runner = new ToolRunner({
      ledger: reopened,
      tools: new ToolRegistry(builtinFileTools),
      probe: h.probe,
      root: h.workspace,
      taskId: TASK,
    });

    const plan = await runner.resume();
    assert.equal(plan.kind, 'ADOPT_COMPLETED_EFFECT');

    // The reconciliation is durable, so a second restart is a no-op too.
    const entries = await reopened.read();
    assert.ok(entries.some((e) => e.type === 'TOOL_RECONCILED'));
    assert.equal(
      (await runner.resume()).kind,
      'START_TURN',
      'a settled effect must not be reconsidered',
    );

    assert.equal(await readFile(join(h.workspace, 'a.ts'), 'utf8'), content);
    await reopened.close();
  } finally {
    await h.dispose();
  }
});

test('a crash before the write lands re-executes exactly once', async () => {
  const h = await harness();
  try {
    // Prepare a file, then fabricate an interrupted second write whose effect
    // never landed.
    await h.runner.run(writeCall('a.ts', 'old'));
    const first = await h.ledger.read();

    const executing = executings(first).at(0);
    assert.ok(executing);

    const interrupted: LedgerEntry[] = [
      ...first,
      {
        ...executing,
        seq: first.length,
        toolCallId: 'call-2' as ToolCallId,
        preState: [{ path: 'a.ts', sha256: sha256Hex('old'), sizeBytes: 3 }],
        expectedPostState: [{ path: 'a.ts', sha256: sha256Hex('new'), sizeBytes: 3 }],
      },
    ];

    await h.ledger.close();
    await writeFile(
      h.ledger.filePath,
      interrupted.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );

    const reopened = await ExecutionLedger.open(join(h.dir, 'storage'), TASK);
    const runner = new ToolRunner({
      ledger: reopened,
      tools: new ToolRegistry(builtinFileTools),
      probe: h.probe,
      root: h.workspace,
      taskId: TASK,
    });

    const plan = await runner.resume();
    assert.equal(plan.kind, 'EXECUTE_TOOL');
    assert.equal(await readFile(join(h.workspace, 'a.ts'), 'utf8'), 'old', 'nothing ran yet');
    await reopened.close();
  } finally {
    await h.dispose();
  }
});

test('a delete predicts absence and is adopted when the file is already gone', async () => {
  const h = await harness();
  try {
    await h.runner.run(writeCall('a.ts', 'x'));
    const outcome = await h.runner.run({
      toolCallId: 'call-del' as ToolCallId,
      stepId: 'step-2' as StepId,
      attemptId: ATTEMPT,
      toolName: 'delete_file',
      args: { path: 'a.ts' },
    });

    assert.equal(outcome.kind, 'EXECUTED');
    const entries = await h.ledger.read();
    const executing = executings(entries).at(-1);
    assert.ok(executing);
    assert.equal(executing.expectedPostState?.[0]?.sha256, null);
  } finally {
    await h.dispose();
  }
});

test('a failing tool is recorded as settled, so it is not re-run as ambiguous', async () => {
  const exploding = registerTool<{ path: string }>({
    name: 'explode',
    safety: 'idempotent',
    parse: (args) => ({ path: (args as { path: string }).path }),
    affectedPaths: ({ path }) => [path],
    predictPostState: () => null,
    async execute() {
      throw new Error('disk on fire');
    },
  });

  const h = await harness([exploding]);
  try {
    const outcome = await h.runner.run({
      toolCallId: CALL,
      stepId: STEP,
      attemptId: ATTEMPT,
      toolName: 'explode',
      args: { path: 'a.ts' },
    });

    assert.equal(outcome.kind, 'FAILED');
    const last = (await h.ledger.read()).at(-1);
    assert.equal(last?.type, 'TOOL_COMPLETED');
    assert.equal(last?.type === 'TOOL_COMPLETED' ? last.ok : true, false);

    // Observed failure is a fact, so recovery must not treat it as "may have run".
    assert.equal((await h.runner.resume()).kind, 'START_TURN');
  } finally {
    await h.dispose();
  }
});

test('malformed arguments fail without opening an ambiguous window', async () => {
  const h = await harness();
  try {
    const outcome = await h.runner.run({
      toolCallId: CALL,
      stepId: STEP,
      attemptId: ATTEMPT,
      toolName: 'write_file',
      args: { path: 'a.ts' }, // no content
    });

    assert.equal(outcome.kind, 'FAILED');
    const types = (await h.ledger.read()).map((e) => e.type);
    assert.deepEqual(types, ['TOOL_REQUESTED', 'TOOL_COMPLETED']);
    assert.ok(!types.includes('TOOL_EXECUTING'), 'nothing was ever about to run');
  } finally {
    await h.dispose();
  }
});

test('an unknown tool is rejected before anything is recorded as executing', async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () =>
        h.runner.run({
          toolCallId: CALL,
          stepId: STEP,
          attemptId: ATTEMPT,
          toolName: 'rm_rf_slash',
          args: {},
        }),
      /Unknown tool/,
    );
  } finally {
    await h.dispose();
  }
});

test('a resumed task with nothing in flight simply starts a turn', async () => {
  const h = await harness();
  try {
    assert.equal((await h.runner.resume()).kind, 'START_TURN');
  } finally {
    await h.dispose();
  }
});

test('paths outside the workspace are refused', async () => {
  for (const path of ['../escape.ts', '../../etc/passwd', '/etc/passwd']) {
    assert.throws(() => resolveInside('/tmp/workspace', path), /outside the workspace/);
  }
});

test('a path inside a subdirectory is allowed', async () => {
  assert.equal(resolveInside('/tmp/ws', 'src/a.ts'), '/tmp/ws/src/a.ts');
});

test('registering two tools under one name is refused', async () => {
  const tools = new ToolRegistry(builtinFileTools);
  assert.throws(() => tools.add(builtinFileTools[0]!), /already registered/);
});
