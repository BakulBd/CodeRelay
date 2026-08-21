/**
 * Workspace checkpoints stored as unreachable git objects.
 *
 * Recovery can tell whether an edit landed, but it cannot undo one. That is what
 * this module is for: before the agent touches the workspace, the current state
 * is committed into git's object database under `refs/coderelay/<taskId>/<n>`,
 * so any file can be recovered afterwards.
 *
 * The hard constraint is that the user's own git state is not ours to touch.
 * Concretely, this module never:
 *
 *  - writes to `.git/index` — every snapshot uses a private index file via
 *    `GIT_INDEX_FILE`, so a half-staged commit the user was preparing survives
 *    untouched;
 *  - moves `HEAD`, creates a branch, or writes anywhere under `refs/heads`;
 *  - runs `checkout`, `reset`, `stash` or `clean`, so nothing in the working
 *    tree changes as a result of taking a checkpoint;
 *  - commits anything git is configured to ignore, because `add -A` honours
 *    `.gitignore` and a snapshot of `node_modules` is not a snapshot anyone
 *    wants.
 *
 * Restoring is deliberately narrow. `restore` returns the bytes of one file at
 * one checkpoint and writes nothing: the caller decides what to do with them.
 * A "restore the whole workspace" button would be a destructive operation
 * wearing the costume of a safety feature.
 *
 * Snapshots are ordinary commits, so `git log refs/coderelay/<taskId>/3` works
 * and the whole history can be dropped with a single `update-ref -d`. They are
 * unreachable from any branch, so `git gc` will eventually collect them, which
 * is the correct lifecycle for a debugging aid.
 *
 * Everything runs through an injected `GitRunner`, so the decision logic is
 * testable without a repository and the real behaviour is testable against one.
 */
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { TaskId } from '../core/types.js';


export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one git command. `env` additions are merged over the ambient env. */
export interface GitRunner {
  run(
    args: readonly string[],
    options?: { readonly stdin?: string; readonly env?: Readonly<Record<string, string>> },
  ): Promise<GitResult>;
}

/** A checkpoint that exists in the object database. */
export interface Checkpoint {
  readonly taskId: TaskId;
  /** Monotonic per task, starting at 1. */
  readonly index: number;
  readonly ref: string;
  readonly commit: string;
  readonly tree: string;
  readonly label: string;
}

/** Why a checkpoint could not be taken. Never thrown; always reported. */
export type CheckpointFailure =
  | { readonly t: 'not_a_repository'; readonly reason: string }
  | { readonly t: 'git_unavailable'; readonly reason: string }
  | { readonly t: 'git_failed'; readonly command: string; readonly reason: string };

export type CheckpointOutcome =
  | { readonly t: 'created'; readonly checkpoint: Checkpoint }
  /**
   * Nothing changed since the previous checkpoint, so no new commit was made.
   *
   * Reported rather than hidden: the caller may be about to run a tool whose
   * effect it expects to be recoverable, and "there was nothing to save" is a
   * different fact from "it was saved".
   */
  | { readonly t: 'unchanged'; readonly checkpoint: Checkpoint }
  | { readonly t: 'unavailable'; readonly failure: CheckpointFailure };

export const REF_NAMESPACE = 'refs/coderelay';

export function checkpointRef(taskId: TaskId, index: number): string {
  return `${REF_NAMESPACE}/${taskId}/${index}`;
}

/** The default runner: the real `git` binary, with no shell involved. */
export function execGitRunner(cwd: string): GitRunner {
  return {
    run(args, options) {
      return new Promise<GitResult>((resolve) => {
        const child = execFile(
          'git',
          [...args],
          {
            cwd,
            // Snapshots of a large tree can produce a lot of output; 32 MiB is
            // generous without being unbounded.
            maxBuffer: 32 * 1024 * 1024,
            env: {
              ...process.env,
              ...options?.env,
              // Never let a pager or a credential prompt block the extension.
              GIT_PAGER: 'cat',
              GIT_TERMINAL_PROMPT: '0',
            },
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({ exitCode: 0, stdout, stderr });
              return;
            }
            const code = (error as { code?: number | string }).code;
            resolve({
              exitCode: typeof code === 'number' ? code : 127,
              stdout,
              stderr: stderr === '' ? error.message : stderr,
            });
          },
        );
        if (options?.stdin !== undefined) {
          child.stdin?.end(options.stdin);
        }
      });
    },
  };
}

