/**
 * Assembles the UI layer.
 *
 * `extension.ts` keeps every action — starting a task, picking a model, storing a
 * credential — because that is where the catalog and credential helpers live and
 * where the safety rules about them are written down. This module owns only the
 * *surfaces*: the four views, the status bar, the checkpoint diff provider, and
 * the single change event that keeps them consistent with each other.
 *
 * One event drives everything. Four views each polling the disk would disagree
 * with one another the moment a task advanced, and four timers would be four ways
 * to poll a file that already tells us when it changes.
 */
import {
  Uri,
  commands,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
} from 'vscode';
import { CheckpointStore, execGitRunner } from '../checkpoint/git.js';
import type { ModelRef, TaskId } from '../core/types.js';
import type { EndpointHealth } from '../policy/health.js';
import type { VerificationRun } from '../verify/run.js';
import type { ContextSet } from '../context/select.js';
import type { Selection } from '../policy/select.js';
import type { Candidate } from '../policy/route.js';
import type { ProviderConfig } from '../providers/catalog.js';
import { StatusBar } from './statusBar.js';
import { TaskStore } from './state/store.js';
import { ChangesTreeProvider } from './view/changesTree.js';
import {
  CHECKPOINT_SCHEME,
  CheckpointContentProvider,
  openCheckpointDiff,
} from './view/diff.js';
import { ModelsTreeProvider } from './view/modelsTree.js';
import { TASK_VIEW_ID, TaskViewProvider } from './view/taskView.js';
import { TasksTreeProvider } from './view/tasksTree.js';
import type { BlockedReason, SessionSummary, ConfiguredProviderItem } from './webview/present.js';
import type { Inbound, TaskMode } from './webview/protocol.js';
import type { SetupViewModel } from './setup/present.js';

import type { NotificationEvent } from './state/notifications.js';
import type { CodeRelaySettingsModel } from './state/settings.js';
import type { McpServerConfig } from '../tools/mcp.js';
import type { ToolPolicyRule } from '../tools/policy.js';
import type { ContinuityScoreResult } from '../continuity/metric.js';
import type { ScenarioBenchmarkResult } from '../bench/recovery-bench.js';
import type { ChaosExperimentReport } from '../bench/chaos.js';

export const TASKS_VIEW_ID = 'coderelay.tasksView';
export const CHANGES_VIEW_ID = 'coderelay.changesView';
export const MODELS_VIEW_ID = 'coderelay.modelsView';

/** What the UI needs from the extension host to describe and act on state. */
export interface UiDeps {
  /** Extension-private storage, or null when no folder is open. */
  readonly storageDir: string | null;
  readonly workspaceRoot: () => string | null;
  /** Routable candidates, from the same function the router uses. */
  readonly candidates: () => readonly Candidate[];
  readonly provider: (providerId: string) => ProviderConfig | null;
  /** Why a task cannot be started, or null when one can. */
  readonly blocked: () => BlockedReason | null;
  /** The model a new task would start on. */
  readonly selectedModel: () => ModelRef | null;
  /** Acts on a validated message from the task view. */
  readonly handle: (message: Inbound) => void | Promise<void>;
  /** The setup panel's view model while guided setup is open, otherwise null. */
  readonly setupModel: () => SetupViewModel | null;
  readonly mode?: () => TaskMode;
  readonly soundEnabled?: () => boolean;
  readonly sessions?: () => readonly SessionSummary[];
  readonly contextWindowLimit?: () => number | null;
  /** The newest verification run, owned by the extension host. */
  readonly verification?: () => VerificationRun | null;
  readonly verifying?: () => boolean;
  /** The context set built for the active task, or null when none has been. */
  readonly context?: () => ContextSet | null;
  /** Why CodeRelay chose the running model, or null when the user pinned it. */
  readonly selection?: () => Selection | null;
  /**
   * Observed endpoint health, for the Models view.
   *
   * Supplied by the extension host, which owns the one tracker shared by every
   * task — health that reset between tasks would forget the thing it exists to
   * remember. Optional, and when it is absent the view shows availability only
   * rather than inventing a verdict.
   */
  readonly health?: () => readonly EndpointHealth[];
  readonly notifications?: () => readonly NotificationEvent[];
  readonly settings?: () => CodeRelaySettingsModel;
  readonly workspaceInfo?: () => { name: string; path: string; hasFolders: boolean };
  readonly activeNavTab?: () => string;
  readonly mcpServers?: () => readonly McpServerConfig[];
  readonly toolPolicies?: () => readonly ToolPolicyRule[];
  readonly configuredProviders?: () => readonly ConfiguredProviderItem[];
  readonly continuityScore?: () => ContinuityScoreResult | null;
  readonly checkpointsList?: () => readonly { id: string; sequenceNumber: number; verified: boolean; reason: string; commitSha?: string; filesChanged: readonly string[] }[];
  readonly benchmarkResults?: () => ScenarioBenchmarkResult | null;
  readonly chaosReport?: () => ChaosExperimentReport | null;
}

