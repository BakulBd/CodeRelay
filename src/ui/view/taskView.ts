/**
 * The task view: the webview in the sidebar.
 *
 * Thin on purpose. It owns three things and delegates everything else:
 *
 *  1. the HTML shell and the resource URIs it needs (`shell.ts`),
 *  2. turning state into the strings the client paints (`present.ts`),
 *  3. validating what comes back and forwarding it to a handler (`protocol.ts`).
 */
import { randomBytes } from 'node:crypto';
import {
  Uri,
  commands,
  window,
  type CancellationToken,
  type Disposable,
  type Webview,
  type WebviewView,
  type WebviewViewProvider,
  type WebviewViewResolveContext,
} from 'vscode';
import type { ModelRef } from '../../core/types.js';
import {
  present,
  type BlockedReason,
  type SessionSummary,
  type TaskViewModel,
  type CandidateModel,
  type ConfiguredProviderItem,
  type EndpointHealthItem,
} from '../webview/present.js';
import { parseInbound, type Inbound, type TaskMode } from '../webview/protocol.js';
import type { SetupViewModel } from '../setup/present.js';
import { renderShell } from '../webview/shell.js';
import type { TaskStore } from '../state/store.js';
import type { VerificationRun } from '../../verify/run.js';
import type { ContextSet } from '../../context/select.js';
import type { Selection } from '../../policy/select.js';
import type { NotificationEvent } from '../state/notifications.js';
import type { CodeRelaySettingsModel } from '../state/settings.js';
import type { McpServerConfig } from '../../tools/mcp.js';
import type { ToolPolicyRule } from '../../tools/policy.js';
import type { ContinuityScoreResult } from '../../continuity/metric.js';
import type { ScenarioBenchmarkResult } from '../../bench/recovery-bench.js';
import type { ChaosExperimentReport } from '../../bench/chaos.js';

export const TASK_VIEW_ID = 'coderelay.taskView';

/** What the host must supply for the view to describe the current state. */
export interface TaskViewDeps {
  readonly store: TaskStore;
  /** Why the composer is disabled, or null when it is usable. */
  readonly blocked: () => BlockedReason | null;
  /** The model a new task would start on. */
  readonly selectedModel: () => ModelRef | null;
  /** Acts on a validated message. Rejections are reported, never swallowed. */
  readonly handle: (message: Inbound) => void | Promise<void>;
  /** The setup panel's view model while guided setup is open, otherwise null. */
  readonly setupModel: () => SetupViewModel | null;
  readonly mode?: () => TaskMode;
  readonly soundEnabled?: () => boolean;
  readonly sessions?: () => readonly SessionSummary[];
  readonly contextWindowLimit?: () => number | null;
  /** The newest verification run for this workspace, or null when none. */
  readonly verification?: () => VerificationRun | null;
  /** True while checks are running. */
  readonly verifying?: () => boolean;
  /** The context set built for the active task. */
  readonly context?: () => ContextSet | null;
  /** Why CodeRelay chose the running model, or null when the user pinned it. */
  readonly selection?: () => Selection | null;
  readonly notifications?: () => readonly NotificationEvent[];
  readonly settings?: () => CodeRelaySettingsModel;
  readonly workspaceInfo?: () => { name: string; path: string; hasFolders: boolean };
  readonly activeNavTab?: () => string;
  readonly mcpServers?: () => readonly McpServerConfig[];
  readonly toolPolicies?: () => readonly ToolPolicyRule[];
  readonly candidates?: () => readonly CandidateModel[];
  readonly configuredProviders?: () => readonly ConfiguredProviderItem[];
  readonly health?: () => readonly EndpointHealthItem[];
  readonly continuityScore?: () => ContinuityScoreResult | null;
  readonly checkpointsList?: () => readonly { id: string; sequenceNumber: number; verified: boolean; reason: string; commitSha?: string; filesChanged: readonly string[] }[];
  readonly benchmarkResults?: () => ScenarioBenchmarkResult | null;
  readonly chaosReport?: () => ChaosExperimentReport | null;
}

export class TaskViewProvider implements WebviewViewProvider, Disposable {
  private view: WebviewView | null = null;
  private readonly disposables: Disposable[] = [];

