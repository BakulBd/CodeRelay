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
import { present, type BlockedReason, type SessionSummary, type TaskViewModel } from '../webview/present.js';
import { parseInbound, type Inbound, type TaskMode } from '../webview/protocol.js';
import type { SetupViewModel } from '../setup/present.js';
import { renderShell } from '../webview/shell.js';
import type { TaskStore } from '../state/store.js';

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
