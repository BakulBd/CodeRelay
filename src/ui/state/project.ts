/**
 * Projection: a ledger becomes something a person can read.
 *
 * This is the only place that decides what the UI *says* about a task, and it is
 * a pure function of the entries plus two facts the ledger cannot know (whether
 * the task is running in this window, and the current clock). That purity is the
 * point: every claim the interface makes is asserted in `node --test`, with no
 * extension host.
 *
 * Three rules shape the output, and each one exists because the alternative
 * would mislead:
 *
 * 1. **One card per operation, not one card per ledger entry.** A single tool
 *    call is written to the ledger three or four times — requested, executing,
 *    then completed or reconciled — because that ordering is what makes recovery
 *    possible. Rendering those as four rows would present bookkeeping as
 *    activity. They are merged into one node whose *status* advances, keyed by
 *    `toolCallId` so the view can patch it in place rather than re-render.
 * 2. **Observed and inferred never render the same.** `TOOL_COMPLETED` is a tool
 *    reporting its own result; `TOOL_RECONCILED` is CodeRelay concluding from
 *    file fingerprints that an interrupted write had already landed. The second
 *    carries `provenance: 'inferred'` and the view is required to label it.
 * 3. **Absent is not zero.** Token usage is only observable on a live stream and
 *    is deliberately not persisted, so a projection of a finished ledger reports
 *    `null` rather than `0`.
 */
import type { FileFingerprint, LedgerEntry } from '../../continuity/entries.js';
import type { ModelRef, ToolCallId, ToolSafety } from '../../core/types.js';

/**
 * What is true of a task right now.
 *
 * `stopped` is separated from `failed` because the ledger records a user
 * cancellation as `TASK_ABANDONED` — correct for the ledger, since the task did
 * stop, but presenting "you pressed stop" and "CodeRelay gave up" identically
 * would misattribute the decision.
 *
 * `awaiting` is not a failure either: an escalated task is parked on a question,
 * and the whole design treats that as a legitimate resting state.
 */
export type TaskStatus =
  | 'empty'
  | 'running'
  | 'awaiting'
  | 'interrupted'
  | 'completed'
  | 'stopped'
  | 'failed';

/** How a tool card reads. */
export type ToolStatus = 'pending' | 'running' | 'ok' | 'failed' | 'adopted';

/** Whether CodeRelay saw something, or worked it out. */
export type Provenance = 'observed' | 'inferred';

/** One row in the execution timeline. */
export type TimelineNode =
  | {
      readonly kind: 'objective';
      readonly id: string;
      readonly at: string;
      readonly text: string;
    }
  | {
      readonly kind: 'turn';
      readonly id: string;
      readonly at: string;
      readonly model: ModelRef;
      /** Null until the turn ends. */
      readonly stopReason: 'stop' | 'tool_use' | 'length' | 'truncated' | null;
      /** Assistant text, present once the turn completed. */
      readonly text: string | null;
      /** Characters streamed so far, for a turn still in flight. */
      readonly streamedChars: number | null;
      readonly done: boolean;
    }
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly at: string;
      readonly toolName: string;
      readonly safety: ToolSafety;
      readonly status: ToolStatus;
      /** Workspace paths the call touches. Empty for a call that touches none. */
      readonly targets: readonly string[];
      /** Result, evidence, or error. Null while still pending. */
      readonly summary: string | null;
      readonly provenance: Provenance;
      readonly durationMs: number | null;
      /** True when the outcome could not be predicted, i.e. an ambiguous restart asks. */
      readonly unpredictable: boolean;
    }
  | {
      readonly kind: 'failure';
      readonly id: string;
      readonly at: string;
      readonly errorClass: string;
      readonly message: string;
      readonly hadStreamedTokens: boolean;
    }
  | {
      readonly kind: 'plan';
      readonly id: string;
      readonly at: string;
      readonly title: string;
      readonly planMarkdown: string;
    }
  | {
      readonly kind: 'recovery';
      readonly id: string;
      readonly at: string;
      readonly decision: string;
    }
  | {
      readonly kind: 'switch';
      readonly id: string;
      readonly at: string;
      readonly from: ModelRef;
      readonly to: ModelRef;
      readonly reason: string;
    }
  | {
      readonly kind: 'escalation';
      readonly id: string;
      readonly at: string;
      readonly question: string;
    }
  | {
      readonly kind: 'terminal';
      readonly id: string;
      readonly at: string;
      readonly outcome: 'done' | 'stopped' | 'abandoned';
      readonly reason: string | null;
    };

