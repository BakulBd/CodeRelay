import { createHash } from 'node:crypto';
import type {
  AttemptId,
  ErrorClass,
  ModelRef,
  SideEffectKey,
  StepId,
  StopReason,
  TaskId,
  ToolCallId,
  ToolSafety,
} from '../core/types.js';

/**
 * Observable facts about a file at a point in time. Used to decide whether a
 * write already landed when we crashed mid-execution.
 */
export interface FileFingerprint {
  readonly path: string;
  /** SHA-256 of file contents, or null if the file did not exist. */
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
}

/** Fields present on every ledger entry. */
interface EntryBase {
  readonly taskId: TaskId;
  readonly stepId: StepId;
  readonly attemptId: AttemptId;
  /** Monotonic per-task sequence number. Gaps indicate a lost write. */
  readonly seq: number;
  /** ISO-8601 timestamp. Wall clock only; never used for ordering. */
  readonly at: string;
}

/**
 * The append-only ledger alphabet.
 *
 * Every entry is durable before the action it describes is allowed to proceed.
 * Recovery is a pure function of these entries plus the observed workspace.
 */
export type LedgerEntry =
  /** A task was created. Carries the objective so recovery can restate it. */
  | (EntryBase & {
      readonly type: 'TASK_STARTED';
      readonly objective: string;
    })
  /** A model turn began. No side effects have occurred yet. */
  | (EntryBase & {
      readonly type: 'STREAMING';
      readonly model: ModelRef;
      readonly credentialId: string;
    })
  /**
   * Partial assistant output, checkpointed periodically during streaming.
   *
   * Persisted so a truncated turn can be shown to the user and handed to a
   * successor model as context. Never treated as a complete response.
   */
  | (EntryBase & {
      readonly type: 'STREAM_PROGRESS';
      readonly textSoFar: string;
    })
  /**
   * The model asked for a tool. The decision is durable but nothing has run.
   * Re-running from here is always safe.
   */
  | (EntryBase & {
      readonly type: 'TOOL_REQUESTED';
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly args: unknown;
      readonly sideEffectKey: SideEffectKey;
      readonly safety: ToolSafety;
    })
  /**
   * We are about to run the tool. Written and flushed BEFORE execution.
   *
   * This is the only genuinely ambiguous state: finding it on restart means
   * the effect may or may not have happened. `preState` is what makes the
   * ambiguity resolvable for file operations.
   */
  | (EntryBase & {
      readonly type: 'TOOL_EXECUTING';
      readonly toolCallId: ToolCallId;
      readonly sideEffectKey: SideEffectKey;
      readonly safety: ToolSafety;
      /** Fingerprints of files the tool intends to touch, taken before it runs. */
      readonly preState: readonly FileFingerprint[];
      /**
       * For file writes, the fingerprint the file should have afterwards.
       * Lets recovery detect a completed-but-unrecorded write. Null when the
       * post-state is not predictable (e.g. terminal commands).
       */
      readonly expectedPostState: readonly FileFingerprint[] | null;
    })
  /** The tool finished and its result is durable. */
  | (EntryBase & {
      readonly type: 'TOOL_COMPLETED';
      readonly toolCallId: ToolCallId;
      readonly sideEffectKey: SideEffectKey;
      readonly ok: boolean;
      readonly resultSummary: string;
      readonly postState: readonly FileFingerprint[];
    })
  /**
   * Recovery concluded the effect had already landed and synthesized a result
   * instead of re-running it. Recorded separately from TOOL_COMPLETED so the
   * timeline can show that an inference was made.
   */
  | (EntryBase & {
      readonly type: 'TOOL_RECONCILED';
      readonly toolCallId: ToolCallId;
      readonly sideEffectKey: SideEffectKey;
      readonly evidence: string;
    })
  /** The model turn completed cleanly. */
  | (EntryBase & {
      readonly type: 'MODEL_RESPONSE_COMPLETED';
      readonly model: ModelRef;
      readonly reason: StopReason;
      readonly text: string;
    })
  /** Something failed. `errorClass` drives the recovery policy. */
  | (EntryBase & {
      readonly type: 'FAILED';
      readonly errorClass: ErrorClass;
      /** Redacted message. Must never contain credential material. */
      readonly message: string;
      readonly hadStreamedTokens: boolean;
    })
  /** Recovery is in progress; records the decision that was taken. */
  | (EntryBase & {
      readonly type: 'RECOVERING';
      readonly decision: string;
    })
  /** The task moved to a different model or credential. */
  | (EntryBase & {
      readonly type: 'PROVIDER_SWITCHED';
      readonly from: ModelRef;
      readonly to: ModelRef;
      readonly reason: string;
    })
  | (EntryBase & {
      readonly type: 'ESCALATED';
      readonly question: string;
      readonly sideEffectKey: SideEffectKey | null;
    })
  /** The model proposed an architectural implementation plan. */
  | (EntryBase & {
      readonly type: 'PLAN_PROPOSED';
      readonly title: string;
      readonly planMarkdown: string;
    })
  /** Terminal states. */
  | (EntryBase & { readonly type: 'TASK_DONE' })
  | (EntryBase & { readonly type: 'TASK_ABANDONED'; readonly reason: string });

export type LedgerEntryType = LedgerEntry['type'];

/**
 * Computes the deterministic side-effect fingerprint for a tool call.
 *
 * Determinism is essential: recovery recomputes this from the ledger and must
 * arrive at the identical value. Object keys are therefore sorted so that
 * argument property order cannot change the result.
 *
 * `stepId` is included so the *same* command requested at two different points
 * in a task is treated as two distinct effects. Without it, a legitimate
 * "run the tests again" would be mistaken for a duplicate.
 */
export function computeSideEffectKey(
  stepId: StepId,
  toolName: string,
  args: unknown,
): SideEffectKey {
  const canonical = canonicalJson(args);
  return createHash('sha256')
    .update(stepId)
    .update('\u0000')
    .update(toolName)
    .update('\u0000')
    .update(canonical)
    .digest('hex') as SideEffectKey;
}

/** JSON serialization with deterministic key ordering. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}
