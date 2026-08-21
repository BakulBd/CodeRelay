/**
 * Checkpoint store.
 *
 * Two layers, because two different kinds of claim need proving:
 *
 *  - a fake `GitRunner` pins the *decision* logic and, more importantly, the
 *    exact argument lists — the guarantee that the user's index and branches are
 *    never touched is a claim about which commands run, so it is tested by
 *    inspecting them;
 *  - a real repository in a temp directory proves the commands actually do what
 *    the module claims, since a fake git will happily agree with a wrong one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CheckpointStore,
  REF_NAMESPACE,
  checkpointRef,
  execGitRunner,
  type Checkpoint,
  type CheckpointOutcome,
  type GitResult,
  type GitRunner,
} from '../../src/checkpoint/git.js';
import type { TaskId } from '../../src/core/types.js';
import { TASK } from '../support/factories.js';

// --- narrowing -------------------------------------------------------------

function expectOutcome<T extends CheckpointOutcome['t']>(
  outcome: CheckpointOutcome,
  t: T,
): Extract<CheckpointOutcome, { t: T }> {
  assert.equal(outcome.t, t, `expected ${t}, got ${outcome.t}`);
  return outcome as Extract<CheckpointOutcome, { t: T }>;
}

// --- fake runner -----------------------------------------------------------

interface Invocation {
  readonly args: readonly string[];
  readonly stdin: string | undefined;
  readonly env: Readonly<Record<string, string>> | undefined;
}

const ok = (stdout = ''): GitResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr: string, exitCode = 1): GitResult => ({ exitCode, stdout: '', stderr });

class FakeGit implements GitRunner {
  readonly calls: Invocation[] = [];

  constructor(private readonly responder: (args: readonly string[]) => GitResult) {}

  async run(
    args: readonly string[],
    options?: { stdin?: string; env?: Readonly<Record<string, string>> },
  ): Promise<GitResult> {
    this.calls.push({ args, stdin: options?.stdin, env: options?.env });
    return this.responder(args);
  }

  argsFor(command: string): readonly string[] | null {
    return this.calls.find((c) => c.args[0] === command)?.args ?? null;
  }
}

/** A responder for a repository with the given existing checkpoint refs. */
function repoWith(refs: readonly string[], overrides: Partial<Record<string, GitResult>> = {}) {
  return (args: readonly string[]): GitResult => {
    const command = args[0] ?? '';
    if (overrides[command] !== undefined) {
      return overrides[command]!;
    }
    switch (command) {
      case 'rev-parse':
        // `--is-inside-work-tree` answers 'true'; `--show-toplevel` answers a
        // path that is *not* an ancestor of the '/scratch' used by `store`, so
        // the default fixture exercises the no-exclusion path.
        return ok(args[1] === '--show-toplevel' ? '/repo\n' : 'true\n');
      case 'for-each-ref':
        return ok(refs.join('\n'));
      case 'add':
        return ok();
      case 'write-tree':
        return ok('tree-new\n');
      case 'commit-tree':
        return ok('commit-new\n');
      case 'update-ref':
        return ok();
      default:
        return ok();
    }
  };
}

function store(git: GitRunner, nowMs = Date.UTC(2026, 0, 1)): CheckpointStore {
  // Fake path: the directory is never created, so creation is stubbed out.
  return new CheckpointStore({ git, scratchDir: '/scratch', now: () => nowMs, ensureDir: async () => {} });
}

/** A store whose scratch directory sits inside the '/repo' work tree. */
function storeWithScratchInside(git: GitRunner, scratchDir = '/repo/.coderelay'): CheckpointStore {
  return new CheckpointStore({ git, scratchDir, now: () => Date.UTC(2026, 0, 1), ensureDir: async () => {} });
}

/** A checkpoint to diff and restore against. Declared here because the pathspec
 * tests below use it as well as the restore tests further down. */
const CP: Checkpoint = {
  taskId: TASK,
  index: 1,
  ref: `${REF_NAMESPACE}/${TASK}/1`,
  commit: 'commit-1',
  tree: 'tree-1',
  label: 'first',
};

// --- ref naming ------------------------------------------------------------

