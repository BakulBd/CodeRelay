/**
 * Cross-provider handoff: what the successor model is told.
 *
 * This is the part of failover that is easy to get wrong in a way that looks
 * fine. The tempting implementation is to replay the transcript: take the
 * messages sent to provider A, send them to provider B, continue. That is
 * unsound, and CodeRelay deliberately does not do it:
 *
 *  - **Partial assistant output is not an assistant message.** A turn cut off
 *    mid-sentence never expressed a complete intent. Presenting it as the
 *    model's own prior words invites the successor to continue a thought that
 *    was never finished, and to assume actions were taken that were not.
 *  - **Reasoning is not portable.** Anthropic returns signed thinking blocks;
 *    OpenAI returns reasoning summaries tied to a response id. Neither is
 *    meaningful to the other provider, and forwarding them either fails
 *    validation or silently launders one model's private reasoning into
 *    another's context as if it were fact.
 *  - **Tool-call ids are provider-scoped.** A `tool_use` id from one provider
 *    has no referent in another provider's conversation.
 *
 * So the handoff is a *reconstruction*, not a replay: the objective, the facts
 * established by tools that actually completed, and an explicit statement of
 * where the work stopped. Every element is tagged with how it is known —
 * `observed` for things that happened, `inferred` for conclusions CodeRelay
 * drew — and the renderer must preserve that distinction. A successor model
 * being told "the file was written" when we only inferred it is how a recovery
 * feature causes the corruption it exists to prevent.
 *
 * Building the packet is a pure function of the ledger, so the exact text a
 * successor receives is testable without a provider.
 */
import type { LedgerEntry } from '../continuity/entries.js';
import type { ModelRef, SideEffectKey, ToolCallId } from '../core/types.js';

/** How a fact in the packet is known. Never render these identically. */
export type Provenance = 'observed' | 'inferred';

/** A tool that ran to completion, with its recorded outcome. */
export interface CompletedEffect {
  readonly toolCallId: ToolCallId;
  readonly sideEffectKey: SideEffectKey;
  readonly toolName: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly paths: readonly string[];
  readonly provenance: Provenance;
}

/**
 * A tool whose outcome is not settled.
 *
 * `mayHaveRun` is the distinction that matters. False means the ledger proves
 * execution never began, so the successor may simply do it. True means the
 * effect might already exist, and the successor must not be told to repeat it.
 */
export interface PendingEffect {
  readonly toolCallId: ToolCallId;
  readonly sideEffectKey: SideEffectKey;
  readonly toolName: string;
  readonly args: unknown;
  readonly mayHaveRun: boolean;
}

export interface HandoffPacket {
  readonly objective: string;
  /** Set only when the objective is missing from the ledger. */
  readonly objectiveMissing: boolean;
  readonly from: ModelRef | null;
  readonly to: ModelRef;
  readonly completed: readonly CompletedEffect[];
  readonly pending: readonly PendingEffect[];
  /** Assistant text from turns that finished cleanly, oldest first. */
  readonly narrative: readonly string[];
  /**
   * Text from the turn that was cut off, if any. Held in its own field so it
   * can never be mistaken for a completed assistant message.
   */
  readonly truncatedText: string | null;
  /** Models this task has already run on, in order of first use. */
  readonly priorModels: readonly ModelRef[];
  readonly compactionsApplied: number;
}

export interface HandoffOptions {
  /** Cap on characters of truncated text carried forward. */
  readonly maxTruncatedChars?: number;
  /** Cap on completed effects listed individually before summarising. */
  readonly maxCompletedListed?: number;
}

const DEFAULT_MAX_TRUNCATED_CHARS = 2_000;
const DEFAULT_MAX_COMPLETED_LISTED = 40;

/**
 * Reconstructs the state of a task for a new model.
 *
 * The reasoning, in the order the ledger answers it:
 *
 * 1. What was the user asking for? Without the objective there is no task, and
 *    an absent objective is reported rather than invented.
 * 2. Which tools definitively completed? Those are facts the successor may rely
 *    on, and re-doing them would be a duplicate side effect.
 * 3. Which tools are unsettled, and is re-running each one safe?
 * 4. What did the models say, and where exactly did the last one stop?
 */
