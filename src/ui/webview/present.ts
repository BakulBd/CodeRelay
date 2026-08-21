/**
 * Presentation: a projection becomes the exact strings the client paints.
 *
 * Developer-first, ultra-responsive UI model with support for:
 * - Modes (Code, Architect, Ask)
 * - Live context window percentage & cost tracking
 * - Reasoning / thinking traces
 * - Rich tool & command cards
 * - 1-click diffs & checkpoint rewind
 * - Session history & management
 */
import type { ModelRef } from '../../core/types.js';
import {
  baseName,
  formatCost,
  formatDuration,
  formatTokens,
  oneLine,
  plural,
  shortPath,
} from '../state/format.js';
import type {
  FileChange,
  TaskProjection,
  TaskStatus,
  TimelineNode,
} from '../state/project.js';
import type { TaskMode } from './protocol.js';

/** A file path the client renders as a control. */
export interface PathRef {
  readonly label: string;
  readonly path: string;
}

/** How a row reads. Drives the icon colour, and nothing else. */
export type RowTone = 'normal' | 'ok' | 'problem' | 'inferred' | 'running' | 'muted';

/** Command execution details for terminal cards. */
export interface CommandDetails {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string | null;
}

/** One timeline row, fully formatted. */
export interface RowModel {
  readonly id: string;
  readonly tone: RowTone;
  /** A single character. */
  readonly glyph: string;
  readonly label: string;
  readonly target: string | null;
  readonly tag: string | null;
  readonly tagKind: 'inferred' | 'tool' | 'checkpoint' | 'thought' | null;
  /** Right-aligned detail: a duration, a token count, a stop reason. */
  readonly aside: string | null;
  /** Prose shown under the head, always visible. */
  readonly text: string | null;
  /** Long output, collapsed behind a disclosure. */
  readonly body: string | null;
  /** Reasoning / chain-of-thought traces. */
  readonly thinking: string | null;
  /** Command execution details if this is a command tool. */
  readonly commandDetails: CommandDetails | null;
  /** Checkpoint commit if this is a snapshot node. */
  readonly checkpointCommit: string | null;
  readonly paths: readonly PathRef[];
  /** The whole row as one sentence, for a screen reader. */
  readonly spoken: string;
}

export interface HeaderModel {
  readonly status: TaskStatus;
  readonly title: string;
  readonly model: ModelRef | null;
  readonly turns: number;
  readonly filesChanged: number;
  readonly elapsedLabel: string | null;
  readonly tokensLabel: string | null;
  readonly costLabel: string | null;
  readonly mode: TaskMode;
  readonly contextPercent: number | null;
  readonly contextWindowLimit: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly soundEnabled: boolean;
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly timeAgo: string;
  readonly turns: number;
  readonly filesChanged: number;
  readonly isCurrent: boolean;
}

export interface FailureModel {
  readonly title: string;
  readonly message: string;
  /** What the ledger proves already happened. Never "no progress". */
  readonly facts: readonly string[];
}

export interface EmptyAction {
  readonly label: string;
  readonly command: string;
  readonly primary: boolean;
}

/** Why the composer is disabled. Each has a different fix. */
export type BlockedReason = 'no-folder' | 'no-models' | 'config-error';

/** Everything the client needs for one paint. */
export interface TaskViewModel {
  readonly kind: 'state';
  readonly taskId: string | null;
  readonly header: HeaderModel | null;
  readonly nodes: readonly RowModel[];
  readonly changes: readonly FileChange[];
  readonly sessions: readonly SessionSummary[];
  readonly mode: TaskMode;
  readonly soundEnabled: boolean;
  readonly pendingQuestion: string | null;
  readonly lastFailure: FailureModel | null;
  readonly live: boolean;
  readonly blocked: BlockedReason | null;
  readonly modelLabel: string;
  readonly modelTooltip: string;
  readonly promptPlaceholder: string;
  readonly emptyTitle: string;
  readonly emptyBody: string;
  readonly emptyActions: readonly EmptyAction[];
}

