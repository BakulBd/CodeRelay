/**
 * Verification: detection, execution and the verdict.
 *
 * The whole feature exists to stop a task being called complete because a model
 * said so, which means the assertions that matter are the ones about *not*
 * claiming success: an empty plan, a cancelled run, a command that could not
 * start. Any of those rendering as a green tick would make the panel worse than
 * having none.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHECK_ORDER,
  detectPackageManager,
  planVerification,
  type WorkspaceFacts,
} from '../../src/verify/plan.js';
import {
  runVerification,
  verdictFor,
  type CheckResult,
  type CommandResult,
} from '../../src/verify/run.js';
import { createExecutor, readWorkspaceFacts } from '../../src/verify/exec.js';

function facts(over: Partial<WorkspaceFacts> = {}): WorkspaceFacts {
  return {
    scripts: { test: 'node --test', build: 'tsc' },
    rootFiles: ['package.json'],
    packageManager: 'npm',
    ...over,
  };
}

const ok = (over: Partial<CommandResult> = {}): CommandResult => ({
  exitCode: 0,
  output: 'fine',
  timedOut: false,
  durationMs: 10,
  ...over,
});

// --- detection: never invent a command ------------------------------------

test('only declared scripts become checks', () => {
  const plan = planVerification(facts({ scripts: { test: 'node --test' }, rootFiles: [] }));

  assert.deepEqual(
    plan.checks.map((c) => c.id),
    ['test'],
    'a project with one script must not be given four commands to fail',
  );
  assert.deepEqual(
    plan.unavailable.map((u) => u.id).sort(),
    ['build', 'lint', 'typecheck'],
  );
});

test('a project with no manifest yields an empty plan and says why', () => {
  const plan = planVerification(facts({ scripts: null, rootFiles: [] }));

  assert.deepEqual(plan.checks, []);
  assert.equal(plan.unavailable.length, CHECK_ORDER.length);
  for (const entry of plan.unavailable) {
    assert.match(entry.reason, /no package\.json/);
  }
});

test('tsconfig.json alone is enough to type-check, and is the only such fallback', () => {
  const plan = planVerification(facts({ scripts: {}, rootFiles: ['tsconfig.json'] }));

  assert.deepEqual(plan.checks.map((c) => c.id), ['typecheck']);
  assert.equal(plan.checks[0]?.command, 'npx tsc --noEmit');
  assert.match(plan.checks[0]?.because ?? '', /tsconfig\.json is present/);

  // No equivalent guess exists for the others: no file implies a test command.
  const guessed = planVerification(
    facts({ scripts: {}, rootFiles: ['tsconfig.json', 'jest.config.js', '.eslintrc.json'] }),
  );
  assert.deepEqual(guessed.checks.map((c) => c.id), ['typecheck']);
});

test('a declared typecheck script beats the tsconfig fallback', () => {
  const plan = planVerification(
    facts({ scripts: { typecheck: 'tsc -p . --noEmit' }, rootFiles: ['tsconfig.json'] }),
  );
  assert.equal(plan.checks[0]?.command, 'npm run typecheck');
  assert.match(plan.checks[0]?.because ?? '', /declares a "typecheck" script/);
});

test('never selects a watch script, which would never exit', () => {
  const plan = planVerification(
    facts({ scripts: { 'test:watch': 'vitest', 'lint:fix': 'eslint --fix' }, rootFiles: [] }),
  );
  assert.deepEqual(
    plan.checks,
    [],
    'a verification step that hangs is worse than one that is absent',
  );
});

test('an empty script value is not a script', () => {
  const plan = planVerification(facts({ scripts: { test: '' }, rootFiles: [] }));
  assert.deepEqual(plan.checks, []);
});

test('checks are ordered cheapest and most localised first', () => {
  const plan = planVerification(
    facts({
      scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x' },
      rootFiles: [],
    }),
  );
  assert.deepEqual(plan.checks.map((c) => c.id), ['typecheck', 'lint', 'test', 'build']);
});

test('the package manager comes from the lockfile that was actually written', () => {
  assert.equal(detectPackageManager(['pnpm-lock.yaml']), 'pnpm');
  assert.equal(detectPackageManager(['yarn.lock']), 'yarn');
  assert.equal(detectPackageManager(['bun.lockb']), 'bun');
  assert.equal(detectPackageManager(['package-lock.json']), 'npm');
  assert.equal(detectPackageManager([]), 'npm', 'npm is the safe default');
  // A repository carrying several lockfiles is common after a migration; the
  // more specific tool wins over npm's.
  assert.equal(detectPackageManager(['package-lock.json', 'pnpm-lock.yaml']), 'pnpm');
});

test('each manager runs scripts its own way', () => {
  for (const [manager, expected] of [
    ['npm', 'npm run test'],
    ['pnpm', 'pnpm run test'],
    ['yarn', 'yarn test'],
    ['bun', 'bun run test'],
  ] as const) {
    const plan = planVerification(
      facts({ scripts: { test: 'x' }, rootFiles: [], packageManager: manager }),
    );
    assert.equal(plan.checks[0]?.command, expected);
  }
});

// --- the verdict: the part that must never lie ----------------------------

test('nothing to check is never reported as verified', async () => {
  const run = await runVerification({
    plan: { checks: [], unavailable: [{ id: 'test', reason: 'no "test" script' }] },
    exec: async () => ok(),
  });

  assert.equal(
    run.verdict,
    'unverifiable',
    'a project with no tests has not passed its tests',
  );
  assert.deepEqual(run.checks, []);
  assert.equal(run.unavailable.length, 1, 'the reason must survive into the panel');
});

test('every check passing is verified', async () => {
  const plan = planVerification(facts({ scripts: { typecheck: 'x', test: 'x' }, rootFiles: [] }));
  const run = await runVerification({ plan, exec: async () => ok(), now: stepClock() });

  assert.equal(run.verdict, 'verified');
  assert.deepEqual(run.checks.map((c) => c.status), ['passed', 'passed']);
});

test('one failure fails the verdict and stops the rest', async () => {
  const plan = planVerification(
    facts({ scripts: { typecheck: 'x', test: 'x', build: 'x' }, rootFiles: [] }),
  );
  const attempted: string[] = [];
  const run = await runVerification({
    plan,
    exec: async (command) => {
      attempted.push(command);
      return ok({ exitCode: 2, output: 'TS2339: nope' });
    },
  });

  assert.equal(run.verdict, 'failed');
  assert.equal(attempted.length, 1, 'a test run after a type error is noise with one cause');
  assert.deepEqual(run.checks.map((c) => c.status), ['failed', 'skipped', 'skipped']);
  assert.match(run.checks[1]?.summary ?? '', /an earlier check failed/);
});

test('continueOnFailure runs everything and still fails the verdict', async () => {
  const plan = planVerification(facts({ scripts: { typecheck: 'x', test: 'x' }, rootFiles: [] }));
  const run = await runVerification({
    plan,
    continueOnFailure: true,
    exec: async (command) =>
      command.includes('typecheck') ? ok({ exitCode: 1 }) : ok(),
  });

  assert.equal(run.verdict, 'failed');
  assert.deepEqual(run.checks.map((c) => c.status), ['failed', 'passed']);
});

test('a command that cannot start is errored, not failed', async () => {
  const plan = planVerification(facts({ scripts: { test: 'x' }, rootFiles: [] }));
  const run = await runVerification({
    plan,
    exec: async () => {
      throw new Error('spawn pnpm ENOENT');
    },
  });

  assert.equal(run.checks[0]?.status, 'errored');
  assert.match(
    run.checks[0]?.summary ?? '',
    /Could not run/,
    '"your tests are broken" and "CodeRelay could not run your tests" have different fixes',
  );
  assert.equal(run.verdict, 'failed');
});

test('a timeout is a failure, not a pass', async () => {
  const plan = planVerification(facts({ scripts: { test: 'x' }, rootFiles: [] }));
  const run = await runVerification({
    plan,
    // Exit code 0 with timedOut set is the shape a killed process can produce.
    exec: async () => ok({ timedOut: true }),
  });

  assert.equal(run.checks[0]?.status, 'failed');
  assert.match(run.checks[0]?.summary ?? '', /did not finish in time/);
  assert.equal(run.verdict, 'failed');
});

test('a cancelled run is never verified, even when nothing failed', async () => {
  const controller = new AbortController();
  const plan = planVerification(facts({ scripts: { typecheck: 'x', test: 'x' }, rootFiles: [] }));

  const run = await runVerification({
    plan,
    signal: controller.signal,
    exec: async () => {
      controller.abort();
      return ok();
    },
  });

  assert.equal(
    run.verdict,
    'cancelled',
    'checks that never ran cannot be counted as checks that passed',
  );
  assert.deepEqual(run.checks.map((c) => c.status), ['passed', 'skipped']);
});

test('an already-aborted signal runs nothing at all', async () => {
  const controller = new AbortController();
  controller.abort();
  const plan = planVerification(facts({ scripts: { test: 'x' }, rootFiles: [] }));
  let ran = false;

  const run = await runVerification({
    plan,
    signal: controller.signal,
    exec: async () => {
      ran = true;
      return ok();
    },
  });

  assert.equal(ran, false);
  assert.equal(run.verdict, 'cancelled');
});

test('verdictFor is exhaustive over the states it can be handed', () => {
  const base: CheckResult = {
    id: 'test',
    label: 'Tests',
    command: 'npm test',
    status: 'passed',
    durationMs: 1,
    summary: '',
    output: '',
  };

  assert.equal(verdictFor([], false), 'unverifiable');
  assert.equal(verdictFor([base], false), 'verified');
  assert.equal(verdictFor([{ ...base, status: 'failed' }], false), 'failed');
  assert.equal(verdictFor([{ ...base, status: 'errored' }], false), 'failed');
  assert.equal(verdictFor([{ ...base, status: 'skipped' }], false), 'cancelled');
  assert.equal(verdictFor([base], true), 'cancelled');
  assert.equal(
    verdictFor([{ ...base, status: 'failed' }, { ...base, status: 'skipped' }], true),
    'failed',
    'a real failure outranks an incomplete run',
  );
});

// --- output handling -------------------------------------------------------

test('huge output is truncated from the head, keeping the summary at the end', async () => {
  const plan = planVerification(facts({ scripts: { test: 'x' }, rootFiles: [] }));
  const tail = 'FAIL: 3 tests failed';
  const run = await runVerification({
    plan,
    exec: async () => ok({ exitCode: 1, output: 'x'.repeat(50_000) + tail }),
  });

  const output = run.checks[0]?.output ?? '';
  assert.ok(output.length < 50_000, 'megabytes of output must not reach the view model');
  assert.ok(output.endsWith(tail), 'runners put the summary last, so the tail is what matters');
  assert.match(output, /earlier characters omitted/);
});

test('a passing check keeps its output for the disclosure', async () => {
  const plan = planVerification(facts({ scripts: { test: 'x' }, rootFiles: [] }));
  const run = await runVerification({ plan, exec: async () => ok({ output: '42 passing' }) });
  assert.equal(run.checks[0]?.output, '42 passing');
});

/** A clock that advances 5ms per read, so durations are exact and non-zero. */
function stepClock(): () => number {
  let t = 0;
  return () => {
    t += 5;
    return t;
  };
}