export interface Ui extends Disposable {
  readonly store: TaskStore;
  readonly taskView: TaskViewProvider;
  /** Re-reads the ledgers, then repaints every surface. */
  refresh(): Promise<void>;
  /** Repaints every surface from state already in memory. */
  render(): void;
  /** Opens the native diff for one changed file. */
  openChange(path: string): Promise<void>;
  /** A read-only checkpoint store for a task, or null when git cannot serve one. */
  checkpointsFor(taskId: TaskId): CheckpointStore | null;
  /** Injects an attached context reference chip into the composer. */
  attachContext(chip: string): void;
  /** Asks user approval for command execution or high-risk actions. */
  requestApproval(req: { requestId: string; command?: string; reason?: string; risk?: string }): void;
}

export function activateUi(context: ExtensionContext, deps: UiDeps): Ui {
  const store = new TaskStore(deps.storageDir);

  const tasksTree = new TasksTreeProvider(store);
  const changesTree = new ChangesTreeProvider(store, deps.workspaceRoot);
  const modelsTree = new ModelsTreeProvider({
    candidates: deps.candidates,
    provider: deps.provider,
    current: () => {
      const taskId = store.selected;
      const runtime = taskId === null ? null : store.runtime(taskId);
      return runtime?.model ?? deps.selectedModel();
    },
    ...(deps.health === undefined ? {} : { health: deps.health }),
  });

  const taskView = new TaskViewProvider(context.extensionUri, {
    store,
    blocked: deps.blocked,
    selectedModel: deps.selectedModel,
    handle: deps.handle,
    setupModel: deps.setupModel,
    mode: deps.mode,
    soundEnabled: deps.soundEnabled,
    sessions: deps.sessions,
    contextWindowLimit: deps.contextWindowLimit,
    verification: deps.verification,
    verifying: deps.verifying,
    context: deps.context,
    selection: deps.selection,
    notifications: deps.notifications,
    settings: deps.settings,
    workspaceInfo: deps.workspaceInfo,
    activeNavTab: deps.activeNavTab,
    mcpServers: deps.mcpServers,
    toolPolicies: deps.toolPolicies,
    candidates: () => {
      const selected = deps.selectedModel();
      return deps.candidates().map((c) => ({
        model: { providerId: c.model.providerId, modelId: c.model.modelId, label: c.model.modelId },
        capabilities: {
          streaming: c.capabilities.streaming,
          toolCalling: c.capabilities.toolCalling,
          structuredOutputs: c.capabilities.structuredOutput,
          nativeReasoning: c.capabilities.reasoning !== 'none',
          contextWindow: c.capabilities.contextWindow,
          maxOutput: c.capabilities.maxOutput,
        },
        isSelected: selected?.providerId === c.model.providerId && selected?.modelId === c.model.modelId,
      }));
    },
    configuredProviders: () => (deps.configuredProviders ? deps.configuredProviders() : []),
    health: () => {
      if (!deps.health) return [];
      return deps.health().map((h) => ({
        providerId: `${h.key.model.providerId}/${h.key.model.modelId}`,
        state: (h.breaker.kind === 'closed' ? 'healthy' : h.breaker.kind === 'half-open' ? 'degraded' : 'failing') as 'healthy' | 'degraded' | 'failing',
        lastError: h.lastErrorClass ?? null,
        latencyMs: h.latencyMs ?? null,
      }));
    },
    continuityScore: deps.continuityScore,
    checkpointsList: deps.checkpointsList,
    benchmarkResults: deps.benchmarkResults,
    chaosReport: deps.chaosReport,
  });

  const statusBar = new StatusBar(store);

  /**
   * Checkpoint stores, one per task, built lazily.
   *
   * Cached because each one memoizes its scratch directory and its work-tree
   * probe, and rebuilding it per diff would re-run `git rev-parse` on every
   * click. Read-only in this use: only `list` and `restore` are called, and
   * `restore` writes nothing.
   */
  const checkpointStores = new Map<TaskId, CheckpointStore | null>();

  const checkpointsFor = (taskId: TaskId): CheckpointStore | null => {
    const cached = checkpointStores.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    const root = deps.workspaceRoot();
    const storage = deps.storageDir;
    const built =
      root === null || storage === null
        ? null
        : new CheckpointStore({
            git: execGitRunner(root),
            // The same path `openSession` uses, so a diff finds the snapshots the
            // run actually took rather than an empty namespace.
            scratchDir: `${storage}/checkpoints/${taskId}`,
          });
    checkpointStores.set(taskId, built);
    return built;
  };

  const diffProvider = new CheckpointContentProvider(() => {
    const taskId = store.selected;
    return taskId === null ? null : checkpointsFor(taskId);
  });

  const render = (): void => {
    tasksTree.refresh();
    changesTree.refresh();
    modelsTree.refresh();
    statusBar.update();
    taskView.render();
  };

  const refresh = async (): Promise<void> => {
    await store.refresh();
    // Load the selected task's entries so the timeline and the changes list have
    // something to show. Only the selected one: reading every ledger on every
    // refresh would make a project with a long history slow to open.
    const taskId = store.selected;
    if (taskId !== null) {
      await store.load(taskId);
    }
    render();
  };

  /**
   * Opens the native diff for a changed file.
   *
   * The left side is the *first* checkpoint of the task — the workspace as it was
   * before the agent touched anything — because the question a reviewer asks is
   * "what did this task do", not "what did its most recent step do".
   */
  const openChange = async (path: string): Promise<void> => {
    const root = deps.workspaceRoot();
    if (root === null) {
      return;
    }
    const current = Uri.file(`${root}/${path}`);
    const taskId = store.selected;
    const checkpoints = taskId === null ? null : checkpointsFor(taskId);

    if (taskId === null || checkpoints === null) {
      await window.showTextDocument(current, { preview: true });
      return;
    }

    const all = await checkpoints.list(taskId);
    const first = all[0];
    if (first === undefined) {
      // No snapshot to compare against. Said out loud rather than shown as a diff
      // with an empty half, which would read as "this file was created".
      void window.showInformationMessage(
        'CodeRelay has no checkpoint for this task, so there is nothing to compare against. ' +
          'Checkpoints need a git repository with at least one commit.',
      );
      await window.showTextDocument(current, { preview: true });
      return;
    }

    await openCheckpointDiff(first.commit, path, current);
  };

  context.subscriptions.push(
    store,
    statusBar,
    taskView,
    diffProvider,
    window.registerWebviewViewProvider(TASK_VIEW_ID, taskView, {
      // The draft in the composer survives the view being hidden, which is what
      // `getState`/`setState` in the client is for. Retaining the whole context
      // would keep a hidden webview's DOM alive for no additional benefit.
      webviewOptions: { retainContextWhenHidden: false },
    }),
    window.registerTreeDataProvider(TASKS_VIEW_ID, tasksTree),
    window.registerTreeDataProvider(CHANGES_VIEW_ID, changesTree),
    window.registerTreeDataProvider(MODELS_VIEW_ID, modelsTree),
    workspace.registerTextDocumentContentProvider(CHECKPOINT_SCHEME, diffProvider),
    // One subscription, every surface. A view that refreshed itself on its own
    // schedule would drift out of step with the others.
    store.onDidChange(render),
    // Settings decide which models exist and what they can do, so an edit must be
    // visible without a reload.
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('coderelay')) {
        render();
      }
    }),
  );

  return {
    store,
    taskView,
    refresh,
    render,
    openChange,
    checkpointsFor,
    attachContext: (chip: string): void => taskView.attachContext(chip),
    requestApproval: (req: { requestId: string; command?: string; reason?: string; risk?: string }): void =>
      taskView.requestApproval(req),
    dispose(): void {
      checkpointStores.clear();
    },
  };
}

/** Reveals the task view, for the status bar and the focus keybinding. */
export async function focusTaskView(): Promise<void> {
  await commands.executeCommand(`${TASK_VIEW_ID}.focus`);
}