export interface PresentOptions {
  readonly taskId: string | null;
  readonly projection: TaskProjection | null;
  readonly live: boolean;
  readonly blocked: BlockedReason | null;
  readonly selectedModel: ModelRef | null;
  readonly activity?: string | null;
  readonly streamTail?: string | null;
  readonly mode?: TaskMode;
  readonly soundEnabled?: boolean;
  readonly sessions?: readonly SessionSummary[];
  readonly contextWindowLimit?: number | null;
}

/** Longest tool output shown inline before the reader has to expand it. */
const BODY_CHARS = 4_000;

export function present(options: PresentOptions): TaskViewModel {
  const { projection } = options;
  const empty = describeEmpty(options);
  const mode = options.mode ?? 'code';
  const soundEnabled = options.soundEnabled ?? true;

  const nodes =
    projection === null
      ? []
      : [
          ...projection.nodes.map(presentRow),
          ...activityRow(options),
        ];

  return {
    kind: 'state',
    taskId: options.taskId,
    header: projection === null ? null : presentHeader(projection, options),
    nodes,
    changes: projection?.changes ?? [],
    sessions: options.sessions ?? [],
    mode,
    soundEnabled,
    pendingQuestion: projection?.pendingQuestion ?? null,
    lastFailure:
      projection === null || projection.lastFailure === null
        ? null
        : describeFailure(projection),
    live: options.live,
    blocked: options.blocked,
    modelLabel:
      options.selectedModel === null ? 'Choose model' : options.selectedModel.modelId,
    modelTooltip:
      options.selectedModel === null
        ? 'Pick which model this task starts on. Failover chooses the rest.'
        : `${options.selectedModel.providerId} / ${options.selectedModel.modelId}`,
    promptPlaceholder:
      options.blocked === null
        ? mode === 'architect'
          ? 'Describe requirements or architectural problem to plan…'
          : mode === 'ask'
            ? 'Ask a question about this codebase…'
            : 'Describe what the agent should do…'
        : 'CodeRelay is not ready yet',
    emptyTitle: empty.title,
    emptyBody: empty.body,
    emptyActions: empty.actions,
  };
}

function presentHeader(projection: TaskProjection, options: PresentOptions): HeaderModel {
  const { header } = projection;
  const input = formatTokens(header.inputTokens);
  const output = formatTokens(header.outputTokens);
  const mode = options.mode ?? 'code';
  const soundEnabled = options.soundEnabled ?? true;

  const limit = options.contextWindowLimit ?? 128_000;
  const totalTokens = (header.inputTokens ?? 0) + (header.outputTokens ?? 0);
  const contextPercent =
    header.inputTokens === null && header.outputTokens === null
      ? null
      : Math.min(100, Math.max(1, Math.round((totalTokens / limit) * 100)));

  return {
    status: header.status,
    title: oneLine(header.title, 200),
    model: header.model,
    turns: header.turns,
    filesChanged: header.filesChanged,
    elapsedLabel: formatDuration(header.elapsedMs),
    tokensLabel:
      input === null && output === null ? null : `${input ?? '\u2014'} in \u00b7 ${output ?? '\u2014'} out`,
    costLabel: formatCost(header.costUsd),
    mode,
    contextPercent,
    contextWindowLimit: limit,
    inputTokens: header.inputTokens,
    outputTokens: header.outputTokens,
    costUsd: header.costUsd,
    soundEnabled,
  };
}

/**
 * A trailing row for work in flight.
 */
function activityRow(options: PresentOptions): RowModel[] {
  if (!options.live) {
    return [];
  }
  const activity = options.activity;
  const tail = options.streamTail;
  if ((activity === null || activity === undefined) && (tail === null || tail === undefined || tail === '')) {
    return [];
  }
  const label = activity ?? 'Working';
  return [
    {
      id: 'activity',
      tone: 'running',
      glyph: '\u25cf',
      label,
      target: null,
      tag: null,
      tagKind: null,
      aside: null,
      text: tail === null || tail === undefined || tail === '' ? null : oneLine(tail, 400),
      body: null,
      thinking: null,
      commandDetails: null,
      checkpointCommit: null,
      paths: [],
      spoken: label,
    },
  ];
}

