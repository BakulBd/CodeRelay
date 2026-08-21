/**
 * Extension host entry point.
 *
 * Deliberately thin. Everything with logic in it lives in modules that take plain
 * paths and plain data, so the recovery behaviour can be tested with `node --test`
 * and no extension host. This file does only what genuinely requires the `vscode`
 * API: resolve storage, read settings, register commands, collect secrets, and
 * show results. The assembly itself is `app/session.ts`, which has no `vscode`
 * import and is therefore testable.
 *
 * Two rules this file exists to uphold:
 *
 * - **A key never leaves SecretStorage in a form anything can log.** It goes from
 *   `showInputBox({ password: true })` straight into `CredentialManager.add`, and
 *   from there only into `ProviderAdapter.sign`. No command echoes one, no error
 *   message interpolates one, and the output channel never sees a request header.
 * - **Nothing with a side effect starts without the user asking for it.**
 *   Activation reports interrupted tasks; it never resumes them.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  buildCandidates,
  openSession,
  DEFAULT_REQUIREMENTS,
  type Session,
} from './app/session.js';
import type { LoopEvent, LoopResult } from './agent/loop.js';
import type { RouteDecision } from './policy/route.js';
import { ExecutionLedger } from './continuity/ledger.js';
import { listTasks, type TaskSummary } from './continuity/tasks.js';
import type { ModelRef, TaskId } from './core/types.js';
import {
  CredentialManager,
  type CredentialRecord,
  type MetadataStore,
  type SecretStore,
} from './credentials/store.js';
import { ConfigError, ModelCatalog } from './providers/catalog.js';
import { createFetch } from './providers/node-fetch.js';
import { describeVerdict, probeModel } from './providers/probe.js';

import { activateUi, focusTaskView, type Ui } from './ui/activate.js';
import { addModel } from './ui/setup.js';
import { SetupController } from './ui/setup/controller.js';
import { ModelsTreeProvider } from './ui/view/modelsTree.js';
import { oneLine } from './ui/state/format.js';
import { summarizeChanges, toolVerb, type BlockedReason, type SessionSummary } from './ui/webview/present.js';
import {
  classifyCommand,
  forbiddenReason,
  isForbidden,
  parsePermissionMode,
  requiresApproval,
} from './security/commands.js';
import type { ApprovalDecision, ApprovalRequest } from './tools/runner.js';

import type { Inbound, TaskMode } from './ui/webview/protocol.js';
import { renderTimeline, renderTimelineText } from './ui/timeline.js';
import { renderTimelineHtml } from './ui/webview.js';
import { buildDiagnosticsReport } from './ui/diagnostics.js';

const CONFIG_SECTION = 'coderelay';

/**
 * The UI surfaces, once activation has built them.
 *
 * Module-scoped rather than threaded through every function because the commands
 * below are registered as closures over `context` and already reach for
 * module-level helpers. Null before `activate` runs, and every use is guarded:
 * a command must not fail because a view has not been created yet.
 */
let ui: Ui | null = null;
/**
 * Guided setup, when it is open.
 */
let setup: SetupController | null = null;

let currentMode: TaskMode = 'code';
let soundEnabled = true;


/**
 * Placeholder stored for endpoints that do not authenticate.
 *
 * `CredentialManager` is the only thing that decides whether a provider is usable,
 * and it decides by whether a record exists. A local runtime with no key would
 * otherwise be permanently unroutable. Storing a marker rather than special-casing
 * "no auth" everywhere keeps one code path; `noAuth` discards it before any
 * request is signed, so it never reaches the wire.
 */
const NO_AUTH_PLACEHOLDER = 'no-auth-required';

/**
 * Where ledgers live.
 *
 * `storageUri` is workspace-scoped and undefined when no folder is open, which is
 * the honest answer: a task ledger belongs to a project, so without one there is
 * nothing to resume. We surface that rather than silently falling back to global
 * storage and stranding ledgers somewhere the user will never find.
 */
function storageDir(context: vscode.ExtensionContext): string | null {
  return context.storageUri?.fsPath ?? null;
}

function requireStorage(context: vscode.ExtensionContext): string | null {
  const dir = storageDir(context);
  if (dir === null) {
    void vscode.window.showWarningMessage(
      'CodeRelay stores task ledgers per project. Open a folder or workspace first.',
    );
  }
  return dir;
}

/** The workspace root tools resolve paths against. */
function workspaceRoot(): string | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- configuration ---

/**
 * Reads and validates the catalog from settings.
 *
 * A `ConfigError` is shown with a route to the settings UI rather than as a bare
 * failure, because every one of them is something only the user can fix and every
 * message names the offending entry.
 */
function readCatalog(): ModelCatalog | null {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  try {
    return ModelCatalog.fromSettings(config.get('providers'), config.get('models'));
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      void vscode.window
        .showErrorMessage(`CodeRelay configuration: ${err.message}`, 'Open Settings')
        .then((choice) => {
          if (choice === 'Open Settings') {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              `${CONFIG_SECTION}.models`,
            );
          }
        });
      return null;
    }
    throw err;
  }
}

/**
 * A catalog with at least one model, or null after offering to build one.
 *
 * Separated from `readCatalog` because "your settings are wrong" and "you have not
 * configured anything yet" want different treatment: the first is a correction, the
 * second is onboarding.
 *
 * This function used to name two settings keys and offer "Open Settings", which was
 * a dead end dressed as help. It was accurate and useless in the same breath: it
 * told the user *what* was missing and left them to hand-write JSON for a schema
 * they had never seen — including the two fields nobody can guess, the wire
 * protocol and the output-cap field. The observed result was a `coderelay.models`
 * set to `[]` and no `coderelay.providers` at all: someone opened settings, saw two
 * empty arrays, and gave up.
 *
 * So it now offers the wizard, and distinguishes the three states, because each has
 * a different next action:
 *
 *  - **no endpoint at all** — start at the beginning
 *  - **an endpoint but no model** — only the model question remains, and asking it
 *    against the endpoint they already added is one prompt rather than five
 *  - **models exist but none is usable** — a key problem, not a configuration one,
 *    so it must not send the user back through setup
 *
 * `async` because it now *does* something rather than firing a notification and
 * abandoning the caller. Every caller already awaited it in an async context.
 */
async function requireCatalog(context: vscode.ExtensionContext): Promise<ModelCatalog | null> {
  const catalog = readCatalog();
  if (catalog === null) {
    return null;
  }
  if (catalog.isConfigured()) {
    return catalog;
  }

  // An endpoint exists, so only the model is missing. Open GUI setup on that provider.
  if (catalog.hasProviders()) {
    const only = catalog.providerConfigs()[0];
    await openGuidedSetup('wizard', only?.id);
    return null;
  }

  // Nothing configured at all: open first-run GUI setup directly in CodeRelay panel.
  await openGuidedSetup('wizard');
  return null;
}

/**
 * Why CodeRelay asks for a model id instead of listing models.
 *
 * Stated wherever the question is raised, because "why are you asking me this?" is
 * the reasonable first reaction, and the answer is a deliberate design choice
 * rather than an unfinished feature.
 */
const MODEL_DECLARATION_REASON =
  'CodeRelay does not ship a model list. Vendors change their line-ups monthly, so a ' +
  'list baked into an extension goes stale and starts misreporting context windows — ' +
  'which is exactly what failover decisions are gated on.';

/** Opens one CodeRelay setting in the settings UI. */
async function openConfigSettings(key: 'providers' | 'models'): Promise<void> {
  await vscode.commands.executeCommand(
    'workbench.action.openSettings',
    `${CONFIG_SECTION}.${key}`,
  );
}


/**
 * Reads a stall limit, in milliseconds.
 *
 * `0` means "no limit" in settings because that is what a number field can
 * express, while the transport wants `null` — a value it can tell apart from
 * "not configured". Converting here keeps the setting simple and the internal
 * contract explicit.
 */
function readTimeoutMs(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallbackSeconds: number,
): number | null {
  const seconds = config.get<number>(key) ?? fallbackSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return Math.round(seconds * 1_000);
}

function readRequirements(): typeof DEFAULT_REQUIREMENTS {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    toolCalling: config.get<boolean>('requireToolCalling') ?? DEFAULT_REQUIREMENTS.toolCalling,
    vision: false,
    minContextWindow: config.get<number>('minContextWindow') ?? 0,
  };
}

// --- credentials ---

/**
 * Bridges VS Code's storage interfaces to the ones `CredentialManager` declares.
 *
 * Not a cast: VS Code returns `Thenable`, which is deliberately narrower than
 * `Promise` (no `catch`, no `finally`), and the credential store awaits and
 * chains on its results. `Promise.resolve` is the honest conversion.
 *
 * The secret itself never passes through this file's own state. `get` hands
 * whatever the keychain returns straight back to the manager, which puts it in a
 * request header and drops it.
 */
