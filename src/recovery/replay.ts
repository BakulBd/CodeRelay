import type { FileFingerprint, LedgerEntry } from '../continuity/entries.js';
import type { SideEffectKey, StepId, ToolCallId } from '../core/types.js';

/**
 * What the agent should do when a task is picked back up.
 *
 * These are the only outcomes. Notably there is no "just retry" — every branch
 * either has positive evidence about whether the side effect landed, or asks
 * the user.
 */
export type RecoveryPlan =
  /** Nothing was in flight. Start the next model turn normally. */
  | { readonly kind: 'START_TURN' }
  /**
   * A turn was streaming but no tool had been requested. No side effect
   * occurred, so the turn can be regenerated on any capable model.
   *
   * `partialText` is carried forward as context, explicitly flagged as cut off,
   * rather than being treated as a real assistant message.
   */
  | { readonly kind: 'REGENERATE_TURN'; readonly partialText: string | null }
  /**
   * A tool was requested but provably never started. Safe to execute.
   */
  | {
      readonly kind: 'EXECUTE_TOOL';
      readonly toolCallId: ToolCallId;
      readonly sideEffectKey: SideEffectKey;
      readonly reason: string;
    }
  /**
   * A tool may have run. Workspace evidence shows the intended end state is
   * already present, so we adopt it instead of re-running.
   */
  | {
      readonly kind: 'ADOPT_COMPLETED_EFFECT';
      readonly toolCallId: ToolCallId;
      readonly sideEffectKey: SideEffectKey;
      readonly evidence: string;
    }
  /**
   * A tool may have run and we cannot prove either way. Only the user can
   * decide. This is a legitimate outcome, not a failure of the design: for an
   * arbitrary shell command there is no sound way to infer completion.
   */
  | {
      readonly kind: 'ASK_USER';
      readonly toolCallId: ToolCallId;
      readonly sideEffectKey: SideEffectKey;
      readonly question: string;
    }
  /** The task already finished or was abandoned. */
  | { readonly kind: 'NOTHING_TO_DO'; readonly reason: string };

/** Reads the current state of files so replay can compare against the ledger. */
export interface WorkspaceProbe {
  fingerprint(path: string): Promise<FileFingerprint>;
}

/** What an `unsafe` tool's effect log records about one operation. */
export type EffectRecord =
  /** The log exists but has no outcome: it began and may not have finished. */
  | { readonly t: 'started' }
  /** The log records a terminal outcome, so the operation definitely finished. */
  | { readonly t: 'finished'; readonly exitCode: number | null };

/**
 * Reads the evidence an `unsafe` tool leaves behind.
 *
 * Absence of a log is itself evidence — it means the operation never began —
 * which is why `null` is a meaningful answer rather than an error. See
 * `tools/command-tool.ts` for why the file is written before execution starts.
 */
export interface EffectLogReader {
  read(sideEffectKey: SideEffectKey): Promise<EffectRecord | null>;
}

/**
 * Derives the recovery plan from the durable ledger plus observed workspace state.
 *
 * This function is the heart of CodeRelay and is deliberately pure apart from
 * the injected probe, so the full matrix of interrupted states can be tested
 * without a live provider or a real VS Code host.
 *
 * The reasoning, in order of the questions that matter:
 *
 * 1. Is the task over? Then stop.
 * 2. Did we get as far as recording a tool execution attempt? That is the only
 *    ambiguous case, so it is checked first and most carefully.
 * 3. Otherwise, was a tool merely requested? Safe to run.
 * 4. Otherwise we were only streaming text, which has no side effects.
 *
 * One subtlety that is easy to get wrong: a `MODEL_RESPONSE_COMPLETED` carrying
 * `reason: 'truncated'` is *not* a completed turn. The agent loop records it so
 * the timeline shows what arrived, and then routes it as a failure precisely
 * because a half-expressed intent must not be executed. Treating it as a clean
 * step boundary here would start a fresh turn and silently discard everything
 * the model had said, which is the one case `REGENERATE_TURN` exists to serve.
 * `buildHandoff` already draws this distinction; the two ledger readers have to
 * agree or a restart behaves differently from a live model switch.
 */