test('checkpoint refs live under a private namespace, never refs/heads', () => {
  const ref = checkpointRef('task-9' as TaskId, 3);
  assert.equal(ref, 'refs/coderelay/task-9/3');
  assert.ok(ref.startsWith(`${REF_NAMESPACE}/`));
  assert.ok(!ref.startsWith('refs/heads/'));
  assert.ok(!ref.startsWith('refs/tags/'));
});

// --- availability ----------------------------------------------------------

test('a workspace that is not a repository is reported, not treated as an error', async () => {
  const git = new FakeGit(() => fail('fatal: not a git repository', 128));
  const failure = await store(git).available();
  assert.equal(failure?.t, 'not_a_repository');
  assert.match(failure!.reason, /Recovery still works; undo does not/);
});

test('a missing git binary is distinguished from a missing repository', async () => {
  const git = new FakeGit(() => fail('spawn git ENOENT', 127));
  const failure = await store(git).available();
  assert.equal(failure?.t, 'git_unavailable');
});

test('creating a checkpoint outside a repository takes no further git action', async () => {
  const git = new FakeGit(() => fail('fatal: not a git repository', 128));
  const outcome = expectOutcome(await store(git).create(TASK, 'before edit'), 'unavailable');
  assert.equal(outcome.failure.t, 'not_a_repository');
  assert.deepEqual(git.calls.map((c) => c.args[0]), ['rev-parse']);
});

// --- what commands are allowed to run -------------------------------------

test('the first checkpoint stages into a private index and writes only our ref', async () => {
  const git = new FakeGit(repoWith([]));
  const outcome = expectOutcome(await store(git).create(TASK, 'before edit'), 'created');

  assert.equal(outcome.checkpoint.index, 1);
  assert.equal(outcome.checkpoint.ref, `${REF_NAMESPACE}/${TASK}/1`);
  assert.equal(outcome.checkpoint.commit, 'commit-new');
  assert.equal(outcome.checkpoint.tree, 'tree-new');
  assert.equal(outcome.checkpoint.label, 'before edit');

  const add = git.calls.find((c) => c.args[0] === 'add')!;
  assert.deepEqual(add.args, ['add', '-A']);
  assert.equal(add.env?.GIT_INDEX_FILE, `/scratch/index-${TASK}`);

  const write = git.calls.find((c) => c.args[0] === 'write-tree')!;
  assert.equal(write.env?.GIT_INDEX_FILE, `/scratch/index-${TASK}`);

  const update = git.argsFor('update-ref')!;
  assert.deepEqual(update, ['update-ref', `${REF_NAMESPACE}/${TASK}/1`, 'commit-new']);
});

test('no command that could alter the user\u2019s working tree or branches is ever run', async () => {
  const git = new FakeGit(repoWith(['refs/coderelay/task-1/1 c1 t1 coderelay checkpoint 1: a']));
  const s = store(git);
  await s.create(TASK, 'x');
  await s.list(TASK);
  await s.changedSince({
    taskId: TASK,
    index: 1,
    ref: `${REF_NAMESPACE}/${TASK}/1`,
    commit: 'c1',
    tree: 't1',
    label: 'a',
  });
  await s.forget(TASK);

  const forbidden = ['checkout', 'reset', 'stash', 'clean', 'commit', 'branch', 'switch', 'push'];
  for (const call of git.calls) {
    assert.ok(!forbidden.includes(call.args[0] ?? ''), `ran forbidden git ${call.args[0]}`);
    // Nothing may be written outside our namespace.
    if (call.args[0] === 'update-ref') {
      const ref = call.args.find((a) => a.startsWith('refs/')) ?? '';
      assert.ok(ref.startsWith(`${REF_NAMESPACE}/`), ref);
    }
  }
});

test('a scratch directory inside the work tree is excluded from the snapshot', async () => {
  const git = new FakeGit(repoWith([]));
  expectOutcome(await storeWithScratchInside(git).create(TASK, 'x'), 'created');

  const add = git.calls.find((c) => c.args[0] === 'add')!;
  assert.deepEqual(add.args, [
    'add',
    '-A',
    '--',
    ':/',
    ':(top,exclude).coderelay',
    ':(top,exclude,glob).coderelay/**',
  ]);
});

test('a scratch directory outside the work tree needs no exclusion pathspec', async () => {
  const git = new FakeGit(repoWith([]));
  expectOutcome(await store(git).create(TASK, 'x'), 'created');
  assert.deepEqual(git.calls.find((c) => c.args[0] === 'add')!.args, ['add', '-A']);
});

