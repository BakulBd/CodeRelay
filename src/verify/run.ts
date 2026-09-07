/**
 * Running the verification plan and deciding whether the work is actually done.
 *
 * The claim this module exists to make honest: **a task is not complete because
 * a model said so.** The model's own report is an assertion; an exit code is
 * evidence. So `complete` is a verdict reached here, from commands the project
 * itself declared, and never from anything a provider generated.
 *
 * Three rules, each of which is a way the panel could otherwise lie:
 *
 *  1. **An empty plan is never `verified`.** A project with no test script has
 *     not passed its tests; it has no tests. Those must not render alike, so an
 *     empty plan yields `unverifiable`, which is a distinct verdict with its own
 *     wording rather than a green tick with nothing behind it.
 *
 *  2. **A check that could not run is not a check that passed.** A missing
 *     package manager, a command that could not start, a run that was
 *     cancelled — each is `skipped` or `errored`, and neither counts toward a
 *     pass. The verdict downgrades accordingly.
 *
 *  3. **Verification stops at the first failure by default.** Running the test
 *     suite after the type check failed produces a wall of errors with one
 *     cause, and the user then has to work out which failures are real. The
 *     order in `CHECK_ORDER` is cheapest-and-most-localised first precisely so
 *     that stopping early is the useful behaviour.
 *
 * Execution is injected. Nothing here spawns a process, so the whole decision
 * table — including timeouts and cancellation — is exercisable with no child
 * process and no workspace.
 */
import { CHECK_LABELS, type CheckId, type PlannedCheck, type VerificationPlan } from './plan.js';

/** What running one command produced. Supplied by the caller's executor. */
export interface CommandResult {
  /** Process exit code, or null when the process never produced one. */
  readonly exitCode: number | null;
  /** Combined stdout and stderr, already bounded by the executor. */
  readonly output: string;
  /** True when the run hit its time limit rather than finishing. */
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/** Runs one command in the workspace. Must honour `signal`. */
export type CommandExecutor = (
  command: string,
  signal: AbortSignal,
) => Promise<CommandResult>;

export type CheckStatus =
  /** Exit code 0. */
  | 'passed'
  /** Ran to completion and reported failure. */
  | 'failed'
  /** Could not be run at all — no such command, or the executor refused. */
  | 'errored'
  /** Deliberately not run: an earlier check failed, or the user cancelled. */
  | 'skipped';

export interface CheckResult {
  readonly id: CheckId;
  readonly label: string;
  readonly command: string;
  readonly status: CheckStatus;
  readonly durationMs: number | null;
  /**
   * A short explanation. Always safe to display.
   *
   * Command output is *not* put here wholesale — it can be megabytes, and it is
   * shown in the collapsible detail instead.
   */
  readonly summary: string;
  /** Bounded command output, for the disclosure. Empty when nothing ran. */
  readonly output: string;
}

export type Verdict =
  /** Every available check ran and passed. */
  | 'verified'
  /** At least one check failed. */
  | 'failed'
  /** Nothing could be checked, so nothing is claimed. */
  | 'unverifiable'
  /** The run was stopped before it finished. */
  | 'cancelled';

export interface VerificationRun {
  readonly verdict: Verdict;
  readonly checks: readonly CheckResult[];
  /** Checks the project does not declare, carried from the plan. */
  readonly unavailable: readonly { readonly id: CheckId; readonly reason: string }[];
  readonly totalDurationMs: number;
}

export interface RunOptions {
  readonly plan: VerificationPlan;
  readonly exec: CommandExecutor;
  readonly signal?: AbortSignal;
  /**
   * Keep going after a failure instead of stopping.
   *
   * Off by default. On for a user who explicitly asked to see everything.
   */
  readonly continueOnFailure?: boolean;
  /** Injected so durations can be asserted exactly. */
  readonly now?: () => number;
}

/** Characters of command output retained per check. */
const MAX_OUTPUT_CHARS = 20_000;

function clampOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output;
  }
  // Keep the tail: compilers and test runners put the summary at the end, and
  // the first 20k of a failing build is almost always the parts that succeeded.
  const kept = output.slice(output.length - MAX_OUTPUT_CHARS);
  return `… ${output.length - MAX_OUTPUT_CHARS} earlier characters omitted …\n${kept}`;
}

/**
 * A one-line summary of what a command did.
 *
 * Deliberately generic. Parsing each tool's output format to extract "3 tests
 * failed" was considered and rejected: every format differs, they change
 * between versions, and a summary that is subtly wrong about *which* tests
 * failed is worse than one that simply says the suite failed and shows the
 * output.
 */
function summarize(result: CommandResult, id: CheckId): string {
  if (result.timedOut) {
    return `${CHECK_LABELS[id]} did not finish in time and was stopped.`;
  }
  if (result.exitCode === 0) {
    return `${CHECK_LABELS[id]} passed.`;
  }
  if (result.exitCode === null) {
    return `${CHECK_LABELS[id]} could not be run.`;
  }
  return `${CHECK_LABELS[id]} failed (exit code ${result.exitCode}).`;
}

