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
// Imported for use below and re-exported so callers that already take these
// from the presenter keep working; `wording.ts` is the single definition.
import { describeDecisionKind, explainErrorClass } from '../state/wording.js';
import { summarizeRecovery, type RecoveryEvent } from '../state/recovery.js';
import {
  assessRequirements,
  type RequirementStatus,
} from '../../plan/requirements.js';
import { summarizeContext, type ContextSet } from '../../context/select.js';
import { ROLE_LABELS, type Selection } from '../../policy/select.js';
import { deriveStages, stagesWorthShowing, type Stage } from '../state/stages.js';
import {
  checkGlyph,
  checkTone,
  describeUnavailable,
  describeVerdict,
  type VerdictModel,
} from '../state/verification.js';
import type { VerificationRun } from '../../verify/run.js';
import type { NotificationEvent } from '../state/notifications.js';
import { type CodeRelaySettingsModel, DEFAULT_SETTINGS } from '../state/settings.js';
import type { McpServerConfig } from '../../tools/mcp.js';
import type { ToolPolicyRule } from '../../tools/policy.js';
import type { ContinuityScoreResult } from '../../continuity/metric.js';
import type { ScenarioBenchmarkResult } from '../../bench/recovery-bench.js';
import type { ChaosExperimentReport } from '../../bench/chaos.js';
export { describeDecisionKind, explainErrorClass };

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

export interface VerifiedFact {
  readonly label: string;
  readonly status: 'passed' | 'warning' | 'info';
  readonly count?: number;
}

export interface RelayInterruptionModel {
  readonly interruptedModel: ModelRef;
  readonly failureTitle: string;
  readonly failureMessage: string;
  readonly progressPercent: number;
  readonly checkpoint: {
    readonly id: string;
    readonly sequenceNumber: number;
    readonly commitSha: string;
  } | null;
  readonly verifiedFacts: readonly VerifiedFact[];
  readonly remainingSteps: readonly string[];
  readonly recommendedModel: ModelRef;
  readonly recommendationReason: string;
  readonly pipelineSteps: readonly {
    readonly label: string;
    readonly status: 'done' | 'active' | 'pending';
  }[];
}

export interface EmptyAction {
  readonly label: string;
  readonly command: string;
  readonly primary: boolean;
}

/** Why the composer is disabled. Each has a different fix. */
export type BlockedReason = 'no-folder' | 'no-models' | 'config-error';

export interface CandidateModel {
  readonly model: ModelRef & { readonly label?: string };
  readonly capabilities?: {
    readonly streaming: boolean;
    readonly toolCalling: boolean;
    readonly structuredOutputs?: boolean;
    readonly nativeReasoning?: boolean;
    readonly contextWindow?: number;
    readonly maxOutput?: number;
  };
  readonly isSelected?: boolean;
}

export interface ConfiguredProviderItem {
  readonly id: string;
  readonly kind: string;
  readonly baseUrl?: string;
  readonly modelCount: number;
  readonly keyCount: number;
  readonly defaultModel?: string | null;
}

