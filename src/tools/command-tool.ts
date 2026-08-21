/**
 * `run_command`: the agent's shell.
 *
 * This is the first tool whose effect the workspace cannot describe. A file
 * write is verifiable — fingerprint the path before and after and you know
 * whether it landed. A command is not: it may touch nothing, or a hundred files,
 * or a remote server, and after a crash there is no state to compare against.
 *
 * `ToolSafety: 'unsafe'` says exactly that, and it is why `predictPostState`
 * returns null: an interrupted command escalates to the user instead of being
 * silently repeated.
 *
 * **The effect log narrows that ambiguity with evidence rather than a guess.**
 * Before the process starts, the runner creates a log file named after the
 * command's `SideEffectKey`. Its existence proves execution *began*; a recorded
 * exit code proves it *finished*. So the three states a restart cares about are
 * distinguishable from disk:
 *
 *   no file          -> the command never started; running it is safe
 *   file, no exit    -> it started and we do not know if it finished; ask
 *   file, exit code  -> it finished, and its outcome is right there
 *
 * That converts most interruptions from "ask the user" into a settled fact. It
 * does not eliminate the ambiguous case, and deliberately does not pretend to:
 * a command killed halfway through still has unknown external effects, and for
 * that one the honest answer remains a question.
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileFingerprint } from '../continuity/entries.js';
import { registerTool, type RegisteredTool, type ToolContext, type ToolSpec } from './tool.js';

export interface CommandArgs {
  readonly command: string;
  /** Optional one-line explanation the model supplies, shown when approving. */
  readonly explanation: string | null;
}

/** How long a single command may run before it is killed. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * How much of a command's output goes back to the model.
 *
 * Bounded because a build can emit megabytes and the transcript is re-sent on
 * every subsequent turn: an unbounded result would blow the context window a few
 * turns later, far from the command that caused it. The head and tail are kept
 * because that is where the useful parts of build output live — what it was
 * doing, and what finally went wrong.
 */
const MAX_OUTPUT_CHARS = 12_000;

function parseArgs(args: unknown): CommandArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('run_command expects an object');
  }
  const record = args as Record<string, unknown>;
  const command = record['command'];
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('run_command requires a non-empty "command" string');
  }
  const explanation = record['explanation'];
  return {
    command: command.trim(),
    explanation: typeof explanation === 'string' && explanation.trim() !== '' ? explanation.trim() : null,
  };
}

export const runCommandTool: RegisteredTool = registerTool<CommandArgs>({
  name: 'run_command',
  // Never `idempotent`. Re-running a command that appends to a file, sends a
  // request or increments a counter is exactly the duplicate side effect the
  // ledger exists to prevent.
  safety: 'unsafe',
  parse: parseArgs,
  // A command's targets are unknowable ahead of time. Claiming otherwise would
  // make recovery compare the wrong fingerprints and conclude the wrong thing.
  affectedPaths: () => [],
  predictPostState: (): readonly FileFingerprint[] | null => null,

  async execute(args, ctx: ToolContext): Promise<string> {
    const log = ctx.effectLogPath ?? null;
    if (log !== null) {
      // Written *before* the process starts, so its existence is evidence that
      // execution began even if this process dies in the next instant.
      await mkdir(dirname(log), { recursive: true });
      await writeFile(log, `command: ${args.command}\nstarted: ${new Date().toISOString()}\n\n`, 'utf8');
    }

    const result = await runProcess(args.command, ctx, ctx.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);

    if (log !== null) {
      await appendFile(
        log,
        `${result.output}\n\nexit: ${result.exitCode ?? 'killed'}\nfinished: ${new Date().toISOString()}\n`,
        'utf8',
      );
    }

    const body = clamp(result.output);
    if (result.timedOut) {
      // A timeout is reported as a result rather than thrown: the model needs to
      // know the command hung, and the ledger needs it recorded as settled.
      throw new Error(
        `timed out after ${Math.round((ctx.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS) / 1000)}s\n${body}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(`exited with code ${result.exitCode}\n${body}`);
    }
    return body === '' ? 'exited 0 with no output' : body;
  },
});

interface ProcessResult {
  readonly output: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/**
 * Runs one command and collects its combined output.
 *
 * `shell: true` is intentional: the model writes ordinary command lines with
 * pipes and `&&`, and refusing them would mean the tool could not run the very
 * things it exists for. The safety boundary is `security/commands.ts` plus the
 * approval gate, not argument escaping — that boundary is stated plainly rather
 * than implied by a half-sandbox.
 */
function runProcess(command: string, ctx: ToolContext, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: ctx.root,
      shell: true,
      // A command must never inherit the extension host's stdin: an interactive
      // prompt would hang the task forever with nothing to type into it.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    let output = '';
    let settled = false;
    const collect = (chunk: Buffer): void => {
      // Bounded as it arrives, not at the end, so a runaway process cannot
      // exhaust memory before its timeout fires.
      if (output.length < MAX_OUTPUT_CHARS * 4) {
        output += chunk.toString('utf8');
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const finish = (result: ProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ output, exitCode: null, timedOut: true });
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish({ output, exitCode: null, timedOut: false });
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err: Error) => {
      finish({ output: `${output}\n${err.message}`, exitCode: null, timedOut: false });
    });
    child.on('close', (code: number | null) => {
      finish({ output, exitCode: code, timedOut: false });
    });
  });
}

/** Keeps the head and tail, which is where build output says anything useful. */
function clamp(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_OUTPUT_CHARS) {
    return trimmed;
  }
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  const omitted = trimmed.length - MAX_OUTPUT_CHARS;
  return `${trimmed.slice(0, half)}\n\n… ${omitted.toLocaleString()} characters omitted …\n\n${trimmed.slice(-half)}`;
}

export const runCommandSpec: ToolSpec = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace root and return its combined output. ' +
    'Use it to build, run tests, type-check and lint. The command runs without a ' +
    'terminal, so it must not expect interactive input. Destructive commands ' +
    'always require the user to approve them first.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run, e.g. "npm test".' },
      explanation: {
        type: 'string',
        description: 'One short sentence on why this command is being run, shown to the user when approval is needed.',
      },
    },
    required: ['command'],
  },
};
