/**
 * The recovery log: what happened to this task, and who was doing the work.
 *
 * This is the surface for CodeRelay's actual differentiator. Everything else in
 * the interface answers "what is the agent doing"; this answers "what went
 * wrong, what did CodeRelay do about it, and did the task survive".
 *
 * It is a projection of the ledger, like the timeline — not a second account of
 * events kept alongside it. That matters for the same reason it mattered there:
 * a log that could disagree with what a resumed task would act on is worse than
 * no log, because it would be believed.
 *
 * ## What is deliberately not here
 *
 * **Checkpoints are not interleaved.** A checkpoint is a git ref, and
 * `CheckpointStore.list()` can prove it exists — but a `Checkpoint` carries no
 * timestamp, so there is no honest way to place one *between* two ledger
 * entries. Guessing an ordering from labels would put an invented fact in the
 * middle of a log whose whole value is that every line is true. So the count is
 * reported as a fact about the task, and the sequence is left to the ledger.
 *
 * **Streaming is collapsed.** A model that runs twenty turns produces twenty
 * `STREAMING` entries, and twenty "Claude is working" lines would bury the four
 * lines that matter. One line is emitted when the *worker changes* — a
 * different model, a different key, or the first turn after a failure — which
 * is exactly when a reader needs to be told who is doing the work now.
 *
 * **A cancellation is not a failure.** The loop records both as
 * `TASK_ABANDONED`; the reason string separates "you pressed stop" from
 * "CodeRelay gave up", and they must never read alike.
 */
import type { LedgerEntry } from '../../continuity/entries.js';
import type { ModelRef } from '../../core/types.js';
import { describeDecisionKind, explainErrorClass } from './wording.js';

/** What kind of thing happened. Drives the glyph and the tone. */
export type RecoveryKind =
  | 'working'
  | 'failed'
  | 'recovering'
  | 'switched'
  | 'escalated'
  | 'completed'
  | 'cancelled'
  | 'abandoned';

export type RecoveryTone = 'normal' | 'problem' | 'ok' | 'muted';

/** One line of the log. Every field is a finished display string. */
export interface RecoveryEvent {
  readonly id: string;
  /** Local wall-clock time, `HH:MM`. Empty when the entry carried no timestamp. */
  readonly time: string;
  readonly kind: RecoveryKind;
  readonly tone: RecoveryTone;
  /** A single character. */
  readonly glyph: string;
  /** The headline, e.g. "Rate limited" or "claude-sonnet-4 → gpt-5". */
  readonly label: string;
  /** Supporting sentence, or null when the label says everything. */
  readonly detail: string | null;
  /** The whole line as one sentence, for a screen reader. */
  readonly spoken: string;
}

export interface RecoveryLog {
  readonly events: readonly RecoveryEvent[];
  /**
   * How many times the task moved to a different model.
   *
   * The headline number: "this task survived 3 provider failures" is the claim
   * CodeRelay exists to be able to make.
   */
  readonly switchCount: number;
  /** How many failures were recorded, whatever was done about them. */
  readonly failureCount: number;
  /** Distinct models that did work on this task, in the order they appeared. */
  readonly modelsUsed: readonly string[];
  /**
   * Checkpoints proved to exist by git, or `null` when it could not be asked.
   *
   * `null` and `0` are different answers — "not a git repository" is not "no
   * snapshots were taken" — and the view must not render them alike.
   */
  readonly checkpointCount: number | null;
}

export interface RecoveryLogInput {
  readonly entries: readonly LedgerEntry[];
  /**
   * Number of checkpoints from `CheckpointStore.list()`, or null when the
   * workspace is not a repository or git could not be reached.
   */
  readonly checkpointCount?: number | null;
}

const GLYPHS: Record<RecoveryKind, string> = {
  working: '◆',
  failed: '✗',
  recovering: '↻',
  switched: '⇄',
  escalated: '?',
  completed: '✓',
  cancelled: '□',
  abandoned: '✗',
};

const TONES: Record<RecoveryKind, RecoveryTone> = {
  working: 'normal',
  failed: 'problem',
  recovering: 'normal',
  switched: 'normal',
  escalated: 'problem',
  completed: 'ok',
  cancelled: 'muted',
  abandoned: 'problem',
};

/**
 * `HH:MM` in the viewer's local time.
 *
 * Returns an empty string rather than a placeholder when the timestamp cannot
 * be read: a log line with no time is honest, and one reading `--:--` or
 * `00:00` states a time nobody recorded.
 */
export function clockTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  const hours = `${parsed.getHours()}`.padStart(2, '0');
  const minutes = `${parsed.getMinutes()}`.padStart(2, '0');
  return `${hours}:${minutes}`;
}

function modelName(model: ModelRef): string {
  return model.modelId;
}

/**
 * Whether a `TASK_ABANDONED` reason means the user stopped it.
 *
 * Matched against the string the loop writes. Kept as a single predicate so the
 * distinction lives in one place: presenting a deliberate stop as a failure is
 * the sort of thing that makes a user distrust every other line in the log.
 */
function isCancellation(reason: string): boolean {
  return /cancelled by the user/i.test(reason);
}

/**
 * Build the log.
 *
 * Pure: same entries in, same lines out. That is what lets the wording be
 * asserted exactly rather than eyeballed in a running editor.
 */