// --- the impure edge -------------------------------------------------------
// `createExecutor` and `readWorkspaceFacts` are the only parts that touch a
// real process or disk, so they are tested against a real temporary directory
// rather than mocked — a fake `spawn` would prove nothing about the thing that
// actually runs.

test('the executor reports a real exit code and captures output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-verify-'));
  try {
    const exec = createExecutor({ root: dir });
    const passed = await exec('echo hello', new AbortController().signal);
    assert.equal(passed.exitCode, 0);
    assert.match(passed.output, /hello/);
    assert.equal(passed.timedOut, false);

    const failed = await exec('exit 3', new AbortController().signal);
    assert.equal(failed.exitCode, 3, 'a failing command resolves; it does not reject');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the executor kills a command that outruns its timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-verify-'));
  try {
    const exec = createExecutor({ root: dir, timeoutMs: 150 });
    const result = await exec('sleep 30', new AbortController().signal);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an already-aborted signal stops the command immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-verify-'));
  try {
    const controller = new AbortController();
    controller.abort();
    const exec = createExecutor({ root: dir, timeoutMs: 30_000 });
    const result = await exec('sleep 30', controller.signal);
    assert.equal(result.timedOut, false, 'cancelling is not the same as timing out');
    assert.equal(result.exitCode, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace facts distinguish no manifest from a manifest with no scripts', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'coderelay-verify-'));
  const withManifest = await mkdtemp(join(tmpdir(), 'coderelay-verify-'));
  try {
    assert.equal(
      (await readWorkspaceFacts(empty)).scripts,
      null,
      'no package.json means nothing is declared',
    );

    await writeFile(join(withManifest, 'package.json'), JSON.stringify({ name: 'x' }));
    assert.deepEqual(
      (await readWorkspaceFacts(withManifest)).scripts,
      {},
      'a manifest with no scripts is a different answer, and is worded differently',
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(withManifest, { recursive: true, force: true });
  }
});

test('a malformed manifest is treated as nothing declared, not as an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-verify-'));
  try {
    await writeFile(join(dir, 'package.json'), '{ this is not json');
    const facts = await readWorkspaceFacts(dir);
    assert.equal(facts.scripts, null);
    assert.deepEqual(
      planVerification(facts).checks,
      [],
      'verification must not be the thing that reports a syntax error in a file the user may not own',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-string script values are discarded rather than run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-verify-'));
  try {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: { bad: true }, lint: 'eslint .' } }),
    );
    const facts = await readWorkspaceFacts(dir);
    assert.deepEqual(Object.keys(facts.scripts ?? {}), ['lint']);
    assert.deepEqual(planVerification(facts).checks.map((c) => c.id), ['lint']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the package manager is detected from the real directory listing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-verify-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    const facts = await readWorkspaceFacts(dir);
    assert.equal(facts.packageManager, 'pnpm');
    assert.equal(planVerification(facts).checks[0]?.command, 'pnpm run test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