test('a work tree root that git will not report leaves the add untouched', async () => {
  // `rev-parse --show-toplevel` failing must not be guessed around: without a
  // root there is no way to compute a relative pathspec, so none is passed.
  const git = new FakeGit((args) => {
    if (args[0] === 'rev-parse') {
      return args[1] === '--show-toplevel' ? fail('fatal: no work tree') : ok('true\n');
    }
    return repoWith([])(args);
  });
  expectOutcome(await storeWithScratchInside(git).create(TASK, 'x'), 'created');
  assert.deepEqual(git.calls.find((c) => c.args[0] === 'add')!.args, ['add', '-A']);
});

test('a scratch directory that is the work tree root is not excluded, which would exclude all', async () => {
  const git = new FakeGit(repoWith([]));
  expectOutcome(await storeWithScratchInside(git, '/repo').create(TASK, 'x'), 'created');
  assert.deepEqual(git.calls.find((c) => c.args[0] === 'add')!.args, ['add', '-A']);
});

test('the work tree root is resolved once and reused across snapshots', async () => {
  const git = new FakeGit(repoWith([]));
  const s = storeWithScratchInside(git);
  await s.create(TASK, 'one');
  await s.changedSince(CP);
  const toplevels = git.calls.filter((c) => c.args[1] === '--show-toplevel');
  assert.equal(toplevels.length, 1);
});

test('changedSince applies the same exclusion, or its diff would report scratch files', async () => {
  const git = new FakeGit((args) => {
    if (args[0] === 'rev-parse') {
      return ok(args[1] === '--show-toplevel' ? '/repo\n' : 'true\n');
    }
    if (args[0] === 'write-tree') {
      return ok('tree-now\n');
    }
    if (args[0] === 'diff-tree') {
      return ok('src/a.ts\n');
    }
    return ok();
  });
  await storeWithScratchInside(git).changedSince(CP);
  const add = git.calls.find((c) => c.args[0] === 'add')!;
  assert.deepEqual(add.args.slice(0, 4), ['add', '-A', '--', ':/']);
  assert.equal(add.env?.GIT_INDEX_FILE, `/repo/.coderelay/index-diff-${TASK}`);
});

test('a nested scratch path is excluded with forward slashes, as git pathspecs require', async () => {
  const git = new FakeGit(repoWith([]));
  const s = storeWithScratchInside(git, join('/repo', '.vscode', 'coderelay'));
  expectOutcome(await s.create(TASK, 'x'), 'created');
  const add = git.calls.find((c) => c.args[0] === 'add')!;
  assert.deepEqual(add.args.slice(4), [
    ':(top,exclude).vscode/coderelay',
    ':(top,exclude,glob).vscode/coderelay/**',
  ]);
});

test('every index-writing command carries GIT_INDEX_FILE, so .git/index is untouched', async () => {
  const git = new FakeGit(repoWith([]));
  await store(git).create(TASK, 'x');
  for (const call of git.calls) {
    if (call.args[0] === 'add' || call.args[0] === 'write-tree') {
      assert.ok(call.env?.GIT_INDEX_FILE !== undefined, `${call.args.join(' ')} used the real index`);
    }
  }
});

test('the commit message arrives on stdin, so a label can never be read as a flag', async () => {
  const git = new FakeGit(repoWith([]));
  await store(git).create(TASK, '--force -p deadbeef');
  const commit = git.calls.find((c) => c.args[0] === 'commit-tree')!;
  assert.deepEqual(commit.args, ['commit-tree', 'tree-new']);
  assert.equal(commit.stdin, 'coderelay checkpoint 1: --force -p deadbeef');
});

test('checkpoints are attributed to CodeRelay with a fixed date, not to the user', async () => {
  const git = new FakeGit(repoWith([]));
  await store(git, Date.UTC(2026, 4, 5, 6, 7, 8)).create(TASK, 'x');
  const env = git.calls.find((c) => c.args[0] === 'commit-tree')!.env!;
  assert.equal(env.GIT_AUTHOR_NAME, 'CodeRelay');
  assert.equal(env.GIT_COMMITTER_EMAIL, 'coderelay@localhost');
  assert.equal(env.GIT_AUTHOR_DATE, '2026-05-05T06:07:08.000Z');
  assert.equal(env.GIT_COMMITTER_DATE, env.GIT_AUTHOR_DATE);
});