export type ChangeKind = 'added' | 'modified' | 'deleted';

/** A file this task changed, as evidenced by recorded fingerprints. */
export interface FileChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly bytesBefore: number | null;
  readonly bytesAfter: number | null;
  /**
   * `inferred` when the only evidence is a reconciliation — recovery concluded
   * the write had landed rather than the tool reporting it.
   */
  readonly provenance: Provenance;
}

/** Everything the task header displays. */
export interface TaskHeader {
  readonly title: string;
  readonly status: TaskStatus;
  readonly model: ModelRef | null;
  readonly elapsedMs: number | null;
  readonly turns: number;
  readonly attempts: number;
  readonly filesChanged: number;
  readonly lastActivity: string | null;
  /** Null unless a live stream reported usage; never defaulted to zero. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

export interface TaskProjection {
  readonly header: TaskHeader;
  readonly nodes: readonly TimelineNode[];
  readonly changes: readonly FileChange[];
  /** The unanswered question, when the task is parked on one. */
  readonly pendingQuestion: string | null;
  /** The newest failure, for the recovery panel. */
  readonly lastFailure: { readonly errorClass: string; readonly message: string } | null;
}

export interface ProjectOptions {
  /** True when this window is actively running the task. */
  readonly live?: boolean;
  readonly now?: number;
  /** Usage observed on the live stream. Absent for a projection of history. */
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly costUsd?: number | null;
  /** Newest nodes to keep. Older ones are dropped rather than rendered. */
  readonly maxNodes?: number;
}

/**
 * Timeline nodes kept by default.
 *
 * A long task can produce thousands of entries, and a DOM that grows without
 * bound is the failure mode Phase 16 of the design exists to prevent. The
 * newest are kept because that is where a running task's attention is; the whole
 * ledger remains available in the text view and the static timeline panel.
 */
const DEFAULT_MAX_NODES = 300;

function isTerminal(entry: LedgerEntry): boolean {
  return entry.type === 'TASK_DONE' || entry.type === 'TASK_ABANDONED';
}

/**
 * The wording the loop uses when the user cancels.
 *
 * Matched rather than inferred from a flag because the ledger has no flag: the
 * loop records a cancellation as `TASK_ABANDONED` with exactly this reason. A
 * mismatch degrades the status to `failed`, which is the safe direction — it
 * over-reports a problem rather than hiding one.
 */
const CANCEL_REASON = 'Cancelled by the user.';

/** Paths in a fingerprint list, deduplicated, order preserved. */
function pathsOf(state: readonly FileFingerprint[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of state) {
    if (!seen.has(f.path)) {
      seen.add(f.path);
      out.push(f.path);
    }
  }
  return out;
}

/** Milliseconds between two ISO stamps, or null if either is unusable. */
function between(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) {
    return null;
  }
  return to - from;
}

/** Mutable accumulator for one tool call spanning several entries. */
interface ToolAccumulator {
  node: Extract<TimelineNode, { kind: 'tool' }>;
  /** Index in the output array, so a later entry can patch in place. */
  index: number;
  startedAt: string | null;
}

/** Mutable accumulator for one model turn spanning several entries. */
interface TurnAccumulator {
  node: Extract<TimelineNode, { kind: 'turn' }>;
  index: number;
}

/**
 * Net file changes, from the fingerprints already in the ledger.
 *
 * The comparison is *first* recorded pre-state against *last* recorded
 * post-state, so a file written twice counts once, and a file created and then
 * deleted correctly reports as neither. Nothing here reads the workspace: these
 * are the facts the ledger captured at the time, which is what makes the list
 * meaningful after a crash.
 */