/** One projection node, formatted. */
export function presentRow(node: TimelineNode): RowModel {
  switch (node.kind) {
    case 'objective':
      return {
        id: node.id,
        tone: 'normal',
        glyph: '\u25c6',
        label: 'Task',
        target: null,
        tag: null,
        tagKind: null,
        aside: null,
        text: node.text,
        body: null,
        thinking: null,
        commandDetails: null,
        checkpointCommit: null,
        paths: [],
        spoken: `Task: ${oneLine(node.text, 200)}`,
      };

    case 'turn':
      return presentTurn(node);

    case 'tool':
      return presentTool(node);

    case 'failure': {
      const explained = explainErrorClass(node.errorClass);
      return {
        id: node.id,
        tone: 'problem',
        glyph: '\u2715',
        label: explained.short,
        target: null,
        tag: null,
        tagKind: null,
        aside: node.hadStreamedTokens ? 'partial output received' : null,
        text: node.message,
        body: null,
        thinking: null,
        commandDetails: null,
        checkpointCommit: null,
        paths: [],
        spoken: `Failed: ${explained.short}. ${oneLine(node.message, 200)}`,
      };
    }

    case 'recovery': {
      const split = node.decision.indexOf(':');
      const kind = split === -1 ? node.decision : node.decision.slice(0, split);
      const reason = split === -1 ? null : node.decision.slice(split + 1).trim();
      return {
        id: node.id,
        tone: 'inferred',
        glyph: '\u21bb',
        label: describeDecisionKind(kind),
        target: null,
        tag: 'inferred',
        tagKind: 'inferred',
        aside: null,
        text: reason,
        body: null,
        thinking: null,
        commandDetails: null,
        checkpointCommit: null,
        paths: [],
        spoken: `Recovery, inferred by CodeRelay: ${describeDecisionKind(kind)}. ${reason ?? ''}`.trim(),
      };
    }

    case 'switch':
      return {
        id: node.id,
        tone: 'inferred',
        glyph: '\u21c4',
        label: 'Switched model',
        target: `${node.from.modelId} \u2192 ${node.to.modelId}`,
        tag: 'inferred',
        tagKind: 'inferred',
        aside: null,
        text: node.reason,
        body: null,
        thinking: null,
        commandDetails: null,
        checkpointCommit: null,
        paths: [],
        spoken:
          `Switched model from ${node.from.providerId} ${node.from.modelId} to ` +
          `${node.to.providerId} ${node.to.modelId}. ${oneLine(node.reason, 200)}`,
      };

    case 'escalation':
      return {
        id: node.id,
        tone: 'problem',
        glyph: '?',
        label: 'Waiting for you',
        target: null,
        tag: null,
        tagKind: null,
        aside: null,
        text: node.question,
        body: null,
        thinking: null,
        commandDetails: null,
        checkpointCommit: null,
        paths: [],
        spoken: `CodeRelay needs a decision: ${oneLine(node.question, 200)}`,
      };

    case 'plan':
      return {
        id: node.id,
        tone: 'normal',
        glyph: '\u2728', // sparkle
        label: 'Proposed Plan',
        target: node.title,
        tag: 'review',
        tagKind: 'thought',
        aside: null,
        text: null,
        body: node.planMarkdown,
        thinking: null,
        commandDetails: null,
        checkpointCommit: null,
        paths: [],
        spoken: `Plan proposed: ${node.title}`,
      };

    case 'terminal': {
      const label =
        node.outcome === 'done'
          ? 'Task complete'
          : node.outcome === 'stopped'
            ? 'Stopped by you'
            : 'Task abandoned';
      return {
        id: node.id,
        tone: node.outcome === 'done' ? 'ok' : 'muted',
        glyph: node.outcome === 'done' ? '\u2713' : '\u25a0',
        label,
        target: null,
        tag: null,
        tagKind: null,
        aside: null,
        text: node.outcome === 'stopped' ? null : node.reason,
        body: null,
        thinking: null,
        commandDetails: null,
        checkpointCommit: null,
        paths: [],
        spoken: label,
      };
    }
  }
}