export async function planRecovery(
  entries: readonly LedgerEntry[],
  probe: WorkspaceProbe,
  effects?: EffectLogReader,
): Promise<RecoveryPlan> {
  if (entries.length === 0) {
    return { kind: 'START_TURN' };
  }

  const last = entries[entries.length - 1]!;
  if (last.type === 'TASK_DONE') {
    return { kind: 'NOTHING_TO_DO', reason: 'task already completed' };
  }
  if (last.type === 'TASK_ABANDONED') {
    return { kind: 'NOTHING_TO_DO', reason: `task abandoned: ${last.reason}` };
  }

  // Find the most recent step that has an unresolved tool execution. A tool is
  // resolved once TOOL_COMPLETED or TOOL_RECONCILED exists for its call id.
  const resolved = new Set<ToolCallId>();
  for (const e of entries) {
    if (e.type === 'TOOL_COMPLETED' || e.type === 'TOOL_RECONCILED') {
      resolved.add(e.toolCallId);
    }
  }

  // Scan backwards for the newest unresolved execution attempt.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;

    if (e.type === 'TOOL_EXECUTING' && !resolved.has(e.toolCallId)) {
      return resolveAmbiguousExecution(e, probe, effects);
    }

    if (e.type === 'TOOL_REQUESTED' && !resolved.has(e.toolCallId)) {
      // We recorded the intent but never reached TOOL_EXECUTING, and because
      // TOOL_EXECUTING is flushed before the effect runs, the effect provably
      // did not start.
      return {
        kind: 'EXECUTE_TOOL',
        toolCallId: e.toolCallId,
        sideEffectKey: e.sideEffectKey,
        reason: 'tool was requested but execution never began',
      };
    }

    // A truncated turn produced no complete intent, so there is nothing to
    // settle and nothing that could have caused a side effect. Regenerate it,
    // carrying the partial text forward as a hint only.
    if (e.type === 'MODEL_RESPONSE_COMPLETED' && e.reason === 'truncated') {
      return { kind: 'REGENERATE_TURN', partialText: partialFrom(e.text, entries) };
    }

    // A completed turn or a settled tool means the step boundary is clean.
    // TOOL_RECONCILED counts as settled: recovery already decided that effect
    // had landed, so re-deciding it would undo that conclusion.
    if (
      e.type === 'MODEL_RESPONSE_COMPLETED' ||
      e.type === 'TOOL_COMPLETED' ||
      e.type === 'TOOL_RECONCILED'
    ) {
      return { kind: 'START_TURN' };
    }

  }

  // No tool activity at all: we were mid-stream on text, or had just started.
  const partial = latestPartialText(entries);
  if (partial !== null) {
    return { kind: 'REGENERATE_TURN', partialText: partial };
  }
  return { kind: 'START_TURN' };
}

/**
 * Decides what to do about a tool that may or may not have executed.
 *
 * Strategy per safety class:
 *
 * - `pure` tools have no side effects, so re-running is always correct.
 * - `idempotent` tools declare an expected post-state. If the workspace
 *   already matches it, the write landed and we adopt it. If the workspace
 *   still matches the pre-state, the write did not land and re-running is safe.
 *   Anything else means a third party changed the file, so we ask.
 * - `unsafe` tools (shell commands) cannot be verified. We always ask.
 */
