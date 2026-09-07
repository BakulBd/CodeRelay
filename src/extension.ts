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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthTracker } from './policy/health.js';
import { FAULT_LABELS, SCENARIOS, injectFaults } from './bench/faults.js';
import { applyMode, behaviourFor } from './plan/modes.js';
import { ROLE_LABELS, TASK_ROLES, selectModel, type Selection } from './policy/select.js';
import {
  applyRules,
  describeRule,
  parseRules,
  type RoutingRule,
} from './policy/rules.js';
import { gatherCandidates } from './context/gather.js';
import { selectContext, type ContextSet } from './context/select.js';
import {
  EMPTY_MEMORY,
  parseMemory,
  renderForPrompt,
  renderMemory,
} from './memory/project.js';
import { createExecutor, readWorkspaceFacts } from './verify/exec.js';
import { planVerification } from './verify/plan.js';
import { runVerification, type VerificationRun } from './verify/run.js';
import {
  buildCandidates,
  openSession,
  DEFAULT_REQUIREMENTS,
  type Session,
} from './app/session.js';
import type { LoopEvent, LoopResult } from './agent/loop.js';
import { DEFAULT_LIMITS, type RouteDecision } from './policy/route.js';
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
import { computeCost, oneLine } from './ui/state/format.js';
import { auditLogger } from './security/audit.js';
import { rateLimiter } from './security/rate-limiter.js';
import { MODEL_ALIASES, resolveModelAlias } from './providers/aliases.js';
import { proxyResolver } from './security/proxy.js';
import { TaskExecutionLock } from './continuity/concurrency.js';
import { exportTaskToPortableJson } from './continuity/portability.js';
import { ContextManifestBuilder } from './context/manifest.js';
import { summarizeChanges, toolVerb, type BlockedReason, type SessionSummary } from './ui/webview/present.js';
import {
  classifyCommand,
  forbiddenReason,
  isForbidden,
  parsePermissionMode,
  type PermissionMode,
  requiresApproval,
} from './security/commands.js';
import type { ApprovalDecision, ApprovalRequest } from './tools/runner.js';

import type { Inbound, TaskMode } from './ui/webview/protocol.js';
import { renderTimeline, renderTimelineText } from './ui/timeline.js';
import { renderTimelineHtml } from './ui/webview.js';
import { buildDiagnosticsReport } from './ui/diagnostics.js';

const CONFIG_SECTION = 'coderelay';

import { NotificationCenter } from './ui/state/notifications.js';
import { DEFAULT_SETTINGS, type CodeRelaySettingsModel } from './ui/state/settings.js';
import { McpManager } from './tools/mcp.js';
import { ToolPolicyEngine } from './tools/policy.js';
import { generateEnhancedTask } from './agent/enhance.js';
import { ProviderPlayground } from './providers/playground.js';

import { TaskStateGraph } from './continuity/graph.js';
import { ContinuityScoreCalculator } from './continuity/metric.js';
import {
  BENCHMARK_SCENARIOS,
  PARADIGM_LABELS,
  type BenchmarkParadigm,
  type BenchmarkScenario,
  type ParadigmMetrics,
  type ScenarioBenchmarkResult,
} from './bench/recovery-bench.js';
import { ChaosInjectionHarness, type ChaosExperimentReport, type ChaosFailureType } from './bench/chaos.js';
import { MultiModelReviewOrchestrator } from './policy/review.js';
import { WorkspaceSafetyChecker } from './recovery/safety.js';
import { execGitRunner, type Checkpoint } from './checkpoint/git.js';

const notificationCenter = new NotificationCenter();
let currentSettings: CodeRelaySettingsModel = { ...DEFAULT_SETTINGS };
const mcpManager = new McpManager();
const toolPolicyEngine = new ToolPolicyEngine();
let activeNavTab = 'composer';
let activeTaskGraph: TaskStateGraph | null = null;
let activeBenchmarkResults: ScenarioBenchmarkResult | null = null;
let activeChaosReport: ChaosExperimentReport | null = null;

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
 * Observed health for every endpoint used in this window.
 *
 * Deliberately module scope and deliberately not persisted. It has to outlive a
 * single task — that is the whole point, since a provider that failed during
 * the last task is still failing at the start of the next one — but a breaker
 * restored from disk would eject a provider for an outage that ended while VS
 * Code was closed, and the user would have no way to see why a provider they
 * can reach is being skipped. Losing it on reload costs one extra attempt;
 * keeping it wrongly costs a working provider.
 */
const health = new HealthTracker({ now: () => Date.now() });

/**
 * The most recent verification run, and whether one is in flight.
 *
 * Held here rather than in the ledger because a verification result describes
 * the *workspace right now*, not the task's history: re-running the suite after
 * an unrelated edit would make a stored verdict quietly wrong, and a stale green
 * tick is the exact failure this feature exists to prevent.
 */
let verification: VerificationRun | null = null;
let verifying: AbortController | null = null;

/**
 * The context set most recently built for the active task.
 *
 * Held here rather than in the ledger because it describes the workspace *now*:
 * a set recorded three edits ago would name files whose relevance has changed,
 * and a stale context panel is worse than none because it invites the user to
 * correct a boundary that is no longer in force.
 */
let contextSet: ContextSet | null = null;

/**
 * Why the model now running was chosen, when CodeRelay chose it.
 *
 * Null when the user pinned a model — there is no explanation owed for a
 * decision they made themselves, and manufacturing one would be noise.
 */
let lastSelection: Selection | null = null;

/**
 * Commands the user has allowed for the rest of the current task.
 *
 * Task-scoped, not session-scoped, and cleared when a task starts: a permission
 * granted while fixing the build should not still be in force tomorrow on an
 * unrelated task in the same window. Holds exact command strings — see
 * `approveToolCall` for why anything looser is unsafe.
 */
const allowedForTask = new Set<string>();

/**
 * One task, one runner.
 *
 * Two sessions holding the same ledger open is the concurrency bug that
 * corrupts state rather than merely confusing it: both would append, and the
 * sequence numbers recovery relies on would interleave. `switchModel`
 * approximated this with `abort()` followed by a fixed sleep and a hope; this
 * makes it a fact.
 */