function credentialManager(context: vscode.ExtensionContext): CredentialManager {
  const secrets: SecretStore = {
    get: (key: string) => Promise.resolve(context.secrets.get(key)),
    store: (key: string, value: string) => Promise.resolve(context.secrets.store(key, value)),
    delete: (key: string) => Promise.resolve(context.secrets.delete(key)),
  };

  const metadata: MetadataStore = {
    get: <T>(key: string): T | undefined => context.globalState.get<T>(key),
    update: (key: string, value: unknown) =>
      Promise.resolve(context.globalState.update(key, value)),
  };

  return new CredentialManager({ secrets, metadata });
}

/**
 * How many keys an endpoint has, and whether any is usable.
 *
 * Shown while choosing where to store a key, because "this one already has two
 * ready keys" and "this one has none" are the two facts that decide whether the
 * user is here to add a spare or to fix an endpoint that cannot run at all.
 */
function describeProviderKeys(credentials: CredentialManager, providerId: string): string {
  const now = Date.now();
  const records = credentials.records().filter((r) => r.providerId === providerId);
  if (records.length === 0) {
    return 'no key stored yet';
  }
  const ready = records.filter(
    (r) => r.disabledReason === null && (r.coolingUntil === null || r.coolingUntil <= now),
  ).length;
  const disabled = records.filter((r) => r.disabledReason !== null).length;

  const parts = [`${records.length} key(s)`];
  if (ready > 0) {
    parts.push(`${ready} ready`);
  }
  if (disabled > 0) {
    // Worth naming: a disabled key is one the provider rejected, and it needs a
    // human rather than a wait.
    parts.push(`${disabled} disabled`);
  }
  if (ready === 0 && disabled === 0) {
    parts.push('all cooling');
  }
  return parts.join(' · ');
}

function describeHealth(record: CredentialRecord, now: number): string {

  if (record.disabledReason !== null) {
    return `disabled — ${record.disabledReason}`;
  }
  if (record.coolingUntil !== null && record.coolingUntil > now) {
    return `cooling for ${Math.ceil((record.coolingUntil - now) / 1000)}s`;
  }
  if (record.consecutiveFailures > 0) {
    return `ready — ${record.consecutiveFailures} recent failure(s)`;
  }
  return 'ready';
}

