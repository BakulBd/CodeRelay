/**
 * The one place verification touches a real process.
 *
 * Kept apart from `run.ts` and `plan.ts` so those stay pure and exhaustively
 * testable, which is the same split the provider layer uses: policy is a
 * function, and exactly one small module is allowed to be impure.
 *
 * The commands this runs are not model output. They come from `planVerification`,
 * which builds them from the project's own `package.json` scripts, so there is
 * no path by which a provider's text reaches a shell through here. That is why
 * this executor has no approval gate of its own: the approval boundary exists
 * for commands a *model* chose, and `run_command` still owns that case.
 */
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandResult } from './run.js';
import { detectPackageManager, type WorkspaceFacts } from './plan.js';

/** Output retained per command, in characters, before truncation. */
const MAX_CAPTURE_CHARS = 200_000;

/** Longest a single verification command may run. */
export const DEFAULT_CHECK_TIMEOUT_MS = 300_000;

export interface ExecOptions {
  readonly root: string;
  readonly timeoutMs?: number;
  /** Injected so durations can be asserted without a real clock. */
  readonly now?: () => number;
}

/**
 * Runs one verification command in the workspace.
 *
 * Never rejects for a command that ran and failed — that is a `CommandResult`
 * with a non-zero exit code, which the caller interprets. It rejects only when
 * the process could not be started at all, because "your build is broken" and
 * "CodeRelay could not start your build" have different fixes and must not
 * arrive at the panel looking the same.
 */
export function createExecutor(options: ExecOptions) {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  return async function exec(command: string, signal: AbortSignal): Promise<CommandResult> {
    const startedAt = now();

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, {
        cwd: options.root,
        // Ordinary command lines with `&&` and pipes, same reasoning as
        // `run_command`: refusing them would mean refusing most real scripts.
        shell: true,
        // Never inherit stdin. A script that stops to ask a question would
        // otherwise hang verification forever with nothing to type into.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Make tools behave as they would in CI: no colour escapes to strip,
          // no interactive prompts, no progress spinners in the captured output.
          CI: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
      });

      let output = '';
      let settled = false;

      const collect = (chunk: Buffer): void => {
        // Bounded as it arrives rather than at the end, so a runaway build
        // cannot exhaust memory before its timeout fires.
        if (output.length < MAX_CAPTURE_CHARS) {
          output += chunk.toString('utf8');
        }
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);

      const finish = (result: CommandResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({
          output,
          exitCode: null,
          timedOut: true,
          durationMs: now() - startedAt,
        });
      }, timeoutMs);

      const onAbort = (): void => {
        child.kill('SIGKILL');
        finish({ output, exitCode: null, timedOut: false, durationMs: now() - startedAt });
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        // Could not start. Rejecting rather than resolving with a null exit
        // code is what lets `runVerification` mark this `errored` instead of
        // `failed`.
        reject(error);
      });

      child.on('close', (code: number | null) => {
        finish({ output, exitCode: code, timedOut: false, durationMs: now() - startedAt });
      });
    });
  };
}

/**
 * Reads what the workspace declares.
 *
 * Every failure is absorbed into "nothing declared" rather than thrown: a
 * workspace with no manifest, an unreadable one, or one containing malformed
 * JSON all mean the same thing to verification — there is nothing here it knows
 * how to check — and a verification panel must not be the thing that reports a
 * syntax error in a file the user may not own.
 */
export async function readWorkspaceFacts(root: string): Promise<WorkspaceFacts> {
  let rootFiles: string[] = [];
  try {
    rootFiles = await readdir(root);
  } catch {
    rootFiles = [];
  }

  let scripts: Record<string, string> | null = null;
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = (parsed as { scripts?: unknown }).scripts;
      if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
        // Only string values survive. A `scripts` entry that is an object or a
        // number is not a command, and letting one through would produce a
        // check whose command line is `[object Object]`.
        const clean: Record<string, string> = {};
        for (const [name, value] of Object.entries(candidate as Record<string, unknown>)) {
          if (typeof value === 'string') {
            clean[name] = value;
          }
        }
        scripts = clean;
      } else {
        // A manifest exists but declares no scripts. That is different from
        // having no manifest, and `planVerification` words the two differently.
        scripts = {};
      }
    }
  } catch {
    scripts = null;
  }

  return { scripts, rootFiles, packageManager: detectPackageManager(rootFiles) };
}