export function buildRecoveryLog(input: RecoveryLogInput): RecoveryLog {
  const events: RecoveryEvent[] = [];
  const modelsUsed: string[] = [];
  let switchCount = 0;
  let failureCount = 0;

  // Who is currently doing the work, so `STREAMING` can be collapsed to the
  // moments the answer changes.
  let currentWorker: string | null = null;
  // Set by a failure so the next turn announces who picked the task back up,
  // even when that is the same model retrying.
  let announceNext = false;

  for (const entry of input.entries) {
    const time = clockTime(entry.at);
    const id = `recovery-${entry.seq}`;

    switch (entry.type) {
      case 'STREAMING': {
        const worker = `${modelName(entry.model)}\0${entry.credentialId}`;
        if (!modelsUsed.includes(modelName(entry.model))) {
          modelsUsed.push(modelName(entry.model));
        }
        if (worker === currentWorker && !announceNext) {
          break;
        }
        const resumed = announceNext;
        currentWorker = worker;
        announceNext = false;
        events.push({
          id,
          time,
          kind: 'working',
          tone: TONES.working,
          glyph: GLYPHS.working,
          label: modelName(entry.model),
          detail: resumed ? 'picked the task up' : 'started work',
          spoken: `At ${time}, ${modelName(entry.model)} ${
            resumed ? 'picked the task up' : 'started work'
          }.`,
        });
        break;
      }

      case 'FAILED': {
        failureCount += 1;
        announceNext = true;
        const explained = explainErrorClass(entry.errorClass);
        // The recorded message is already redacted by the classifier, but the
        // label stays the short phrase: a provider's raw text is not something
        // to headline a log line with.
        events.push({
          id,
          time,
          kind: 'failed',
          tone: TONES.failed,
          glyph: GLYPHS.failed,
          label: explained.short,
          detail: entry.hadStreamedTokens
            ? 'partial output had already arrived'
            : null,
          spoken: `At ${time}, the request failed: ${explained.title}.`,
        });
        break;
      }

      case 'RECOVERING': {
        events.push({
          id,
          time,
          kind: 'recovering',
          tone: TONES.recovering,
          glyph: GLYPHS.recovering,
          label: describeDecisionKind(entry.decision),
          detail: null,
          spoken: `At ${time}, CodeRelay responded: ${describeDecisionKind(
            entry.decision,
          ).toLowerCase()}.`,
        });
        break;
      }

      case 'PROVIDER_SWITCHED': {
        switchCount += 1;
        announceNext = true;
        const from = modelName(entry.from);
        const to = modelName(entry.to);
        events.push({
          id,
          time,
          kind: 'switched',
          tone: TONES.switched,
          glyph: GLYPHS.switched,
          label: `${from} → ${to}`,
          detail: entry.reason,
          spoken: `At ${time}, the task moved from ${from} to ${to}. ${entry.reason}`,
        });
        break;
      }

      case 'ESCALATED': {
        events.push({
          id,
          time,
          kind: 'escalated',
          tone: TONES.escalated,
          glyph: GLYPHS.escalated,
          label: 'Waiting for you',
          detail: entry.question,
          spoken: `At ${time}, CodeRelay needed a decision: ${entry.question}`,
        });
        break;
      }

      case 'TASK_DONE': {
        events.push({
          id,
          time,
          kind: 'completed',
          tone: TONES.completed,
          glyph: GLYPHS.completed,
          label: 'Task complete',
          detail: null,
          spoken: `At ${time}, the task completed.`,
        });
        break;
      }

      case 'TASK_ABANDONED': {
        const cancelled = isCancellation(entry.reason);
        const kind: RecoveryKind = cancelled ? 'cancelled' : 'abandoned';
        events.push({
          id,
          time,
          kind,
          tone: TONES[kind],
          glyph: GLYPHS[kind],
          label: cancelled ? 'Stopped by you' : 'CodeRelay stopped the task',
          detail: cancelled ? null : entry.reason,
          spoken: cancelled
            ? `At ${time}, you stopped the task.`
            : `At ${time}, CodeRelay stopped the task: ${entry.reason}`,
        });
        break;
      }

      default:
        // Every other entry type is ordinary progress and belongs in the
        // timeline, not here. Listing them explicitly rather than filtering
        // would make this switch a second copy of the timeline projection.
        break;
    }
  }

  return {
    events,
    switchCount,
    failureCount,
    modelsUsed,
    checkpointCount: input.checkpointCount ?? null,
  };
}

/**
 * A one-line summary for the panel header.
 *
 * Returns `null` when nothing worth summarising happened — a task that ran
 * cleanly on one model needs no recovery headline, and manufacturing one
 * ("0 recoveries") would draw attention to the absence of a problem.
 */
export function summarizeRecovery(log: RecoveryLog): string | null {
  if (log.failureCount === 0 && log.switchCount === 0) {
    return null;
  }

  const parts: string[] = [];
  parts.push(log.failureCount === 1 ? '1 failure' : `${log.failureCount} failures`);
  if (log.switchCount > 0) {
    parts.push(
      log.switchCount === 1 ? '1 model switch' : `${log.switchCount} model switches`,
    );
  }
  if (log.modelsUsed.length > 1) {
    parts.push(`${log.modelsUsed.length} models`);
  }
  return `Survived ${parts.join(' · ')}`;
}