export function buildHandoff(
  entries: readonly LedgerEntry[],
  to: ModelRef,
  options: HandoffOptions = {},
): HandoffPacket {
  const maxTruncated = options.maxTruncatedChars ?? DEFAULT_MAX_TRUNCATED_CHARS;
  const maxListed = options.maxCompletedListed ?? DEFAULT_MAX_COMPLETED_LISTED;

  let objective: string | null = null;
  let compactions = 0;

  // Requests are indexed so a completion can recover the tool name and args,
  // which TOOL_COMPLETED does not repeat.
  const requests = new Map<ToolCallId, Extract<LedgerEntry, { type: 'TOOL_REQUESTED' }>>();
  const executing = new Map<ToolCallId, Extract<LedgerEntry, { type: 'TOOL_EXECUTING' }>>();
  const settled = new Set<ToolCallId>();
  const completed: CompletedEffect[] = [];
  const narrative: string[] = [];
  const models: ModelRef[] = [];

  let lastModel: ModelRef | null = null;
  let truncated: string | null = null;

  for (const entry of entries) {
    switch (entry.type) {
      case 'TASK_STARTED':
        objective = entry.objective;
        break;

      case 'STREAMING':
        lastModel = entry.model;
        rememberModel(models, entry.model);
        break;

      case 'STREAM_PROGRESS':
        // Provisional. Superseded the moment the turn completes cleanly.
        truncated = entry.textSoFar;
        break;

      case 'TOOL_REQUESTED':
        requests.set(entry.toolCallId, entry);
        break;

      case 'TOOL_EXECUTING':
        executing.set(entry.toolCallId, entry);
        break;

      case 'TOOL_COMPLETED': {
        settled.add(entry.toolCallId);
        const request = requests.get(entry.toolCallId);
        completed.push({
          toolCallId: entry.toolCallId,
          sideEffectKey: entry.sideEffectKey,
          toolName: request?.toolName ?? 'unknown tool',
          ok: entry.ok,
          summary: entry.resultSummary,
          paths: entry.postState.map((f) => f.path),
          // The tool reported its own result. Nothing is being guessed here.
          provenance: 'observed',
        });
        break;
      }

      case 'TOOL_RECONCILED': {
        settled.add(entry.toolCallId);
        const request = requests.get(entry.toolCallId);
        const executed = executing.get(entry.toolCallId);
        completed.push({
          toolCallId: entry.toolCallId,
          sideEffectKey: entry.sideEffectKey,
          toolName: request?.toolName ?? 'unknown tool',
          ok: true,
          summary: entry.evidence,
          paths: (executed?.expectedPostState ?? []).map((f) => f.path),
          // Recovery concluded this landed from workspace evidence; the tool
          // itself never reported back. The successor must be told which it is.
          provenance: 'inferred',
        });
        break;
      }

      case 'MODEL_RESPONSE_COMPLETED':
        if (entry.reason === 'truncated') {
          // A truncated turn is not a completed one, whatever the entry says
          // about the text it managed to emit.
          truncated = entry.text === '' ? truncated : entry.text;
        } else {
          if (entry.text !== '') {
            narrative.push(entry.text);
          }
          truncated = null;
        }
        lastModel = entry.model;
        rememberModel(models, entry.model);
        break;

      case 'PROVIDER_SWITCHED':
        lastModel = entry.to;
        rememberModel(models, entry.from);
        rememberModel(models, entry.to);
        break;

      case 'RECOVERING':
        if (entry.decision.startsWith('COMPACT_CONTEXT')) {
          compactions += 1;
        }
        break;

      default:
        // FAILED, ESCALATED, TASK_DONE, TASK_ABANDONED carry nothing the
        // successor needs in order to continue the work.
        break;
    }
  }

  const pending: PendingEffect[] = [];
  for (const [toolCallId, request] of requests) {
    if (settled.has(toolCallId)) {
      continue;
    }
    pending.push({
      toolCallId,
      sideEffectKey: request.sideEffectKey,
      toolName: request.toolName,
      args: request.args,
      // TOOL_EXECUTING is durable before the effect runs, so its presence is
      // exactly the "may have run" condition and its absence rules it out.
      mayHaveRun: executing.has(toolCallId),
    });
  }

  return {
    objective: objective ?? 'The original objective was not recorded in the ledger.',
    objectiveMissing: objective === null,
    from: lastModel,
    to,
    completed: completed.slice(-maxListed),
    pending,
    narrative,
    truncatedText: truncated === null ? null : clampTail(truncated, maxTruncated),
    priorModels: models,
    compactionsApplied: compactions,
  };
}

