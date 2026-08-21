/**
 * Composition: turns configuration into a runnable `AgentLoop`.
 *
 * Everything below `src/` is written against injected dependencies precisely so
 * that no module has to know how the others are built. That leaves one job
 * unclaimed — actually building them — and this is where it happens. It is kept
 * out of `extension.ts` because none of it needs the VS Code API: a session can
 * be constructed and driven from `node --test`, which is the only way the wiring
 * itself gets tested rather than assumed.
 *
 * The only VS Code-shaped things a caller must supply are `SecretStore` and
 * `MetadataStore`, and both are already narrowed to three methods each by
 * `credentials/store.ts`.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AgentLoop, type AgentLoopDeps, type LoopEvent, type LoopResult } from '../agent/loop.js';
import { CheckpointStore, execGitRunner, type GitRunner } from '../checkpoint/git.js';
import type { LedgerEntry } from '../continuity/entries.js';
import { ExecutionLedger } from '../continuity/ledger.js';

import type { ModelRef, TaskId } from '../core/types.js';
import type { CredentialManager } from '../credentials/store.js';
import { DEFAULT_LIMITS, type Candidate, type Requirements, type RouteLimits } from '../policy/route.js';
import { ModelCatalog } from '../providers/catalog.js';
import { createFetch } from '../providers/node-fetch.js';
import { createRequestBuilder } from '../providers/requests.js';
import type { FetchLike } from '../providers/transport.js';
import { runCommandSpec, runCommandTool } from '../tools/command-tool.js';
import { builtinFileTools, builtinToolSpecs } from '../tools/file-tools.js';
import { proposePlanSpec, proposePlanTool } from '../tools/plan-tool.js';
import {
  ToolRunner,
  type ApprovalDecision,
  type ApprovalRequest,
} from '../tools/runner.js';
import { ToolRegistry } from '../tools/tool.js';
import { FileSystemEffectLog } from '../workspace/probe.js';
import { FileSystemProbe } from '../workspace/probe.js';

/** A fresh task id. Opaque and collision-free; the ledger filename derives from it. */
export function newTaskId(): TaskId {
  return randomUUID() as TaskId;
}

/**
 * What a task needs from a model.
 *
 * `toolCalling: true` is the honest default for this extension: every tool in the
 * registry writes or reads files, so a model that cannot call tools cannot do the
 * work, and letting the router pick one anyway would produce a task that narrates
 * edits it never made.
 */
export const DEFAULT_REQUIREMENTS: Requirements = {
  toolCalling: true,
  vision: false,
  minContextWindow: 0,
};

/**
 * Derives the routable candidate set from the catalog and credential health.
 *
 * This is the function that makes capability-gated failover possible at all:
 * `Candidate.capabilities` is non-optional because a router that cannot see a
 * model's limits cannot avoid exceeding them, and the catalog is where those
 * limits are declared.
 *
 * A model with no usable credential is still returned, with an empty
 * `readyCredentialIds`, rather than filtered out. The distinction matters for the
 * message the user gets: `route()` can then say "every key for this provider is
 * cooling, retry in 40s" instead of "no model supports tool calling", which would
 * be a false explanation of a credential problem.
 */
export function buildCandidates(
  catalog: ModelCatalog,
  credentials: CredentialManager,
  now: number,
): readonly Candidate[] {
  const records = credentials.records();

  return catalog.entries().flatMap((entry): Candidate[] => {
    const ref: ModelRef = { providerId: entry.provider, modelId: entry.model };
    const capabilities = catalog.capabilities(ref);
    if (capabilities === null) {
      return [];
    }

    const forProvider = records.filter((r) => r.providerId === entry.provider);
    const ready = forProvider.filter(
      (r) => r.disabledReason === null && (r.coolingUntil === null || r.coolingUntil <= now),
    );

    // Only meaningful when nothing is ready: it answers "how long until this
    // model becomes usable again", and a model that is usable now has no wait.
    let coolingRetryAfterMs: number | null = null;
    if (ready.length === 0) {
      const waits = forProvider
        .filter((r) => r.disabledReason === null && r.coolingUntil !== null)
        .map((r) => Math.max(0, (r.coolingUntil as number) - now));
      coolingRetryAfterMs = waits.length === 0 ? null : Math.min(...waits);
    }

    return [
      {
        model: ref,
        capabilities,
        readyCredentialIds: ready.map((r) => r.credentialId),
        coolingRetryAfterMs,
      },
    ];
  });
}

export interface SessionOptions {
  /** Extension-private storage. Ledgers and checkpoint scratch files live here. */
  readonly storageDir: string;
  readonly workspaceRoot: string;
  readonly catalog: ModelCatalog;
  readonly credentials: CredentialManager;
  readonly initialModel: ModelRef;
  /** Omit for a new task; supply an existing id to resume one. */
  readonly taskId?: TaskId;
  readonly requirements?: Requirements;
  readonly limits?: RouteLimits;
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
  readonly observer?: (event: LoopEvent) => void;
  /**
   * Notified as each ledger entry becomes durable.
   *
   * Separate from `observer` because the two carry different things.
   * `LoopEvent` is transient — streamed text, a routing decision, a checkpoint
   * outcome — and exists for progress reporting. A `LedgerEntry` is the durable
   * record recovery itself reads. A view driven by the ledger is therefore
   * showing exactly what a resumed task would act on, which is the property that
   * makes the timeline trustworthy rather than merely live.
   */
  readonly ledgerObserver?: (entry: LedgerEntry) => void;
  readonly fetchImpl?: FetchLike;