// --- sequencing ------------------------------------------------------------

test('a later checkpoint increments the index and chains to the previous commit', async () => {
  const git = new FakeGit(
    repoWith([`${REF_NAMESPACE}/${TASK}/1 commit-1 tree-1 coderelay checkpoint 1: first`]),
  );
  const outcome = expectOutcome(await store(git).create(TASK, 'second'), 'created');
  assert.equal(outcome.checkpoint.index, 2);
  assert.deepEqual(git.argsFor('commit-tree'), [
    'commit-tree',
    'tree-new',
    '-p',
    'commit-1',
  ]);
});

test('an unchanged tree reports the existing checkpoint instead of committing again', async () => {
  const git = new FakeGit(
    repoWith([`${REF_NAMESPACE}/${TASK}/1 commit-1 tree-new coderelay checkpoint 1: first`]),
  );
  const outcome = expectOutcome(await store(git).create(TASK, 'second'), 'unchanged');
  assert.equal(outcome.checkpoint.index, 1);
  assert.equal(outcome.checkpoint.commit, 'commit-1');
  assert.equal(git.argsFor('commit-tree'), null);
  assert.equal(git.argsFor('update-ref'), null);
});

test('checkpoint 10 sorts after checkpoint 2, not before it', async () => {
  const git = new FakeGit(
    repoWith([
      `${REF_NAMESPACE}/${TASK}/1 c1 t1 coderelay checkpoint 1: a`,
      `${REF_NAMESPACE}/${TASK}/10 c10 t10 coderelay checkpoint 10: j`,
      `${REF_NAMESPACE}/${TASK}/2 c2 t2 coderelay checkpoint 2: b`,
    ]),
  );
  const all = await store(git).list(TASK);
  assert.deepEqual(all.map((c) => c.index), [1, 2, 10]);
  assert.equal((await store(git).latest(TASK))?.index, 10);
});

test('a ref under our namespace with an unexpected shape is ignored, not guessed at', async () => {
  const git = new FakeGit(
    repoWith([
      `${REF_NAMESPACE}/${TASK}/notanumber cx tx something`,
      `${REF_NAMESPACE}/${TASK}/0 cy ty coderelay checkpoint 0: zero`,
      `${REF_NAMESPACE}/other-task/1 cz tz coderelay checkpoint 1: other`,
      `${REF_NAMESPACE}/${TASK}/1 c1 t1 coderelay checkpoint 1: real`,
      '',
    ]),
  );
  const all = await store(git).list(TASK);
  assert.deepEqual(all.map((c) => c.label), ['real']);
});

test('a label containing spaces survives the round trip through the subject line', async () => {
  const git = new FakeGit(
    repoWith([`${REF_NAMESPACE}/${TASK}/1 c1 t1 coderelay checkpoint 1: before write_file a b`]),
  );
  const all = await store(git).list(TASK);
  assert.equal(all[0]!.label, 'before write_file a b');
});

test('a subject that is not ours is kept verbatim rather than mangled', async () => {
  const git = new FakeGit(repoWith([`${REF_NAMESPACE}/${TASK}/1 c1 t1 some other subject`]));
  const all = await store(git).list(TASK);
  assert.equal(all[0]!.label, 'some other subject');
});

test('no checkpoints yields an empty list and a null latest', async () => {
  const git = new FakeGit(repoWith([]));
  assert.deepEqual(await store(git).list(TASK), []);
  assert.equal(await store(git).latest(TASK), null);
});

// --- failure reporting -----------------------------------------------------