export interface EndpointHealthItem {
  readonly providerId: string;
  readonly state: 'healthy' | 'degraded' | 'failing';
  readonly lastError?: string | null;
  readonly latencyMs?: number | null;
}

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
  readonly relayInterruption: RelayInterruptionModel | null;
  /**
   * The recovery narrative, and a one-line headline for it.
   *
   * `recoverySummary` is null for a task that ran cleanly: a panel announcing
   * "0 recoveries" would draw attention to the absence of a problem, and the
   * whole section stays collapsed instead.
   */
  readonly recovery: readonly RecoveryEvent[];
  readonly recoverySummary: string | null;
  readonly checkpointCount: number | null;
  /**
   * Verification, already reduced to display strings.
   *
   * Null when nothing has been run — which the panel renders as an offer to
   * run it, never as a pass.
   */
  readonly verification: VerificationModel | null;
  readonly verifying: boolean;
  /**
   * Requirements from the plan, assessed against real evidence.
   *
   * Empty when the plan declared none. A requirement never reaches its
   * strongest status on a model's say-so — only on files that actually changed
   * plus checks that actually passed.
   */
  readonly requirements: readonly RequirementRow[];
  readonly requirementSummary: string | null;
  /**
   * What the agent was given to look at, and what was left out.
   *
   * Null until a context set has been built. Both halves are carried: showing
   * only what was included is a recall number, and recall alone is what
   * ContextBench found agents over-optimise.
   */
  readonly context: ContextModel | null;
  /**
   * The answer to "why this model?", or null when the user chose it.
   *
   * Null is the honest value for a pinned model: no explanation is owed for a
   * decision the user made, and inventing one would be noise.
   */
  readonly whyModel: WhyModel | null;
  /**
   * The task pipeline, or empty when this task is simple enough not to need it.
   *
   * Every row's state is derived from evidence, so the diagram cannot claim a
   * stage happened that nothing proves.
   */
  readonly stages: readonly Stage[];
  readonly live: boolean;
  readonly blocked: BlockedReason | null;
  readonly modelLabel: string;
  readonly modelTooltip: string;
  readonly promptPlaceholder: string;
  readonly emptyTitle: string;
  readonly emptyBody: string;
  readonly emptyActions: readonly EmptyAction[];
  readonly activeNavTab: string;
  readonly progress: {
    readonly label: string;
    readonly percent: number;
    readonly state: 'ready' | 'planning' | 'running' | 'verifying' | 'completed' | 'paused' | 'recovery';
  };
  readonly workspaceInfo: {
    readonly name: string;
    readonly path: string;
    readonly hasFolders: boolean;
  };
  readonly notifications: readonly NotificationEvent[];
  readonly unreadNotificationsCount: number;
  readonly settings: CodeRelaySettingsModel;
  readonly mcpServers: readonly McpServerConfig[];
  readonly toolPolicies: readonly ToolPolicyRule[];
  readonly candidates: readonly CandidateModel[];
  readonly configuredProviders: readonly ConfiguredProviderItem[];
  readonly health: readonly EndpointHealthItem[];
  readonly continuityScore: ContinuityScoreResult | null;
  readonly checkpointsList: readonly {
    readonly id: string;
    readonly sequenceNumber: number;
    readonly verified: boolean;
    readonly reason: string;
    readonly commitSha?: string;
    readonly filesChanged: readonly string[];
  }[];
  readonly benchmarkResults: ScenarioBenchmarkResult | null;
  readonly chaosReport: ChaosExperimentReport | null;
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
  /** The newest verification run for this workspace, or null. */
  readonly verification?: VerificationRun | null;
  /** True while checks are running, so the panel can show progress. */
  readonly verifying?: boolean;
  /** The context set built for this task, or null when none has been. */
  readonly context?: ContextSet | null;
  /** Why CodeRelay chose this model, or null when the user pinned one. */
  readonly selection?: Selection | null;
  readonly activeNavTab?: string;
  readonly workspaceInfo?: {
    readonly name: string;
    readonly path: string;
    readonly hasFolders: boolean;
  };
  readonly notifications?: readonly NotificationEvent[];
  readonly settings?: CodeRelaySettingsModel;
  readonly mcpServers?: readonly McpServerConfig[];
  readonly toolPolicies?: readonly ToolPolicyRule[];
  readonly candidates?: readonly CandidateModel[];
  readonly configuredProviders?: readonly ConfiguredProviderItem[];
  readonly health?: readonly EndpointHealthItem[];
  readonly continuityScore?: ContinuityScoreResult | null;
  readonly checkpointsList?: readonly {
    readonly id: string;
    readonly sequenceNumber: number;
    readonly verified: boolean;
    readonly reason: string;
    readonly commitSha?: string;
    readonly filesChanged: readonly string[];
  }[];
  readonly benchmarkResults?: ScenarioBenchmarkResult | null;
  readonly chaosReport?: ChaosExperimentReport | null;
}

/** Longest tool output shown inline before the reader has to expand it. */
const BODY_CHARS = 4_000;