function presentTurn(node: Extract<TimelineNode, { kind: 'turn' }>): RowModel {
  const truncated = node.stopReason === 'truncated';
  const label = node.done
    ? truncated
      ? 'Response cut off'
      : 'Thought through the next step'
    : 'Thinking';

  const aside = !node.done
    ? node.streamedChars === null
      ? null
      : `${node.streamedChars} chars`
    : node.stopReason === 'length'
      ? 'hit the output limit'
      : null;

  return {
    id: node.id,
    tone: truncated ? 'problem' : node.done ? 'normal' : 'running',
    glyph: node.done ? '\u25cb' : '\u25cf',
    label,
    target: node.model.modelId,
    tag: null,
    tagKind: null,
    aside,
    text: node.text === null ? null : oneLine(node.text, 600),
    body: node.text !== null && node.text.length > 600 ? clampBody(node.text) : null,
    thinking: null,
    commandDetails: null,
    checkpointCommit: null,
    paths: [],
    spoken: `${label}, on ${node.model.providerId} ${node.model.modelId}`,
  };
}

/** Verbs the user recognises, keyed by the tool the agent actually has. */
const TOOL_VERB: Record<string, { present: string; past: string }> = {
  read_file: { present: 'Reading', past: 'Read' },
  write_file: { present: 'Editing', past: 'Edited' },
  delete_file: { present: 'Deleting', past: 'Deleted' },
  run_command: { present: 'Running', past: 'Ran' },
};

export function toolVerb(toolName: string): string {
  return TOOL_VERB[toolName]?.present ?? toolName;
}

function presentTool(node: Extract<TimelineNode, { kind: 'tool' }>): RowModel {
  const verb = TOOL_VERB[node.toolName];
  const running = node.status === 'pending' || node.status === 'running';
  const label = verb === undefined ? node.toolName : running ? verb.present : verb.past;

  const tone: RowTone =
    node.status === 'failed'
      ? 'problem'
      : node.status === 'adopted'
        ? 'inferred'
        : node.status === 'ok'
          ? 'ok'
          : 'running';

  const glyph =
    node.status === 'failed'
      ? '\u2715'
      : node.status === 'adopted'
        ? '\u21ba'
        : node.status === 'ok'
          ? '\u2713'
          : '\u25cf';

  const summary = node.summary;
  const target = node.targets.length === 0 ? null : shortPath(node.targets[0] ?? '');
  const extra = node.targets.length > 1 ? ` +${node.targets.length - 1}` : '';

  const spokenStatus =
    node.status === 'adopted'
      ? 'already applied, inferred by recovery'
      : node.status === 'failed'
        ? 'failed'
        : node.status === 'ok'
          ? 'succeeded'
          : 'in progress';

  const isCommand = node.toolName === 'run_command';
  const commandDetails: CommandDetails | null = isCommand
    ? {
        command: node.targets[0] ?? 'command',
        exitCode: node.status === 'failed' ? 1 : node.status === 'ok' ? 0 : null,
        output: summary,
      }
    : null;

  const text =
    summary === null
      ? null
      : summary.length > 200 && node.toolName === 'read_file'
        ? `${summary.length.toLocaleString()} characters read`
        : oneLine(summary, 200);

  return {
    id: node.id,
    tone,
    glyph,
    label,
    target: target === null ? null : target + extra,
    tag: node.provenance === 'inferred' ? 'inferred' : node.safety === 'unsafe' ? 'unverifiable' : null,
    tagKind: node.provenance === 'inferred' ? 'inferred' : null,
    aside: node.durationMs === null ? null : formatDuration(node.durationMs),
    text,
    body: summary !== null && summary.length > 200 ? clampBody(summary) : null,
    thinking: null,
    commandDetails,
    checkpointCommit: null,
    paths: node.targets.map((p) => ({ label: baseName(p), path: p })),
    spoken:
      `${label}${target === null ? '' : ' ' + target}: ${spokenStatus}. ` +
      `${node.provenance === 'inferred' ? 'Inferred by recovery. ' : ''}` +
      `${text === null ? '' : text}`.trim(),
  };
}

