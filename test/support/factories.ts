/**
 * Test fixtures for building ledger histories.
 *
 * Tests describe interrupted states declaratively, because the value of the
 * recovery tests is in covering the *matrix* of states; any boilerplate per
 * case makes that matrix harder to read and therefore easier to leave gaps in.
 */
import type { FileFingerprint, LedgerEntry } from '../../src/continuity/entries.js';
import type { WorkspaceProbe } from '../../src/recovery/replay.js';
import type {
  AttemptId,
  SideEffectKey,
  StepId,
  TaskId,
  ToolCallId,
} from '../../src/core/types.js';

export const TASK = 'task-1' as TaskId;
export const STEP = 'step-1' as StepId;
export const ATTEMPT = 'attempt-1' as AttemptId;
export const CALL = 'call-1' as ToolCallId;
export const KEY = 'sek-1' as SideEffectKey;

export const stepId = (s: string): StepId => s as StepId;
export const callId = (s: string): ToolCallId => s as ToolCallId;
export const sekId = (s: string): SideEffectKey => s as SideEffectKey;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An entry without the fields the fixture fills in. */
export type EntryDraft = DistributiveOmit<
  LedgerEntry,
  'taskId' | 'attemptId' | 'stepId' | 'seq' | 'at'
> & {
  /** Override when a test needs more than one step. */
  readonly stepId?: StepId;
};

/** Builds a well-formed history: shared task ids, ascending `seq` and `at`. */
export function history(...drafts: readonly EntryDraft[]): LedgerEntry[] {
  return drafts.map(
    (draft, i) =>
      ({
        taskId: TASK,
        stepId: STEP,
        attemptId: ATTEMPT,
        ...draft,
        seq: i,
        at: new Date(Date.UTC(2026, 0, 1) + i * 1_000).toISOString(),
      }) as LedgerEntry,
  );
}

/** A fingerprint literal. `null` means "the file does not exist". */
export function fp(path: string, sha256: string | null): FileFingerprint {
  return { path, sha256, sizeBytes: sha256 === null ? null : 42 };
}

/**
 * An in-memory workspace. Keys are paths, values are content hashes; a missing
 * key means the file is absent, which is exactly what the real probe reports.
 */
export class StubProbe implements WorkspaceProbe {
  /** Paths queried, in order. Lets tests assert the probe is actually consulted. */
  readonly queried: string[] = [];

  constructor(private readonly state: Readonly<Record<string, string>> = {}) {}

  async fingerprint(path: string): Promise<FileFingerprint> {
    this.queried.push(path);
    const sha = this.state[path];
    return fp(path, sha ?? null);
  }
}
