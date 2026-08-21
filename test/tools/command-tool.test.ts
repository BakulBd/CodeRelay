/**
 * `run_command`, against real processes.
 *
 * These tests spawn actual shells, because the properties being checked are
 * about process behaviour — exit codes, timeouts, killed children, output that
 * arrives on stderr — and a mocked spawn would assert that the mock works.
 *
 * The property doing the most work is the effect log: it is written *before* the
 * process starts, which is what lets recovery tell "never ran" from "may have
 * run" after a crash. That ordering is asserted directly rather than assumed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandTool, runCommandSpec } from '../../src/tools/command-tool.js';
import { FileSystemProbe } from '../../src/workspace/probe.js';
import type { ToolContext } from '../../src/tools/tool.js';

async function workspace(): Promise<{ dir: string; ctx: ToolContext; log: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-cmd-'));
  const log = join(dir, '.effects', 'key.log');
  return { dir, log, ctx: { root: dir, probe: new FileSystemProbe(dir), effectLogPath: log } };
}

test('a successful command returns its output', async (t) => {
  const { dir, ctx } = await workspace();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const summary = await runCommandTool.execute({ command: 'echo hello-relay' }, ctx);
  assert.match(summary, /hello-relay/);
});

test('the command runs in the workspace root, not the extension host cwd', async (t) => {
  const { dir, ctx } = await workspace();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'marker.txt'), 'x', 'utf8');

  const summary = await runCommandTool.execute({ command: 'ls' }, ctx);
  assert.match(summary, /marker\.txt/);
});

test('a non-zero exit is a failure carrying the output, not a silent success', async (t) => {
  const { dir, ctx } = await workspace();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => runCommandTool.execute({ command: 'echo boom >&2; exit 3' }, ctx),
    (err: Error) => {
      assert.match(err.message, /exited with code 3/);
      // stderr is part of the evidence the model needs to fix the failure.
      assert.match(err.message, /boom/);
      return true;
    },
  );
});

test('stderr is captured as well as stdout', async (t) => {
  const { dir, ctx } = await workspace();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const summary = await runCommandTool.execute({ command: 'echo out; echo err >&2' }, ctx);
  assert.match(summary, /out/);
  assert.match(summary, /err/);
});

test('the effect log exists before the command finishes, and records the exit code after', async (t) => {
  const { dir, ctx, log } = await workspace();
  t.after(() => rm(dir, { recursive: true, force: true }));

  // The command blocks until the file it is waiting on appears, so the assertion
  // below runs while the process is genuinely still in flight.
  const gate = join(dir, 'gate');
  const running = runCommandTool.execute(
    { command: `while [ ! -f "${gate}" ]; do sleep 0.02; done; echo done` },
    ctx,
  );

  // Wait for the log to appear, which is the evidence recovery relies on.
  for (let i = 0; i < 200 && !existsSync(log); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(existsSync(log), 'the log must exist while the command is still running');
  const midFlight = await readFile(log, 'utf8');
  assert.ok(!/^exit:/m.test(midFlight), 'no exit code may be recorded before the command ends');

  await writeFile(gate, '', 'utf8');
  await running;

  const finished = await readFile(log, 'utf8');
  assert.match(finished, /^exit: 0$/m, 'the outcome must be recorded once it is known');
  assert.match(finished, /command: while/);
});

test('a failing command still records its exit code, so recovery can settle it', async (t) => {
  const { dir, ctx, log } = await workspace();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => runCommandTool.execute({ command: 'exit 7' }, ctx));
  assert.match(await readFile(log, 'utf8'), /^exit: 7$/m);
});

test('a command that overruns its limit is killed and reported as a timeout', async (t) => {
  const { dir, ctx } = await workspace();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => runCommandTool.execute({ command: 'sleep 30' }, { ...ctx, commandTimeoutMs: 150 }),
    /timed out/,
  );
});

test('cancelling the task kills the command instead of waiting for it', async (t) => {
  const { dir, ctx } = await workspace();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const controller = new AbortController();
  const started = Date.now();
  const running = runCommandTool.execute({ command: 'sleep 30' }, { ...ctx, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);

  // Killed, so it resolves or rejects quickly rather than after 30 seconds.
  await running.catch(() => undefined);
  assert.ok(Date.now() - started < 5_000, 'an aborted command must not run to completion');
});

test('output is bounded, so one noisy build cannot exhaust the context window', async (t) => {
  const { dir, ctx } = await workspace();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const summary = await runCommandTool.execute(
    { command: 'for i in $(seq 1 20000); do echo "line-$i-padding-padding-padding"; done' },
    ctx,
  );
  assert.ok(summary.length < 20_000, `expected clipping, got ${summary.length} chars`);
  assert.match(summary, /characters omitted/);
});

test('the tool refuses a call with no command rather than running an empty shell', async (t) => {
  const { dir, ctx } = await workspace();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => runCommandTool.execute({ command: '   ' }, ctx), /non-empty/);
  await assert.rejects(() => runCommandTool.execute({}, ctx), /non-empty/);
});

test('the tool is unsafe and predicts nothing, which is what forces escalation', () => {
  assert.equal(runCommandTool.safety, 'unsafe');
  const planned = runCommandTool.plan({ command: 'npm test' });
  assert.deepEqual(planned.paths, [], 'a command’s targets are unknowable in advance');
  assert.equal(planned.expectedPostState, null, 'claiming a post-state would misdirect recovery');
});

test('the advertised schema matches what the tool actually parses', () => {
  assert.equal(runCommandSpec.name, runCommandTool.name);
  assert.deepEqual(runCommandSpec.schema.required, ['command']);
  assert.ok('command' in runCommandSpec.schema.properties);
  assert.ok('explanation' in runCommandSpec.schema.properties);
});