async function resolveAmbiguousExecution(
  e: Extract<LedgerEntry, { type: 'TOOL_EXECUTING' }>,
  probe: WorkspaceProbe,
  effects?: EffectLogReader,
): Promise<RecoveryPlan> {
  if (e.safety === 'pure') {
    return {
      kind: 'EXECUTE_TOOL',
      toolCallId: e.toolCallId,
      sideEffectKey: e.sideEffectKey,
      reason: 'tool has no side effects, so re-running is safe',
    };
  }

  // An `unsafe` tool has no post-state to compare, but it may have left a log
  // saying whether it began and whether it finished. That is real evidence, and
  // it settles two of the three cases without troubling the user.
  if (e.safety === 'unsafe' && effects !== undefined) {
    const record = await effects.read(e.sideEffectKey);
    if (record === null) {
      return {
        kind: 'EXECUTE_TOOL',
        toolCallId: e.toolCallId,
        sideEffectKey: e.sideEffectKey,
        reason: 'the operation left no record of starting, so it provably never ran',
      };
    }
    if (record.t === 'finished') {
      return {
        kind: 'ADOPT_COMPLETED_EFFECT',
        toolCallId: e.toolCallId,
        sideEffectKey: e.sideEffectKey,
        evidence:
          record.exitCode === null
            ? 'the operation recorded that it finished'
            : `the operation ran to completion and exited ${record.exitCode}`,
      };
    }
    // Started, no outcome. Genuinely unknown, so the user decides.
    return {
      kind: 'ASK_USER',
      toolCallId: e.toolCallId,
      sideEffectKey: e.sideEffectKey,
      question:
        'This command started but never recorded finishing, so CodeRelay cannot tell how far ' +
        'it got. Run it again, or skip it?',
    };
  }

  if (e.safety === 'unsafe' || e.expectedPostState === null) {
    return {
      kind: 'ASK_USER',
      toolCallId: e.toolCallId,
      sideEffectKey: e.sideEffectKey,
      question:
        'This operation may have already run before the interruption, and its effect ' +
        'cannot be verified from the workspace. Run it again, or skip it?',
    };
  }

  const matchesExpected = await allMatch(e.expectedPostState, probe);
  if (matchesExpected) {
    return {
      kind: 'ADOPT_COMPLETED_EFFECT',
      toolCallId: e.toolCallId,
      sideEffectKey: e.sideEffectKey,
      evidence: 'workspace already matches the expected post-state of this edit',
    };
  }

  const matchesPre = await allMatch(e.preState, probe);
  if (matchesPre) {
    return {
      kind: 'EXECUTE_TOOL',
      toolCallId: e.toolCallId,
      sideEffectKey: e.sideEffectKey,
      reason: 'workspace still matches the pre-state, so the edit did not land',
    };
  }

  // Neither state matches: something outside this task modified the files.
  // Re-applying could clobber the user's own work, so we stop and ask.
  return {
    kind: 'ASK_USER',
    toolCallId: e.toolCallId,
    sideEffectKey: e.sideEffectKey,
    question:
      'The target files match neither the state before this edit nor the state after it. ' +
      'They were probably changed outside CodeRelay. Re-apply the edit, or skip it?',
  };
}

/** True when every fingerprint still describes the file on disk. */
async function allMatch(
  expected: readonly FileFingerprint[],
  probe: WorkspaceProbe,
): Promise<boolean> {
  if (expected.length === 0) {
    return false; // no evidence is not the same as matching evidence
  }
  for (const want of expected) {
    const got = await probe.fingerprint(want.path);
    if (got.sha256 !== want.sha256) {
      return false;
    }
  }
  return true;
}

/**
 * The text to carry forward from a truncated turn.
 *
 * The recorded `text` is normally the fullest account of what arrived, since the
 * loop accumulates every delta before writing the entry. It can still be empty —
 * a stream that died before any text, or an entry written by an older build — so
 * `STREAM_PROGRESS` is the fallback rather than the primary source. Returning
 * `null` rather than `''` matters: `REGENERATE_TURN` uses it to decide whether
 * there is a hint worth showing the next model at all.
 */
function partialFrom(text: string, entries: readonly LedgerEntry[]): string | null {
  if (text !== '') {
    return text;
  }
  const progress = latestPartialText(entries);
  return progress === null || progress === '' ? null : progress;
}

/**
 * The most recent partial stream text, if the last turn never completed.
 *
 * A *cleanly* completed turn ends the search: its text is a finished statement
 * that belongs in the transcript, not a partial hint. A truncated one does not,
 * for the reason given on `planRecovery`.
 */
function latestPartialText(entries: readonly LedgerEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === 'MODEL_RESPONSE_COMPLETED' && e.reason !== 'truncated') {
      return null;
    }
    if (e.type === 'STREAM_PROGRESS') {
      return e.textSoFar;
    }
  }
  return null;
}

/** Steps that have at least one unresolved tool call. Useful for diagnostics. */
export function unresolvedSteps(entries: readonly LedgerEntry[]): StepId[] {
  const resolved = new Set<ToolCallId>();
  for (const e of entries) {
    if (e.type === 'TOOL_COMPLETED' || e.type === 'TOOL_RECONCILED') {
      resolved.add(e.toolCallId);
    }
  }
  const out = new Set<StepId>();
  for (const e of entries) {
    if (
      (e.type === 'TOOL_REQUESTED' || e.type === 'TOOL_EXECUTING') &&
      !resolved.has(e.toolCallId)
    ) {
      out.add(e.stepId);
    }
  }
  return [...out];
}