function clampBody(raw: string): string {
  if (raw.length <= BODY_CHARS) {
    return raw;
  }
  const dropped = raw.length - BODY_CHARS;
  return raw.slice(0, BODY_CHARS) + `\n\n\u2026 (${dropped.toLocaleString()} more characters omitted)`;
}

export function describeDecisionKind(kind: string): string {
  switch (kind) {
    case 'RETRY_SAME':
      return 'Retrying the same model';
    case 'SWITCH_CREDENTIAL':
    case 'ROTATE_KEY':
      return 'Trying another key';
    case 'SWITCH_MODEL':
    case 'FAILOVER_MODEL':
      return 'Moving to another model';
    case 'COMPACT_CONTEXT':
      return 'Compacting the context';
    case 'REGENERATE_TURN':
      return 'Re-asking the model from the last checkpoint';
    case 'RECONCILE_FILES':
      return 'Checking which file edits landed';
    case 'ASK_USER':
      return 'Asking you how to proceed';
    case 'ABORT':
      return 'Stopping the task';
    default:
      return kind.replace(/_/g, ' ').toLowerCase();
  }
}

export function explainErrorClass(errorClass: string): {
  readonly short: string;
  readonly title: string;
  readonly advice: string;
} {
  switch (errorClass) {
    case 'AUTH':
      return {
        short: 'API key rejected',
        title: 'The API key was rejected',
        advice: 'Check the key in settings, or add a fresh key for this provider.',
      };
    case 'RATE_LIMIT':
      return {
        short: 'Rate limited',
        title: 'Rate limited by the provider',
        advice: 'CodeRelay can retry automatically, rotate to another key, or fail over to another model.',
      };
    case 'CONTEXT_LENGTH':
      return {
        short: 'Context window full',
        title: 'The context window was exceeded',
        advice: 'Compact the context, switch to a model with a larger context window, or shorten files.',
      };
    case 'INVALID_REQUEST':
      return {
        short: 'Invalid request',
        title: 'The provider rejected the request',
        advice: 'The prompt or request parameters were rejected by the model provider.',
      };
    case 'SERVER_ERROR':
      return {
        short: 'Provider outage',
        title: 'The provider reported an internal error',
        advice: 'The provider endpoint returned a server error (HTTP 5xx). Try again or switch models.',
      };
    case 'NETWORK':
      return {
        short: 'Connection lost',
        title: 'Connection lost',
        advice: 'Check the connection to the provider and try again.',
      };
    case 'TLS_UNTRUSTED':
      return {
        short: 'Untrusted certificate',
        title: 'TLS certificate verification failed',
        advice: 'The connection was intercepted by an untrusted TLS certificate or corporate proxy.',
      };
    case 'PROTOCOL_ERROR':
      return {
        short: 'Unrecognised response',
        title: 'The stream broke the protocol',
        advice: 'The endpoint emitted a response format that did not conform to the protocol.',
      };
    case 'TOOL_EXECUTION':
    case 'TOOL':
      return {
        short: 'Tool failed',
        title: 'A tool failed to execute',
        advice: 'A tool run encountered an error. You can retry or inspect the command logs.',
      };
    case 'MODEL_UNAVAILABLE':
      return {
        short: 'Model unavailable',
        title: 'The model is not available',
        advice: 'The requested model is not available or disabled on this endpoint.',
      };
    case 'FILESYSTEM':
      return {
        short: 'Filesystem error',
        title: 'Filesystem operation failed',
        advice: 'A file read or write failed due to permissions or missing directory.',
      };
    case 'TIMEOUT':
      return {
        short: 'Request timed out',
        title: 'The request timed out',
        advice: 'The provider took too long to answer headers or stream tokens.',
      };
    case 'UNKNOWN':
      return {
        short: 'Unexplained fault',
        title: 'The task could not proceed',
        advice: 'An unexplained fault interrupted execution. Check logs or retry.',
      };
    default:
      return {
        short: 'Unexplained fault',
        title: 'The task could not proceed',
        advice: 'An unexpected fault interrupted execution. Check logs or retry with another model.',
      };
  }
}