test('a failure at each step names the command that failed and why', async () => {
  const steps: readonly [string, string][] = [
    ['add', 'fatal: unable to write index'],
    ['write-tree', 'fatal: bad tree'],
    ['commit-tree', 'fatal: cannot commit'],
    ['update-ref', 'fatal: cannot lock ref'],
  ];
  for (const [command, stderr] of steps) {
    const git = new FakeGit(repoWith([], { [command]: fail(stderr) }));
    const outcome = expectOutcome(await store(git).create(TASK, 'x'), 'unavailable');
    assert.equal(outcome.failure.t, 'git_failed');
    assert.match(outcome.failure.reason, new RegExp(stderr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('a silent git failure still reports the exit code rather than an empty reason', async () => {
  const git = new FakeGit(repoWith([], { 'write-tree': { exitCode: 3, stdout: '', stderr: '' } }));
  const outcome = expectOutcome(await store(git).create(TASK, 'x'), 'unavailable');
  assert.equal(outcome.failure.t, 'git_failed');
  assert.match(outcome.failure.reason, /write-tree exited with 3/);
});

test('an unreadable ref listing degrades to no checkpoints instead of throwing', async () => {
  const git = new FakeGit(repoWith([], { 'for-each-ref': fail('fatal: broken') }));
  assert.deepEqual(await store(git).list(TASK), []);
});

// --- restore and diff ------------------------------------------------------

test('restore reads a blob from the checkpoint commit and writes nothing', async () => {
  const git = new FakeGit((args) => (args[0] === 'show' ? ok('old contents') : ok()));
  const content = await store(git).restore(CP, 'src/a.ts');
  assert.equal(content, 'old contents');
  assert.deepEqual(git.argsFor('show'), ['show', 'commit-1:src/a.ts']);
  assert.equal(git.calls.length, 1); // nothing else ran
});

test('a file absent from the checkpoint restores as null, which is a real answer', async () => {
  const git = new FakeGit(() => fail('fatal: path does not exist', 128));
  assert.equal(await store(git).restore(CP, 'new.ts'), null);
});

test('changedSince diffs the checkpoint tree against a freshly written tree', async () => {
  const git = new FakeGit((args) => {
    if (args[0] === 'write-tree') {
      return ok('tree-now\n');
    }
    if (args[0] === 'diff-tree') {
      return ok('src/a.ts\nsrc/b.ts\n');
    }
    return ok();
  });
  const changed = await store(git).changedSince(CP);
  assert.deepEqual(changed, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(git.argsFor('diff-tree'), [
    'diff-tree',
    '-r',
    '--name-only',
    '--no-commit-id',
    'tree-1',
    'tree-now',
  ]);
  // The diff must use its own index too, or it would clobber the user's staging.
  const add = git.calls.find((c) => c.args[0] === 'add')!;
  assert.equal(add.env?.GIT_INDEX_FILE, `/scratch/index-diff-${TASK}`);
});

test('a failed diff reports no changes rather than a wrong list', async () => {
  const git = new FakeGit((args) => (args[0] === 'diff-tree' ? fail('boom') : ok('t\n')));
  assert.deepEqual(await store(git).changedSince(CP), []);
});

// --- cleanup ---------------------------------------------------------------

test('forget deletes only our refs, one per checkpoint', async () => {
  const git = new FakeGit(
    repoWith([
      `${REF_NAMESPACE}/${TASK}/1 c1 t1 coderelay checkpoint 1: a`,
      `${REF_NAMESPACE}/${TASK}/2 c2 t2 coderelay checkpoint 2: b`,
    ]),
  );
  const deleted = await store(git).forget(TASK);
  assert.equal(deleted, 2);
  const deletions = git.calls.filter((c) => c.args[0] === 'update-ref');
  assert.deepEqual(deletions.map((c) => c.args), [
    ['update-ref', '-d', `${REF_NAMESPACE}/${TASK}/1`],
    ['update-ref', '-d', `${REF_NAMESPACE}/${TASK}/2`],
  ]);
});

test('forget counts only the deletions that actually succeeded', async () => {
  const git = new FakeGit(
    repoWith([`${REF_NAMESPACE}/${TASK}/1 c1 t1 coderelay checkpoint 1: a`], {
      'update-ref': fail('cannot lock ref'),
    }),
  );
  assert.equal(await store(git).forget(TASK), 0);
});

// --- against a real repository --------------------------------------------
// A fake git will agree with a wrong command list. These tests prove the real
// binary does what the module claims, including leaving the user's index alone.

/**
 * A real repository plus a store.
 *
 * `scratchDir` defaults to a directory *outside* the work tree, mirroring the
 * extension, which uses `context.storageUri`. Pass `inside: true` to put it in
 * the work tree, which is what the exclusion defence exists for.
 */
async function tempRepo(
  options: { inside?: boolean } = {},
): Promise<{ dir: string; scratchDir: string; s: CheckpointStore; git: GitRunner }> {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-cp-'));
  const git = execGitRunner(dir);
  await git.run(['init', '--quiet']);
  await git.run(['config', 'user.name', 'Test User']);
  await git.run(['config', 'user.email', 'test@example.com']);
  await git.run(['config', 'commit.gpgsign', 'false']);
  const scratchDir =
    options.inside === true
      ? join(dir, '.coderelay')
      : await mkdtemp(join(tmpdir(), 'coderelay-scratch-'));
  await mkdir(scratchDir, { recursive: true });
  return { dir, scratchDir, git, s: new CheckpointStore({ git, scratchDir }) };
}

test('a scratch directory that does not exist yet is created, not silently fatal', async (t) => {
  // Regression. `openSession` derives scratchDir as
  // <storage>/checkpoints/<taskId> and nothing creates it, but git will not
  // create the directory holding GIT_INDEX_FILE — `add -A` fails with
  // "Unable to create ... .lock: No such file or directory". Because every
  // checkpoint path degrades to `unavailable` instead of throwing, that turned
  // snapshotting into a silent no-op for the entire session: tasks completed
  // normally and no checkpoint was ever written.
  //
  // The other real-repository tests missed it because their helper creates the
  // directory itself, which production does not. This one deliberately does not.
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-cp-'));
  const git = execGitRunner(dir);
  await git.run(['init', '--quiet']);
  await git.run(['config', 'user.name', 'Test User']);
  await git.run(['config', 'user.email', 'test@example.com']);
  await git.run(['config', 'commit.gpgsign', 'false']);

  const parent = await mkdtemp(join(tmpdir(), 'coderelay-scratch-'));
  const scratchDir = join(parent, 'checkpoints', TASK);
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  });

  const s = new CheckpointStore({ git, scratchDir });
  await writeFile(join(dir, 'a.txt'), 'original\n', 'utf8');

  const created = expectOutcome(await s.create(TASK, 'before edit'), 'created');
  assert.match(created.checkpoint.ref, /^refs\/coderelay\//);

  // And it is a real, readable snapshot rather than a ref pointing at nothing.
  await writeFile(join(dir, 'a.txt'), 'modified\n', 'utf8');
  assert.equal(await s.restore(created.checkpoint, 'a.txt'), 'original\n');
  assert.deepEqual(await s.changedSince(created.checkpoint), ['a.txt']);
});

test('a real repository round trips a file through a checkpoint', async (t) => {
  const { dir, scratchDir, s } = await tempRepo();
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratchDir, { recursive: true, force: true });
  });

  await writeFile(join(dir, 'a.txt'), 'original\n', 'utf8');
  const first = expectOutcome(await s.create(TASK, 'before edit'), 'created');

  await writeFile(join(dir, 'a.txt'), 'modified\n', 'utf8');
  assert.deepEqual(await s.changedSince(first.checkpoint), ['a.txt']);

  // The old bytes are recoverable, and the working tree is untouched by reading.
  assert.equal(await s.restore(first.checkpoint, 'a.txt'), 'original\n');
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'modified\n');
});

test('a real checkpoint does not disturb the user\u2019s staging area', async (t) => {
  const { dir, scratchDir, git, s } = await tempRepo();
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratchDir, { recursive: true, force: true });
  });

  await writeFile(join(dir, 'tracked.txt'), 'v1\n', 'utf8');
  await git.run(['add', 'tracked.txt']);
  await git.run(['commit', '--quiet', '-m', 'initial']);

  // The user stages one file and deliberately leaves another unstaged.
  await writeFile(join(dir, 'staged.txt'), 'staged\n', 'utf8');
  await writeFile(join(dir, 'unstaged.txt'), 'unstaged\n', 'utf8');
  await git.run(['add', 'staged.txt']);

  const before = (await git.run(['status', '--porcelain'])).stdout;
  expectOutcome(await s.create(TASK, 'before edit'), 'created');
  const after = (await git.run(['status', '--porcelain'])).stdout;

  assert.equal(after, before, 'the checkpoint changed the user\u2019s git status');
});