/**
 * Renders the packet as the prompt text the successor model receives.
 *
 * Written as plain prose with explicit headings rather than JSON, because this
 * is read by a language model and the point is that it cannot misread which
 * claims are established and which are not. Where a fact was inferred it says
 * so in the sentence itself, not in a field the model might ignore.
 */
export function renderHandoff(packet: HandoffPacket): string {
  const lines: string[] = [];

  lines.push('# Continuing an interrupted task');
  lines.push('');
  lines.push(
    'You are taking over a coding task that was already in progress on a different ' +
      'model. The transcript is not replayed, because a partial turn is not a statement ' +
      'of intent. What follows is a reconstruction of what is known.',
  );
  lines.push('');

  lines.push('## Objective');
  lines.push(packet.objective);
  if (packet.objectiveMissing) {
    lines.push(
      'Because the objective is unknown, do not take any action with side effects. ' +
        'Ask what the task was.',
    );
  }
  lines.push('');

  lines.push('## Work already completed');
  if (packet.completed.length === 0) {
    lines.push('Nothing has been executed yet. No files have been changed.');
  } else {
    for (const effect of packet.completed) {
      const outcome = effect.ok ? 'succeeded' : 'failed';
      const files = effect.paths.length === 0 ? '' : ` (${effect.paths.join(', ')})`;
      if (effect.provenance === 'observed') {
        lines.push(`- \`${effect.toolName}\`${files} ${outcome}: ${effect.summary}`);
      } else {
        lines.push(
          `- \`${effect.toolName}\`${files} was **not** confirmed by the tool itself. ` +
            `CodeRelay inferred that it had already taken effect: ${effect.summary}. ` +
            'Treat this as likely but unverified.',
        );
      }
    }
    lines.push('');
    lines.push('Do not repeat any of the above. Those effects already exist.');
  }
  lines.push('');

  if (packet.narrative.length > 0) {
    lines.push('## What was explained so far');
    for (const text of packet.narrative) {
      lines.push(text);
    }
    lines.push('');
  }

  if (packet.truncatedText !== null) {
    lines.push('## Output that was cut off');
    lines.push(
      'The previous model was interrupted mid-response. The text below is incomplete and ' +
        'was never finished. It is context only; it is not a decision, and nothing it ' +
        'describes should be assumed to have happened.',
    );
    lines.push('');
    lines.push('```');
    lines.push(packet.truncatedText);
    lines.push('```');
    lines.push('');
  }

  if (packet.pending.length > 0) {
    lines.push('## Unfinished operations');
    for (const effect of packet.pending) {
      if (effect.mayHaveRun) {
        lines.push(
          `- \`${effect.toolName}\` was started and its outcome is unknown. It may or may ` +
            'not have taken effect. Do not run it again; verify the current state first.',
        );
      } else {
        lines.push(
          `- \`${effect.toolName}\` was requested but provably never started, so it still ` +
            'needs to be done.',
        );
      }
    }
    lines.push('');
  }

  lines.push('## How to continue');
  lines.push(
    'Resume from this state. Verify anything you are unsure about by reading the ' +
      'workspace rather than assuming, and prefer asking over repeating an operation ' +
      'that may already have taken effect.',
  );

  return lines.join('\n');
}

/**
 * Keeps the *end* of an overlong string.
 *
 * The tail is the part that matters: it is where the model was when it stopped,
 * and therefore the only part that tells the successor where to pick up.
 */
function clampTail(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `\u2026${text.slice(text.length - maxChars)}`;
}

function rememberModel(seen: ModelRef[], model: ModelRef): void {
  const already = seen.some(
    (m) => m.providerId === model.providerId && m.modelId === model.modelId,
  );
  if (!already) {
    seen.push(model);
  }
}