export interface CheckpointStoreDeps {
  readonly git: GitRunner;
  /**
   * Directory for the private index files. Must be writable and task-private.
   *
   * Normally outside the work tree — the extension uses `context.storageUri`.
   * If it does sit inside the work tree, it is excluded from every snapshot:
   * `add -A` would otherwise stage git's own index and `.lock` files, so the
   * act of taking a checkpoint would change the tree it is trying to capture.
   */
  readonly scratchDir: string;
  readonly now?: () => number;
  /**
   * Creates `scratchDir`. Injected for the same reason `git` is: it is the only
   * other real-world effect this class performs, and tests that drive a fake
   * `GitRunner` against a fake path must not touch the filesystem to do it.
   */
  readonly ensureDir?: (path: string) => Promise<void>;
}

export class CheckpointStore {
  private readonly git: GitRunner;
  private readonly scratchDir: string;
  private scratchReady: Promise<CheckpointFailure | null> | null = null;
  private readonly ensureDir: (path: string) => Promise<void>;
  private readonly now: () => number;
  /**
   * Cached `rev-parse --show-toplevel`. `undefined` means "not asked yet",
   * `null` means git could not answer — in which case no exclusion is applied,
   * because guessing at the work tree root would be worse than not excluding.
   */
  private topLevel: string | null | undefined = undefined;

  constructor(deps: CheckpointStoreDeps) {
    this.git = deps.git;
    this.scratchDir = deps.scratchDir;
    this.now = deps.now ?? Date.now;
    this.ensureDir = deps.ensureDir ?? (async (path) => void (await mkdir(path, { recursive: true })));
  }