export function describeFailure(projection: TaskProjection): FailureModel {
  const last = projection.lastFailure;
  const explained = explainErrorClass(last?.errorClass ?? 'UNKNOWN');
  const facts: string[] = [];

  const turns = projection.header.turns;
  if (turns > 0) {
    facts.push(`${plural(turns, 'step', 'steps')} completed before the fault`);
  }
  const files = projection.changes.length;
  if (files > 0) {
    facts.push(`${plural(files, 'file', 'files')} written to disk`);
  }
  facts.push('All progress is checkpointed and safe on disk');
  facts.push(`\u2717 ${explained.short}`);

  const message =
    last?.message === undefined || last.message === ''
      ? explained.advice
      : `${explained.advice}. ${last.message}`;

  return {
    title: explained.title,
    message,
    facts,
  };
}

export function describeEmpty(options: PresentOptions): {
  readonly title: string;
  readonly body: string;
  readonly actions: readonly EmptyAction[];
} {
  if (options.blocked === 'no-folder') {
    return {
      title: 'Open a folder to start',
      body:
        'CodeRelay records every step to disk and tracks file edits against the workspace. ' +
        'Open a workspace folder to begin.',
      actions: [],
    };
  }
  if (options.blocked === 'no-models') {
    return {
      title: 'Connect an AI provider',
      body:
        'CodeRelay works with Anthropic, OpenAI, Gemini, NVIDIA, OpenRouter, Azure, or a local ' +
        'server. Setup asks for the endpoint, one model and a key \u2014 about a minute. The key ' +
        'goes into the OS keychain and is never written to your settings.',
      actions: [
        { label: 'Set Up Provider', command: 'setUp', primary: true },
        { label: 'Manage Providers', command: 'setupOpenManage', primary: false },
      ],
    };
  }

  if (options.blocked === 'config-error') {
    return {
      title: 'Check your CodeRelay settings',
      body:
        'One of the configured providers or models could not be read. CodeRelay will not guess ' +
        'at a value it was given incorrectly.',
      actions: [{ label: 'Open Providers & Setup', command: 'setupOpenManage', primary: true }],
    };
  }
  if (options.taskId === null) {
    return {
      title: 'Start your first coding task',
      body:
        'Describe an outcome below. CodeRelay reasons autonomously, executes tools, ' +
        'verifies each change, and tracks checkpoints safely.',
      actions: [],
    };
  }
  return {
    title: 'Ready',
    body: 'The task has not produced any activity yet.',
    actions: [],
  };
}

export function summarizeChanges(changes: readonly FileChange[]): string {
  if (changes.length === 0) {
    return 'No files changed.';
  }
  const added = changes.filter((c) => c.kind === 'added').length;
  const modified = changes.filter((c) => c.kind === 'modified').length;
  const deleted = changes.filter((c) => c.kind === 'deleted').length;
  const parts: string[] = [];
  if (added > 0) {
    parts.push(`${added} added`);
  }
  if (modified > 0) {
    parts.push(`${modified} modified`);
  }
  if (deleted > 0) {
    parts.push(`${deleted} deleted`);
  }
  const count = changes.length;
  const suffix = parts.length > 0 ? `: ${parts.join(', ')}.` : ' written to disk.';
  return `${plural(count, 'file', 'files')}${suffix}`;
}