test('a real scratch directory inside the work tree is kept out of the snapshot', async (t) => {
  // Misconfiguration insurance. If the private index files were staged, every
  // snapshot would differ from the last for reasons that have nothing to do
  // with the user's code, and `changedSince` would report git's own churn as
  // work the agent did.
  const { dir, s } = await tempRepo({ inside: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'a.txt'), 'v1\n', 'utf8');
  const first = expectOutcome(await s.create(TASK, 'first'), 'created');
  assert.equal(await s.restore(first.checkpoint, '.coderelay/index-' + TASK), null);

  // And the second snapshot still sees an unchanged tree, even though taking
  // the first one wrote index files inside the work tree.
  expectOutcome(await s.create(TASK, 'second'), 'unchanged');

  await writeFile(join(dir, 'a.txt'), 'v2\n', 'utf8');
  assert.deepEqual(await s.changedSince(first.checkpoint), ['a.txt']);
});

test('a real checkpoint leaves HEAD and the branch list alone', async (t) => {
  const { dir, scratchDir, git, s } = await tempRepo();
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratchDir, { recursive: true, force: true });
  });

  await writeFile(join(dir, 'a.txt'), 'v1\n', 'utf8');
  await git.run(['add', 'a.txt']);
  await git.run(['commit', '--quiet', '-m', 'initial']);

  const headBefore = (await git.run(['rev-parse', 'HEAD'])).stdout.trim();
  const branchesBefore = (await git.run(['for-each-ref', 'refs/heads'])).stdout;

  await writeFile(join(dir, 'a.txt'), 'v2\n', 'utf8');
  expectOutcome(await s.create(TASK, 'snapshot'), 'created');

  assert.equal((await git.run(['rev-parse', 'HEAD'])).stdout.trim(), headBefore);
  assert.equal((await git.run(['for-each-ref', 'refs/heads'])).stdout, branchesBefore);
});