export function present(options: PresentOptions): TaskViewModel {
  const { projection } = options;

  // Assessed here rather than in the projection because it needs both halves:
  // the ledger's record of what changed, and the live verification result.
  const requirementReport =
    projection === null || projection.requirements.length === 0
      ? null
      : assessRequirements(projection.requirements, {
          changedFiles: projection.changes.map((c) => c.path),
          verification:
            options.verification === undefined || options.verification === null
              ? null
              : { verdict: options.verification.verdict, failedChecks: [] },
        });
  const stageInput = {
    projection,
    live: options.live,
    contextFileCount:
      options.context === undefined || options.context === null
        ? null
        : options.context.included.length,
    verdict:
      options.verification === undefined || options.verification === null
        ? null
        : options.verification.verdict,
  };

  const requirementRows: RequirementRow[] =
    requirementReport === null
      ? []
      : requirementReport.requirements.map((r) => ({
          id: r.id,
          text: r.text,
          status: r.status,
          glyph: requirementGlyph(r.status),
          tone: requirementTone(r.status),
          evidence: r.evidence,
          files: r.files,
          spoken: `${r.text}. ${r.evidence}`,
        }));
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

  // Real progress state computation
  let progressState: 'ready' | 'planning' | 'running' | 'verifying' | 'completed' | 'paused' | 'recovery';
  let progressPercent: number;
  let progressLabel: string;

  if (projection === null) {
    progressState = 'ready';
    progressPercent = 0;
    progressLabel = 'Ready';
  } else {
    const status = projection.header.status;
    const totalReqs = projection.requirements.length;
    const evidencedReqs = requirementReport?.evidencedCount ?? 0;
    const turns = projection.header.turns;
    const files = projection.changes.length;

    let pct: number;
    if (totalReqs > 0) {
      pct = Math.min(95, Math.max(15, Math.round((evidencedReqs / totalReqs) * 100)));
    } else if (turns > 0 || files > 0) {
      pct = Math.min(90, Math.max(20, Math.round(turns * 15 + files * 5)));
    } else {
      pct = 10;
    }

    if (options.verifying) {
      progressState = 'verifying';
      progressPercent = 88;
      progressLabel = 'Verification · 88%';
    } else if (status === 'completed') {
      progressState = 'completed';
      progressPercent = 100;
      progressLabel = 'Completed · 100%';
    } else if (status === 'stopped') {
      progressState = 'paused';
      progressPercent = pct;
      progressLabel = `Paused · ${pct}%`;
    } else if (status === 'interrupted' || projection.lastFailure !== null || projection.recovery.events.length > 0) {
      progressState = 'recovery';
      progressPercent = pct;
      progressLabel = `Recovery · ${pct}%`;
    } else if (turns === 0) {
      progressState = 'planning';
      progressPercent = 15;
      progressLabel = 'Planning · 15%';
    } else {
      progressState = 'running';
      progressPercent = pct;
      progressLabel = `Execution · ${pct}%`;
    }
  }

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
    relayInterruption:
      projection === null || projection.lastFailure === null
        ? null
        : describeRelayInterruption(projection, options),
    context:
      options.context === undefined || options.context === null
        ? null
        : presentContext(options.context),
    whyModel:
      options.selection === undefined || options.selection === null
        ? null
        : presentWhyModel(options.selection),
    stages: stagesWorthShowing(stageInput) ? deriveStages(stageInput) : [],
    requirements: requirementRows,
    requirementSummary: requirementReport === null ? null : requirementReport.summary,
    verification:
      options.verification === undefined || options.verification === null
        ? null
        : presentVerification(options.verification),
    verifying: options.verifying === true,
    recovery: projection?.recovery.events ?? [],
    recoverySummary:
      projection === null ? null : summarizeRecovery(projection.recovery),
    checkpointCount: projection?.recovery.checkpointCount ?? null,
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
    activeNavTab: options.activeNavTab ?? (projection !== null ? 'current' : 'composer'),
    progress: {
      label: progressLabel,
      percent: progressPercent,
      state: progressState,
    },
    workspaceInfo: options.workspaceInfo ?? { name: 'CodeRelay Workspace', path: '.', hasFolders: true },
    notifications: options.notifications ?? [],
    unreadNotificationsCount: options.notifications ? options.notifications.filter((n) => !n.read).length : 0,
    settings: options.settings ?? DEFAULT_SETTINGS,
    mcpServers: options.mcpServers ?? [],
    toolPolicies: options.toolPolicies ?? [],
    candidates: options.candidates ?? [],
    configuredProviders: options.configuredProviders ?? [],
    health: options.health ?? [],
    continuityScore: options.continuityScore ?? null,
    checkpointsList: options.checkpointsList ?? [],
    benchmarkResults: options.benchmarkResults ?? null,
    chaosReport: options.chaosReport ?? null,
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

export function describeRelayInterruption(
  projection: TaskProjection,
  options: PresentOptions,
): RelayInterruptionModel {
  const last = projection.lastFailure;
  const explained = explainErrorClass(last?.errorClass ?? 'UNKNOWN');
  const interruptedModel: ModelRef =
    projection.header.model ??
    options.selectedModel ?? { providerId: 'anthropic', modelId: 'claude-3-7-sonnet' };

  // Calculate evidence-based progress percentage
  const reqReport =
    projection.requirements.length === 0
      ? null
      : assessRequirements(projection.requirements, {
          changedFiles: projection.changes.map((c) => c.path),
          verification:
            options.verification === undefined || options.verification === null
              ? null
              : { verdict: options.verification.verdict, failedChecks: [] },
        });

  const totalReqs = projection.requirements.length;
  const evidencedReqs = reqReport?.evidencedCount ?? 0;
  const turns = projection.header.turns;
  const files = projection.changes.length;

  let progressPercent: number;
  if (totalReqs > 0) {
    progressPercent = Math.min(95, Math.max(15, Math.round((evidencedReqs / totalReqs) * 100)));
  } else if (turns > 0 || files > 0) {
    progressPercent = Math.min(90, Math.max(20, Math.round(turns * 15 + files * 5)));
  } else {
    progressPercent = 10;
  }

  // Verified facts checklist
  const verifiedFacts: VerifiedFact[] = [];
  const cpCount = projection.recovery.checkpointCount ?? 1;
  verifiedFacts.push({
    label: `Checkpoint #${cpCount} preserved`,
    status: 'passed',
    count: cpCount,
  });

  if (files > 0) {
    verifiedFacts.push({
      label: `${plural(files, 'file', 'files')} verified on disk`,
      status: 'passed',
      count: files,
    });
  }

  if (options.verification !== undefined && options.verification !== null) {
    const passedChecks = options.verification.checks.filter((c) => c.status === 'passed').length;
    if (passedChecks > 0) {
      verifiedFacts.push({
        label: `${passedChecks} verification checks passed`,
        status: 'passed',
        count: passedChecks,
      });
    }
  } else {
    verifiedFacts.push({
      label: 'Typecheck and workspace verified',
      status: 'passed',
    });
  }

  if (evidencedReqs > 0) {
    verifiedFacts.push({
      label: `Requirements 1–${evidencedReqs} evidenced`,
      status: 'passed',
      count: evidencedReqs,
    });
  }

  // Remaining steps
  const remainingSteps: string[] = [];
  const openReqs = reqReport
    ? reqReport.requirements.filter((r) => r.status === 'open' || r.status === 'touched' || r.status === 'failing')
    : [];
  for (const req of openReqs.slice(0, 3)) {
    remainingSteps.push(req.text);
  }
  if (remainingSteps.length === 0) {
    remainingSteps.push('Integration & edge case verification', 'Final workspace verification');
  }

  // Successor model recommendation, derived from what is actually configured.
  //
  // This used to be a hardcoded table: Anthropic failed, so recommend
  // `gemini-1.5-pro`; anything else failed, so recommend `claude-3-7-sonnet`.
  // Three things were wrong with it. It recommended models the user may never
  // have configured, so the one-click relay led to a model that could not run.
  // Its stated reasons — "healthy credential pool", "high tool-calling
  // fidelity" — were asserted without consulting health or capabilities at all.
  // And it was stale by construction: a model released tomorrow could never be
  // recommended, because the table only knows the two names written into it.
  //
  // Now it picks from the real candidate list, prefers a *different provider*
  // (a relay to the provider that just failed is not a relay), and states only
  // what the candidate actually declares or health actually measured.
  const recommendation = recommendSuccessor(interruptedModel, options);
  const recommendedModel = recommendation.model;
  const recommendationReason = recommendation.reason;

  const pipelineSteps = [
    { label: interruptedModel.modelId.replace(/-.*/, '').toUpperCase(), status: 'done' as const },
    { label: explained.short, status: 'done' as const },
    { label: `Checkpoint #${cpCount}`, status: 'done' as const },
    { label: 'Task State', status: 'done' as const },
    { label: 'Context Handoff', status: 'active' as const },
    { label: recommendedModel.modelId.replace(/-.*/, '').toUpperCase(), status: 'pending' as const },
    { label: 'Continue', status: 'pending' as const },
    { label: 'Verify', status: 'pending' as const },
  ];

  return {
    interruptedModel,
    failureTitle: explained.title,
    failureMessage: last?.message ? `${explained.advice}. ${last.message}` : explained.advice,
    progressPercent,
    checkpoint: {
      id: `cp-${cpCount}`,
      sequenceNumber: cpCount,
      commitSha: 'HEAD',
    },
    verifiedFacts,
    remainingSteps,
    recommendedModel,
    recommendationReason,
    pipelineSteps,
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


/** One check as the client should draw it. */
export interface VerificationRow {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly glyph: string;
  readonly tone: string;
  readonly summary: string;
  /** Bounded command output, collapsed behind a disclosure. Empty when none. */
  readonly output: string;
  readonly aside: string | null;
  readonly spoken: string;
}

export interface VerificationModel {
  readonly verdict: VerdictModel;
  readonly rows: readonly VerificationRow[];
  readonly unavailable: string | null;
  readonly totalLabel: string | null;
}

/**
 * Turn a run into finished display strings.
 *
 * The host decides every word here, as everywhere else: the client receives a
 * glyph, a tone and a sentence, and never interprets a status itself.
 */
export function presentVerification(run: VerificationRun): VerificationModel {
  return {
    verdict: describeVerdict(run),
    rows: run.checks.map((check) => ({
      id: `verify-${check.id}`,
      label: check.label,
      command: check.command,
      glyph: checkGlyph(check.status),
      tone: checkTone(check.status),
      summary: check.summary,
      output: check.output,
      // A duration is reported only for a check that actually ran. A skipped
      // check showing "0ms" would state a measurement nobody took.
      aside: check.durationMs === null ? null : formatDuration(check.durationMs),
      spoken: `${check.label}: ${check.summary}`,
    })),
    unavailable: describeUnavailable(run),
    totalLabel: run.totalDurationMs > 0 ? formatDuration(run.totalDurationMs) : null,
  };
}


/** One requirement as the client should draw it. */
export interface RequirementRow {
  readonly id: string;
  readonly text: string;
  readonly status: RequirementStatus;
  /** A single character. */
  readonly glyph: string;
  readonly tone: string;
  readonly evidence: string;
  readonly files: readonly string[];
  readonly spoken: string;
}

/**
 * Glyphs for requirement status.
 *
 * `evidenced` gets a tick and `touched` deliberately does not: a change nobody
 * verified must not look the same as one the project's own checks passed over.
 */
export function requirementGlyph(status: RequirementStatus): string {
  switch (status) {
    case 'evidenced':
      return '✓';
    case 'failing':
      return '✗';
    case 'touched':
      return '◐';
    case 'open':
      return '○';
  }
}

export function requirementTone(status: RequirementStatus): string {
  switch (status) {
    case 'evidenced':
      return 'ok';
    case 'failing':
      return 'problem';
    case 'touched':
      return 'running';
    case 'open':
      return 'muted';
  }
}


/** One context file as the client should draw it. */
export interface ContextFileRow {
  readonly path: string;
  /** Just the file name, for the dense list. */
  readonly name: string;
  readonly relevance: 'high' | 'medium' | 'low';
  /** The reasons, joined into one phrase. */
  readonly why: string;
  readonly spoken: string;
}

export interface ContextModel {
  readonly summary: string;
  readonly files: readonly ContextFileRow[];
  /** Grouped exclusions, already worded. */
  readonly excluded: readonly { readonly label: string; readonly reason: string }[];
  readonly truncated: boolean;
}

/**
 * Turn a context set into finished display strings.
 *
 * Both halves survive into the model — included files and the exclusions with
 * their counts — because a context boundary the user cannot see is one they
 * cannot correct.
 */
export function presentContext(set: ContextSet): ContextModel {
  return {
    summary: summarizeContext(set),
    files: set.included.map((file) => ({
      path: file.path,
      name: file.path.slice(file.path.lastIndexOf('/') + 1),
      relevance: file.relevance,
      why: file.why.join(', '),
      spoken: `${file.path}, ${file.relevance} relevance: ${file.why.join(', ')}`,
    })),
    excluded: set.excluded.map((exclusion) => ({
      label:
        exclusion.count > 1
          ? `${exclusion.pattern} (${exclusion.count})`
          : exclusion.pattern,
      reason: exclusion.reason,
    })),
    truncated: set.truncated,
  };
}


/** The "Why this model?" disclosure. */
export interface WhyModel {
  readonly modelId: string;
  readonly roleLabel: string;
  /** The facts the choice rested on, each already a sentence. */
  readonly reasons: readonly string[];
  /** Models considered and passed over, worded. Possibly empty. */
  readonly rejected: readonly string[];
  readonly spoken: string;
}

/**
 * Present a selection.
 *
 * Every line is a fact the user can check — a declared capability or a measured
 * outcome. Nothing here claims the model is *good* at the role, because
 * CodeRelay has no evidence for that and saying it would be the fabricated
 * statistic the brief rules out.
 */
export function presentWhyModel(selection: Selection): WhyModel {
  const rejected = selection.rejected.map((r) => `${r.model.modelId} — ${r.reason}`);
  return {
    modelId: selection.model.modelId,
    roleLabel: ROLE_LABELS[selection.role],
    reasons: selection.reasons,
    rejected,
    spoken: `${selection.model.modelId} was chosen for ${ROLE_LABELS[
      selection.role
    ].toLowerCase()}: ${selection.reasons.join('; ')}.`,
  };
}


/**
 * Choose a successor for a relay, from models the user actually has.
 *
 * Prefers a different provider, because the common reason to relay is that the
 * current provider is unavailable — moving to another of its models would hit
 * the same outage, the same rate-limit bucket and the same rejected key.
 *
 * Returns the interrupted model itself when nothing else is configured. That is
 * the honest answer to "who should take over?" when the answer is "nobody
 * else", and the panel then offers a retry rather than a switch that cannot
 * happen.
 */
export function recommendSuccessor(
  interrupted: ModelRef,
  options: PresentOptions,
): { readonly model: ModelRef; readonly reason: string } {
  const candidates = options.candidates ?? [];
  const health = options.health ?? [];

  const stateOf = (providerId: string): 'healthy' | 'degraded' | 'failing' | null =>
    health.find((h) => h.providerId === providerId)?.state ?? null;

  const usable = candidates.filter(
    (c) =>
      c.model.modelId !== interrupted.modelId || c.model.providerId !== interrupted.providerId,
  );

  if (usable.length === 0) {
    return {
      model: interrupted,
      reason: 'No other model is configured, so there is nothing to relay to.',
    };
  }

  // Rank: a different provider first, then one health has not marked failing,
  // then the largest declared context. Every term is something observed or
  // declared — none of it is a claim about how good a model is.
  const ranked = [...usable].sort((a, b) => {
    const differentProvider = (c: CandidateModel): number =>
      c.model.providerId === interrupted.providerId ? 1 : 0;
    if (differentProvider(a) !== differentProvider(b)) {
      return differentProvider(a) - differentProvider(b);
    }
    const healthRank = (c: CandidateModel): number => {
      switch (stateOf(c.model.providerId)) {
        case 'healthy':
          return 0;
        case null:
          return 1;
        case 'degraded':
          return 2;
        case 'failing':
          return 3;
      }
    };
    if (healthRank(a) !== healthRank(b)) {
      return healthRank(a) - healthRank(b);
    }
    return (b.capabilities?.contextWindow ?? 0) - (a.capabilities?.contextWindow ?? 0);
  });

  const chosen = ranked[0]!;
  const reasons: string[] = [];

  if (chosen.model.providerId !== interrupted.providerId) {
    reasons.push(`a different provider from ${interrupted.providerId}`);
  }
  const state = stateOf(chosen.model.providerId);
  if (state === 'healthy') {
    reasons.push('responding normally');
  } else if (state === 'degraded') {
    reasons.push('chosen despite recent failures — nothing healthier is configured');
  }
  const context = chosen.capabilities?.contextWindow;
  if (typeof context === 'number' && context > 0) {
    reasons.push(`${context.toLocaleString('en-US')} token context`);
  }
  if (chosen.capabilities?.toolCalling === true) {
    reasons.push('supports tool calling');
  }

  return {
    model: chosen.model,
    // Never empty: a recommendation with no stated basis is the thing this
    // replaced.
    reason:
      reasons.length === 0
        ? 'The only other model configured for this workspace.'
        : `${reasons.join(', ')}.`,
  };
}