export function projectChanges(entries: readonly LedgerEntry[]): readonly FileChange[] {
  interface Track {
    before: FileFingerprint | null;
    after: FileFingerprint | null;
    provenance: Provenance;
  }
  const tracks = new Map<string, Track>();
  const executing = new Map<ToolCallId, Extract<LedgerEntry, { type: 'TOOL_EXECUTING' }>>();

  const track = (path: string): Track => {
    let found = tracks.get(path);
    if (found === undefined) {
      found = { before: null, after: null, provenance: 'observed' };
      tracks.set(path, found);
    }
    return found;
  };


  for (const entry of entries) {
    if (entry.type === 'TOOL_EXECUTING') {
      executing.set(entry.toolCallId, entry);
      for (const fingerprint of entry.preState) {
        const found = track(fingerprint.path);
        // Only the earliest pre-state is the original: a second write to the
        // same file starts from the first write's result, not from the original.
        found.before ??= fingerprint;
      }
      continue;
    }

    if (entry.type === 'TOOL_COMPLETED') {
      if (!entry.ok) {
        // A failed tool may still have changed the file — `postState` is
        // captured either way — so it is recorded, not skipped.
        for (const fingerprint of entry.postState) {
          track(fingerprint.path).after = fingerprint;
        }
        continue;
      }
      for (const fingerprint of entry.postState) {
        track(fingerprint.path).after = fingerprint;
      }
      continue;
    }

    if (entry.type === 'TOOL_RECONCILED') {
      // The tool never reported, so the only available end state is what the
      // call *predicted*, which recovery then verified against the workspace.
      const started = executing.get(entry.toolCallId);
      for (const fingerprint of started?.expectedPostState ?? []) {
        const found = track(fingerprint.path);
        found.after = fingerprint;
        found.provenance = 'inferred';
      }
    }
  }

  const out: FileChange[] = [];
  for (const [path, t] of tracks) {
    const beforeSha = t.before?.sha256 ?? null;
    const afterSha = t.after?.sha256 ?? null;

    if (t.after === null) {
      // Recorded as touched but never settled. Not a change yet.
      continue;
    }
    if (beforeSha === afterSha) {
      continue;
    }

    const kind: ChangeKind =
      beforeSha === null ? 'added' : afterSha === null ? 'deleted' : 'modified';

    out.push({
      path,
      kind,
      bytesBefore: t.before?.sizeBytes ?? null,
      bytesAfter: t.after.sizeBytes,
      provenance: t.provenance,
    });
  }

  // Stable, and grouped the way a reviewer reads: additions, edits, deletions.
  const rank: Record<ChangeKind, number> = { added: 0, modified: 1, deleted: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.path.localeCompare(b.path));
}

/**
 * Derives the status of a task from its last meaningful entry.
 *
 * `live` wins over everything except a terminal entry, because a task this
 * window is currently running is running whatever the ledger's last line says —
 * the ledger lags the loop by design, since entries are written ahead of the
 * actions they describe.
 */
export function projectStatus(
  entries: readonly LedgerEntry[],
  live: boolean,
): TaskStatus {
  const last = entries[entries.length - 1];
  if (last === undefined) {
    return live ? 'running' : 'empty';
  }
  if (last.type === 'TASK_DONE') {
    return 'completed';
  }
  if (last.type === 'TASK_ABANDONED') {
    return last.reason === CANCEL_REASON ? 'stopped' : 'failed';
  }
  if (live) {
    return 'running';
  }
  if (last.type === 'ESCALATED') {
    return 'awaiting';
  }
  return 'interrupted';
}

/**
 * Builds the whole view model for one task.
 *
 * Written as a single pass with keyed accumulators rather than several filters,
 * because the merging in rule 1 above needs to patch a node that an earlier
 * entry created, and because one pass over a large ledger is the difference
 * between a responsive panel and a stalled one.
 */
