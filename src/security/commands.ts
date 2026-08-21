/**
 * What a shell command is allowed to do, and who has to say yes.
 *
 * This module exists because `run_command` is the first tool CodeRelay has whose
 * effect is unbounded. `write_file` can only write one path inside the
 * workspace; a command can do anything the user can do, including things no
 * checkpoint can undo — pushing to a remote, dropping a database, deleting files
 * outside the repository.
 *
 * Two deliberate positions:
 *
 * 1. **Classification is advisory, not a sandbox.** A regex cannot decide
 *    whether `node scripts/deploy.js` is safe, and pretending otherwise would be
 *    worse than saying so: it would train users to click through prompts. What
 *    it *can* do reliably is recognise the well-known irreversible shapes and
 *    make those impossible to run by accident.
 * 2. **The default mode asks about anything that writes.** A tool that quietly
 *    ran `npm install` the first time a user tried CodeRelay would be a bad
 *    trade, whatever the convenience.
 *
 * Pure and dependency-free, so every rule below is testable without a shell.
 */

/** How much autonomy the user has granted for this workspace. */
export type PermissionMode =
  /** Read-only inspection. Nothing that writes runs without a yes. */
  | 'safe'
  /** Ordinary development commands run; irreversible ones still ask. */
  | 'balanced'
  /** Everything runs except the irreversible shapes, which always ask. */
  | 'autonomous';

/**
 * How much damage a command could do.
 *
 * `destructive` is reserved for effects that a git checkpoint cannot undo.
 * That is the distinction that matters: CodeRelay snapshots the work tree before
 * every file-modifying step, so a command that only edits tracked files is
 * recoverable even when it goes wrong. A force-push is not.
 */
export type CommandDanger = 'read-only' | 'writes' | 'destructive';

export interface CommandVerdict {
  readonly danger: CommandDanger;
  /** Shown to the user when approval is requested. Plain language. */
  readonly reason: string;
  /** The matched fragment, so the prompt can point at the actual risk. */
  readonly trigger: string | null;
}

/**
 * Irreversible shapes, each with the reason a person needs to hear.
 *
 * Ordered most-specific first: `git reset --hard` is reported as losing
 * uncommitted work rather than as a generic git command.
 */
const DESTRUCTIVE: readonly { readonly re: RegExp; readonly why: string }[] = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, why: 'deletes files recursively or without prompting' },
  { re: /\brm\s+-[a-zA-Z]*f/, why: 'deletes files without prompting' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'discards uncommitted work in the working tree' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*[fd]/, why: 'deletes untracked files, which no checkpoint holds' },
  { re: /\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/, why: 'rewrites history on a remote' },
  { re: /\bgit\s+(branch|tag)\s+-D\b/, why: 'deletes a branch or tag without checking it is merged' },
  { re: /\bdd\s+[^|;&]*\bof=/, why: 'writes directly to a device or file, overwriting it' },
  { re: /\bmkfs(\.\w+)?\b/, why: 'formats a filesystem' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: 'stops the machine' },
  { re: /\bchmod\s+-R\s+0?777\b/, why: 'makes a tree world-writable' },
  { re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba)?sh\b/, why: 'pipes a downloaded script straight into a shell' },
  { re: /\bsudo\b/, why: 'runs with administrator privileges' },
  { re: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, why: 'destroys database contents' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/, why: 'publishes a package to a public registry' },
  { re: /\bdocker\s+(system\s+)?prune\b/, why: 'deletes Docker data' },
  { re: /\bkubectl\s+delete\b/, why: 'deletes cluster resources' },
  { re: /\bterraform\s+(apply|destroy)\b/, why: 'changes real infrastructure' },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, why: 'is a fork bomb' },
  { re: />\s*\/dev\/(sd|nvme|disk)/, why: 'writes to a raw disk device' },
];