  readonly systemPrompt?: string;
  /**
   * Git checkpoints before each side effect. Default true.
   *
   * Disabled automatically when the workspace is not a git repository, since
   * `CheckpointStore` has nothing to write into. Never touches `HEAD`, a branch,
   * the index, or the work tree: snapshots are unreachable objects under
   * `refs/coderelay/`, which is why this can be on by default without ever
   * creating a commit the user did not ask for.
   */
  readonly checkpoints?: boolean;
  /**
   * Per-attempt stall limits, in ms. `null` disables one.
   *
   * Forwarded to the transport unchanged. Exposed here because the right value
   * is a property of the endpoint rather than of CodeRelay: a hosted API that
   * has not answered in a minute is broken, while a local model on modest
   * hardware may legitimately take longer than any default.
   */
  readonly connectTimeoutMs?: number | null;
  readonly idleTimeoutMs?: number | null;
  /**
   * Enables `run_command`, together with the approval gate that guards it.
   *
   * One option rather than two, because the tool and its gate are not separable:
   * omitting the approver would leave a shell with nothing to ask about a
   * destructive command, which is the one configuration that must be
   * unreachable.
   */
  readonly commands?: {
    readonly approve: (request: ApprovalRequest) => Promise<ApprovalDecision>;
    readonly timeoutMs?: number;
  };
  readonly now?: () => number;
}

export interface Session {
  readonly taskId: TaskId;
  readonly ledgerPath: string;
  /**
   * The checkpoint store this session built, or null when it could not.
   *
   * Exposed rather than kept private so a caller can offer "compare with the
   * state before this edit" using the snapshots that were already taken. Null is
   * a meaningful answer — it means the workspace is not a git repository — and
   * the UI reports that instead of showing a comparison it cannot make.
   *
   * Read-only in practice: `restore` returns bytes and writes nothing, and
   * nothing here can move a ref the user cares about.
   */
  readonly checkpoints: CheckpointStore | null;
  /**
   * Runs to a terminal state.
   *
   * Safe to call on a ledger that already has entries: that *is* the resume path.
   * The loop reconciles the ambiguous window from the fingerprints already on
   * disk, so an interrupted tool call is adopted rather than repeated.
   */
  run(objective: string): Promise<LoopResult>;
  close(): Promise<void>;
}

/**
 * Builds a session.
 *
 * Checkpoint availability is *probed* rather than assumed: a workspace that is
 * not a git repository gets no checkpoints and says so, instead of failing on
 * every step with a git error the user cannot act on.
 */
export async function openSession(options: SessionOptions): Promise<Session> {
  const now = options.now ?? Date.now;
  const taskId = options.taskId ?? newTaskId();
  const ledger = await ExecutionLedger.open(
    options.storageDir,
    taskId,
    options.ledgerObserver === undefined ? {} : { observer: options.ledgerObserver },
  );

  const probe = new FileSystemProbe(options.workspaceRoot);
  // The shell tool is opt-in per session. A configuration with no approver has
  // no way to ask about a destructive command, and a tool that can run anything
  // must never be reachable without the gate that guards it.
  const commandsEnabled = options.commands !== undefined;
  const tools = new ToolRegistry(
    commandsEnabled ? [...builtinFileTools, runCommandTool, proposePlanTool] : [...builtinFileTools, proposePlanTool],
  );
  const effectsDir = join(options.storageDir, 'effects', taskId);
  const runner = new ToolRunner({
    ledger,
    tools,
    probe,
    root: options.workspaceRoot,
    taskId,
    effectsDir,
    // Reading that evidence back is what turns most interrupted commands from a
    // question into a settled fact. See `tools/command-tool.ts`.
    effects: new FileSystemEffectLog(effectsDir),
    ...(options.commands === undefined ? {} : { approve: options.commands.approve }),
    ...(options.commands?.timeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commands.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const git = execGitRunner(options.workspaceRoot);
  let checkpoints: CheckpointStore | null = null;
  if (options.checkpoints !== false && (await isGitRepository(git))) {
    checkpoints = new CheckpointStore({
      git,
      // Outside the work tree, so `add -A` never stages git's own index files.
      scratchDir: join(options.storageDir, 'checkpoints', taskId),
      now,
    });
  }

  const buildRequest = createRequestBuilder({
    catalog: options.catalog,
    toolSpecs: commandsEnabled ? [...builtinToolSpecs, runCommandSpec, proposePlanSpec] : [...builtinToolSpecs, proposePlanSpec],
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
  });

  const deps: AgentLoopDeps = {
    taskId,
    ledger,
    runner,
    tools,
    credentials: options.credentials,
    adapters: options.catalog.adapterMap(),
    fetchImpl: options.fetchImpl ?? createFetch(),
    buildRequest,
    // Re-evaluated per routing decision, so a key that finished cooling during a
    // backoff becomes usable without restarting the task.
    candidates: async () => buildCandidates(options.catalog, options.credentials, now()),
    requirements: options.requirements ?? DEFAULT_REQUIREMENTS,
    initialModel: options.initialModel,
    checkpoints,
    limits: options.limits ?? DEFAULT_LIMITS,
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  };

  const loop = new AgentLoop(deps);

  return {
    taskId,
    ledgerPath: ledger.filePath,
    checkpoints,
    run: (objective: string) => loop.run(objective),
    close: () => ledger.close(),
  };
}

/**
 * Whether the workspace is inside a git work tree.
 *
 * `CheckpointStore` already reports `not_a_repository` rather than throwing, so
 * this probe is not about safety — it is about noise. Without it, a workspace
 * that is not a repository records a checkpoint failure on every single step, and
 * a timeline full of expected failures trains the user to ignore the one that
 * matters. Asked once per session, because the answer cannot change mid-task in
 * any way that would help.
 */
async function isGitRepository(git: GitRunner): Promise<boolean> {
  try {
    const result = await git.run(['rev-parse', '--is-inside-work-tree']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