  /**
   * The scratch directory as a work-tree-relative path, or null when it lies
   * outside the work tree (the normal case) or git cannot say.
   */
  private async scratchRelativeToWorkTree(): Promise<string | null> {
    if (this.topLevel === undefined) {
      const result = await this.git.run(['rev-parse', '--show-toplevel']);
      this.topLevel =
        result.exitCode === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null;
    }
    if (this.topLevel === null) {
      return null;
    }
    const rel = relative(this.topLevel, this.scratchDir);
    // '' means the scratch dir *is* the work tree root: excluding it would
    // exclude everything, so the honest answer is to snapshot normally and let
    // the caller see the scratch files. '..' or absolute means it is outside.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return null;
    }
    return rel.split(sep).join('/');
  }

  /**
   * The `add` invocation used for every snapshot.
   *
   * Pathspecs carry `top` magic so they are anchored at the work tree root
   * rather than resolved against whatever directory git was started in.
   */
  private async addArgs(): Promise<readonly string[]> {
    const rel = await this.scratchRelativeToWorkTree();
    if (rel === null) {
      return ['add', '-A'];
    }
    return ['add', '-A', '--', ':/', `:(top,exclude)${rel}`, `:(top,exclude,glob)${rel}/**`];
  }

  /** True when the workspace is inside a git work tree. */
  async available(): Promise<CheckpointFailure | null> {
    const result = await this.git.run(['rev-parse', '--is-inside-work-tree']);
    if (result.exitCode === 127) {
      return {
        t: 'git_unavailable',
        reason: 'The git executable could not be run, so checkpoints are unavailable.',
      };
    }
    if (result.exitCode !== 0 || result.stdout.trim() !== 'true') {
      return {
        t: 'not_a_repository',
        reason:
          'This workspace is not a git repository, so CodeRelay cannot snapshot it. ' +
          'Recovery still works; undo does not.',
      };
    }
    return null;
  }

  /**
   * Snapshots the working tree.
   *
   * The sequence is `add -A` into a private index, `write-tree`, `commit-tree`,
   * `update-ref`. The tree is compared with the previous checkpoint's tree
   * first, because an identical tree means an identical snapshot and committing
   * it again would only add noise to the history the user may later read.
   */
  /**
   * Creates the directory holding the private index.
   *
   * `GIT_INDEX_FILE` names a file git will happily create, but git will *not*
   * create the directory containing it — `add -A` fails with
   * "Unable to create ... .lock: No such file or directory". Because every
   * checkpoint path degrades to `unavailable` rather than throwing, a missing
   * directory turns snapshotting into a silent no-op for the whole session,
   * which is the one failure mode this class must not have.
   *
   * Memoized because the answer cannot usefully change mid-task, and returned as
   * a `CheckpointFailure` rather than thrown so the caller's existing
   * degrade-and-report path handles it like any other git problem.
   */
  private ensureScratch(): Promise<CheckpointFailure | null> {
    this.scratchReady ??= this.ensureDir(this.scratchDir).then(
      () => null,
      (err: unknown) => ({
        t: 'git_failed' as const,
        command: 'mkdir scratchDir',
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    return this.scratchReady;
  }

  async create(taskId: TaskId, label: string): Promise<CheckpointOutcome> {
    const unavailable = await this.available();
    if (unavailable !== null) {
      return { t: 'unavailable', failure: unavailable };
    }

    const scratchFailure = await this.ensureScratch();
    if (scratchFailure !== null) {
      return { t: 'unavailable', failure: scratchFailure };
    }

    const previous = await this.latest(taskId);
    const indexFile = `${this.scratchDir}/index-${taskId}`;
    const env = { GIT_INDEX_FILE: indexFile };

    // `add -A` stages every tracked and untracked non-ignored path. Into a
    // private index, so the user's staging area is not involved at all.
    const staged = await this.git.run(await this.addArgs(), { env });
    if (staged.exitCode !== 0) {
      return { t: 'unavailable', failure: gitFailed('add -A', staged) };
    }

    const written = await this.git.run(['write-tree'], { env });
    if (written.exitCode !== 0) {
      return { t: 'unavailable', failure: gitFailed('write-tree', written) };
    }
    const tree = written.stdout.trim();

    if (previous !== null && previous.tree === tree) {
      return { t: 'unchanged', checkpoint: previous };
    }

    const index = previous === null ? 1 : previous.index + 1;
    const message = `coderelay checkpoint ${index}: ${label}`;
    const commitArgs = ['commit-tree', tree];
    if (previous !== null) {
      // Chaining to the previous checkpoint makes `git log <ref>` show the
      // task's history. It does not connect the chain to any branch.
      commitArgs.push('-p', previous.commit);
    }

    const stamp = new Date(this.now()).toISOString();
    const committed = await this.git.run(commitArgs, {
      stdin: message,
      env: {
        // Identity is fixed so a checkpoint is never mistaken for the user's own
        // commit, and dates are fixed so the same tree yields the same commit.
        GIT_AUTHOR_NAME: 'CodeRelay',
        GIT_AUTHOR_EMAIL: 'coderelay@localhost',
        GIT_COMMITTER_NAME: 'CodeRelay',
        GIT_COMMITTER_EMAIL: 'coderelay@localhost',
        GIT_AUTHOR_DATE: stamp,
        GIT_COMMITTER_DATE: stamp,
      },
    });
    if (committed.exitCode !== 0) {
      return { t: 'unavailable', failure: gitFailed('commit-tree', committed) };
    }
    const commit = committed.stdout.trim();

    const ref = checkpointRef(taskId, index);
    const updated = await this.git.run(['update-ref', ref, commit]);
    if (updated.exitCode !== 0) {
      return { t: 'unavailable', failure: gitFailed('update-ref', updated) };
    }

    return { t: 'created', checkpoint: { taskId, index, ref, commit, tree, label } };
  }

  /** Every checkpoint for a task, oldest first. */
  async list(taskId: TaskId): Promise<readonly Checkpoint[]> {
    const result = await this.git.run([
      'for-each-ref',
      '--format=%(refname) %(objectname) %(tree) %(subject)',
      `${REF_NAMESPACE}/${taskId}`,
    ]);
    if (result.exitCode !== 0) {
      return [];
    }

    const out: Checkpoint[] = [];
    for (const line of result.stdout.split('\n')) {
      const parsed = parseRefLine(line, taskId);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    // Sorted numerically: `for-each-ref` sorts refs as text, which would put
    // checkpoint 10 before checkpoint 2.
    return out.sort((a, b) => a.index - b.index);
  }

  async latest(taskId: TaskId): Promise<Checkpoint | null> {
    const all = await this.list(taskId);
    return all.at(-1) ?? null;
  }

  /**
   * Reads one file as it was at a checkpoint.
   *
   * Returns the bytes; writes nothing. `null` means the file did not exist in
   * that snapshot, which is a real answer and not an error — it is how the
   * caller learns a file was created by the work being undone.
   */
  async restore(checkpoint: Checkpoint, path: string): Promise<string | null> {
    const result = await this.git.run(['show', `${checkpoint.commit}:${path}`]);
    if (result.exitCode !== 0) {
      return null;
    }
    return result.stdout;
  }

  /** Paths that differ between a checkpoint and the current working tree. */
  async changedSince(checkpoint: Checkpoint): Promise<readonly string[]> {
    if ((await this.ensureScratch()) !== null) {
      return [];
    }
    const indexFile = `${this.scratchDir}/index-diff-${checkpoint.taskId}`;
    const env = { GIT_INDEX_FILE: indexFile };
    const staged = await this.git.run(await this.addArgs(), { env });
    if (staged.exitCode !== 0) {
      return [];
    }
    const written = await this.git.run(['write-tree'], { env });
    if (written.exitCode !== 0) {
      return [];
    }
    const diff = await this.git.run([
      'diff-tree',
      '-r',
      '--name-only',
      '--no-commit-id',
      checkpoint.tree,
      written.stdout.trim(),
    ]);
    if (diff.exitCode !== 0) {
      return [];
    }
    return diff.stdout.split('\n').filter((line) => line !== '');
  }

  /**
   * Deletes a task's checkpoints.
   *
   * Only ever touches `refs/coderelay/<taskId>/…`. The objects themselves are
   * left for `git gc`, so a mistaken cleanup is still recoverable by anyone who
   * knows the commit hash.
   */
  async forget(taskId: TaskId): Promise<number> {
    const all = await this.list(taskId);
    let deleted = 0;
    for (const checkpoint of all) {
      const result = await this.git.run(['update-ref', '-d', checkpoint.ref]);
      if (result.exitCode === 0) {
        deleted += 1;
      }
    }
    return deleted;
  }
}

function gitFailed(command: string, result: GitResult): CheckpointFailure {
  const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();
  return {
    t: 'git_failed',
    command,
    reason: detail === '' ? `git ${command} exited with ${result.exitCode}` : detail,
  };
}

/**
 * Parses one `for-each-ref` line.
 *
 * Returns null for anything unexpected rather than guessing. A ref under our
 * namespace that does not match the shape was not written by this module, and
 * inventing an index for it would corrupt the ordering.
 */
function parseRefLine(line: string, taskId: TaskId): Checkpoint | null {
  if (line.trim() === '') {
    return null;
  }
  const [refname, commit, tree, ...subjectParts] = line.split(' ');
  if (refname === undefined || commit === undefined || tree === undefined) {
    return null;
  }
  const prefix = `${REF_NAMESPACE}/${taskId}/`;
  if (!refname.startsWith(prefix)) {
    return null;
  }
  const index = Number(refname.slice(prefix.length));
  if (!Number.isInteger(index) || index < 1) {
    return null;
  }
  const subject = subjectParts.join(' ');
  const marker = `coderelay checkpoint ${index}: `;
  return {
    taskId,
    index,
    ref: refname,
    commit,
    tree,
    label: subject.startsWith(marker) ? subject.slice(marker.length) : subject,
  };
}
