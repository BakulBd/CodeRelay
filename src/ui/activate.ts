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
import type { BlockedReason, SessionSummary } from './webview/present.js';
import type { Inbound, TaskMode } from './webview/protocol.js';
import type { SetupViewModel } from './setup/present.js';

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
    dispose(): void {
      checkpointStores.clear();
    },
  };
}

/** Reveals the task view, for the status bar and the focus keybinding. */
export async function focusTaskView(): Promise<void> {
  await commands.executeCommand(`${TASK_VIEW_ID}.focus`);
}