test('a real checkpoint honours .gitignore', async (t) => {
  const { dir, s } = await tempRepo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, '.gitignore'), 'ignored/\n', 'utf8');
  await mkdir(join(dir, 'ignored'), { recursive: true });
  await writeFile(join(dir, 'ignored', 'big.bin'), 'x'.repeat(64), 'utf8');
  await writeFile(join(dir, 'kept.txt'), 'kept\n', 'utf8');

  const created = expectOutcome(await s.create(TASK, 'snapshot'), 'created');
  assert.equal(await s.restore(created.checkpoint, 'kept.txt'), 'kept\n');
  assert.equal(await s.restore(created.checkpoint, 'ignored/big.bin'), null);
});

test('a real second checkpoint chains, and an unchanged tree does not create one', async (t) => {
  const { dir, git, s } = await tempRepo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'a.txt'), 'v1\n', 'utf8');
  const first = expectOutcome(await s.create(TASK, 'first'), 'created');

  const unchanged = expectOutcome(await s.create(TASK, 'second'), 'unchanged');
  assert.equal(unchanged.checkpoint.commit, first.checkpoint.commit);

  await writeFile(join(dir, 'a.txt'), 'v2\n', 'utf8');
  const second = expectOutcome(await s.create(TASK, 'after edit'), 'created');
  assert.equal(second.checkpoint.index, 2);

  // The chain is walkable with plain git, which is the point of using refs.
  const log = await git.run(['log', '--format=%s', second.checkpoint.ref]);
  assert.deepEqual(log.stdout.trim().split('\n'), [
    'coderelay checkpoint 2: after edit',
    'coderelay checkpoint 1: first',
  ]);

  const listed = await s.list(TASK);
  assert.deepEqual(listed.map((c) => c.label), ['first', 'after edit']);
});

test('forget removes the real refs and nothing else', async (t) => {
  const { dir, git, s } = await tempRepo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'a.txt'), 'v1\n', 'utf8');
  await git.run(['add', 'a.txt']);
  await git.run(['commit', '--quiet', '-m', 'initial']);
  await writeFile(join(dir, 'a.txt'), 'v2\n', 'utf8');
  await s.create(TASK, 'first');

  assert.equal(await s.forget(TASK), 1);
  assert.deepEqual(await s.list(TASK), []);
  assert.equal((await git.run(['rev-parse', '--verify', 'HEAD'])).exitCode, 0);
});

test('a directory that is not a repository reports not_a_repository against real git', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-nogit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = new CheckpointStore({ git: execGitRunner(dir), scratchDir: dir });
  const outcome = expectOutcome(await s.create(TASK, 'x'), 'unavailable');
  assert.equal(outcome.failure.t, 'not_a_repository');
});