/**
 * Commands that only read.
 *
 * Kept small and exact on purpose. Anything not recognised here is assumed to
 * write, because the cost of the two mistakes is not symmetric: treating a write
 * as a read runs it unattended, while treating a read as a write only asks an
 * unnecessary question.
 */
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'whoami', 'date', 'echo',
  'grep', 'rg', 'fd', 'find', 'which', 'type', 'file', 'stat', 'du', 'df',
  'env', 'printenv', 'uname', 'hostname', 'ps', 'top',
  'node', 'python', 'python3', 'ruby', 'go', 'java',
]);

/** Git subcommands that only report. */
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'blame',
  'describe', 'rev-parse', 'ls-files', 'shortlog', 'config',
]);

/**
 * Classifies one command line.
 *
 * The whole line is examined, not just the first word, because the risk usually
 * lives in an argument (`git push --force`) or after a pipe. Chained commands
 * take the danger of their most dangerous part, since `npm test && rm -rf dist`
 * is a destructive command whatever its first word says.
 */
export function classifyCommand(command: string): CommandVerdict {
  const line = command.trim();
  if (line === '') {
    return { danger: 'writes', reason: 'the command is empty', trigger: null };
  }

  for (const { re, why } of DESTRUCTIVE) {
    const match = re.exec(line);
    if (match !== null) {
      return {
        danger: 'destructive',
        reason: `This ${why}.`,
        trigger: match[0].trim(),
      };
    }
  }

  // A chained or piped line is only read-only if every part is.
  const parts = line.split(/\s*(?:&&|\|\||;|\|)\s*/).filter((p) => p !== '');
  if (parts.length > 1) {
    const verdicts = parts.map((p) => classifyCommand(p));
    const worst = verdicts.find((v) => v.danger === 'destructive')
      ?? verdicts.find((v) => v.danger === 'writes');
    return worst ?? { danger: 'read-only', reason: 'Only reads.', trigger: null };
  }

  const words = line.split(/\s+/);
  const head = (words[0] ?? '').replace(/^.*\//, '');

  if (head === 'git') {
    const sub = words[1] ?? '';
    return READ_ONLY_GIT.has(sub)
      ? { danger: 'read-only', reason: `\`git ${sub}\` only reports.`, trigger: null }
      : { danger: 'writes', reason: `\`git ${sub}\` can change the repository.`, trigger: null };
  }

  // `node -e` and friends run arbitrary code, so the interpreter alone is not
  // enough to call it read-only.
  if (READ_ONLY.has(head) && !/\s-(e|c|-eval)\b/.test(line)) {
    return { danger: 'read-only', reason: `\`${head}\` only reads.`, trigger: null };
  }

  return { danger: 'writes', reason: `\`${head}\` can change files.`, trigger: null };
}

/**
 * Whether the user has to approve this command in this mode.
 *
 * Destructive commands always ask, in every mode including `autonomous`. That is
 * the one rule with no override: a mode called "autonomous" that force-pushed
 * without asking would be a setting whose consequences the user could not have
 * predicted when they chose it.
 */
export function requiresApproval(mode: PermissionMode, danger: CommandDanger): boolean {
  if (danger === 'destructive') {
    return true;
  }
  switch (mode) {
    case 'safe':
      return danger !== 'read-only';
    case 'balanced':
      return false;
    case 'autonomous':
      return false;
  }
}

/**
 * Whether the mode forbids the command outright, rather than merely asking.
 *
 * `safe` is a read-only mode, so a write is refused rather than queued behind a
 * prompt the user would have to decline every time.
 */
export function isForbidden(mode: PermissionMode, danger: CommandDanger): boolean {
  return mode === 'safe' && danger !== 'read-only';
}

/** The sentence shown when a command is refused by the current mode. */
export function forbiddenReason(verdict: CommandVerdict): string {
  return (
    `CodeRelay is in read-only mode, so it did not run this command. ${verdict.reason} ` +
    'Change the permission mode in settings to allow it.'
  );
}

const MODES: readonly PermissionMode[] = ['safe', 'balanced', 'autonomous'];

/** Reads a mode from settings, falling back to the safest sensible default. */
export function parsePermissionMode(raw: unknown): PermissionMode {
  return typeof raw === 'string' && (MODES as readonly string[]).includes(raw)
    ? (raw as PermissionMode)
    : 'balanced';
}