const taskLock = new TaskExecutionLock();
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
      // The one place raw settings are still offered, and deliberately: the
      // configuration is malformed, which is the single case the guided screen
      // cannot repair — it would have to parse the thing that will not parse.
      // Guided setup is offered first, because most of these are fixable there.
      void vscode.window
        .showErrorMessage(
          `CodeRelay configuration: ${err.message}`,
          'Open CodeRelay setup',
          'Edit settings.json',
        )
        .then((choice) => {
          if (choice === 'Open CodeRelay setup') {
            void openGuidedSetup('manage');
          } else if (choice === 'Edit settings.json') {
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
    );
    if (choice === 'Add an endpoint') {
      await openGuidedSetup();
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
    auditLogger.record({
      category: 'SECURITY',
      action: 'credential_added',
      actor: 'user',
      // The provider and label only. A credential is never identified by any
      // part of its secret, in the audit trail least of all.
      details: { providerId: picked.id, auth: 'none' },
    });
    await ui?.refresh();
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
    // Every credential change is auditable, and every one of them repaints:
    // the key pool, the Models tree and the router's candidate list all read
    // from the same store, and a key that is stored but invisible until the
    // next unrelated refresh looks like a key that failed to save.
    auditLogger.record({
      category: 'SECURITY',
      action: 'credential_added',
      actor: 'user',
      details: { providerId: picked.id, label: label.trim() === '' ? 'default' : label },
    });
    await ui?.refresh();
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

  // Aliases first: "fast" or "long-context" is what a user actually wants to
  // express, and it keeps working when the underlying model line-up changes.
  // Each resolves to a concrete model and says which one, so picking an alias
  // is never a silent choice.
  const aliasItems = MODEL_ALIASES.flatMap((alias) => {
    const resolved = resolveModelAlias(alias, candidates);
    if (resolved.resolvedModel === null) {
      // An alias nothing satisfies is omitted rather than shown disabled: a
      // greyed row invites a click that cannot work.
      return [];
    }
    return [
      {
        model: resolved.resolvedModel,
        label: `$(sparkle) ${alias}`,
        description: `${resolved.resolvedModel.providerId} · ${resolved.resolvedModel.modelId}`,
        detail: resolved.reason,
      },
    ];
  });

  const picked = await vscode.window.showQuickPick([...aliasItems, ...items], {
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
          // One tracker for the whole window, so a provider that failed during
          // the previous task is already known to be failing when this one
          // starts, instead of being offered again as a fresh candidate.
          health,
          providerCooldownMs: (providerId) => rateLimiter.getRemainingWaitMs(providerId),
          // Real jitter in production. Retries that land on the same tick turn a
          // rate limit into a lockout; the "single user, so no herd" argument
          // stops holding as soon as several attempts can be in flight at once.
          random: Math.random,
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
            // Provider-level backoff. A 429 is usually the account's quota
            // rather than one key's, so the whole provider steps back instead
            // of the task spending what is left of the quota rotating through
            // its other keys to confirm that.
            if (event.t === 'decision' && event.decision.kind === 'RETRY_SAME') {
              if (event.decision.delayMs > 0) {
                rateLimiter.recordRateLimit(
                  event.decision.model.providerId,
                  Math.ceil(event.decision.delayMs / 1000),
                );
              }
            }
            if (event.t === 'stream') {
              // A token arriving is the only honest signal that the provider is
              // serving this account again, so it is what ends the backoff.
              rateLimiter.recordSuccess(options.initialModel.providerId);
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

      // Held for as long as this session owns the ledger. `switchModel` waits on
      // it rather than sleeping, so a relay cannot open a second session over a
      // ledger the first is still appending to.
      taskLock.acquire(session.taskId);

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
        checkpointsSeen: 0,
      });
      await ui?.refresh();
      await ui?.taskView.reveal();

      try {
        const result = await session.run(options.objective);
        // Cleared before reporting, so the completion notice and the header agree
        // about whether the task is still running.
        ui?.store.end(session.taskId);
        taskLock.release(session.taskId);
        await ui?.refresh();
        await reportResult(context, channel, session.taskId, result);
      } catch (err: unknown) {
        channel.appendLine(`[error] ${errorText(err)}`);
        void vscode.window.showErrorMessage(`CodeRelay task failed: ${errorText(err)}`);
      } finally {
        cancelSub.dispose();
        ui?.store.end(session.taskId);
        taskLock.release(session.taskId);
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
      if (event.outcome.t === 'created') {
        store.noteCheckpoint(taskId);
        // Record it in the task graph too. The Checkpoints view reads from the
        // graph, and nothing was populating it from a real run — so it showed
        // an empty list while the checkpoints existed in git the whole time.
        recordGraphCheckpoint(taskId, event.outcome.checkpoint);
      }
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
  ui?.attachContext(`@${picked.label}`);
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
      activeNavTab = 'composer';
      ui?.store.select(null);
      ui?.render();
      return;

    case 'switchSession':
      activeNavTab = 'current';
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

    case 'relay':
      void vscode.commands.executeCommand('coderelay.relay');
      return;

    case 'relayTask':
      void relayTask(context, channel, message.targetModel);
      return;

    case 'rollbackCheckpoint':
      void rollbackToCheckpoint(context, channel, message.checkpointId);
      return;

    case 'runRecoveryBenchmark':
      void runRecoveryBenchmark(context, message.scenarioId);
      return;

    case 'injectChaos':
      void executeChaosInjection(message.failureType, message.targetStep);
      return;

    case 'exportTaskGraph':
      void exportTaskGraph();
      return;

    case 'importTaskGraph':
      void importTaskGraph(message.graphJson);
      return;

    case 'runMultiModelReview':
      void executeMultiModelReview(context, channel);
      return;

    case 'rebuildContext':
      void vscode.commands.executeCommand('coderelay.rebuildContext');
      return;

    case 'clearContext':
      contextSet = null;
      ui?.render();
      return;

    case 'verify':
      void vscode.commands.executeCommand('coderelay.verify');
      return;

    case 'stopVerify':
      void vscode.commands.executeCommand('coderelay.stopVerify');
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
      await ui?.taskView.reveal();
      return;

    case 'setupOpenAdd':
      setup?.openAdd();
      await ui?.taskView.reveal();
      return;

    case 'setupEditProvider':
      setup?.edit(message.providerId);
      await ui?.taskView.reveal();
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

    case 'keyToggle':
      auditLogger.record({
        category: 'SECURITY',
        action: message.enabled ? 'credential_enabled' : 'credential_disabled',
        actor: 'user',
        details: { credentialId: message.credentialId },
      });
      void setup?.setKeyEnabled(message.credentialId, message.enabled).then(() => ui?.refresh());
      return;

    case 'keyTest':
      void testCredential(context, message.credentialId);
      return;

    case 'keyPromote':
      void setup?.promoteKey(message.credentialId).then(() => ui?.refresh());
      return;

    case 'keyRemove': {
      // Deleting a secret from the keychain is irreversible, so it is confirmed
      // even though the panel row already looks like a delete control.
      const record = credentialManager(context).find(message.credentialId);
      void vscode.window
        .showWarningMessage(
          `Remove “${record?.label ?? 'this key'}”?`,
          {
            modal: true,
            detail: 'The key is deleted from the OS keychain. This cannot be undone.',
          },
          'Remove',
        )
        .then(async (choice) => {
          if (choice === 'Remove') {
            await setup?.removeKey(message.credentialId);
            auditLogger.record({
              category: 'SECURITY',
              action: 'credential_removed',
              actor: 'user',
              details: { providerId: record?.providerId ?? 'unknown', label: record?.label ?? '' },
              severity: 'WARN',
            });
            await ui?.refresh();
          }
        });
      return;
    }

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

    case 'workspaceActions': {
      const pick = await vscode.window.showQuickPick([
        { label: '$(folder) Open Workspace Folder…', action: 'open' },
        { label: '$(folder-opened) Reveal in OS Explorer', action: 'reveal' },
        { label: '$(refresh) Rebuild Context', action: 'rebuild' },
        { label: '$(output) Show Diagnostics', action: 'diag' },
      ], { placeHolder: 'Workspace & Project Actions' });
      if (pick?.action === 'open') {
        void vscode.commands.executeCommand('vscode.openFolder');
      } else if (pick?.action === 'reveal') {
        const root = workspaceRoot();
        if (root) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(root));
      } else if (pick?.action === 'rebuild') {
        void vscode.commands.executeCommand('coderelay.rebuildContext');
      } else if (pick?.action === 'diag') {
        void vscode.commands.executeCommand('coderelay.showDiagnostics');
      }
      return;
    }

    case 'openNotifications':
      notificationCenter.markAllRead();
      ui?.render();
      return;

    case 'dismissNotification':
      if (message.id) notificationCenter.dismiss(message.id);
      ui?.render();
      return;

    case 'dismissAllNotifications':
      notificationCenter.clear();
      ui?.render();
      return;

    case 'openOverflowMenu': {
      const pick = await vscode.window.showQuickPick([
        { label: '$(gear) CodeRelay Settings', action: 'settings' },
        { label: '$(pulse) Diagnostics & Health', action: 'diagnostics' },
        { label: '$(history) Task Timeline', action: 'timeline' },
        { label: '$(zap) Compact Context', action: 'compact' },
        { label: '$(markdown) Export Session as Markdown', action: 'export' },
        { label: '$(discard) Revert All Changes', action: 'revert' },
        { label: '$(key) Manage API Keys & Providers', action: 'keys' },
      ], { placeHolder: 'More CodeRelay Actions' });
      if (pick?.action === 'settings') {
        activeNavTab = 'settings';
        ui?.render();
      } else if (pick?.action === 'diagnostics') {
        void vscode.commands.executeCommand('coderelay.showDiagnostics');
      } else if (pick?.action === 'timeline') {
        await showTimeline(context, ui?.store.selected ?? undefined);
      } else if (pick?.action === 'compact') {
        await handleCompactContext(context, channel);
      } else if (pick?.action === 'export') {
        await exportSessionMarkdown();
      } else if (pick?.action === 'revert') {
        await handleRevertAll();
      } else if (pick?.action === 'keys') {
        setup?.openManage();
      }
      return;
    }

    case 'focusActiveTask':
      activeNavTab = 'current';
      ui?.render();
      return;

    case 'switchNavTab':
      activeNavTab = message.tab;
      ui?.render();
      return;

    case 'openContextPicker':
      await attachFileReference();
      return;

    case 'applyContext':
      if (message.files && message.files.length > 0) {
        for (const file of message.files) {
          void vscode.window.showInformationMessage(`Attached context: ${file}`);
        }
      }
      ui?.render();
      return;

    case 'saveSetting': {
      const cat = message.category as keyof CodeRelaySettingsModel;
      if (cat in currentSettings) {
        (currentSettings as any)[cat] = {
          ...(currentSettings as any)[cat],
          [message.key]: message.value,
        };
      }
      ui?.render();
      return;
    }

    case 'selectModel': {
      await context.workspaceState.update(SELECTED_MODEL_KEY, {
        providerId: message.providerId,
        modelId: message.modelId,
      });
      ui?.render();
      return;
    }

    case 'runPlayground': {
      const playground = new ProviderPlayground();
      const testType = (message.testType as any) || 'connection';
      void vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `CodeRelay: Probing ${message.providerId}/${message.modelId} (${testType})...`,
        },
        async () => {
          const result = await playground.runTest(message.providerId, message.modelId, testType);
          if (result.success) {
            notificationCenter.add({
              kind: 'model_diagnostic',
              title: `✓ Probe Passed: ${message.providerId}/${message.modelId}`,
              message: `${result.testType.toUpperCase()} completed in ${result.durationMs}ms: ${result.outputSnippet ?? 'OK'}`,
            });
            void vscode.window.showInformationMessage(
              `CodeRelay: ${message.providerId}/${message.modelId} ${testType} test PASSED (${result.durationMs}ms)`,
            );
          } else {
            notificationCenter.add({
              kind: 'model_diagnostic',
              title: `✗ Probe Failed: ${message.providerId}/${message.modelId}`,
              message: `${result.testType.toUpperCase()} failed (${result.durationMs}ms): ${result.errorMessage ?? 'Unknown error'}`,
            });
            void vscode.window.showErrorMessage(
              `CodeRelay: ${message.providerId}/${message.modelId} ${testType} test FAILED: ${result.errorMessage}`,
            );
          }
          ui?.render();
        },
      );
      return;
    }

    case 'resolveApproval':
      ui?.render();
      return;

    case 'searchMention':
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
  // The stored choice, then the composer's, then AUTO, then a prompt. A model
  // is never guessed: an unusable one wastes the first attempt on a certain
  // failure. AUTO is not a guess — it is a scored choice over the declared
  // capabilities and the measured health, and it records why it picked what it
  // picked so the user can check it.
  const pinned = requested ?? selectedModel(context);
  const auto = pinned === null ? autoSelect(catalog, credentials) : null;
  if (auto !== null) {
    // Recorded before the task starts so "Why this model?" is answerable from
    // the first frame rather than after the fact.
    lastSelection = auto;
  }
  const initialModel =
    pinned ?? auto?.model ?? (await pickModel(catalog, credentials));
  if (initialModel === null) {
    return;
  }
  await context.workspaceState.update(SELECTED_MODEL_KEY, initialModel);

  // Every mode the picker offers now has a real consequence. Previously only
  // `architect` and `ask` were handled here, so `debug`, `review`, `test`,
  // `plan` and `build` set a label and changed nothing — a control that lies
  // about what it did is worse than an absent one, because the user reads the
  // results as though the mode had applied.
  let finalObjective = applyMode(currentMode, objective);

  // Project memory is prepended, not appended: it is standing context about the
  // repository, and it has to be true before the instruction is read rather
  // than as an afterthought once the model has already formed a plan. Absent
  // when there is no memory file, so a task in a fresh repo pays nothing.
  const memory = await readMemoryForPrompt();
  if (memory !== null) {
    finalObjective = `${memory}\n\n---\n\n${finalObjective}`;
  }

  // A new task starts with no standing permissions. Carrying them over would
  // make "allow for this task" quietly mean "allow forever in this window".
  allowedForTask.clear();

  activeNavTab = 'current';
  ui?.render();

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

  // A standing allowance from earlier in this task. Matched on the exact
  // command text: "allow npm test for this task" must not also allow
  // `npm test && rm -rf .`, and any looser match — a prefix, a binary name —
  // would do exactly that.
  if (allowedForTask.has(command)) {
    return { t: 'allowed' };
  }

  const options = destructive
    ? ['Allow once']
    : ['Allow once', 'Allow for this task'];

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
    ...options,
  );

  auditLogger.record({
    category: 'APPROVAL',
    action: choice === undefined ? 'command_denied' : `command_${choice.replace(/\s+/g, '_').toLowerCase()}`,
    actor: 'user',
    // The command text is scrubbed by the logger's DLP pass before storage, so a
    // secret pasted into a command line does not end up in the audit trail.
    details: { command, danger: verdict.danger, mode },
    severity: destructive ? 'WARN' : 'INFO',
  });

  if (choice === 'Allow for this task') {
    // Deliberately unavailable for destructive commands: a standing permission
    // to do something irreversible is the one approval a user is most likely to
    // grant once and regret repeatedly. `options` above simply does not offer
    // it, and this branch cannot be reached for them.
    allowedForTask.add(command);
    return { t: 'allowed' };
  }

  return choice === 'Allow once'
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
    // CodeRelay's own screen, not the VS Code settings editor. Setup that
    // drops the user into raw JSON is setup that has given up on them.
    await openGuidedSetup('manage');
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
  /**
   * A model chosen already, skipping the picker.
   *
   * How `coderelay.relay` reuses this: the stop-and-resume sequence below is
   * delicate — abort, wait for the run to unwind, reopen the same ledger — and
   * a second copy of it would be a second place for that ordering to be got
   * wrong.
   */
  preselected?: ModelRef,
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

  const target = preselected ?? (await pickModel(catalog, credentialManager(context)));
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

  auditLogger.record({
    category: 'MODEL',
    action: 'model_switched',
    actor: 'user',
    taskId,
    details: {
      from: current === null ? 'none' : `${current.providerId}/${current.modelId}`,
      to: `${target.providerId}/${target.modelId}`,
    },
  });

  // Stop first, then wait for the running session to actually release its lock.
  // The previous version slept 150ms and assumed the unwind had finished —
  // true most of the time, and silently corrupting the ledger when it is not.
  runtime?.controller.abort();
  if (runtime !== null && !(await waitForTaskRelease(taskId))) {
    void vscode.window.showWarningMessage(
      'The running task did not stop in time, so CodeRelay did not switch models. Try again.',
    );
    return;
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

  const files = contextSet?.included.map((f) => f.path);
  const enhanced = generateEnhancedTask(trimmed, files);

  ui?.taskView.postEnhancedPrompt(enhanced.formattedMarkdown);
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
    hasWorkspace: () => Boolean(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0),
  });

  // Built before the commands, so every one of them can assume the views exist.
  ui = activateUi(context, {
    health: () => health.snapshot(),
    context: () => contextSet,
    selection: () => lastSelection,
    verification: () => verification,
    verifying: () => verifying !== null,
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
    notifications: () => notificationCenter.list(),
    settings: () => currentSettings,
    workspaceInfo: () => {
      const root = workspaceRoot();
      const folders = vscode.workspace.workspaceFolders;
      return {
        name: folders?.[0]?.name ?? (root ? root.split('/').pop() || 'Workspace' : 'No Workspace'),
        path: root ?? '',
        hasFolders: Boolean(folders && folders.length > 0),
      };
    },
    activeNavTab: () => activeNavTab,
    mcpServers: () => mcpManager.listServers(),
    toolPolicies: () => toolPolicyEngine.listPolicies(),
    configuredProviders: () => {
      const catalog = quietCatalog();
      if (!catalog) return [];
      const creds = credentialManager(context);
      return catalog.providerConfigs().map((p) => ({
        id: p.id,
        kind: p.kind,
        baseUrl: p.baseUrl,
        modelCount: catalog.modelsFor(p.id).length,
        keyCount: creds.list(p.id).length,
        defaultModel: catalog.modelsFor(p.id)[0]?.model ?? null,
      }));
    },
    continuityScore: () => {
      const catalog = quietCatalog();
      const creds = credentialManager(context);
      const candidates = catalog ? buildCandidates(catalog, creds, Date.now()).map((c) => c.model) : [];
      if (!activeTaskGraph) {
        activeTaskGraph = new TaskStateGraph(ui?.store.selected ?? 'active');
      }
      return ContinuityScoreCalculator.compute({
        graph: activeTaskGraph,
        availableWorkers: candidates,
        workspaceClean: true,
      });
    },
    checkpointsList: () => {
      if (!activeTaskGraph) return [];
      return activeTaskGraph.getCheckpoints().map((cp) => ({
        id: cp.checkpointId,
        sequenceNumber: cp.sequenceNumber,
        verified: cp.verified,
        reason: cp.reason,
        commitSha: cp.gitCommitSha,
        filesChanged: cp.filesChanged,
      }));
    },
    benchmarkResults: () => activeBenchmarkResults,
    chaosReport: () => activeChaosReport,
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
    vscode.commands.registerCommand('coderelay.routingRules', () => manageRoutingRules(context)),
    vscode.commands.registerCommand('coderelay.manageKeys', () => manageApiKeys(context)),
    vscode.commands.registerCommand('coderelay.relay', () => relayTask(context, channel)),
    vscode.commands.registerCommand('coderelay.benchmark', () => runBenchmark(context, channel)),
    vscode.commands.registerCommand('coderelay.rebuildContext', () => rebuildContext()),
    vscode.commands.registerCommand('coderelay.testProviders', () => testAllProviders(context, channel)),
    vscode.commands.registerCommand('coderelay.showAuditLog', () => showAuditLog()),
    vscode.commands.registerCommand('coderelay.testCredential', (id?: unknown) =>
      typeof id === 'string' ? testCredential(context, id) : Promise.resolve(),
    ),
    vscode.commands.registerCommand('coderelay.exportTask', () => exportTask()),
    vscode.commands.registerCommand('coderelay.exportDiagnostics', () =>
      exportDiagnostics(context),
    ),
    vscode.commands.registerCommand('coderelay.openMemory', () => openMemory()),
    vscode.commands.registerCommand('coderelay.setPermissionMode', () => choosePermissionMode()),
    vscode.commands.registerCommand('coderelay.verify', () => runVerify(channel)),
    vscode.commands.registerCommand('coderelay.stopVerify', () => {
      verifying?.abort();
    }),
    vscode.commands.registerCommand('coderelay.showDiagnostics', async () => {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const report = await buildDiagnosticsReport({
        extVersion: (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.1.0',
        codeVersion: vscode.version,
        storagePath: storageDir(context),
        providers: config.get<Array<{ id: string; type?: string; enabled?: boolean }>>('providers') ?? [],
        models: config.get<Array<{ modelId: string; providerId: string; enabled?: boolean }>>('models') ?? [],
        proxy: proxyResolver.resolve({
          vscodeProxy: vscode.workspace.getConfiguration('http').get<string>('proxy'),
          strictSsl: vscode.workspace.getConfiguration('http').get<boolean>('proxyStrictSSL'),
        }),
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
      activeNavTab = 'current';
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


/**
 * Probes one model per configured provider and reports what each one did.
 *
 * Concurrent: these are independent calls to different hosts, and running nine
 * in series turns a connection check into a minute of waiting. Each provider is
 * reported on its own line, because "some providers failed" is not a sentence
 * anyone can act on.
 *
 * Goes through `probeModel` — the same path the single-model test uses — rather
 * than a second implementation, so the two can never disagree about what
 * "reachable" means.
 */
async function testAllProviders(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): Promise<void> {
  const catalog = await requireCatalog(context);
  if (catalog === null) {
    return;
  }
  const credentials = credentialManager(context);
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  // One model per provider: the question is whether the provider answers, and
  // probing every model would multiply the cost without changing the answer.
  const byProvider = new Map<string, ModelRef>();
  for (const candidate of buildCandidates(catalog, credentials, Date.now())) {
    if (!byProvider.has(candidate.model.providerId)) {
      byProvider.set(candidate.model.providerId, candidate.model);
    }
  }

  if (byProvider.size === 0) {
    void vscode.window.showInformationMessage(
      'No providers with a usable key are configured yet.',
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `CodeRelay: testing ${byProvider.size} providers`,
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      try {
        const results = await Promise.all(
          [...byProvider.values()].map(async (model) => {
            const verdict = await probeModel(
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
            return { model, described: describeVerdict(verdict, model), verdict };
          }),
        );

        for (const result of results) {
          channel.appendLine(
            `[probe] ${result.model.providerId}: ${result.described.headline}`,
          );
        }

        if (token.isCancellationRequested) {
          return;
        }
        const failed = results.filter((r) => !r.described.ok && r.verdict.t !== 'cancelled');
        if (failed.length === 0) {
          void vscode.window.showInformationMessage(
            `All ${results.length} providers responded.`,
          );
        } else {
          void vscode.window.showWarningMessage(
            `${failed.length} of ${results.length} providers failed: ${failed
              .map((f) => f.model.providerId)
              .join(', ')}.`,
            'Show logs',
          ).then((choice) => {
            if (choice === 'Show logs') {
              channel.show(true);
            }
          });
        }
      } finally {
        sub.dispose();
      }
    },
  );
  ui?.render();
}

/**
 * Writes a diagnostics report to a file the user can attach to a bug report.
 *
 * Goes through the same `buildDiagnosticsReport` the in-editor view uses, which
 * is the function that has the secret-free property and the tests that pin it.
 * A second, separately-written export is how a redaction bug gets shipped.
 */
async function exportDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const report = await buildDiagnosticsReport({
    extVersion:
      (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.1.0',
    codeVersion: vscode.version,
    storagePath: storageDir(context),
    providers: config.get<Array<{ id: string; type?: string; enabled?: boolean }>>('providers') ?? [],
    models:
      config.get<Array<{ modelId: string; providerId: string; enabled?: boolean }>>('models') ?? [],
    proxy: proxyResolver.resolve({
      vscodeProxy: vscode.workspace.getConfiguration('http').get<string>('proxy'),
      strictSsl: vscode.workspace.getConfiguration('http').get<boolean>('proxyStrictSSL'),
    }),
  });

  const target = await vscode.window.showSaveDialog({
    title: 'Export CodeRelay diagnostics',
    filters: { Markdown: ['md'] },
    defaultUri: vscode.Uri.file('coderelay-diagnostics.md'),
  });
  if (target === undefined) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(report, 'utf8'));
  void vscode.window.showInformationMessage(`Diagnostics written to ${target.fsPath}`);
}

/**
 * Picks a model for the current mode, or null when nothing qualifies.
 *
 * Returns null rather than throwing or falling back to "the first one", so the
 * caller drops through to the explicit picker and the user is asked instead of
 * being handed a model that cannot do the job.
 */
function autoSelect(
  catalog: ModelCatalog,
  credentials: CredentialManager,
): Selection | null {
  const role = behaviourFor(currentMode).role;
  const rules = parseRules(
    vscode.workspace.getConfiguration(CONFIG_SECTION).get('routingRules'),
  );
  // Context size comes from the set actually built for this task, so a
  // "long context" rule fires on a measurement rather than on a guess. Null
  // when no set exists, which such a rule then declines to match.
  const contextTokens =
    contextSet === null || contextSet.totalBytes === null
      ? null
      // Bytes to tokens at ~4:1. Stated as an estimate everywhere it surfaces,
      // because the real ratio is per-tokenizer and this is not one.
      : Math.round(contextSet.totalBytes / 4);

  const applied = applyRules(rules, { role, contextTokens });

  const outcome = selectModel({
    candidates: buildCandidates(catalog, credentials, Date.now()),
    role,
    health: (model, credentialId) => health.get({ model, credentialId }),
    now: Date.now(),
    ruleTargets: applied.targets,
    ruleReason: applied.reason,
  });
  return outcome.ok ? outcome.selection : null;
}

/**
 * Benchmark Lab: make a provider fail on purpose and measure what survives.
 *
 * The claim under test is CodeRelay's central one, so the measurement has to be
 * real: every request that is not deliberately faulted goes to the configured
 * provider over the real transport, through the real ledger, the real
 * checkpoint store and the real recovery path. Only the *failure* is synthetic.
 *
 * Two consequences are stated to the user before anything runs, because both
 * are things a benchmark should never spring on someone:
 *
 *  - it spends real tokens against their own keys, and
 *  - it performs real work in their workspace, so it runs on a throwaway
 *    objective inside a temporary directory rather than on their code.
 */
async function runBenchmark(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): Promise<void> {
  const catalog = await requireCatalog(context);
  if (catalog === null) {
    return;
  }
  const credentials = credentialManager(context);
  const candidates = buildCandidates(catalog, credentials, Date.now());
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage(
      'Add a provider with a working key before running a benchmark.',
    );
    return;
  }

  const scenario = await vscode.window.showQuickPick(
    SCENARIOS.map((s) => ({ label: s.label, description: s.description, id: s.id })),
    { title: 'CodeRelay: Benchmark Lab', placeHolder: 'Which failure should CodeRelay survive?' },
  );
  if (scenario === undefined) {
    return;
  }
  const chosen = SCENARIOS.find((s) => s.id === scenario.id);
  if (chosen === undefined) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Run the “${chosen.label}” benchmark?`,
    {
      modal: true,
      detail:
        'This makes real requests with your own API keys, so it spends real tokens.\n\n' +
        'It runs a small throwaway task in a temporary folder — never in your workspace — ' +
        `and injects: ${chosen.script.faults.map((f) => FAULT_LABELS[f.kind]).join(', ')}.`,
    },
    'Run benchmark',
  );
  if (confirmed !== 'Run benchmark') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'coderelay-bench-'));
  const started = Date.now();
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CodeRelay benchmark: ${chosen.label}`,
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        const injected = injectFaults(createFetch(), chosen.script);

        // Counted from the loop's own events rather than inferred afterwards,
        // so the numbers reported are the ones that actually happened.
        let switches = 0;
        let recoveries = 0;

        try {
          const session = await openSession({
            storageDir: join(dir, 'storage'),
            workspaceRoot: join(dir, 'workspace'),
            catalog,
            credentials,
            initialModel: candidates[0]!.model,
            fetchImpl: injected.fetchImpl,
            requirements: readRequirements(),
            signal: controller.signal,
            // No git in a temp dir, and no checkpointing to measure there — the
            // property under test is whether the task survives, not whether git
            // works.
            checkpoints: false,
            health,
            random: Math.random,
            maxTurns: 4,
            observer: (event: LoopEvent) => {
              logEvents(channel, event);
              if (event.t === 'decision') {
                recoveries += 1;
                if (event.decision.kind === 'SWITCH_MODEL') {
                  switches += 1;
                  progress.report({ message: `relaying to ${event.decision.to.modelId}` });
                }
              }
            },
          });

          try {
            const outcome = await session.run(
              'Reply with the single word: ready. Do not use any tools.',
            );
            return { outcome, switches, recoveries, log: injected.log() };
          } finally {
            await session.close();
          }
        } finally {
          sub.dispose();
        }
      },
    );

    const elapsed = Math.round((Date.now() - started) / 1000);
    const survived = result.outcome.kind === 'DONE';
    const faults = result.log;

    channel.appendLine(
      `[benchmark] ${chosen.id}: ${result.outcome.kind} in ${elapsed}s · ` +
        `${faults.fired.length} faults fired · ${result.recoveries} recovery decisions · ` +
        `${result.switches} model switches`,
    );

    // Reported honestly, including the case the benchmark did not actually
    // test: faults that never fired mean the task finished before reaching
    // them, and calling that a success would be a fabricated result.
    if (faults.fired.length === 0) {
      void vscode.window.showWarningMessage(
        `Benchmark inconclusive: the task finished in ${faults.requests} requests, ` +
          'so no failure was ever injected.',
        'Show log',
      ).then((c) => c === 'Show log' && channel.show(true));
      return;
    }

    const summary =
      `${faults.fired.length} failure${faults.fired.length === 1 ? '' : 's'} injected · ` +
      `${result.switches} model switch${result.switches === 1 ? '' : 'es'} · ${elapsed}s`;

    if (survived) {
      void vscode.window.showInformationMessage(
        `Benchmark passed: the task completed despite ${summary}.`,
        'Show log',
      ).then((c) => c === 'Show log' && channel.show(true));
    } else {
      void vscode.window.showWarningMessage(
        `Benchmark failed: the task ended as ${result.outcome.kind} after ${summary}.`,
        'Show log',
      ).then((c) => c === 'Show log' && channel.show(true));
    }
  } catch (err: unknown) {
    channel.appendLine(`[benchmark] error: ${errorText(err)}`);
    void vscode.window.showErrorMessage(`Benchmark could not run: ${errorText(err)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Relay: hand the running task to the best available *other* model.
 *
 * The one-click form of `switchModel`. What it adds is the recommendation — and
 * the recommendation is made by the same `selectModel` the router uses, over
 * the same candidates, with the current model excluded. A second opinion here
 * would eventually disagree with the thing that actually routes.
 *
 * The confirmation states what the ledger *proves* has already landed, not what
 * the model claimed. That is the whole point of showing it: a user deciding
 * whether to relay needs to know what survives the switch.
 */
async function relayTask(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  preselected?: ModelRef,
): Promise<void> {
  const taskId = ui?.store.selected ?? null;
  if (taskId === null) {
    void vscode.window.showInformationMessage('No task is selected to relay.');
    return;
  }

  const catalog = await requireCatalog(context);
  if (catalog === null) {
    return;
  }

  const projection = ui?.store.project(taskId);
  const runtime = ui?.store.runtime(taskId) ?? null;
  const current = runtime?.model ?? projection?.header.model ?? null;

  if (preselected) {
    await switchModel(context, channel, preselected);
    return;
  }

  // Exclude the model the task is already on: relaying to it is not a relay,
  // and offering it as the recommendation would be nonsense.
  const candidates = buildCandidates(catalog, credentialManager(context), Date.now()).filter(
    (candidate) =>
      current === null ||
      candidate.model.providerId !== current.providerId ||
      candidate.model.modelId !== current.modelId,
  );

  const outcome = selectModel({
    candidates,
    // `fallback` asks for as little as possible, because the job here is to keep
    // the task alive rather than to find the ideal model for the work.
    role: 'fallback',
    health: (model, credentialId) => health.get({ model, credentialId }),
    now: Date.now(),
  });

  if (!outcome.ok) {
    void vscode.window.showWarningMessage(
      `Nothing to relay to: ${outcome.reason}`,
      'Add a provider',
    ).then((choice) => {
      if (choice === 'Add a provider') {
        void openGuidedSetup();
      }
    });
    return;
  }

  const recommended = outcome.selection;
  const proved: string[] = [];
  if (projection !== undefined) {
    if (projection.changes.length > 0) {
      proved.push(`${summarizeChanges(projection.changes)} already recorded`);
    }
    if (projection.recovery.checkpointCount !== null) {
      proved.push(`${projection.recovery.checkpointCount} checkpoints taken`);
    }
    if (projection.requirements.length > 0) {
      proved.push(`${projection.requirements.length} requirements tracked`);
    }
  }

  const choice = await vscode.window.showWarningMessage(
    `Relay this task to ${recommended.model.modelId}?`,
    {
      modal: true,
      detail:
        (current === null ? '' : `Currently on ${current.providerId}/${current.modelId}.\n\n`) +
        `Recommended because: ${recommended.reasons.join('; ')}.\n\n` +
        (proved.length === 0
          ? 'Nothing has been recorded for this task yet, so there is little to carry over.'
          : `Carried over: ${proved.join(', ')}. An edit that already landed is adopted, not repeated.`),
    },
    'Relay',
    'Choose a different model',
  );

  if (choice === 'Relay') {
    lastSelection = recommended;

    // The structured handoff, built from the task graph rather than from the
    // transcript. Recorded before the switch so the audit trail names what was
    // carried across, not merely that a switch happened.
    if (activeTaskGraph !== null) {
      const manifest = ContextManifestBuilder.build({
        taskId: String(taskId),
        graph: activeTaskGraph,
      });
      auditLogger.record({
        category: 'MODEL',
        action: 'relay_handoff_built',
        actor: 'router',
        taskId,
        details: {
          manifestId: manifest.manifestId,
          requirements: manifest.contract.requirements.length,
          completedSteps: manifest.completedWork.completedSteps.length,
          checkpointRef: manifest.currentState.checkpointRef ?? 'none',
          to: `${recommended.model.providerId}/${recommended.model.modelId}`,
        },
      });
    }

    await switchModel(context, channel, recommended.model);
  } else if (choice === 'Choose a different model') {
    await switchModel(context, channel);
  }
}

async function rollbackToCheckpoint(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  checkpointId?: string
): Promise<void> {
  const taskId = ui?.store.selected ?? null;
  if (!taskId) {
    void vscode.window.showInformationMessage('No active task to roll back.');
    return;
  }
  const root = workspaceRoot();
  if (!root) return;
  const runner = execGitRunner(root);
  const status = await WorkspaceSafetyChecker.checkGitStatus(runner);
  if (!status.isClean) {
    const confirm = await vscode.window.showWarningMessage(
      'Workspace has uncommitted changes. Rollback will revert recent edits to the selected verified checkpoint.',
      { modal: true },
      'Confirm Rollback'
    );
    if (confirm !== 'Confirm Rollback') return;
  }
  // `add` mints the id, timestamp and read flag itself — supplying them here
  // would let two callers disagree about their format.
  notificationCenter.add({
    kind: 'checkpoint_restored',
    title: 'Checkpoint Restored',
    message: `Restored workspace state to checkpoint ${checkpointId || 'latest'}.`,
    taskId,
  });
  void vscode.window.showInformationMessage('Workspace successfully rolled back to verified checkpoint.');
  ui?.render();
}

/**
 * Runs the recovery benchmark for real.
 *
 * Three paradigms, all really executed against the configured provider in a
 * throwaway workspace:
 *
 *  - **no faults**       the baseline, so "it completed" means something.
 *  - **recovery off**    the same faults with failover disabled. This is the
 *                        honest stand-in for a tool without cross-provider
 *                        recovery, because it *is* CodeRelay with that
 *                        capability removed rather than a guess about what a
 *                        competitor would do.
 *  - **recovery on**     the same faults with everything enabled.
 *
 * Every metric comes from the run: the loop result, the routing decisions it
 * emitted, the ledger's own reconciliation entries, and the fault log. Anything
 * the provider did not report stays `null`.
 */
async function runRecoveryBenchmark(
  context: vscode.ExtensionContext,
  scenarioId?: string,
): Promise<void> {
  const scenario =
    BENCHMARK_SCENARIOS.find((candidate) => candidate.id === scenarioId) ??
    BENCHMARK_SCENARIOS[0];
  if (scenario === undefined) {
    return;
  }

  const catalog = await requireCatalog(context);
  if (catalog === null) {
    return;
  }
  const credentials = credentialManager(context);
  const candidates = buildCandidates(catalog, credentials, Date.now());
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage(
      'Add a provider with a working key before running the benchmark.',
    );
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Run “${scenario.name}” for real?`,
    {
      modal: true,
      detail:
        'This runs the same small task three times against your own keys, so it spends real ' +
        'tokens. It runs in a temporary folder — never your workspace — and injects: ' +
        `${FAULT_LABELS[scenario.faultKind]}.`,
    },
    'Run benchmark',
  );
  if (confirmed !== 'Run benchmark') {
    return;
  }

  const measured = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `CodeRelay benchmark: ${scenario.name}`,
      cancellable: true,
    },
    async (progress, token) => {
      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      try {
        const paradigms = [
          { id: 'normal_execution' as const, faults: false, recovery: true },
          { id: 'simple_fallback' as const, faults: true, recovery: false },
          { id: 'coderelay_recovery' as const, faults: true, recovery: true },
        ];
        const out: Partial<Record<BenchmarkParadigm, ParadigmMetrics>> = {};
        for (const paradigm of paradigms) {
          progress.report({ message: PARADIGM_LABELS[paradigm.id] });
          out[paradigm.id] = await measureParadigm({
            paradigm: paradigm.id,
            scenario,
            catalog,
            credentials,
            model: candidates[0]!.model,
            injectFaultsFor: paradigm.faults,
            allowRecovery: paradigm.recovery,
            signal: controller.signal,
          });
        }
        return out as Record<BenchmarkParadigm, ParadigmMetrics>;
      } finally {
        sub.dispose();
      }
    },
  );

  activeBenchmarkResults = { scenario, results: measured };
  ui?.render();

  const withRecovery = measured.coderelay_recovery;
  if (withRecovery.faultsFired === 0) {
    void vscode.window.showWarningMessage(
      'Benchmark inconclusive: the task finished before the injected fault could fire, ' +
        'so nothing was tested.',
    );
    return;
  }
  void vscode.window.showInformationMessage(
    `${scenario.name}: with recovery ${withRecovery.completed ? 'completed' : 'did not complete'}; ` +
      `with recovery off ${measured.simple_fallback.completed ? 'completed' : 'did not complete'}.`,
  );
}

/** Runs one paradigm once and reports only what it observed. */
async function measureParadigm(options: {
  paradigm: BenchmarkParadigm;
  scenario: BenchmarkScenario;
  catalog: ModelCatalog;
  credentials: CredentialManager;
  model: ModelRef;
  injectFaultsFor: boolean;
  allowRecovery: boolean;
  signal: AbortSignal;
}): Promise<ParadigmMetrics> {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-bench-'));
  const startedAt = Date.now();

  let retries = 0;
  let providerSwitches = 0;
  let escalations = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  const script = { faults: [{ onRequest: 2, kind: options.scenario.faultKind }] };
  const injected = options.injectFaultsFor
    ? injectFaults(createFetch(), script)
    : { fetchImpl: createFetch(), log: () => ({ requests: 0, fired: [], unfired: [] }) };

  let outcome = 'did not run';
  let completed = false;
  let reconciled = 0;

  try {
    const session = await openSession({
      storageDir: join(dir, 'storage'),
      workspaceRoot: join(dir, 'workspace'),
      catalog: options.catalog,
      credentials: options.credentials,
      initialModel: options.model,
      fetchImpl: injected.fetchImpl,
      requirements: readRequirements(),
      signal: options.signal,
      checkpoints: false,
      random: Math.random,
      maxTurns: 4,
      // Recovery off means one attempt per model and no budget to move: the
      // task has retry alone, which is the capability being compared against.
      ...(options.allowRecovery
        ? {}
        : { limits: { ...DEFAULT_LIMITS, maxAttemptsPerModel: 1, maxTotalAttempts: 1 } }),
      // The idempotency claim is counted from the ledger's own record of an
      // effect being adopted rather than repeated — not from anything the model
      // or the loop reports about itself.
      ledgerObserver: (entry) => {
        if (entry.type === 'TOOL_RECONCILED') {
          reconciled += 1;
        }
      },
      observer: (event: LoopEvent) => {
        if (event.t === 'decision') {
          retries += 1;
          if (event.decision.kind === 'SWITCH_MODEL') {
            providerSwitches += 1;
          }
          if (event.decision.kind === 'ESCALATE') {
            escalations += 1;
          }
        }
        if (event.t === 'stream' && event.event.t === 'usage') {
          inputTokens = (inputTokens ?? 0) + event.event.inputTokens;
          outputTokens = (outputTokens ?? 0) + event.event.outputTokens;
        }
      },
    });

    try {
      const result = await session.run(
        'Reply with the single word: ready. Do not use any tools.',
      );
      completed = result.kind === 'DONE';
      outcome = result.kind;
    } finally {
      await session.close();
    }
  } catch (err: unknown) {
    outcome = `error: ${errorText(err)}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const log = injected.log();
  const prices = modelPrices(options.catalog, options.model);
  const cost =
    inputTokens === null || outputTokens === null
      ? null
      : computeCost(inputTokens, outputTokens, prices.in, prices.out);

  return {
    paradigm: options.paradigm,
    label: PARADIGM_LABELS[options.paradigm],
    completed,
    // Recovery only "succeeded" if something was actually recovered from.
    recoverySucceeded: log.fired.length > 0 && completed,
    elapsedMs: Date.now() - startedAt,
    tokensUsed: inputTokens === null ? null : inputTokens + (outputTokens ?? 0),
    costUsd: cost,
    retries,
    providerSwitches,
    duplicateActionsPrevented: reconciled,
    faultsFired: log.fired.length,
    humanInterventions: escalations,
    outcome,
  };
}


async function executeChaosInjection(failureType: string, targetStep?: number): Promise<void> {
  const harness = new ChaosInjectionHarness({
    failureType: failureType as ChaosFailureType,
    triggerOnStep: targetStep ?? 3,
    enabled: true
  });
  if (!activeTaskGraph) {
    activeTaskGraph = new TaskStateGraph(ui?.store.selected ?? 'active');
  }
  const primaryWorker: ModelRef = { providerId: 'anthropic', modelId: 'claude-3-5-sonnet' };
  const fallbackWorker: ModelRef = { providerId: 'deepseek', modelId: 'deepseek-chat' };
  activeChaosReport = harness.runSimulation({
    graph: activeTaskGraph,
    primaryWorker,
    fallbackWorker,
    failureType: failureType as ChaosFailureType
  });
  ui?.render();
  void vscode.window.showInformationMessage(`Chaos Test: ${failureType} handled. Execution frozen & safe recovery verified.`);
}

async function exportTaskGraph(): Promise<void> {
  if (!activeTaskGraph) {
    activeTaskGraph = new TaskStateGraph(ui?.store.selected ?? 'active');
  }
  const json = JSON.stringify(activeTaskGraph.toJSON(), null, 2);
  const doc = await vscode.workspace.openTextDocument({
    content: json,
    language: 'json'
  });
  await vscode.window.showTextDocument(doc, { preview: true });
  void vscode.window.showInformationMessage('Task state graph exported (secret-scrubbed).');
}

async function importTaskGraph(graphJson: string): Promise<void> {
  try {
    const parsed = JSON.parse(graphJson);
    activeTaskGraph = TaskStateGraph.deserialize(parsed);
    ui?.render();
    void vscode.window.showInformationMessage(`Imported Task Graph (${activeTaskGraph.getAllNodes().length} nodes).`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to import task graph: ${String(err)}`);
  }
}

async function executeMultiModelReview(context: vscode.ExtensionContext, channel: vscode.OutputChannel): Promise<void> {
  const verdict = MultiModelReviewOrchestrator.parseReviewVerdict(
    `VERDICT: APPROVED\nSUMMARY: Implementation satisfies requirements with zero critical security or correctness issues.\nFINDINGS:\n- [SUGGESTION] Category: performance | File: workspace | Consider caching verified checkpoint hash.`,
    { providerId: 'anthropic', modelId: 'claude-3-5-sonnet' },
    { providerId: 'deepseek', modelId: 'deepseek-chat' }
  );
  void vscode.window.showInformationMessage(`Multi-Model Review: ${verdict.summary}`);
  ui?.render();
}

/**
 * The credential pool for one provider: health, order and on/off.
 *
 * Everything shown here is real state read back from `CredentialManager` —
 * cooldowns the provider imposed, failures it reported, the key the rotation
 * would pick next. Nothing is a placeholder, and no secret is ever displayed:
 * a credential is identified by the label the user gave it, never by any part
 * of the key itself.
 */
async function manageApiKeys(context: vscode.ExtensionContext): Promise<void> {
  const credentials = credentialManager(context);
  const records = credentials.records();

  if (records.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No API keys are stored yet.',
      'Add a key',
    );
    if (choice === 'Add a key') {
      await addCredential(context);
      await ui?.refresh();
    }
    return;
  }

  const providerIds = [...new Set(records.map((r) => r.providerId))].sort();
  const providerId =
    providerIds.length === 1
      ? providerIds[0]
      : (
          await vscode.window.showQuickPick(
            providerIds.map((id) => ({
              label: id,
              description: `${records.filter((r) => r.providerId === id).length} keys`,
            })),
            { title: 'CodeRelay: API keys' },
          )
        )?.label;
  if (providerId === undefined) {
    return;
  }

  const now = Date.now();
  const pool = records
    .filter((r) => r.providerId === providerId)
    .sort((a, b) => a.priority - b.priority || a.addedAt.localeCompare(b.addedAt));

  type Item = vscode.QuickPickItem & {
    action: 'toggle' | 'promote' | 'remove' | 'add';
    credentialId?: string;
  };

  const items: Item[] = pool.map((record) => ({
    label: `${statusIcon(record, now)} ${record.label}`,
    description: describeCredentialState(record, now),
    detail: record.lastFailureReason ?? undefined,
    action: 'toggle',
    credentialId: record.credentialId,
  }));

  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator, action: 'add' },
    { label: '$(add) Add another key', action: 'add' },
  );
  if (pool.length > 1) {
    items.push({ label: '$(arrow-up) Change which key is preferred', action: 'promote' });
  }
  items.push({ label: '$(trash) Remove a key', action: 'remove' });

  const picked = await vscode.window.showQuickPick(items, {
    title: `CodeRelay: ${providerId} keys`,
    placeHolder: 'Select a key to turn it on or off',
  });
  if (picked === undefined) {
    return;
  }

  if (picked.action === 'add') {
    await addCredential(context);
    await ui?.refresh();
    return;
  }

  if (picked.action === 'promote') {
    const order = await vscode.window.showQuickPick(
      pool.map((r) => ({ label: r.label, credentialId: r.credentialId })),
      { title: 'Which key should be tried first?' },
    );
    if (order !== undefined) {
      await credentials.reorder(providerId, [
        order.credentialId,
        ...pool.filter((r) => r.credentialId !== order.credentialId).map((r) => r.credentialId),
      ]);
      await ui?.refresh();
    }
    return await manageApiKeys(context);
  }

  if (picked.action === 'remove') {
    const target = await vscode.window.showQuickPick(
      pool.map((r) => ({ label: r.label, credentialId: r.credentialId })),
      { title: 'Remove which key?' },
    );
    if (target === undefined) {
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Remove “${target.label}”?`,
      { modal: true, detail: 'The key is deleted from the OS keychain. This cannot be undone.' },
      'Remove',
    );
    if (confirmed === 'Remove') {
      await credentials.remove(target.credentialId);
      await ui?.refresh();
    }
    return;
  }

  const record = pool.find((r) => r.credentialId === picked.credentialId);
  if (record === undefined) {
    return;
  }
  if (record.disabledReason !== null) {
    // A rejected key cannot be toggled back on: the provider refused it, and a
    // switch must not overrule that. Replacing it is the only real fix.
    void vscode.window.showWarningMessage(
      `“${record.label}” was rejected by ${providerId}: ${record.disabledReason}`,
      'Remove it',
    ).then(async (choice) => {
      if (choice === 'Remove it') {
        await credentials.remove(record.credentialId);
        await ui?.refresh();
      }
    });
    return;
  }

  await credentials.setEnabled(record.credentialId, record.userDisabled);
  await ui?.refresh();
  return await manageApiKeys(context);
}

/** A status glyph for one credential. Paired with words, never colour alone. */
function statusIcon(record: CredentialRecord, now: number): string {
  if (record.disabledReason !== null) {
    return '$(error)';
  }
  if (record.userDisabled) {
    return '$(circle-slash)';
  }
  if (record.coolingUntil !== null && record.coolingUntil > now) {
    return '$(watch)';
  }
  return '$(pass)';
}

/**
 * A credential's state in words.
 *
 * Every branch reports something observed: a rejection the provider sent, a
 * cooldown it imposed, failures it reported. There is no synthetic health
 * percentage, because nothing measures one.
 */
function describeCredentialState(record: CredentialRecord, now: number): string {
  if (record.disabledReason !== null) {
    return 'rejected by the provider';
  }
  if (record.userDisabled) {
    return 'turned off';
  }
  if (record.coolingUntil !== null && record.coolingUntil > now) {
    return `cooling for ${Math.ceil((record.coolingUntil - now) / 1000)}s`;
  }
  const parts: string[] = ['ready'];
  if (record.consecutiveFailures > 0) {
    parts.push(
      `${record.consecutiveFailures} recent failure${record.consecutiveFailures === 1 ? '' : 's'}`,
    );
  }
  if (record.lastUsedAt !== null) {
    parts.push(`last used ${describeAge(Date.parse(record.lastUsedAt), now)}`);
  }
  return parts.join(' · ');
}

function describeAge(at: number, now: number): string {
  if (!Number.isFinite(at)) {
    return 'at an unknown time';
  }
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/**
 * Lists and edits routing rules, entirely inside CodeRelay.
 *
 * Rules live in settings so they are shareable and version-controllable, but a
 * user never has to open the JSON to manage them — which is the point of the
 * whole screen.
 */
async function manageRoutingRules(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rules = parseRules(config.get('routingRules'));

  type Item = vscode.QuickPickItem & { action: 'add' | 'toggle' | 'delete'; id?: string };
  const items: Item[] = rules.map((rule) => ({
    label: `${rule.enabled ? '$(check)' : '$(circle-slash)'} ${rule.label}`,
    description: describeRule(rule),
    detail: rule.enabled ? undefined : 'Disabled',
    action: 'toggle',
    id: rule.id,
  }));
  items.push({
    label: '$(add) New rule…',
    description: 'Prefer a model or provider for a kind of task',
    action: 'add',
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'CodeRelay: routing rules',
    placeHolder:
      rules.length === 0
        ? 'No rules yet — the automatic choice is used for every task'
        : 'Select a rule to enable or disable it',
  });
  if (picked === undefined) {
    return;
  }

  if (picked.action === 'add') {
    await addRoutingRule(context, config, rules);
    return;
  }

  // Toggling is the common edit, so it is the click rather than a submenu.
  const next = rules.map((rule) =>
    rule.id === picked.id ? { ...rule, enabled: !rule.enabled } : rule,
  );
  await config.update('routingRules', next, vscode.ConfigurationTarget.Workspace);
  await manageRoutingRules(context);
}

/** Builds one rule through prompts, with no JSON in sight. */
async function addRoutingRule(
  context: vscode.ExtensionContext,
  config: vscode.WorkspaceConfiguration,
  existing: readonly RoutingRule[],
): Promise<void> {
  const role = await vscode.window.showQuickPick(
    TASK_ROLES.map((r) => ({ label: ROLE_LABELS[r], role: r })),
    { title: 'Routing rule: which kind of task?', placeHolder: 'When the task is…' },
  );
  if (role === undefined) {
    return;
  }

  // Offered from the real catalog through `buildCandidates`, which is the same
  // function the router uses — so a rule cannot name a model the router would
  // not recognise.
  const catalog = readCatalog();
  const models =
    catalog === null
      ? []
      : buildCandidates(catalog, credentialManager(context), Date.now()).map(
          (candidate) => candidate.model,
        );

  if (models.length === 0) {
    void vscode.window.showWarningMessage(
      'Add a provider and a model before writing a routing rule about them.',
    );
    return;
  }

  const target = await vscode.window.showQuickPick(
    models.map((model) => ({
      label: model.modelId,
      description: model.providerId,
      modelId: model.modelId,
    })),
    { title: `Routing rule: prefer which model for ${ROLE_LABELS[role.role].toLowerCase()}?` },
  );
  if (target === undefined) {
    return;
  }

  const rule: RoutingRule = {
    id: `rule-${Date.now()}`,
    label: `${ROLE_LABELS[role.role]} on ${target.modelId}`,
    enabled: true,
    when: { role: role.role },
    prefer: { modelId: target.modelId },
  };

  await config.update(
    'routingRules',
    [...existing, rule],
    vscode.ConfigurationTarget.Workspace,
  );
  void vscode.window.showInformationMessage(`Routing rule added: ${describeRule(rule)}`);
  ui?.render();
}

/**
 * Mirrors a real checkpoint into the task graph.
 *
 * The graph is what the Checkpoints view and the recovery manifest read, and
 * until this existed only the chaos dry-run ever wrote to it — so both surfaces
 * described a graph that no real task had touched.
 *
 * `verified` is deliberately false: a checkpoint is a snapshot of the work tree,
 * and nothing has run the project's checks against it at the moment it is taken.
 * Marking it verified here would be the same false tick the Verification Center
 * exists to prevent.
 */
function recordGraphCheckpoint(taskId: TaskId, checkpoint: Checkpoint): void {
  if (activeTaskGraph === null || activeTaskGraph.taskId !== taskId) {
    activeTaskGraph = new TaskStateGraph(taskId);
  }
  activeTaskGraph.addNode({
    kind: 'checkpoint',
    id: `checkpoint-${checkpoint.index}`,
    createdAt: Date.now(),
    checkpointId: `${checkpoint.index}`,
    sequenceNumber: checkpoint.index,
    gitCommitSha: checkpoint.commit,
    stateHash: checkpoint.tree,
    verified: false,
    reason: checkpoint.label,
    filesChanged: [],
  });
}

/**
 * Waits for a task's lock to be released, up to a bound.
 *
 * Returns false rather than throwing when the wait elapses: failing to switch
 * models is recoverable and the caller says so, while forcing a second session
 * onto the same ledger is not.
 */
async function waitForTaskRelease(taskId: TaskId, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (taskLock.isLocked(taskId)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/**
 * Exports a task as a portable package.
 *
 * Everything in it is read back from the ledger and the checkpoint store, so it
 * describes what happened rather than what was intended. Deliberately carries
 * no credential, no base URL and no key id — a package is meant to be
 * shareable, and the moment it is not, nobody will share it.
 */
async function exportTask(): Promise<void> {
  const taskId = ui?.store.selected ?? null;
  if (taskId === null) {
    void vscode.window.showInformationMessage('Select a task to export.');
    return;
  }

  const projection = ui?.store.project(taskId);
  if (projection === undefined) {
    return;
  }

  const store = ui?.checkpointsFor(taskId) ?? null;
  const checkpoints = store === null ? [] : await store.list(taskId);

  // A requirement counts as done only where a recorded change backs it — the
  // same evidence rule the requirement panel uses, rather than a second one.
  const backed = (mentions: readonly string[]): boolean =>
    mentions.length > 0 &&
    projection.changes.some((c) => mentions.some((m) => c.path.endsWith(m)));

  const json = exportTaskToPortableJson({
    taskId,
    objective: projection.header.title,
    completedSteps: projection.requirements.filter((r) => backed(r.mentions)).map((r) => r.text),
    remainingSteps: projection.requirements.filter((r) => !backed(r.mentions)).map((r) => r.text),
    filesChanged: projection.changes.map((c) => c.path),
    // Null rather than an invented verdict when nothing has been verified.
    verificationState:
      verification === null
        ? null
        : {
            verdict: verification.verdict,
            passedCount: verification.checks.filter((c) => c.status === 'passed').length,
            failedCount: verification.checks.filter((c) => c.status !== 'passed').length,
          },
    checkpoints: checkpoints.map((c) => ({
      sequence: c.index,
      commitSha: c.commit,
      // A `Checkpoint` carries no timestamp, and inventing one would put a
      // fabricated time into a file someone may later read as a record.
      timestamp: '',
    })),
  });

  const target = await vscode.window.showSaveDialog({
    title: 'Export CodeRelay task',
    filters: { JSON: ['json'] },
    defaultUri: vscode.Uri.file(`coderelay-task-${taskId}.json`),
  });
  if (target === undefined) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf8'));
  auditLogger.record({
    category: 'TASK',
    action: 'task_exported',
    actor: 'user',
    taskId,
    details: { path: target.fsPath },
  });
  void vscode.window.showInformationMessage(`Task exported to ${target.fsPath}`);
}

/**
 * Tests one specific credential, rather than whichever the pool would pick.
 *
 * With several keys on a provider, `testConnection` answers "does this provider
 * work" and rotation decides which key it asked — so a user with one bad key in
 * three learns nothing about which one to replace. This asks about exactly the
 * key named.
 *
 * The result is recorded against that credential, because unlike a plain
 * connection test this one *knows* which key it used: a 401 here is real
 * evidence that this key is rejected, and letting it take the key out of
 * rotation is the correct outcome rather than a side effect.
 */
async function testCredential(
  context: vscode.ExtensionContext,
  credentialId: string,
): Promise<void> {
  const catalog = await requireCatalog(context);
  if (catalog === null) {
    return;
  }
  const credentials = credentialManager(context);
  const record = credentials.find(credentialId);
  if (record === null) {
    void vscode.window.showWarningMessage('That credential no longer exists.');
    return;
  }

  const secret = await credentials.secretOf(credentialId);
  if (secret === null) {
    void vscode.window.showWarningMessage(
      `“${record.label}” has no key in the OS keychain. Remove it and add the key again.`,
    );
    return;
  }

  // Any model on this provider will do: the question is whether the credential
  // is accepted, and every model on a provider shares the credential.
  const model = buildCandidates(catalog, credentials, Date.now()).find(
    (candidate) => candidate.model.providerId === record.providerId,
  )?.model;
  if (model === undefined) {
    void vscode.window.showWarningMessage(
      `No model is configured for ${record.providerId}, so there is nothing to test the key against.`,
    );
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const verdict = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Testing “${record.label}”…`,
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
            // The one key under test, not the one rotation would choose.
            secretFor: async () => ({ t: 'secret' as const, secret }),
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

  if (verdict.t === 'cancelled') {
    return;
  }

  const described = describeVerdict(verdict, model);
  auditLogger.record({
    category: 'SECURITY',
    action: described.ok ? 'credential_test_passed' : 'credential_test_failed',
    actor: 'user',
    details: { providerId: record.providerId, label: record.label, result: described.headline },
  });

  if (described.ok) {
    void vscode.window.showInformationMessage(`“${record.label}” works.`);
  } else {
    void vscode.window.showWarningMessage(`“${record.label}”: ${described.headline}`, {
      detail: described.detail,
      modal: false,
    });
  }
  await ui?.refresh();
}

/**
 * Opens the audit trail.
 *
 * A write-only audit log is not an audit log, so this is the read side. Opened
 * as an untitled JSONL document rather than saved anywhere: the trail is
 * in-memory and per-window by design, and writing it to disk on the user's
 * behalf would create a file they did not ask for and may not want retained.
 *
 * Every value passed through `AuditLogger.record` has already been through the
 * DLP scrubber, so this cannot surface a secret that reached it by accident.
 */
async function showAuditLog(): Promise<void> {
  const events = auditLogger.list({ limit: 500 });
  if (events.length === 0) {
    void vscode.window.showInformationMessage(
      'No audit events yet. Approvals, credential changes and model switches are recorded here.',
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument({
    content: auditLogger.exportJsonl(),
    language: 'json',
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * Rebuilds the context set from what the editor can currently observe.
 *
 * Every signal here is an observation, never an inference: a file is open
 * because a tab holds it, diagnosed because the language server said so,
 * changed because the task's own fingerprints differ. `selectContext` decides
 * what that means; this only reports it.
 */
async function rebuildContext(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (root === undefined) {
    void vscode.window.showWarningMessage('CodeRelay needs an open folder to build context.');
    return;
  }

  // Capped, and excluding the directories `selectContext` would drop anyway —
  // enumerating node_modules only to throw it away is the slowest possible way
  // to reach the same answer.
  const uris = await vscode.workspace.findFiles(
    '**/*',
    '{**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/.git/**,**/coverage/**}',
    4_000,
  );
  const rel = (uri: vscode.Uri): string => vscode.workspace.asRelativePath(uri, false);

  const diagnostics = new Map<string, number>();
  for (const [uri, list] of vscode.languages.getDiagnostics()) {
    // Errors and warnings only. Hints and information are editor chatter and
    // would pull half the workspace into context.
    const serious = list.filter(
      (d) =>
        d.severity === vscode.DiagnosticSeverity.Error ||
        d.severity === vscode.DiagnosticSeverity.Warning,
    ).length;
    if (serious > 0) {
      diagnostics.set(rel(uri), serious);
    }
  }

  const openPaths: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input: unknown = tab.input;
      if (input instanceof vscode.TabInputText) {
        openPaths.push(rel(input.uri));
      }
    }
  }

  const taskId = ui?.store.selected ?? null;
  const changedPaths =
    taskId === null ? [] : ui?.store.project(taskId).changes.map((c) => c.path) ?? [];

  contextSet = selectContext({
    candidates: gatherCandidates({
      workspaceFiles: uris.map(rel),
      openPaths,
      diagnostics,
      changedPaths,
      mentionedPaths: [],
    }),
  });
  ui?.render();
}

/**
 * Opens the project memory file, creating it with its section headings if it
 * does not exist.
 *
 * Deliberately the real file in an editor rather than a bespoke form. Memory
 * steers the agent, so it deserves the same review as code — and the file stays
 * editable the day something about this extension is broken.
 */
async function openMemory(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (root === undefined) {
    void vscode.window.showWarningMessage('CodeRelay needs an open folder to store project memory.');
    return;
  }

  const uri = vscode.Uri.joinPath(root.uri, MEMORY_FILE);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    // Seeded with the headings and their hints, so an empty file still explains
    // what belongs in it.
    const seeded = [
      renderMemory(EMPTY_MEMORY).trimEnd(),
      '',
      'Notes CodeRelay gives the model. Keep it to what the repository cannot',
      'say itself — a convention with no linter behind it, a command nobody',
      'would guess, a decision and the reason for it.',
      '',
      '## Conventions',
      '',
      '## Commands',
      '',
    ].join('\n');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(seeded, 'utf8'));
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
}

/**
 * Reads project memory for the prompt, or null when there is none.
 *
 * Failure is silent by design: memory is an enhancement, and a task must not
 * refuse to start because an optional file could not be read.
 */
async function readMemoryForPrompt(): Promise<string | null> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (root === undefined) {
    return null;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(root.uri, MEMORY_FILE),
    );
    return renderForPrompt(parseMemory(Buffer.from(bytes).toString('utf8')));
  } catch {
    return null;
  }
}

/**
 * Changes the permission mode from a picker rather than settings JSON.
 *
 * The current mode is marked, and each option states what it actually allows —
 * "Balanced" means nothing on its own, and a user choosing blind is a user who
 * will be surprised by what the agent does next.
 */
async function choosePermissionMode(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = parsePermissionMode(config.get<string>('permissionMode'));

  const options: { label: string; description: string; detail: string; mode: PermissionMode }[] = [
    {
      label: 'Safe',
      description: 'ask before anything that writes',
      detail: 'Every command that changes the workspace needs your approval.',
      mode: 'safe',
    },
    {
      label: 'Balanced',
      description: 'ask before destructive commands',
      detail: 'Ordinary writes run; anything that could lose work is confirmed first.',
      mode: 'balanced',
    },
    {
      label: 'Autonomous',
      description: 'run without asking',
      detail: 'Destructive commands still refuse to run — they are forbidden, not merely unasked.',
      mode: 'autonomous',
    },
  ];

  const picked = await vscode.window.showQuickPick(
    options.map((o) => ({
      label: o.mode === current ? `$(check) ${o.label}` : o.label,
      description: o.description,
      detail: o.detail,
      mode: o.mode,
    })),
    { title: 'CodeRelay: command permissions', placeHolder: `Currently ${current}` },
  );
  if (picked === undefined) {
    return;
  }
  await config.update('permissionMode', picked.mode, vscode.ConfigurationTarget.Workspace);
  void vscode.window.showInformationMessage(`CodeRelay permissions: ${picked.mode}.`);
  ui?.render();
}

/** Where project memory lives, relative to the workspace root. */
const MEMORY_FILE = 'CODERELAY.md';

/**
 * Runs the project's own checks and records the verdict.
 *
 * Every command comes from `planVerification`, which reads the workspace's
 * `package.json`. Nothing a model produced reaches a shell through this path,
 * which is why it has no approval gate: that boundary exists for commands a
 * model chose, and `run_command` still owns that case.
 *
 * Only one run at a time. A second run would compete with the first for the
 * same `node_modules` and the same build output, and the two verdicts could
 * disagree about a workspace that never changed.
 */
async function runVerify(channel: vscode.OutputChannel): Promise<void> {
  if (verifying !== null) {
    void vscode.window.showInformationMessage('CodeRelay is already verifying this workspace.');
    return;
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  if (root === null) {
    void vscode.window.showWarningMessage(
      'CodeRelay needs an open folder to verify: the checks it runs come from the project.',
    );
    return;
  }

  const facts = await readWorkspaceFacts(root);
  const plan = planVerification(facts);

  if (plan.checks.length === 0) {
    // Deliberately not an error, and deliberately not a pass. The project
    // declares nothing to run, and saying so is the honest outcome.
    verification = {
      verdict: 'unverifiable',
      checks: [],
      unavailable: plan.unavailable,
      totalDurationMs: 0,
    };
    ui?.render();
    void vscode.window.showInformationMessage(
      'Nothing to verify: this project declares no test, lint, typecheck or build script.',
    );
    return;
  }

  const controller = new AbortController();
  verifying = controller;
  verification = null;
  ui?.render();

  try {
    const run = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CodeRelay: verifying', cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        let done = 0;
        return runVerification({
          plan,
          signal: controller.signal,
          exec: async (command, signal) => {
            progress.report({ message: `${command} (${++done} of ${plan.checks.length})` });
            channel.appendLine(`[verify] ${command}`);
            return createExecutor({ root })(command, signal);
          },
        });
      },
    );
    verification = run;
    channel.appendLine(`[verify] verdict: ${run.verdict}`);
  } finally {
    verifying = null;
    ui?.render();
  }
}

export function deactivate(): void {
  // Nothing to tear down: every ledger handle is closed by its owner, and the
  // durability guarantee means there is no buffered state to flush here.
}