  constructor(
    private readonly extensionUri: Uri,
    private readonly deps: TaskViewDeps,
  ) {}

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.view = null;
  }

  resolveWebviewView(
    view: WebviewView,
    _context: WebviewViewResolveContext,
    _token: CancellationToken,
  ): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(this.extensionUri, 'media')],
    };

    view.webview.html = this.html(view.webview);

    this.disposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseInbound(raw);
        if (message === null) {
          return;
        }
        void Promise.resolve(this.deps.handle(message)).catch((err: unknown) => {
          void window.showErrorMessage(
            `CodeRelay could not complete that action: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }),
    );

    this.disposables.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.render();
        }
      }),
    );

    view.onDidDispose(() => {
      this.view = null;
    });

    this.render();
  }

  /** Reveals the view, creating it if the user has never opened it. */
  async reveal(): Promise<void> {
    if (this.view !== null) {
      this.view.show(true);
      return;
    }
    await commands.executeCommand(`${TASK_VIEW_ID}.focus`);
  }

  /** Moves keyboard focus into the composer. */
  focusComposer(): void {
    this.view?.show(true);
  }

  postEnhancedPrompt(text: string): void {
    if (this.view !== null && this.view.visible) {
      void this.view.webview.postMessage({ kind: 'enhancedPrompt', text });
    }
  }

  /** Sends an attached context reference chip (e.g. @file.ts) to the composer. */
  attachContext(chip: string): void {
    if (this.view !== null && this.view.visible) {
      void this.view.webview.postMessage({ kind: 'attachContext', chip });
    }
  }

  /** Sends an interactive approval request to the panel. */
  requestApproval(request: { requestId: string; command?: string; reason?: string; risk?: string }): void {
    if (this.view !== null && this.view.visible) {
      void this.view.webview.postMessage({ kind: 'approvalRequest', ...request });
    }
  }

  /** Sends the current state to the client. */
  render(): void {
    const view = this.view;
    if (view === null || !view.visible) {
      return;
    }
    void view.webview.postMessage(this.model());
  }

  private model(): TaskViewModel | SetupViewModel {
    const setup = this.deps.setupModel();
    if (setup !== null) {
      return setup;
    }
    return this.taskModel();
  }

  private taskModel(): TaskViewModel {
    const { store } = this.deps;
    const taskId = store.selected;
    const runtime = taskId === null ? null : store.runtime(taskId);

    return present({
      taskId,
      projection: taskId === null ? null : store.project(taskId),
      live: runtime !== null,
      blocked: this.deps.blocked(),
      selectedModel: runtime?.model ?? this.deps.selectedModel(),
      activity: runtime?.activity ?? null,
      streamTail: runtime?.streamTail ?? null,
      mode: this.deps.mode ? this.deps.mode() : 'code',
      soundEnabled: this.deps.soundEnabled ? this.deps.soundEnabled() : true,
      sessions: this.deps.sessions ? this.deps.sessions() : [],
      contextWindowLimit: this.deps.contextWindowLimit ? this.deps.contextWindowLimit() : null,
      verification: this.deps.verification ? this.deps.verification() : null,
      verifying: this.deps.verifying ? this.deps.verifying() : false,
      context: this.deps.context ? this.deps.context() : null,
      selection: this.deps.selection ? this.deps.selection() : null,
      notifications: this.deps.notifications ? this.deps.notifications() : [],
      settings: this.deps.settings ? this.deps.settings() : undefined,
      workspaceInfo: this.deps.workspaceInfo ? this.deps.workspaceInfo() : undefined,
      activeNavTab: this.deps.activeNavTab ? this.deps.activeNavTab() : undefined,
      mcpServers: this.deps.mcpServers ? this.deps.mcpServers() : [],
      toolPolicies: this.deps.toolPolicies ? this.deps.toolPolicies() : [],
      candidates: this.deps.candidates ? this.deps.candidates() : [],
      configuredProviders: this.deps.configuredProviders ? this.deps.configuredProviders() : [],
      health: this.deps.health ? this.deps.health() : [],
      continuityScore: this.deps.continuityScore ? this.deps.continuityScore() : null,
      checkpointsList: this.deps.checkpointsList ? this.deps.checkpointsList() : [],
      benchmarkResults: this.deps.benchmarkResults ? this.deps.benchmarkResults() : null,
      chaosReport: this.deps.chaosReport ? this.deps.chaosReport() : null,
    });
  }

  private html(webview: Webview): string {
    const media = Uri.joinPath(this.extensionUri, 'media');
    return renderShell({
      cspSource: webview.cspSource,
      styleUri: webview.asWebviewUri(Uri.joinPath(media, 'task.css')).toString(),
      scriptUri: webview.asWebviewUri(Uri.joinPath(media, 'task.js')).toString(),
      nonce: randomBytes(16).toString('base64'),
    });
  }
}