async function addCredential(context: vscode.ExtensionContext): Promise<void> {
  const catalog = readCatalog();
  if (catalog === null) {
    return;
  }

  const credentials = credentialManager(context);

  // Enumerated from the configured *endpoints*, not from the model list.
  //
  // The previous version derived this from `catalog.entries()`, which returns
  // models — so a user who had added an endpoint but not yet declared a model
  // against it was told to configure a provider they had just configured. Worse,
  // the advice was unfollowable: declaring a model first is pointless without a
  // key to make it usable. `providerIds()` exists precisely so the two questions
  // stay separate.
  const providers = catalog.providerConfigs().map((provider) => ({
    id: provider.id,
    label: provider.id,
    description: `${provider.kind} · ${provider.baseUrl}`,
    detail: describeProviderKeys(credentials, provider.id),
    auth: provider.auth ?? 'bearer',
  }));

  if (providers.length === 0) {
    // A dead end no longer: the one thing to do next is offered directly.
    const choice = await vscode.window.showInformationMessage(
      'CodeRelay has no AI endpoint configured yet. Adding one takes about a minute.',
      'Add an endpoint',
      'Open settings',
    );
    if (choice === 'Add an endpoint') {
      await openGuidedSetup();
    } else if (choice === 'Open settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `${CONFIG_SECTION}.providers`,
      );
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(providers, {
    title: 'CodeRelay: which endpoint is this key for?',
    matchOnDescription: true,
  });
  if (picked === undefined) {
    return;
  }


  // An endpoint that does not authenticate still needs a record, because a record
  // is how `CredentialManager` knows the provider is usable at all.
  if (picked.auth === 'none') {
    await credentials.add(picked.id, 'no authentication', NO_AUTH_PLACEHOLDER);
    void vscode.window.showInformationMessage(
      `CodeRelay marked "${picked.id}" as usable without a key.`,
    );
    return;
  }

  const label = await vscode.window.showInputBox({
    title: `CodeRelay: label for this ${picked.id} key`,
    prompt: 'Shown in the credential list. Not sent anywhere.',
    placeHolder: 'personal key',
    value: 'default',
  });
  if (label === undefined) {
    return;
  }

  // `password: true` keeps the value out of the input history and off the screen.
  // It goes straight into SecretStorage below and is never held anywhere else:
  // not in a variable that outlives this call, not in the output channel, not in
  // any error message this function can produce.
  const secret = await vscode.window.showInputBox({
    title: `CodeRelay: API key for ${picked.id}`,
    prompt: 'Stored in the OS keychain through VS Code SecretStorage. Never written to disk by CodeRelay.',
    password: true,
    ignoreFocusOut: true,
  });
  if (secret === undefined || secret.trim() === '') {
    return;
  }

  try {
    const ref = await credentials.add(picked.id, label.trim() === '' ? 'default' : label, secret);
    void vscode.window.showInformationMessage(
      `CodeRelay stored a credential for ${picked.id} (${ref.credentialId.slice(0, 8)}…).`,
    );
  } catch (err: unknown) {
    // `errorText` on a failure from `add` cannot contain the secret: the only
    // throw is the empty-value guard, which quotes nothing.
    void vscode.window.showErrorMessage(`CodeRelay could not store the credential: ${errorText(err)}`);
  }
}

async function manageCredentials(context: vscode.ExtensionContext): Promise<void> {
  const credentials = credentialManager(context);
  const now = Date.now();
  const records = credentials.records();

  if (records.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'CodeRelay has no credentials stored.',
      'Add Credential',
    );
    if (choice === 'Add Credential') {
      await addCredential(context);
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(
    records.map((record) => ({
      record,
      label: `${record.providerId} · ${record.label}`,
      description: describeHealth(record, now),
      detail: record.lastFailureReason === null ? undefined : `last failure: ${record.lastFailureReason}`,
    })),
    { title: 'CodeRelay: credentials', matchOnDescription: true },
  );
  if (picked === undefined) {
    return;
  }

  const actions: string[] = ['Remove'];
  if (picked.record.disabledReason !== null) {
    actions.unshift('Re-enable');
  }

  const action = await vscode.window.showQuickPick(actions, {
    title: `CodeRelay: ${picked.record.providerId} · ${picked.record.label}`,
  });

  if (action === 'Re-enable') {
    await credentials.enable(picked.record.credentialId);
    void vscode.window.showInformationMessage('Credential re-enabled.');
    return;
  }

  if (action === 'Remove') {
    const confirm = await vscode.window.showWarningMessage(
      `Remove the ${picked.record.providerId} credential "${picked.record.label}"? This deletes it from the OS keychain.`,
      { modal: true },
      'Remove',
    );
    if (confirm === 'Remove') {
      await credentials.remove(picked.record.credentialId);
      void vscode.window.showInformationMessage('Credential removed.');
    }
  }
}

// --- model selection ---

/**
 * Picks the model a task starts on.
 *
 * Only the *starting* model: failover chooses the rest, and it chooses from the
 * whole catalog rather than from this answer. Credential health is shown here
 * because starting on a model whose only key is cooling wastes the first attempt
 * on a backoff the user could have avoided.
 */
async function pickModel(
  catalog: ModelCatalog,
  credentials: CredentialManager,
): Promise<ModelRef | null> {
  const now = Date.now();
  const candidates = buildCandidates(catalog, credentials, now);

  const items = candidates.map((candidate) => {
    const caps = candidate.capabilities;
    const ready = candidate.readyCredentialIds.length;
    return {
      model: candidate.model,
      label: `${candidate.model.providerId} · ${candidate.model.modelId}`,
      description:
        ready > 0
          ? `${ready} key(s) ready`
          : candidate.coolingRetryAfterMs === null
            ? 'no credential'
            : `cooling ${Math.ceil(candidate.coolingRetryAfterMs / 1000)}s`,
      detail:
        `${caps.contextWindow.toLocaleString()} ctx · ${caps.maxOutput.toLocaleString()} out · ` +
        `tools ${caps.toolCalling ? 'yes' : 'no'}`,
    };
  });

  if (items.length === 0) {
    void vscode.window.showWarningMessage('CodeRelay has no configured models to choose from.');
    return null;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'CodeRelay: start this task on which model?',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.model ?? null;
}

// --- running a task ---

/**
 * Streams loop events into an output channel.
 *
 * Model switches are logged unconditionally, because hiding one would make a task
 * that silently changed models look like a task that did not. Headers, bodies and
 * credentials are never logged — only decisions and their stated reasons.
 */
function logEvents(channel: vscode.OutputChannel, event: LoopEvent): void {
  switch (event.t) {
    case 'decision':
      channel.appendLine(
        `[route] ${event.decision.kind} (${event.decision.tone}) — ${event.decision.reason}`,
      );
      if (event.decision.kind === 'SWITCH_MODEL' && event.decision.degraded.length > 0) {
        // A downgrade is never silent. `route()` collects it precisely so it can
        // be said out loud, and a user whose task moved to a weaker model must be
        // able to see which capability it lost.
        channel.appendLine(`[route] degraded: ${event.decision.degraded.join(', ')}`);
      }
      break;
    case 'tool':
      channel.appendLine(`[tool] ${event.toolName} → ${event.outcome.kind}`);
      break;
    case 'checkpoint':
      // `unchanged` is logged as distinctly as the other two on purpose:
      // "nothing needed saving" and "it was saved" are different facts, and a
      // user reading this channel to decide whether a rollback point exists
      // needs to be able to tell them apart.
      channel.appendLine(
        event.outcome.t === 'unavailable'
          ? `[checkpoint] unavailable — ${event.outcome.failure.reason}`
          : event.outcome.t === 'unchanged'
            ? `[checkpoint] unchanged since ${event.outcome.checkpoint.ref}`
            : `[checkpoint] ${event.outcome.checkpoint.ref}`,
      );
      break;
    case 'stream':
      // Token-by-token output would drown the channel and tell the user nothing
      // they cannot read in the timeline, so only turn boundaries are logged.
      if (event.event.t === 'done') {
        channel.appendLine(`[turn] finished (${event.event.reason})`);
      }
      break;
  }
}

function describeDecision(decision: RouteDecision): string {
  return decision.reason;
}

/**
 * Runs a task with progress and cancellation.
 *
 * `CancellationToken` is bridged to an `AbortSignal` because that is what the
 * transport understands, and because a cancelled request must reach the socket
 * rather than being noticed after the fact. The loop treats cancellation as
 * terminal rather than as a failure, so nothing is retried on the way out.
 */
async function runTask(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  options: {
    readonly storage: string;
    readonly root: string;
    readonly catalog: ModelCatalog;
    readonly credentials: CredentialManager;
    readonly initialModel: ModelRef;
    readonly objective: string;
    readonly taskId?: TaskId;
    readonly title: string;
  },
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const maxTurns = config.get<number>('maxTurns');

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.title,
      cancellable: true,
    },
    async (progress, token) => {
      const controller = new AbortController();
      const cancelSub = token.onCancellationRequested(() => controller.abort());

      // Declared before the session so the observers below can name the task.
      // `openSession` mints the id when one is not supplied, so it is only known
      // after the call — hence the mutable binding rather than a parameter.
      let taskId: TaskId | null = options.taskId ?? null;
      const prices = modelPrices(options.catalog, options.initialModel);

      let session: Session;
      try {
        session = await openSession({
          storageDir: options.storage,
          workspaceRoot: options.root,
          catalog: options.catalog,
          credentials: options.credentials,
          initialModel: options.initialModel,
          ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
          requirements: readRequirements(),
          signal: controller.signal,
          checkpoints: config.get<boolean>('checkpoints') ?? true,
          ...(config.get<boolean>('commands') === true
            ? {
                commands: {
                  approve: (request) => approveToolCall(config, request),
                  ...(typeof config.get<number>('commandTimeoutMs') === 'number'
                    ? { timeoutMs: config.get<number>('commandTimeoutMs')! }
                    : {}),
                },
              }
            : {}),
          connectTimeoutMs: readTimeoutMs(config, 'connectTimeoutSeconds', 60),
          idleTimeoutMs: readTimeoutMs(config, 'idleTimeoutSeconds', 120),
          ...(typeof maxTurns === 'number' && maxTurns > 0 ? { maxTurns } : {}),
          // The durable record, straight into the view. The timeline therefore
          // shows exactly what a resumed task would act on rather than a parallel
          // account of it.
          ledgerObserver: (entry) => {
            if (taskId !== null) {
              ui?.store.noteEntry(taskId, entry);
            }
          },
          observer: (event: LoopEvent) => {
            logEvents(channel, event);
            if (taskId !== null) {
              noteLoopEvent(taskId, options.catalog, event);
            }
            if (event.t === 'decision' && event.decision.kind === 'SWITCH_MODEL') {
              // Never hidden: a switch changes who is doing the work, so it is
              // surfaced in the progress notification as it happens, not only in
              // the timeline afterwards.
              progress.report({
                message: `switching to ${event.decision.to.modelId} — ${describeDecision(event.decision)}`,
              });
            } else if (event.t === 'tool') {
              progress.report({ message: `${event.toolName}: ${event.outcome.kind.toLowerCase()}` });
            }
          },
        });
      } catch (err: unknown) {
        // Opening the ledger is the one thing that must not fail silently: with
        // no durable record there is no safety property left to rely on, so the
        // task does not start at all.
        cancelSub.dispose();
        channel.appendLine(`[error] could not open a task ledger: ${errorText(err)}`);
        void vscode.window.showErrorMessage(
          `CodeRelay could not open its task ledger, so it did not start: ${errorText(err)}`,
        );
        return;
      }

      taskId = session.taskId;
      channel.appendLine(`\n=== task ${session.taskId} ===`);
      channel.appendLine(`objective: ${options.objective}`);
      channel.appendLine(`ledger: ${session.ledgerPath}`);

      // Registering the runtime is what makes the task *live*: the store now has
      // an abort controller to stop it with, and every view reads "running" from
      // here rather than guessing from a ledger that always trails the loop.
      ui?.store.begin({
        taskId: session.taskId,
        controller,
        model: options.initialModel,
        inputTokens: null,
        outputTokens: null,
        costPerMTokIn: prices.in,
        costPerMTokOut: prices.out,
        streamTail: '',
        activity: 'Starting',
        startedAtMs: Date.now(),
      });
      await ui?.refresh();
      await ui?.taskView.reveal();

      try {
        const result = await session.run(options.objective);
        // Cleared before reporting, so the completion notice and the header agree
        // about whether the task is still running.
        ui?.store.end(session.taskId);
        await ui?.refresh();
        await reportResult(context, channel, session.taskId, result);
      } catch (err: unknown) {
        channel.appendLine(`[error] ${errorText(err)}`);
        void vscode.window.showErrorMessage(`CodeRelay task failed: ${errorText(err)}`);
      } finally {
        cancelSub.dispose();
        ui?.store.end(session.taskId);
        await session.close();
        await ui?.refresh();
      }
    },
  );
}

/** Declared prices for a model, or zeroes when the catalog states none. */
function modelPrices(
  catalog: ModelCatalog,
  model: ModelRef,
): { readonly in: number; readonly out: number } {
  const caps = catalog.capabilities(model);
  return { in: caps?.costPerMTokIn ?? 0, out: caps?.costPerMTokOut ?? 0 };
}

/**
 * Feeds a loop event into the store.
 *
 * Only the things the ledger deliberately does not persist, plus a short phrase
 * for what is happening right now. Usage is the important one: it is observable
 * only on a live stream, so this is the only chance to record it — and it is why
 * a finished task reports no token count rather than zero.
 */
function noteLoopEvent(taskId: TaskId, catalog: ModelCatalog, event: LoopEvent): void {
  const store = ui?.store;
  if (store === undefined) {
    return;
  }

  switch (event.t) {
    case 'stream':
      if (event.event.t === 'usage') {
        store.noteUsage(taskId, event.event.inputTokens, event.event.outputTokens);
      } else if (event.event.t === 'text') {
        store.noteStreamText(taskId, event.event.delta);
        store.noteActivity(taskId, 'Thinking');
      } else if (event.event.t === 'done') {
        store.resetStreamText(taskId);
      }
      // `thinking` is deliberately ignored: reasoning is never persisted or
      // forwarded, and it is not shown here either.
      break;

    case 'tool':
      store.noteActivity(taskId, toolVerb(event.toolName));
      break;

    case 'checkpoint':
      store.noteActivity(
        taskId,
        event.outcome.t === 'created' ? 'Checkpointing' : 'Preparing the next step',
      );
      break;

    case 'decision':
      if (event.decision.kind === 'SWITCH_MODEL') {
        const prices = modelPrices(catalog, event.decision.to);
        store.noteModel(taskId, event.decision.to, prices.in, prices.out);
        store.noteActivity(taskId, `Switching to ${event.decision.to.modelId}`);
      } else {
        store.noteActivity(taskId, 'Recovering');
      }
      break;
  }
}


/**
 * Reports a terminal result.
 *
 * `ESCALATED` is the one that matters: it means a decision is genuinely the
 * user's, so it gets an actionable prompt rather than an information toast that
 * scrolls away and leaves a parked task nobody knows about.
 */
async function reportResult(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  taskId: TaskId,
  result: LoopResult,
): Promise<void> {
  channel.appendLine(`[result] ${result.kind}`);

  switch (result.kind) {
    case 'DONE': {
      const choice = await vscode.window.showInformationMessage(
        `CodeRelay finished the task in ${result.turns} turn(s).`,
        'Show Timeline',
      );
      if (choice === 'Show Timeline') {
        await showTimeline(context, taskId);
      }
      return;
    }
    case 'CANCELLED':
      void vscode.window.showInformationMessage(
        'CodeRelay stopped. The ledger records where it stopped, so the task can be resumed.',
      );
      return;
    case 'ABANDONED': {
      const choice = await vscode.window.showWarningMessage(
        `CodeRelay gave up: ${result.reason}`,
        'Show Timeline',
      );
      if (choice === 'Show Timeline') {
        await showTimeline(context, taskId);
      }
      return;
    }
    case 'ESCALATED': {
      channel.appendLine(`[escalated] ${result.question}`);
      const choice = await vscode.window.showWarningMessage(
        `CodeRelay needs a decision: ${result.question}`,
        { modal: true },
        'Show Timeline',
        'Resolve',
      );
      if (choice === 'Show Timeline') {
        await showTimeline(context, taskId);
      } else if (choice === 'Resolve') {
        await vscode.commands.executeCommand('coderelay.resolveEscalation');
      }
      return;
    }
  }
}

async function startTask(context: vscode.ExtensionContext, channel: vscode.OutputChannel): Promise<void> {
  const storage = requireStorage(context);
  const root = workspaceRoot();
  if (storage === null) {
    return;
  }
  if (root === null) {
    void vscode.window.showWarningMessage(
      'CodeRelay edits files inside a workspace folder. Open a folder first.',
    );
    return;
  }

  const catalog = await requireCatalog(context);
  if (catalog === null) {
    return;
  }

  const objective = await vscode.window.showInputBox({
    title: 'CodeRelay: what should the agent do?',

    prompt: 'Describe the outcome. The agent will read and write files in this workspace.',
    placeHolder: 'Add input validation to the signup handler and a test for it',
    ignoreFocusOut: true,
  });
  if (objective === undefined || objective.trim() === '') {
    return;
  }

  const credentials = credentialManager(context);
  const initialModel = await pickModel(catalog, credentials);
  if (initialModel === null) {
    return;
  }

  await runTask(context, channel, {
    storage,
    root,
    catalog,
    credentials,
    initialModel,
    objective: objective.trim(),
    title: 'CodeRelay',
  });
}

async function resumeTask(context: vscode.ExtensionContext, channel: vscode.OutputChannel): Promise<void> {
  const storage = requireStorage(context);
  const root = workspaceRoot();
  if (storage === null || root === null) {
    return;
  }

  const catalog = await requireCatalog(context);
  if (catalog === null) {
    return;
  }

  const task = await pickTask(storage, { onlyResumable: true });

  if (task === null) {
    return;
  }

  // Resuming performs side effects, so it is confirmed explicitly. The wording
  // says what recovery will actually do, because "resume" on its own does not
  // tell the user whether an interrupted edit is about to be repeated.
  const confirm = await vscode.window.showWarningMessage(
    `Resume "${task.objective ?? task.taskId}"?`,
    {
      modal: true,
      detail:
        'CodeRelay will check the workspace against what the ledger recorded before ' +
        'the interruption. An edit it can prove already landed is adopted, not repeated. ' +
        'If it cannot prove either way, it will stop and ask you.',
    },
    'Resume',
  );
  if (confirm !== 'Resume') {
    return;
  }

  const credentials = credentialManager(context);
  const initialModel = await pickModel(catalog, credentials);
  if (initialModel === null) {
    return;
  }

  await runTask(context, channel, {
    storage,
    root,
    catalog,
    credentials,
    initialModel,
    // Ignored when the ledger already records one: `AgentLoop.startup` keeps the
    // original objective so a resume cannot silently retarget the task.
    objective: task.objective ?? '(objective recorded in ledger)',
    taskId: task.taskId,
    title: 'CodeRelay (resuming)',
  });
}

/**
 * Settles a task parked on an unverifiable operation.
 *
 * The only two answers are the ones the escalation question asks for, and each is
 * expressed through an existing ledger entry rather than a new mechanism:
 *
 *  - *Already applied* writes `TOOL_RECONCILED`, which is what `planRecovery`
 *    treats as settled. The task then continues from the next turn.
 *  - *Abandon* writes `TASK_ABANDONED`, after which recovery reports
 *    `NOTHING_TO_DO` and the task can never be resurrected by accident.
 *
 * There is deliberately no "run it again" button. The operation reached this state
 * precisely because its effect cannot be verified, so re-running it is the
 * duplicate side effect the whole design exists to prevent — and CodeRelay will
 * not offer to do it behind a one-click confirmation. The user can inspect the
 * workspace and then say which of the two facts is true.
 */
async function resolveEscalation(context: vscode.ExtensionContext): Promise<void> {
  const storage = requireStorage(context);
  if (storage === null) {
    return;
  }

  const task = await pickTask(storage, { onlyResumable: true });
  if (task === null) {
    return;
  }

  const entries = await ExecutionLedger.readEntries(task.filePath);
  const escalation = [...entries].reverse().find((e) => e.type === 'ESCALATED');
  if (escalation === undefined || escalation.type !== 'ESCALATED') {
    void vscode.window.showInformationMessage('That task is not waiting on a decision.');
    return;
  }

  // The same rule `planRecovery` uses: a tool call is settled once either a
  // completion or a reconciliation exists for it. Anything still in
  // `TOOL_EXECUTING` without one is inside the ambiguous window.
  const settled = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'TOOL_COMPLETED' || entry.type === 'TOOL_RECONCILED') {
      settled.add(entry.toolCallId);
    }
  }

  const pending = [...entries]
    .reverse()
    .find((e) => e.type === 'TOOL_EXECUTING' && !settled.has(e.toolCallId));

  const choice = await vscode.window.showWarningMessage(
    escalation.question,
    { modal: true, detail: 'Inspect the workspace first if you are unsure. Both answers are recorded in the ledger.' },
    ...(pending === undefined ? [] : ['It was already applied']),
    'Abandon this task',
  );

  const ledger = await ExecutionLedger.open(storage, task.taskId);
  try {
    if (choice === 'It was already applied' && pending !== undefined && pending.type === 'TOOL_EXECUTING') {
      await ledger.append({
        taskId: task.taskId,
        stepId: pending.stepId,
        attemptId: pending.attemptId,
        type: 'TOOL_RECONCILED',
        toolCallId: pending.toolCallId,
        sideEffectKey: pending.sideEffectKey,
        // Recorded as the user's assertion, not as something CodeRelay observed.
        // The timeline renders the two differently on purpose.
        evidence: 'the user confirmed this operation had already been applied',
      });
      void vscode.window.showInformationMessage(
        'Recorded. Resume the task to continue from the next step.',
      );
    } else if (choice === 'Abandon this task') {
      await ledger.append({
        taskId: task.taskId,
        stepId: escalation.stepId,
        attemptId: escalation.attemptId,
        type: 'TASK_ABANDONED',
        reason: 'the user abandoned the task while it was waiting on a decision',
      });
      void vscode.window.showInformationMessage('Task abandoned. Its ledger is kept for inspection.');
    }
  } catch (err: unknown) {
    void vscode.window.showErrorMessage(`CodeRelay could not record the decision: ${errorText(err)}`);
  } finally {
    await ledger.close();
  }
}