export function projectTask(
  entries: readonly LedgerEntry[],
  options: ProjectOptions = {},
): TaskProjection {
  const live = options.live === true;
  const now = options.now ?? Date.now();
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

  const nodes: TimelineNode[] = [];
  const tools = new Map<ToolCallId, ToolAccumulator>();
  const turns = new Map<string, TurnAccumulator>();

  let objective: string | null = null;
  let model: ModelRef | null = null;
  let attempts = 0;
  let lastFailure: { errorClass: string; message: string } | null = null;
  let pendingQuestion: string | null = null;
  const steps = new Set<string>();

  for (const entry of entries) {
    steps.add(entry.stepId);

    switch (entry.type) {
      case 'TASK_STARTED': {
        objective = entry.objective;
        nodes.push({
          kind: 'objective',
          id: `objective-${entry.seq}`,
          at: entry.at,
          text: entry.objective,
        });
        break;
      }

      case 'STREAMING': {
        attempts += 1;
        model = entry.model;
        const node: Extract<TimelineNode, { kind: 'turn' }> = {
          kind: 'turn',
          id: `turn-${entry.attemptId}`,
          at: entry.at,
          model: entry.model,
          stopReason: null,
          text: null,
          streamedChars: null,
          done: false,
        };
        turns.set(entry.attemptId, { node, index: nodes.length });
        nodes.push(node);
        break;
      }

      case 'STREAM_PROGRESS': {
        // Folded into the turn rather than given a row of its own: a progress
        // entry is a recovery hint, not an event the user acted on, and one row
        // per few hundred characters of output would bury everything else.
        const turn = turns.get(entry.attemptId);
        if (turn !== undefined) {
          turn.node = { ...turn.node, streamedChars: entry.textSoFar.length };
          nodes[turn.index] = turn.node;
        }
        break;
      }

      case 'MODEL_RESPONSE_COMPLETED': {
        model = entry.model;
        const turn = turns.get(entry.attemptId);
        const patched = {
          stopReason: entry.reason,
          text: entry.text === '' ? null : entry.text,
          done: true,
        } as const;
        if (turn === undefined) {
          // A completion with no matching STREAMING entry: possible when a
          // ledger was truncated at the head, or written by another build.
          // Recorded as its own turn rather than dropped.
          nodes.push({
            kind: 'turn',
            id: `turn-${entry.attemptId}`,
            at: entry.at,
            model: entry.model,
            streamedChars: null,
            ...patched,
          });
          break;
        }
        turn.node = { ...turn.node, ...patched };
        nodes[turn.index] = turn.node;
        break;
      }

      case 'TOOL_REQUESTED': {
        const node: Extract<TimelineNode, { kind: 'tool' }> = {
          kind: 'tool',
          id: `tool-${entry.toolCallId}`,
          at: entry.at,
          toolName: entry.toolName,
          safety: entry.safety,
          status: 'pending',
          targets: argumentPaths(entry.args),
          summary: null,
          provenance: 'observed',
          durationMs: null,
          unpredictable: false,
        };
        tools.set(entry.toolCallId, { node, index: nodes.length, startedAt: null });
        nodes.push(node);
        break;
      }

      case 'TOOL_EXECUTING': {
        const acc = tools.get(entry.toolCallId);
        const targets = pathsOf(entry.preState);
        if (acc === undefined) {
          const node: Extract<TimelineNode, { kind: 'tool' }> = {
            kind: 'tool',
            id: `tool-${entry.toolCallId}`,
            at: entry.at,
            toolName: 'unknown tool',
            safety: entry.safety,
            status: 'running',
            targets,
            summary: null,
            provenance: 'observed',
            durationMs: null,
            unpredictable: entry.expectedPostState === null,
          };
          tools.set(entry.toolCallId, { node, index: nodes.length, startedAt: entry.at });
          nodes.push(node);
          break;
        }
        acc.startedAt = entry.at;
        acc.node = {
          ...acc.node,
          status: 'running',
          // The pre-state names the files actually fingerprinted, which is
          // better evidence than the raw arguments guessed at above.
          targets: targets.length > 0 ? targets : acc.node.targets,
          unpredictable: entry.expectedPostState === null,
        };
        nodes[acc.index] = acc.node;
        break;
      }

      case 'TOOL_COMPLETED': {
        const acc = tools.get(entry.toolCallId);
        if (acc === undefined) {
          nodes.push({
            kind: 'tool',
            id: `tool-${entry.toolCallId}`,
            at: entry.at,
            toolName: 'unknown tool',
            safety: 'pure',
            status: entry.ok ? 'ok' : 'failed',
            targets: pathsOf(entry.postState),
            summary: entry.resultSummary,
            provenance: 'observed',
            durationMs: null,
            unpredictable: false,
          });
          break;
        }
        acc.node = {
          ...acc.node,
          status: entry.ok ? 'ok' : 'failed',
          summary: entry.resultSummary,
          durationMs: acc.startedAt === null ? null : between(acc.startedAt, entry.at),
        };
        nodes[acc.index] = acc.node;
        break;
      }

      case 'TOOL_RECONCILED': {
        const acc = tools.get(entry.toolCallId);
        const patch = {
          status: 'adopted' as const,
          summary: entry.evidence,
          // The defining property of this entry: nothing observed the effect.
          provenance: 'inferred' as const,
        };
        if (acc === undefined) {
          nodes.push({
            kind: 'tool',
            id: `tool-${entry.toolCallId}`,
            at: entry.at,
            toolName: 'unknown tool',
            safety: 'idempotent',
            targets: [],
            durationMs: null,
            unpredictable: false,
            ...patch,
          });
          break;
        }
        acc.node = { ...acc.node, ...patch };
        nodes[acc.index] = acc.node;
        break;
      }

      case 'FAILED': {
        lastFailure = { errorClass: entry.errorClass, message: entry.message };
        nodes.push({
          kind: 'failure',
          id: `failure-${entry.seq}`,
          at: entry.at,
          errorClass: entry.errorClass,
          message: entry.message,
          hadStreamedTokens: entry.hadStreamedTokens,
        });
        break;
      }

      case 'RECOVERING': {
        nodes.push({
          kind: 'recovery',
          id: `recovery-${entry.seq}`,
          at: entry.at,
          decision: entry.decision,
        });
        break;
      }

      case 'PLAN_PROPOSED': {
        nodes.push({
          kind: 'plan',
          id: `plan-${entry.seq}`,
          at: entry.at,
          title: entry.title,
          planMarkdown: entry.planMarkdown,
        });
        break;
      }

      case 'PROVIDER_SWITCHED': {
        model = entry.to;
        nodes.push({
          kind: 'switch',
          id: `switch-${entry.seq}`,
          at: entry.at,
          from: entry.from,
          to: entry.to,
          reason: entry.reason,
        });
        break;
      }

      case 'ESCALATED': {
        pendingQuestion = entry.question;
        nodes.push({
          kind: 'escalation',
          id: `escalation-${entry.seq}`,
          at: entry.at,
          question: entry.question,
        });
        break;
      }

      case 'TASK_DONE': {
        nodes.push({
          kind: 'terminal',
          id: `terminal-${entry.seq}`,
          at: entry.at,
          outcome: 'done',
          reason: null,
        });
        break;
      }

      case 'TASK_ABANDONED': {
        nodes.push({
          kind: 'terminal',
          id: `terminal-${entry.seq}`,
          at: entry.at,
          outcome: entry.reason === CANCEL_REASON ? 'stopped' : 'abandoned',
          reason: entry.reason,
        });
        break;
      }
    }
  }

  const first = entries[0];
  const last = entries[entries.length - 1];
  const status = projectStatus(entries, live);
  const changes = projectChanges(entries);

  // A running task's clock runs to now; a finished one stops at its last entry,
  // so reopening a completed task does not show its duration still growing.
  const elapsedMs =
    first === undefined
      ? null
      : status === 'running'
        ? between(first.at, new Date(now).toISOString())
        : last === undefined
          ? null
          : between(first.at, last.at);

  // A question is only pending while nothing has settled it. Any later entry
  // means the task moved on, and a stale prompt would invite the user to answer
  // something that is no longer being asked.
  if (pendingQuestion !== null && last !== undefined) {
    if (last.type !== 'ESCALATED') {
      pendingQuestion = null;
    }
  }

  return {
    header: {
      title: objective ?? 'Untitled task',
      status,
      model,
      elapsedMs,
      turns: steps.size,
      attempts,
      filesChanged: changes.length,
      lastActivity: last?.at ?? null,
      inputTokens: options.inputTokens ?? null,
      outputTokens: options.outputTokens ?? null,
      costUsd: options.costUsd ?? null,
    },
    // Truncated from the head: the newest activity is what a running task needs
    // on screen, and dropping the oldest keeps terminal state visible.
    nodes: nodes.length > maxNodes ? nodes.slice(nodes.length - maxNodes) : nodes,
    changes,
    pendingQuestion,
    lastFailure: last !== undefined && isTerminal(last) && status === 'completed' ? null : lastFailure,
  };
}

/**
 * Best-effort target paths from raw tool arguments.
 *
 * Used only for the brief window between `TOOL_REQUESTED` and `TOOL_EXECUTING`,
 * before real fingerprints exist. The arguments come from a model, so nothing is
 * trusted: a non-string `path` yields no target rather than a rendered `[object
 * Object]`.
 */
export function argumentPaths(args: unknown): readonly string[] {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return [];
  }
  const record = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['path', 'file', 'filePath']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') {
      out.push(value);
    }
  }
  return out;
}