function skipped(check: PlannedCheck, summary: string): CheckResult {
  return {
    id: check.id,
    label: check.label,
    command: check.command,
    status: 'skipped',
    durationMs: null,
    summary,
    output: '',
  };
}

/**
 * Run the plan.
 *
 * Sequential on purpose. These commands compete for the same CPU, the same
 * `node_modules` and often the same build output directory; running a type
 * check and a build concurrently is a good way to make both slower and one of
 * them flaky.
 */
export async function runVerification(options: RunOptions): Promise<VerificationRun> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { plan, exec, signal } = options;
  const results: CheckResult[] = [];

  // Stated before anything runs: with no checks there is nothing to conclude,
  // and the verdict says exactly that rather than defaulting to success.
  if (plan.checks.length === 0) {
    return {
      verdict: 'unverifiable',
      checks: [],
      unavailable: plan.unavailable,
      totalDurationMs: 0,
    };
  }

  let stopReason: 'failure' | 'cancelled' | null = null;

  for (const check of plan.checks) {
    if (signal?.aborted === true) {
      stopReason = stopReason ?? 'cancelled';
    }

    if (stopReason !== null) {
      results.push(
        skipped(
          check,
          stopReason === 'cancelled'
            ? 'Not run — verification was stopped.'
            : 'Not run — an earlier check failed.',
        ),
      );
      continue;
    }

    let result: CommandResult;
    try {
      result = await exec(check.command, signal ?? new AbortController().signal);
    } catch (error: unknown) {
      // An executor that throws means the command could not be started at all,
      // which is a different thing from a command that ran and failed. Calling
      // it `errored` keeps "your tests are broken" and "CodeRelay could not run
      // your tests" apart, because they have different fixes.
      results.push({
        id: check.id,
        label: check.label,
        command: check.command,
        status: 'errored',
        durationMs: null,
        summary: `Could not run \`${check.command}\`: ${describeError(error)}`,
        output: '',
      });
      stopReason = options.continueOnFailure === true ? null : 'failure';
      continue;
    }

    const passed = result.exitCode === 0 && !result.timedOut;
    const status: CheckStatus = passed
      ? 'passed'
      : result.exitCode === null && !result.timedOut
        ? 'errored'
        : 'failed';

    results.push({
      id: check.id,
      label: check.label,
      command: check.command,
      status,
      durationMs: result.durationMs,
      summary: summarize(result, check.id),
      output: clampOutput(result.output),
    });

    if (!passed && options.continueOnFailure !== true) {
      stopReason = 'failure';
    }
  }

  return {
    verdict: verdictFor(results, signal?.aborted === true),
    checks: results,
    unavailable: plan.unavailable,
    totalDurationMs: now() - startedAt,
  };
}

/**
 * The verdict for a finished run.
 *
 * Exported because it is the single most important judgement in this module and
 * deserves to be asserted directly rather than only through a full run.
 */
export function verdictFor(
  results: readonly CheckResult[],
  cancelled: boolean,
): Verdict {
  if (results.length === 0) {
    return 'unverifiable';
  }
  if (results.some((r) => r.status === 'failed' || r.status === 'errored')) {
    return 'failed';
  }
  if (cancelled || results.some((r) => r.status === 'skipped')) {
    // Some checks never ran, so the work has not been verified — even though
    // nothing that did run failed. Reporting this as `verified` is exactly the
    // false green tick this module exists to prevent.
    return 'cancelled';
  }
  return 'verified';
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Returns true only when every declared check ran to completion and passed.
 * An empty plan (unverifiable) or skipped checks are never verified.
 */
export function isFullyVerified(run: VerificationRun): boolean {
  return run.verdict === 'verified' && run.checks.length > 0;
}

/**
 * Summarizes the verification results for display and structured handoffs.
 */
export function summarizeVerification(run: VerificationRun): {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly summary: string;
} {
  const passed = run.checks.filter((c) => c.status === 'passed').length;
  const failed = run.checks.filter((c) => c.status === 'failed' || c.status === 'errored').length;
  const total = run.checks.length;

  let summary: string;
  if (run.verdict === 'verified') {
    summary = `Verified ✓ (${passed}/${total} checks passed)`;
  } else if (run.verdict === 'failed') {
    const failedNames = run.checks
      .filter((c) => c.status === 'failed' || c.status === 'errored')
      .map((c) => c.label)
      .join(', ');
    summary = `Failed (${failedNames})`;
  } else if (run.verdict === 'unverifiable') {
    summary = 'Unverifiable (no checks declared)';
  } else {
    summary = 'Cancelled';
  }

  return { total, passed, failed, summary };
}