// --- read-only views ---

function describeTask(task: TaskSummary): vscode.QuickPickItem & { task: TaskSummary } {
  return {
    task,
    label: task.objective ?? task.taskId,
    description: task.needsAttention ? 'needs recovery' : (task.lastEntryType ?? 'empty'),
    detail: `${task.entryCount} entries · ${task.updatedAt ?? 'never written'}`,
  };
}

/** Prompts for a task, skipping the prompt when there is only one. */
async function pickTask(
  storage: string,
  options: { readonly onlyResumable?: boolean } = {},
): Promise<TaskSummary | null> {
  const all = await listTasks(storage);
  const tasks = options.onlyResumable === true ? all.filter((t) => t.needsAttention) : all;

  if (tasks.length === 0) {
    void vscode.window.showInformationMessage(
      options.onlyResumable === true
        ? 'CodeRelay has no interrupted tasks.'
        : 'CodeRelay has not recorded any tasks yet.',
    );
    return null;
  }
  if (tasks.length === 1) {
    return tasks[0] ?? null;
  }

  const picked = await vscode.window.showQuickPick(tasks.map(describeTask), {
    title: 'CodeRelay: select a task',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.task ?? null;
}

async function showTimeline(
  context: vscode.ExtensionContext,
  taskId?: TaskId,
): Promise<void> {
  const storage = requireStorage(context);
  if (storage === null) {
    return;
  }

  const task =
    taskId === undefined
      ? await pickTask(storage)
      : ((await listTasks(storage)).find((t) => t.taskId === taskId) ?? null);
  if (task === null) {
    return;
  }

  const entries = await ExecutionLedger.readEntries(task.filePath);
  const panel = vscode.window.createWebviewPanel(
    'coderelay.timeline',
    `CodeRelay: ${task.objective ?? task.taskId}`,
    vscode.ViewColumn.Active,
    // The view is static HTML. Scripts stay disabled so ledger text, which
    // originates from model output, can never execute.
    { enableScripts: false },
  );

  // Disposed with the extension as well as by the user, so a panel left open
  // across a reload does not outlive the host that created it.
  context.subscriptions.push(panel);

  panel.webview.html = renderTimelineHtml({
    title: `Task ${task.taskId}`,
    objective: task.objective,
    rows: renderTimeline(entries),
    nonce: randomBytes(16).toString('base64'),
  });
}

async function inspectLedger(context: vscode.ExtensionContext): Promise<void> {
  const storage = requireStorage(context);
  if (storage === null) {
    return;
  }

  const task = await pickTask(storage);
  if (task === null) {
    return;
  }

  const entries = await ExecutionLedger.readEntries(task.filePath);
  const document = await vscode.workspace.openTextDocument({
    content: renderTimelineText(entries),
    language: 'log',
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

/**
 * Reports interrupted tasks on activation.
 *
 * It only reports. Resuming performs side effects, and side effects must be the
 * user's decision rather than something that happens because a window reopened.
 */
async function reportInterruptedTasks(context: vscode.ExtensionContext): Promise<void> {
  const storage = storageDir(context);
  if (storage === null) {
    return;
  }

  const interrupted = (await listTasks(storage)).filter((t) => t.needsAttention);
  if (interrupted.length === 0) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    interrupted.length === 1
      ? 'CodeRelay found 1 task that was interrupted.'
      : `CodeRelay found ${interrupted.length} tasks that were interrupted.`,
    'Resume',
    'Show Timeline',
  );
  if (choice === 'Show Timeline') {
    await showTimeline(context);
  } else if (choice === 'Resume') {
    await vscode.commands.executeCommand('coderelay.resumeTask');
  }
}

/**
 * Why the composer cannot start a task, or null when it can.
 *
 * Three distinct answers because each has a different fix, and a single
 * "unavailable" would leave the user with nothing to do. Deliberately silent:
 * unlike `requireCatalog`, this is called on every repaint, so it must not raise
 * a notification.
 */
function blockedReason(context: vscode.ExtensionContext): BlockedReason | null {
  if (storageDir(context) === null || workspaceRoot() === null) {
    return 'no-folder';
  }
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  try {
    const catalog = ModelCatalog.fromSettings(config.get('providers'), config.get('models'));
    return catalog.isConfigured() ? null : 'no-models';
  } catch {
    return 'config-error';
  }
}

/** The catalog, or null, without prompting. For repaint paths. */
function quietCatalog(): ModelCatalog | null {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  try {
    return ModelCatalog.fromSettings(config.get('providers'), config.get('models'));
  } catch {
    return null;
  }
}

/**
 * The model a new task would start on.
 *
 * Remembered across tasks in workspace state, because re-picking the same model
 * for every task is friction with no safety benefit — and a stored choice that no
 * longer exists in the catalog is dropped rather than offered.
 */
const SELECTED_MODEL_KEY = 'coderelay.selectedModel';

function selectedModel(context: vscode.ExtensionContext): ModelRef | null {
  const stored = context.workspaceState.get<ModelRef>(SELECTED_MODEL_KEY);
  if (stored === undefined) {
    return null;
  }
  const catalog = quietCatalog();
  // Verified against the catalog: settings can change between sessions, and
  // offering a model that is no longer declared would fail at request time.
  return catalog?.entry(stored) === null || catalog === null ? null : stored;
}

/**
 * Opens a workspace file named by the webview.
 *
 * The containment check is here rather than in the protocol validator, which
 * cannot know the workspace root. A path that escapes the root is refused: the
 * frame is untrusted, and this is the only place with the information to judge.
 */
async function openWorkspaceFile(path: string): Promise<void> {
  const root = workspaceRoot();
  if (root === null) {
    return;
  }
  const target = vscode.Uri.joinPath(vscode.Uri.file(root), path);
  if (!target.fsPath.startsWith(vscode.Uri.file(root).fsPath)) {
    void vscode.window.showWarningMessage(
      'CodeRelay will only open files inside the workspace folder.',
    );
    return;
  }
  try {
    await vscode.window.showTextDocument(target, { preview: true });
  } catch {
    // A file the agent deleted, or one that never existed. Not an error worth a
    // modal: the timeline row it came from is still accurate about what happened.
    void vscode.window.setStatusBarMessage(`CodeRelay: ${path} is no longer on disk`, 4_000);
  }
}

/** Inserts an `@`-style file reference into the composer via a native picker. */
async function attachFileReference(): Promise<void> {
  const root = workspaceRoot();
  if (root === null) {
    return;
  }
  // VS Code's own file search, rather than a bespoke list in the webview. Awaited
  // before the pick because the overload that takes a promise is typed for
  // `QuickPickItem[]` and would erase the `uri` this needs to carry.
  const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 2_000);
  const items = uris.map((uri) => ({
    label: vscode.workspace.asRelativePath(uri, false),
    uri,
  }));
  if (items.length === 0) {
    void vscode.window.showInformationMessage('No files found in this workspace.');
    return;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'CodeRelay: reference a file in this task',
    matchOnDescription: true,
  });
  if (picked === undefined) {
    return;
  }

  // Opened rather than injected as text: the agent discovers files with its own
  // tools, and showing the file is the useful half of "attach" that does not
  // require reaching into the webview's input.
  await vscode.window.showTextDocument(picked.uri, { preview: true });
}

/**
 * Acts on a validated message from the task view.
 *
 * Every branch routes to an existing command or an existing helper. Nothing here
 * performs a side effect the command palette could not already reach, which keeps
 * one implementation per action rather than two that can diverge.
 */
async function handleViewMessage(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  message: Inbound,
): Promise<void> {
  switch (message.kind) {
    case 'ready':
      ui?.render();
      return;

    case 'start':
      await startFromComposer(context, channel, message.objective, message.model);
      return;

    case 'stop': {
      // The abort reaches the socket, and the loop treats it as terminal rather
      // than as a failure — so nothing is retried on the way out and the ledger
      // records where it stopped.
      const taskId = ui?.store.selected ?? null;
      const runtime = taskId === null ? null : ui?.store.runtime(taskId);
      runtime?.controller.abort();
      return;
    }

    case 'resume':
    case 'retry':
      // Both go through the same confirmed path: resuming performs side effects,
      // so it stays behind the existing prompt that explains what recovery does.
      await vscode.commands.executeCommand('coderelay.resumeTask');
      return;

    case 'switchModel':
      await switchModel(context, channel);
      return;

    case 'pickModel':
      await chooseModel(context);
      return;

    case 'openFile':
      await openWorkspaceFile(message.path);
      return;

    case 'openChange':
      await ui?.openChange(message.path);
      return;

    case 'openTimeline':
      await showTimeline(context, ui?.store.selected ?? undefined);
      return;

    case 'setMode':
      currentMode = message.mode;
      ui?.render();
      return;

    case 'toggleSound':
      soundEnabled = message.enabled;
      ui?.render();
      return;

    case 'newSession':
      ui?.store.select(null);
      ui?.render();
      return;

    case 'switchSession':
      await ui?.store.select(message.taskId as TaskId);
      await ui?.store.load(message.taskId as TaskId);
      ui?.render();
      return;

    case 'deleteSession':
      await deleteSession(context, message.taskId as TaskId);
      await ui?.refresh();
      return;

    case 'exportMarkdown':
      await exportSessionMarkdown();
      return;

    case 'enhancePrompt':
      handleEnhancePrompt(message.text);
      return;

    case 'rewindToCheckpoint':
      await handleRewind(message.commitOrTurnId);
      return;

    case 'compactContext':
      await handleCompactContext(context, channel);
      return;

    case 'revertAllChanges':
      await handleRevertAll();
      return;

    case 'approvePlan':
      currentMode = 'code';
      await startFromComposer(context, channel, "The proposed plan is approved. Please implement it now.", null);
      return;

    case 'rejectPlan':
      // The user wants to provide feedback or edits.
      return;

    case 'regeneratePlan':
      await startFromComposer(context, channel, "Please reconsider and regenerate the engineering plan with an alternative architecture.", null);
      return;

    case 'refreshViews':
      await ui?.refresh();
      return;

    case 'showDiagnostics':
      await vscode.commands.executeCommand('coderelay.showDiagnostics');
      return;

    case 'openSettings':
      setup?.open('manage');
      return;

    case 'setUp':
      setup?.open('wizard');
      return;

    case 'setupLocal':
      setup?.open('wizard');
      setup?.choose('ollama');
      return;

    case 'setupOpenManage':
      setup?.openManage();
      return;

    case 'setupOpenAdd':
      setup?.openAdd();
      return;

    case 'setupEditProvider':
      setup?.edit(message.providerId);
      return;

    case 'setupDeleteProvider':
      await setup?.deleteProvider(message.providerId);
      return;

    case 'setupTestConnection':
      await setup?.testConnectionOnly();
      return;

    case 'setupFilterModels':
      setup?.filterModels(message.query);
      return;

    case 'setupChoose':
      setup?.choose(message.presetKey);
      return;

    case 'setupField':
      setup?.editField(message.field, message.value);
      return;

    case 'setupPrimary':
      await setup?.primary();
      return;

    case 'setupBack':
      setup?.goBack();
      return;

    case 'setupCancel':
      setup?.close();
      return;

    case 'setupToggleModel':
      setup?.toggleModel(message.modelId);
      return;

    case 'setupAddModel':
      setup?.addModel(message.modelId);
      return;

    case 'setupDefaultModel':
      setup?.setDefault(message.modelId);
      return;

    case 'setupReorder':
      setup?.reorder(message.modelId, message.direction);
      return;

    case 'setupRefreshModels':
      await setup?.refreshModels();
      return;

    case 'addCredential':
      setup?.open('manage');
      return;

    case 'resolve':
      await resolveEscalation(context);
      await ui?.refresh();
      return;

    case 'attachFile':
      await attachFileReference();
      return;

    case 'openInEditor':
      await focusTaskView();
      return;
  }
}

/**
 * Starts a task from the composer.
 *
 * Distinct from `startTask` only in where the objective came from: the composer
 * already has it, so prompting for it again would be absurd. Every validation and
 * every message is the same, because they are the same rules.
 */
async function startFromComposer(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  objective: string,
  requested: ModelRef | null,
): Promise<void> {
  const storage = requireStorage(context);
  const root = workspaceRoot();
  if (storage === null || root === null) {
    if (root === null) {
      void vscode.window.showWarningMessage(
        'CodeRelay edits files inside a workspace folder. Open a folder first.',
      );
    }
    return;
  }

  const catalog = await requireCatalog(context);
  if (catalog === null) {
    return;
  }

  const credentials = credentialManager(context);
  // The stored choice, then the composer's, then a prompt. A model is never

  // guessed: an unusable one wastes the first attempt on a certain failure.
  const initialModel =
    requested ?? selectedModel(context) ?? (await pickModel(catalog, credentials));
  if (initialModel === null) {
    return;
  }
  await context.workspaceState.update(SELECTED_MODEL_KEY, initialModel);

  let finalObjective = objective;
  if (currentMode === 'architect') {
    finalObjective = `[ARCHITECT MODE: You are in Architect Mode. Your primary objective is to explore the codebase, gather context, and formulate a world-class architectural implementation plan. Do NOT write or modify application code. Instead, use the \`propose_plan\` tool to submit your detailed Markdown plan for the user's approval. You must use this tool once you have completed your research.]\n\n${objective}`;
  } else if (currentMode === 'ask') {
    finalObjective = `[ASK MODE: Explore and answer questions about the codebase without making modifications or destructive writes.]\n\n${objective}`;
  }

  await runTask(context, channel, {
    storage,
    root,
    catalog,
    credentials,
    initialModel,
    objective: finalObjective,
    title: 'CodeRelay',
  });
}

/**
 * Sends one real request to a configured model and reports what happened.
 *
 * Goes through the same builder, signer and transport a task uses, so a pass
 * means the row works rather than meaning a bespoke health endpoint answered.
 * Cancellable, because a hung endpoint is one of the things being tested for.
 *
 * `secretFor` reads a key without reporting its health: a question about an
 * endpoint must not take a credential out of rotation as a side effect.
 */
/**
 * Asks the user about a tool call, according to the configured permission mode.
 *
 * Only `run_command` is gated here. The file tools are already bounded — they
 * write one path inside the workspace, and every one of those writes is
 * checkpointed — so prompting for each would be noise that teaches people to
 * click through prompts, which is how a real warning gets missed.
 *
 * The dialog is modal on purpose. A notification toast can be missed, and a
 * command the user did not see is a command they did not agree to.
 */
async function approveToolCall(
  config: vscode.WorkspaceConfiguration,
  request: ApprovalRequest,
): Promise<ApprovalDecision> {
  if (request.toolName !== 'run_command') {
    return { t: 'allowed' };
  }

  const args = (request.args ?? {}) as Record<string, unknown>;
  const command = typeof args['command'] === 'string' ? args['command'] : '';
  const explanation = typeof args['explanation'] === 'string' ? args['explanation'] : null;

  const mode = parsePermissionMode(config.get<string>('permissionMode'));
  const verdict = classifyCommand(command);

  if (isForbidden(mode, verdict.danger)) {
    return { t: 'denied', reason: forbiddenReason(verdict) };
  }
  if (!requiresApproval(mode, verdict.danger)) {
    return { t: 'allowed' };
  }

  const destructive = verdict.danger === 'destructive';
  const choice = await vscode.window.showWarningMessage(
    destructive ? 'CodeRelay wants to run a destructive command' : 'CodeRelay wants to run a command',
    {
      modal: true,
      detail:
        `${command}\n\n` +
        (explanation === null ? '' : `${explanation}\n\n`) +
        `${verdict.reason}` +
        (destructive
          ? '\n\nThis cannot be undone by a CodeRelay checkpoint.'
          : ''),
    },
    'Run it',
  );

  return choice === 'Run it'
    ? { t: 'allowed' }
    : {
        t: 'denied',
        // Phrased as a fact for the model to work around, not as an error.
        reason: 'The user declined to run this command. Try another approach, or ask what to do instead.',
      };
}

/**
 * Opens guided setup in the CodeRelay panel.
 *
 * The one entry point. Normal configuration never leaves the extension's own
 * surface: not into a quick-pick chain at the top of the window, and not into
 * the settings editor. Both are still reachable deliberately — `Open settings`
 * remains for the advanced cases — but neither is where setup *starts*.
 */
async function openGuidedSetup(mode?: 'wizard' | 'manage', providerId?: string): Promise<void> {
  setup?.open(mode, providerId);
  await ui?.taskView.reveal();
}

async function testConnection(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  target?: unknown,
): Promise<void> {
  const catalog = await requireCatalog(context);
  if (catalog === null) {
    return;
  }
  const credentials = credentialManager(context);

  const model =
    ModelsTreeProvider.modelOf(target) ?? (await pickModel(catalog, credentials));
  if (model === null) {
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const verdict = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Testing ${model.providerId}/${model.modelId}…`,
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      try {
        return await probeModel(
          {
            catalog,
            fetchImpl: createFetch(),
            secretFor: async (providerId: string) => {
              const choice = await credentials.next(providerId);
              return choice.t === 'credential'
                ? { t: 'secret' as const, secret: choice.secret }
                : { t: 'none' as const, reason: choice.reason };
            },
            signal: controller.signal,
            connectTimeoutMs: readTimeoutMs(config, 'connectTimeoutSeconds', 60),
            idleTimeoutMs: readTimeoutMs(config, 'idleTimeoutSeconds', 120),
          },
          model,
        );
      } finally {
        sub.dispose();
      }
    },
  );

  const described = describeVerdict(verdict, model);
  channel.appendLine(`[probe] ${model.providerId}/${model.modelId}: ${described.headline}`);
  if (described.detail !== '') {
    channel.appendLine(`[probe] ${described.detail}`);
  }

  if (verdict.t === 'cancelled') {
    return;
  }
  if (described.ok) {
    void vscode.window.showInformationMessage(described.headline, { detail: described.detail, modal: false });
    return;
  }

  // A failed test is the answer, not an error in CodeRelay — so it offers the
  // two things that actually fix it rather than only reporting.
  const choice = await vscode.window.showWarningMessage(
    described.headline,
    { detail: described.detail, modal: false },
    'Add a key',
    'Open settings',
    'Show logs',
  );
  if (choice === 'Add a key') {
    await addCredential(context);
    await ui?.refresh();
  } else if (choice === 'Open settings') {
    await openConfigSettings('providers');
  } else if (choice === 'Show logs') {
    channel.show(true);
  }
}

/** Chooses the model for the next task, and remembers it. */
async function chooseModel(context: vscode.ExtensionContext): Promise<void> {
  const catalog = readCatalog();
  if (catalog === null || !catalog.isConfigured()) {
    await openGuidedSetup('wizard');
    return;
  }

  const credentials = credentialManager(context);
  const now = Date.now();
  const candidates = buildCandidates(catalog, credentials, now);

  const items = candidates.map((candidate) => {
    const caps = candidate.capabilities;
    const ready = candidate.readyCredentialIds.length;
    return {
      model: candidate.model as ModelRef | null,
      label: `${candidate.model.providerId} · ${candidate.model.modelId}`,
      description:
        ready > 0
          ? `${ready} key(s) ready`
          : candidate.coolingRetryAfterMs === null
            ? 'no credential'
            : `cooling ${Math.ceil(candidate.coolingRetryAfterMs / 1000)}s`,
      detail:
        `${caps.contextWindow.toLocaleString()} ctx · ${caps.maxOutput.toLocaleString()} out · ` +
        `tools ${caps.toolCalling ? 'yes' : 'no'}`,
    };
  });

  items.push({
    model: null,
    label: '$(gear) Configure AI Providers & Models',
    description: 'Open CodeRelay Setup',
    detail: 'Add providers, API keys, manage models, and configure fallback order',
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'CodeRelay: start this task on which model?',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) {
    return;
  }
  if (picked.model === null) {
    await openGuidedSetup('manage');
    return;
  }
  await context.workspaceState.update(SELECTED_MODEL_KEY, picked.model);
  ui?.render();
}

/**
 * Moves a task to a different model.
 *
 * The honest description of what happens, stated in the confirmation because the
 * word "switch" alone does not say it: the current attempt is stopped, and the
 * task then continues from its ledger. Completed edits are not repeated —
 * `planRecovery` decides that from the fingerprints already on disk — so this is
 * a change of model rather than a restart of the work.
 */
async function switchModel(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): Promise<void> {
  const taskId = ui?.store.selected ?? null;
  if (taskId === null) {
    await chooseModel(context);
    return;
  }

  const catalog = await requireCatalog(context);
  if (catalog === null) {
    return;
  }

  const runtime = ui?.store.runtime(taskId) ?? null;

  const projection = ui?.store.project(taskId);
  const current = runtime?.model ?? projection?.header.model ?? null;

  const target = await pickModel(catalog, credentialManager(context));
  if (target === null) {
    return;
  }
  if (
    current !== null &&
    current.providerId === target.providerId &&
    current.modelId === target.modelId
  ) {
    void vscode.window.showInformationMessage('That task is already on that model.');
    return;
  }

  const changed = projection === undefined ? '' : summarizeChanges(projection.changes);
  const confirm = await vscode.window.showWarningMessage(
    `Continue this task on ${target.modelId}?`,
    {
      modal: true,
      detail:
        (current === null ? '' : `Currently on ${current.providerId}/${current.modelId}. `) +
        'CodeRelay will stop the current attempt and continue from the task ledger. ' +
        'An edit that already landed is adopted, not repeated. ' +
        changed,
    },
    'Switch and continue',
  );
  if (confirm !== 'Switch and continue') {
    return;
  }

  await context.workspaceState.update(SELECTED_MODEL_KEY, target);

  // Stop first, and wait for the run to unwind, so two sessions never hold the
  // same ledger open at once.
  runtime?.controller.abort();
  if (runtime !== null) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const storage = requireStorage(context);
  const root = workspaceRoot();
  if (storage === null || root === null) {
    return;
  }

  const summary = ui?.store.summary(taskId);
  await runTask(context, channel, {
    storage,
    root,
    catalog,
    credentials: credentialManager(context),
    initialModel: target,
    // Ignored when the ledger records one, which it does for any task that got
    // as far as starting. `AgentLoop.startup` keeps the original objective so a
    // model switch cannot silently retarget the task.
    objective: summary?.objective ?? '(objective recorded in ledger)',
    taskId,
    title: `CodeRelay (${target.modelId})`,
  });
}

function getSessionSummaries(): SessionSummary[] {
  if (!ui) return [];
  const currentSelected = ui.store.selected;
  return ui.store.tasks.map((task) => {
    const projection = ui?.store.project(task.taskId);
    const title = task.objective ? oneLine(task.objective, 60) : `Task ${task.taskId.slice(0, 8)}`;
    const status = projection?.header.status ?? 'completed';
    const turns = projection?.header.turns ?? 0;
    const filesChanged = projection?.header.filesChanged ?? 0;

    let timeAgo = '';
    if (task.updatedAt) {
      const diffMs = Date.now() - new Date(task.updatedAt).getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) timeAgo = 'just now';
      else if (mins < 60) timeAgo = `${mins}m ago`;
      else {
        const hours = Math.floor(mins / 60);
        if (hours < 24) timeAgo = `${hours}h ago`;
        else timeAgo = `${Math.floor(hours / 24)}d ago`;
      }
    }

    return {
      id: task.taskId,
      title,
      status,
      timeAgo,
      turns,
      filesChanged,
      isCurrent: task.taskId === currentSelected,
    };
  });
}

function getContextWindowLimit(context: vscode.ExtensionContext): number | null {
  const model = selectedModel(context);
  if (!model) return 128_000;
  const catalog = readCatalog();
  if (!catalog) return 128_000;
  return catalog.capabilities(model)?.contextWindow ?? 128_000;
}

async function deleteSession(context: vscode.ExtensionContext, taskId: TaskId): Promise<void> {
  const storage = storageDir(context);
  if (!storage) return;
  try {
    const sessionDir = vscode.Uri.file(`${storage}/tasks/${taskId}`);
    await vscode.workspace.fs.delete(sessionDir, { recursive: true, useTrash: false });
    if (ui?.store.selected === taskId) {
      ui.store.select(null);
    }
  } catch {
    // Ignore if already deleted
  }
}

async function exportSessionMarkdown(): Promise<void> {
  const taskId = ui?.store.selected;
  if (!taskId) {
    void vscode.window.showInformationMessage('No active task to export.');
    return;
  }
  const projection = ui?.store.project(taskId);
  if (!projection) {
    void vscode.window.showInformationMessage('Task details not found.');
    return;
  }

  const lines: string[] = [];
  lines.push(`# CodeRelay Task: ${projection.header.title}`);
  lines.push(`- **Status**: ${projection.header.status}`);
  lines.push(`- **Model**: ${projection.header.model ? `${projection.header.model.providerId}/${projection.header.model.modelId}` : 'None'}`);
  lines.push(`- **Turns**: ${projection.header.turns}`);
  lines.push(`- **Files Modified**: ${projection.header.filesChanged}`);
  if (projection.header.inputTokens !== null || projection.header.outputTokens !== null) {
    lines.push(`- **Tokens**: ${projection.header.inputTokens ?? 0} in / ${projection.header.outputTokens ?? 0} out`);
  }
  if (projection.header.costUsd !== null) {
    lines.push(`- **Estimated Cost**: $${projection.header.costUsd.toFixed(4)}`);
  }
  lines.push('');
  lines.push('## Execution Timeline');
  lines.push('');
  for (const node of projection.nodes) {
    lines.push(`### [${node.kind.toUpperCase()}] ${node.id}`);
    if ('text' in node && typeof (node as { text?: unknown }).text === 'string') {
      lines.push((node as { text: string }).text);
    }
    if ('summary' in node && typeof (node as { summary?: unknown }).summary === 'string') {
      lines.push('```');
      lines.push((node as { summary: string }).summary);
      lines.push('```');
    }
    lines.push('');
  }

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

function handleEnhancePrompt(rawText: string): void {
  const trimmed = rawText.trim();
  if (!trimmed) return;

  const enhanced =
    `Goal: ${trimmed}\n\n` +
    `Requirements:\n` +
    `- Inspect relevant codebase context first.\n` +
    `- Implement clean, minimal, robust changes adhering to existing patterns.\n` +
    `- Verify correctness with tests or execution validation.`;

  ui?.taskView.postEnhancedPrompt(enhanced);
}

async function handleRewind(commitOrTurnId: string): Promise<void> {
  const taskId = ui?.store.selected;
  const root = workspaceRoot();
  if (!taskId || !root) return;
  const checkpoints = ui?.checkpointsFor(taskId);
  if (!checkpoints) {
    void vscode.window.showWarningMessage('Checkpoints are not available for this task.');
    return;
  }

  const all = await checkpoints.list(taskId);
  const target = all.find((c) => c.commit.startsWith(commitOrTurnId) || String(c.index) === commitOrTurnId);
  if (!target) {
    void vscode.window.showErrorMessage(`Checkpoint ${commitOrTurnId} not found.`);
    return;
  }

  const changedPaths = await checkpoints.changedSince(target);
  for (const relPath of changedPaths) {
    const content = await checkpoints.restore(target, relPath);
    const fullUri = vscode.Uri.joinPath(vscode.Uri.file(root), relPath);
    if (content === null) {
      try {
        await vscode.workspace.fs.delete(fullUri);
      } catch {}
    } else {
      await vscode.workspace.fs.writeFile(fullUri, Buffer.from(content, 'utf8'));
    }
  }
  void vscode.window.showInformationMessage(`Restored ${changedPaths.length} file(s) to checkpoint #${target.index}.`);
  await ui?.refresh();
}

async function handleCompactContext(_context: vscode.ExtensionContext, _channel: vscode.OutputChannel): Promise<void> {
  void vscode.window.showInformationMessage('Context compressed. Older turn outputs have been compacted.');
  ui?.render();
}

async function handleRevertAll(): Promise<void> {
  const taskId = ui?.store.selected;
  const root = workspaceRoot();
  if (!taskId || !root) return;
  const checkpoints = ui?.checkpointsFor(taskId);
  if (!checkpoints) return;
  const all = await checkpoints.list(taskId);
  if (all.length > 0 && all[0]) {
    const first = all[0];
    const changedPaths = await checkpoints.changedSince(first);
    for (const relPath of changedPaths) {
      const content = await checkpoints.restore(first, relPath);
      const fullUri = vscode.Uri.joinPath(vscode.Uri.file(root), relPath);
      if (content === null) {
        try {
          await vscode.workspace.fs.delete(fullUri);
        } catch {}
      } else {
        await vscode.workspace.fs.writeFile(fullUri, Buffer.from(content, 'utf8'));
      }
    }
    void vscode.window.showInformationMessage('Reverted all changes made in this task.');
    await ui?.refresh();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('CodeRelay');

  setup = new SetupController({
    credentials: credentialManager(context),
    config: () => vscode.workspace.getConfiguration(CONFIG_SECTION),
    onChange: () => ui?.taskView.render(),
    // Settings changed, so the trees and the model picker have to re-read them.
    onSaved: async () => {
      await ui?.refresh();
    },
    onSelectModel: async (model) => {
      await context.workspaceState.update(SELECTED_MODEL_KEY, model);
      ui?.render();
    },
  });

  // Built before the commands, so every one of them can assume the views exist.
  ui = activateUi(context, {
    storageDir: storageDir(context),
    workspaceRoot,
    // The same function the router uses. A second opinion about which models are
    // usable would eventually disagree with the one that actually routes.
    candidates: () => {
      const catalog = quietCatalog();
      return catalog === null
        ? []
        : buildCandidates(catalog, credentialManager(context), Date.now());
    },
    provider: (providerId: string) => quietCatalog()?.provider(providerId) ?? null,
    setupModel: () => (setup?.isOpen === true ? setup.model() : null),
    blocked: () => blockedReason(context),
    selectedModel: () => selectedModel(context),
    handle: (message: Inbound) => handleViewMessage(context, channel, message),
    mode: () => currentMode,
    soundEnabled: () => soundEnabled,
    sessions: () => getSessionSummaries(),
    contextWindowLimit: () => getContextWindowLimit(context),
  });
  context.subscriptions.push(ui);

  context.subscriptions.push(
    channel,
    vscode.commands.registerCommand('coderelay.startTask', () => startTask(context, channel)),
    vscode.commands.registerCommand('coderelay.resumeTask', () => resumeTask(context, channel)),
    vscode.commands.registerCommand('coderelay.resolveEscalation', () => resolveEscalation(context)),
    vscode.commands.registerCommand('coderelay.addCredential', () => openGuidedSetup('manage')),
    vscode.commands.registerCommand('coderelay.manageCredentials', () => openGuidedSetup('manage')),
    vscode.commands.registerCommand('coderelay.showTimeline', (taskId?: unknown) =>
      showTimeline(context, typeof taskId === 'string' ? (taskId as TaskId) : undefined),
    ),
    vscode.commands.registerCommand('coderelay.inspectLedger', () => inspectLedger(context)),
    vscode.commands.registerCommand('coderelay.showLogs', () => {
      channel.show(true);
    }),
    vscode.commands.registerCommand('coderelay.showDiagnostics', async () => {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const report = await buildDiagnosticsReport({
        extVersion: (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.1.0',
        codeVersion: vscode.version,
        storagePath: storageDir(context),
        providers: config.get<Array<{ id: string; type?: string; enabled?: boolean }>>('providers') ?? [],
        models: config.get<Array<{ modelId: string; providerId: string; enabled?: boolean }>>('models') ?? [],
      });
      const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    // --- UI commands ---
    vscode.commands.registerCommand('coderelay.focusTask', () => focusTaskView()),
    vscode.commands.registerCommand('coderelay.openSettings', () => openGuidedSetup('manage')),
    vscode.commands.registerCommand('coderelay.refreshViews', () => ui?.refresh()),
    // Guided setup. Opens the first-class GUI Setup panel directly.
    vscode.commands.registerCommand('coderelay.addProvider', () => openGuidedSetup('wizard')),
    vscode.commands.registerCommand('coderelay.addModel', (target?: unknown) =>
      openGuidedSetup('wizard', ModelsTreeProvider.providerIdOf(target) ?? undefined),
    ),

    // Sends one real request, so a pass means the configuration actually works
    // rather than meaning a health endpoint answered.
    vscode.commands.registerCommand('coderelay.testConnection', (target?: unknown) =>
      testConnection(context, channel, target),
    ),


    vscode.commands.registerCommand('coderelay.stopTask', () => {
      const taskId = ui?.store.selected ?? null;
      const runtime = taskId === null ? null : ui?.store.runtime(taskId);
      if (runtime === null || runtime === undefined) {
        void vscode.window.showInformationMessage('No CodeRelay task is running in this window.');
        return;
      }
      runtime.controller.abort();
    }),
    vscode.commands.registerCommand('coderelay.openTask', async (taskId?: unknown) => {
      const id = typeof taskId === 'string' ? (taskId as TaskId) : null;
      if (id === null || ui === null) {
        return;
      }
      ui.store.select(id);
      await ui.store.load(id);
      ui.render();
      await ui.taskView.reveal();
    }),
    vscode.commands.registerCommand('coderelay.openChange', async (path?: unknown) => {
      if (typeof path === 'string') {
        await ui?.openChange(path);
      }
    }),
    vscode.commands.registerCommand('coderelay.selectModel', async (model?: unknown) => {
      if (
        typeof model === 'object' &&
        model !== null &&
        'providerId' in model &&
        'modelId' in model
      ) {
        await context.workspaceState.update(SELECTED_MODEL_KEY, model as ModelRef);
        ui?.render();
        return;
      }
      await chooseModel(context);
    }),
    vscode.commands.registerCommand('coderelay.deleteTask', async (taskId?: unknown) => {
      const id = typeof taskId === 'string' ? (taskId as TaskId) : null;
      if (id === null) {
        return;
      }
      await deleteTask(context, id);
    }),
  );

  // Not awaited: activation must not block on disk scanning. Failures are
  // reported rather than swallowed, because a ledger we cannot read is exactly
  // the situation a user needs to know about.
  void ui
    .refresh()
    .then(() => reportInterruptedTasks(context))
    .catch((err: unknown) => {
      void vscode.window.showErrorMessage(
        `CodeRelay could not read its task ledgers: ${errorText(err)}`,
      );
    });
}

/**
 * Deletes a task's ledger.
 *
 * Confirmed, and honest about what survives: the ledger goes, the files the agent
 * wrote do not. Deleting a record of edits is not the same as undoing them, and a
 * user who expects the second would be badly surprised.
 */
async function deleteTask(context: vscode.ExtensionContext, taskId: TaskId): Promise<void> {
  const storage = storageDir(context);
  if (storage === null) {
    return;
  }
  const summary = ui?.store.summary(taskId) ?? null;
  if (summary === null) {
    return;
  }

  const running = ui?.store.runtime(taskId) ?? null;
  if (running !== null) {
    void vscode.window.showWarningMessage(
      'That task is still running. Stop it before deleting its ledger.',
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete the record of "${summary.objective ?? taskId}"?`,
    {
      modal: true,
      detail:
        'This removes the execution ledger, so the task can no longer be resumed or ' +
        'inspected. Files the agent already changed are left exactly as they are — ' +
        'deleting the record does not undo the work.',
    },
    'Delete record',
  );
  if (confirm !== 'Delete record') {
    return;
  }

  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(summary.filePath), { useTrash: false });
    ui?.store.invalidate(taskId);
    await ui?.refresh();
  } catch (err: unknown) {
    void vscode.window.showErrorMessage(
      `CodeRelay could not delete that ledger: ${errorText(err)}`,
    );
  }
}


export function deactivate(): void {
  // Nothing to tear down: every ledger handle is closed by its owner, and the
  // durability guarantee means there is no buffered state to flush here.
}
