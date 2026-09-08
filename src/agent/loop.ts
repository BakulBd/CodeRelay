/**
 * The agent loop: the one place where a task is driven forward.
 *
 * Everything interesting about CodeRelay lives in the modules this file wires
 * together, and the loop's job is to sequence them without inventing any new
 * policy of its own:
 *
 *  - `ToolRunner` is the *only* path to a side effect, so the write-ahead
 *    protocol cannot be bypassed by a code path that happens to be convenient.
 *  - `planRecovery` (via `ToolRunner.resume`) decides what an interrupted task
 *    should do next. The loop acts on that decision; it never second-guesses it.
 *  - `route` decides what to do about a failure. The loop applies the decision
 *    and records it; it does not add its own retry logic on top.
 *  - `buildHandoff`/`renderHandoff` produce the text a successor model receives.
 *  - `CheckpointStore` snapshots the work tree before anything irreversible.
 *
 * Two rules shape the code more than anything else:
 *
 * 1. **A cancelled request is not a failure.** `StreamOutcome.cancelled` ends
 *    the task immediately and is never routed, never retried, and never counted
 *    as an attempt. Retrying a request the user aborted is how an agent runs a
 *    tool the user was trying to stop.
 * 2. **Request outcome is not task outcome.** A turn only counts as finished
 *    when the decoder confirmed it (`ok`) *and* the stop reason is not
 *    `truncated`. A truncated turn is recorded honestly and then routed as a
 *    failure, because a half-expressed intent must not be executed.
 *
 * Every external edge is injected — fetch, git, clock, sleep, id generation —
 * so the whole loop is exercisable with no network, no repository and no VS
 * Code host, which is the same pattern used by `TransportDeps.fetchImpl`,
 * `CheckpointStoreDeps.git` and `CredentialManagerDeps.now`.
 */
import type { CheckpointOutcome, CheckpointStore } from '../checkpoint/git.js';
import type { LedgerEntry } from '../continuity/entries.js';
import type { ExecutionLedger } from '../continuity/ledger.js';
import type { CredentialManager } from '../credentials/store.js';
import type {
  AttemptId,
  ModelRef,
  NormalizedEvent,
  StepId,
  StopReason,
  TaskId,
  ToolCallId,
} from '../core/types.js';
import { buildHandoff, renderHandoff } from '../policy/handoff.js';
import {
  DEFAULT_LIMITS,
  route,
  type Candidate,
  type PastAttempt,
  type Requirements,
  type RouteDecision,
  type RouteLimits,
} from '../policy/route.js';
import type { BuiltRequest, ProviderAdapter } from '../providers/adapter.js';
import { streamTurn, type FetchLike, type StreamOutcome } from '../providers/transport.js';
import { classifyFailure, type RequestClassification } from '../recovery/classify.js';
import type { AttemptOutcome, EndpointHealth, EndpointKey } from '../policy/health.js';
import { DEFAULT_HEDGE_LIMITS, planHedge, type HedgeLimits } from '../policy/hedge.js';
import { race, realTimer, type Timer } from './race.js';
import type { VerificationRun } from '../verify/run.js';
import type { ToolCallRequest, ToolOutcome, ToolRunner } from '../tools/runner.js';
import type { ToolRegistry } from '../tools/tool.js';

/** One item of context carried between turns. */
export interface TranscriptItem {
  /**
   * `assistant` is text a model actually completed. `tool_result` is what a
   * tool reported. `note` is something CodeRelay itself is telling the model —
   * a recovery conclusion, a discarded partial turn, a compaction summary.
   * The three are kept distinct so a prompt builder can render CodeRelay's own
   * inferences differently from observed model output.
   */
  readonly role: 'assistant' | 'tool_result' | 'note';
  readonly text: string;
  readonly toolCallId?: ToolCallId;
}

/** Everything a prompt builder is given for one attempt. */
export interface TurnPrompt {
  readonly model: ModelRef;
  readonly objective: string;
  readonly transcript: readonly TranscriptItem[];
  /**
   * Rendered handoff packet, non-null only on the first attempt after a model
   * switch. It is a reconstruction, not a transcript: see `policy/handoff.ts`.
   */
  readonly handoff: string | null;
  readonly toolNames: readonly string[];
}

/**
 * Produces the unsigned request for one attempt.
 *
 * Unsigned deliberately: the builder never sees key material. The adapter for
 * the model being used applies credentials afterwards, which is what lets a
 * provider put its key somewhere other than a header.
 */
export type RequestBuilder = (prompt: TurnPrompt) => BuiltRequest;

/** Observability hook. Deliberately not the ledger: this is for the UI. */
export type LoopEvent =
  | { readonly t: 'stream'; readonly event: NormalizedEvent }
  | { readonly t: 'tool'; readonly toolName: string; readonly outcome: ToolOutcome }
  | { readonly t: 'checkpoint'; readonly outcome: CheckpointOutcome }
  | { readonly t: 'decision'; readonly decision: RouteDecision }
  /**
   * A concurrent request was engaged alongside the primary.
   *
   * Reported here rather than written to the ledger deliberately: a hedge that
   * loses must leave no durable trace, or recovery would try to reconcile a
   * turn that never landed. The UI still needs to say a second provider was
   * engaged, because the user is paying for it.
   */
  | { readonly t: 'hedge'; readonly model: ModelRef };

export interface AgentLoopDeps {
  readonly taskId: TaskId;
  readonly ledger: ExecutionLedger;
  readonly runner: ToolRunner;
  readonly tools: ToolRegistry;
  readonly credentials: CredentialManager;
  /** Keyed by `providerId`. Each supplies a fresh decoder per attempt. */
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly fetchImpl: FetchLike;
  readonly buildRequest: RequestBuilder;
  /** Recomputed after every failure so credential health is never stale. */
  readonly candidates: () => Promise<readonly Candidate[]>;
  readonly requirements: Requirements;
  readonly initialModel: ModelRef;
  /**
   * Optional because a workspace need not be a git repository. When absent, no
   * snapshot is taken and the caller is told so — the loop never reports a
   * checkpoint it does not have.
   */
  readonly checkpoints?: CheckpointStore | null;
  readonly limits?: RouteLimits;
  /** Hard stop on model turns, so a looping model cannot run forever. */
  readonly maxTurns?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly observer?: (event: LoopEvent) => void;
  /** Characters of new text between `STREAM_PROGRESS` entries. */
  readonly progressEveryChars?: number;
  /**
   * Per-attempt stall limits, passed straight to the transport.
   *
   * Held here rather than inside the transport's defaults so a local runtime can
   * be given longer limits — or none — without every provider inheriting them.
   */
  readonly connectTimeoutMs?: number | null;
  readonly idleTimeoutMs?: number | null;
  /**
   * Source of jitter for computed retry backoff.
   *
   * Injected so `route()` stays a pure function of its inputs and the decision
   * table remains assertable. Production supplies `Math.random`; tests omit it
   * and keep the deterministic delay. A provider-supplied `retry-after` is
   * never jittered — see `backoffMs`.
   */
  readonly random?: () => number;
  /**
   * Clock used to measure time-to-first-token for health.
   *
   * Injected like every other external edge, so a health assertion can be made
   * exact instead of approximate. Defaults to `Date.now`.
   */
  readonly now?: () => number;
  /**
   * Records what each endpoint actually did, so a provider that has been
   * failing stops being chosen before it wastes another turn proving it.
   *
   * Optional because the loop is fully functional without it: health only ever
   * *reorders* and *ejects* candidates, it never invents one. A task run with
   * no tracker behaves exactly as it did before health existed.
   */
  readonly health?: HealthRecorder | null;
  /**
   * Runs the project's checks when the model claims to be finished.
   *
   * Optional: with no verifier the loop finishes on the model's word, which is
   * the behaviour that existed before the gate. Supplying one makes "done" a
   * verdict rather than a claim.
   */
  readonly verifier?: () => Promise<VerificationRun>;
  /**
   * Run more than one endpoint at once for a turn.
   *
   * Absent, or `mode: 'off'`, means exactly one leg — byte-for-byte the
   * behaviour this loop has always had, with no extra requests and no extra
   * ledger entries. Opting in races *proposals*: several endpoints are asked,
   * the first usable answer wins, and every other leg is aborted before
   * anything is committed.
   *
   * The safety argument is in `policy/hedge.ts`. The short version: a leg
   * produces text and tool-call *requests*, and only the winner is dispatched
   * through the one `ToolRunner`. A losing leg can cost input tokens; it cannot
   * cost a duplicated write.
   */
  readonly hedge?: HedgeLimits;
  /** Health for hedge planning. Injected so the planner stays pure. */
  readonly hedgeHealth?: (model: ModelRef, credentialId: string) => EndpointHealth;
  /** Breaker admission for hedge planning. Mutates, so the loop cannot fake it. */
  readonly hedgeAdmit?: (
    model: ModelRef,
    credentialId: string,
  ) => { readonly ok: boolean; readonly probe: boolean };
  /** Injected so hedge timing is deterministic under test. */
  readonly timer?: Timer;
}

/**
 * The slice of `HealthTracker` the loop needs.
 *
 * Narrowed to two methods rather than taking the class so the loop cannot
 * accidentally start reading health to make decisions — that is the router's
 * job, and a loop that both records and interprets health would be a second
 * routing policy hiding inside the sequencer.
 */
export interface HealthRecorder {
  readonly record: (key: EndpointKey, outcome: AttemptOutcome) => unknown;
  readonly releaseProbeSlot: (key: EndpointKey) => void;
}

/**
 * What one streaming attempt concluded about the loop's next move.
 *
 * `sameTurn` is the distinction the audit found missing: a retry, a credential
 * switch, a model switch and a compaction are all further *attempts at the same
 * logical turn*, while a turn that completed and dispatched tools has finished
 * its step. Only the latter advances `turn`, which is what keeps `stepId` — and
 * therefore `SideEffectKey` — stable across retries.
 */
type TurnStep =
  | { readonly kind: 'CONTINUE'; readonly sameTurn: boolean }
  | { readonly kind: 'END'; readonly result: LoopResult };

export type LoopResult =
  /** The model finished a turn with no tool calls left to make. */
  | { readonly kind: 'DONE'; readonly turns: number }
  /** Parked on a question only a human can answer. The task is not dead. */
  | { readonly kind: 'ESCALATED'; readonly question: string }
  /** The model proposed an implementation plan. */
  | { readonly kind: 'PLAN_PROPOSED'; readonly title: string; readonly planMarkdown: string }
  /** Nothing left that could plausibly work. */
  | { readonly kind: 'ABANDONED'; readonly reason: string }
  /** The caller aborted. Never retried, never routed. */
  | { readonly kind: 'CANCELLED' };

const DEFAULT_MAX_TURNS = 32;
const DEFAULT_PROGRESS_CHARS = 500;

/**
 * One leg's proposal.
 *
 * Text and tool-call *requests* only. Nothing here has touched the disk: the
 * winner is committed later through the single `ToolRunner`, and every loser is
 * discarded. That separation is the entire reason racing is safe.
 */
interface LegResult {
  readonly model: ModelRef;
  readonly credentialId: string;
  readonly outcome: StreamOutcome;
  readonly collected: Collected;
  /** Time to first token, for health. */
  readonly latencyMs: number;
}

/** What one streaming attempt produced. */
interface Collected {
  text: string;
  readonly toolCalls: { id: ToolCallId; name: string; args: unknown }[];
  stop: StopReason | null;
}

export class AgentLoop {
  private readonly limits: RouteLimits;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxTurns: number;
  private readonly progressEveryChars: number;

  private objective = '';
  private model: ModelRef;
  private transcript: TranscriptItem[] = [];
  private handoff: string | null = null;
  private attempts: PastAttempt[] = [];
  private compactions = 0;
  /** The logical step. Advances only when a turn is finished with, never on retry. */
  private turn = 0;
  /** Attempts spent on the current turn. Reported in `attemptId`, never in `stepId`. */
  private attemptsThisTurn = 0;

  constructor(private readonly deps: AgentLoopDeps) {
    this.limits = deps.limits ?? DEFAULT_LIMITS;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
    this.progressEveryChars = deps.progressEveryChars ?? DEFAULT_PROGRESS_CHARS;
    this.model = deps.initialModel;
  }

  /**
   * Runs a task to a terminal state.
   *
   * Safe to call on a ledger that already has entries: that is the resume path,
   * and it is the same code path as a fresh start apart from what recovery
   * decides to do first.
   */
  async run(objective: string): Promise<LoopResult> {
    const early = await this.startup(objective);
    if (early !== null) {
      return early;
    }
    return this.turnLoop();
  }

  // --- startup and recovery ---

  /**
   * Records the objective if this is a new task, then acts on the recovery plan.
   *
   * Returns a terminal result when recovery itself ends the task, otherwise
   * null to mean "carry on into the turn loop".
   */
  private async startup(objective: string): Promise<LoopResult | null> {
    const { ledger, runner } = this.deps;
    const entries = await ledger.read();
    const started = entries.find((e) => e.type === 'TASK_STARTED');
    // Whether the state summary below already went into the transcript. The
    // recovery switch consults it so a fact is not stated twice.
    let seededFromHandoff = false;

    // An existing objective wins. Resuming a task must not silently retarget it
    // because the caller passed a different string.
    this.objective = started?.type === 'TASK_STARTED' ? started.objective : objective;

    if (started === undefined) {
      await ledger.append({
        ...this.ids(),
        type: 'TASK_STARTED',
        objective: this.objective,
      });
    } else if (hasProgress(entries)) {
      // Resuming a task that already got somewhere. Without this the model would
      // be handed the objective and nothing else, having forgotten every step it
      // already took — the ledger would keep it from *repeating* a side effect,
      // but it would still plan the task again from the beginning, re-reading
      // files it had read and re-deciding edits it had already made.
      //
      // The reconstruction is the same one a live model switch and a compaction
      // use, for the same reason: it is the smallest faithful restatement of a
      // task we have, and it already marks what was observed separately from what
      // was inferred. A restart is a handoff whose two ends happen to be the same
      // model, so it needs no separate mechanism.
      //
      // Seeded before the recovery switch below, so any note recovery adds lands
      // *after* the state summary rather than being overwritten by it.
      const packet = buildHandoff(entries, this.deps.initialModel);
      this.transcript = [{ role: 'note', text: renderHandoff(packet) }];
      seededFromHandoff = true;
    }

    const plan = await runner.resume();

    switch (plan.kind) {
      case 'NOTHING_TO_DO':
        // The ledger already reached a terminal state. Starting a turn here
        // would resurrect a task the user finished or abandoned.
        return { kind: 'DONE', turns: 0 };

      case 'ASK_USER':
        await ledger.append({
          ...this.ids(),
          type: 'ESCALATED',
          question: plan.question,
          sideEffectKey: plan.sideEffectKey,
        });
        return { kind: 'ESCALATED', question: plan.question };

      case 'ADOPT_COMPLETED_EFFECT':
        // `resume()` already wrote TOOL_RECONCILED. The note keeps the model
        // from re-requesting the effect, and is marked as an inference.
        this.transcript.push({
          role: 'note',
          toolCallId: plan.toolCallId,
          text: `CodeRelay inferred that an interrupted operation had already completed: ${plan.evidence}. It was not run again.`,
        });
        return null;

      case 'EXECUTE_TOOL': {
        const request = this.findRequest(entries, plan.toolCallId);
        if (request === null) {
          // Recovery says to run it but the arguments are not in the ledger, so
          // there is nothing to run. Say so rather than guessing at args.
          this.transcript.push({
            role: 'note',
            text: `An interrupted operation could not be resumed because its arguments were not recorded (${plan.reason}).`,
          });
          return null;
        }
        const dispatched = await this.dispatch(request);
        if (dispatched !== null) {
          return dispatched;
        }
        return null;
      }

      case 'REGENERATE_TURN':
        // The partial text is stated exactly once. `buildHandoff` already
        // reports it, in a section that says it was never finished and that
        // nothing it describes should be assumed to have happened — so when the
        // summary was seeded above, repeating it here would send the same
        // unfinished output to the model twice and give it two different
        // accounts of one event.
        if (!seededFromHandoff && plan.partialText !== null && plan.partialText !== '') {
          this.transcript.push({
            role: 'note',
            text:
              'The previous turn was cut off before it completed. Its partial text is provided ' +
              'only as a hint about intent; it was never a finished statement and no action was ' +
              `taken from it:\n${plan.partialText}`,
          });
        }
        return null;

      case 'START_TURN':
        return null;
    }
  }

  /** Rebuilds a tool call request from the ledger, for the resume path. */
  private findRequest(
    entries: Awaited<ReturnType<ExecutionLedger['read']>>,
    toolCallId: ToolCallId,
  ): ToolCallRequest | null {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.type === 'TOOL_REQUESTED' && e.toolCallId === toolCallId) {
        return {
          toolCallId,
          stepId: e.stepId,
          attemptId: e.attemptId,
          toolName: e.toolName,
          args: e.args,
        };
      }
    }
    return null;
  }

  // --- the turn loop ---

  /**
   * Drives turns until something terminal happens.
   *
   * The two budgets here are deliberately independent. `maxTurns` bounds how
   * many *logical* turns a model gets, so a model that loops productively-looking
   * forever is stopped. Retries within a turn are bounded by the routing policy's
   * own attempt budget (`RouteLimits.maxTotalAttempts`), which is why the inner
   * repetition needs no counter of its own: `this.attempts` grows on every
   * failure and `route` returns `GIVE_UP` once it is spent, so a turn cannot
   * retry indefinitely.
   */
  private async turnLoop(): Promise<LoopResult> {
    const { ledger } = this.deps;
    let turnsStarted = 0;
    let beginNewTurn = true;

    for (;;) {
      if (beginNewTurn) {
        if (turnsStarted >= this.maxTurns) {
          break;
        }
        turnsStarted += 1;
        this.turn += 1;
        this.attemptsThisTurn = 0;
      }

      const result = await this.attemptTurn();
      if (result.kind === 'END') {
        return result.result;
      }
      beginNewTurn = !result.sameTurn;
    }

    const reason = `Stopped after ${this.maxTurns} model turns without reaching a conclusion.`;
    await ledger.append({ ...this.ids(), type: 'TASK_ABANDONED', reason });
    return { kind: 'ABANDONED', reason };
  }

  /**
   * Runs the project's own checks before a task is allowed to finish.
   *
   * Returns null when the work may complete, or the text to hand back when it
   * may not. Absent verifier means no gate at all — the loop behaves exactly as
   * it did before this existed, which is what keeps the dependency optional.
   *
   * `unverifiable` passes the gate deliberately: a project that declares no
   * checks has not failed them, and refusing to ever finish such a task would
   * make the gate a trap rather than a safeguard.
   */
  private async verifyBeforeDone(): Promise<string | null> {
    const verifier = this.deps.verifier;
    if (verifier === undefined) {
      return null;
    }

    let run: VerificationRun;
    try {
      run = await verifier();
    } catch {
      // A gate that cannot run must not block the task: failing to check is not
      // the same as checking and finding a problem.
      return null;
    }

    if (run.verdict === 'verified' || run.verdict === 'unverifiable') {
      return null;
    }

    const failed = run.checks.filter((c) => c.status === 'failed' || c.status === 'errored');
    const detail = failed
      .map((c) => `${c.label} (${c.command}): ${c.summary}\n${c.output}`.trim())
      .join('\n\n');

    return [
      'CodeRelay Evidence Gate: the task is not complete.',
      '',
      "You reported the work as finished, but the project's own checks did not pass.",
      'Fix what follows and then finish again. Do not restate that the work is done',
      'without changing anything.',
      '',
      detail,
    ].join('\n');
  }

  /**
   * One streaming attempt plus whatever follows from it.
   *
   * `CONTINUE` means the loop should keep going; the state needed for that
   * (model, credential pin, transcript, handoff) has already been updated.
   * `sameTurn` says whether the next iteration is another attempt at this turn
   * or the start of the next one.
   */
  private async attemptTurn(): Promise<TurnStep> {
    const { ledger, adapters, credentials, fetchImpl, buildRequest, tools, signal } = this.deps;
    const ids = this.ids();

    const adapter = adapters.get(this.model.providerId);
    if (adapter === undefined) {
      // A model was selected for a provider that is not installed. That is a
      // configuration fault, not something to retry.
      const reason = `No adapter is registered for provider "${this.model.providerId}".`;
      await ledger.append({ ...ids, type: 'TASK_ABANDONED', reason });
      return { kind: 'END', result: { kind: 'ABANDONED', reason } };
    }

    const acquired = await this.acquireCredential(this.model.providerId);
    if (acquired.t === 'blocked') {
      await ledger.append({
        ...ids,
        type: 'ESCALATED',
        question: acquired.question,
        sideEffectKey: null,
      });
      return { kind: 'END', result: { kind: 'ESCALATED', question: acquired.question } };
    }

    const credentialId = acquired.credentialId;

    await ledger.append({
      ...ids,
      type: 'STREAMING',
      model: this.model,
      credentialId,
    });

    const unsigned = buildRequest({
      model: this.model,
      objective: this.objective,
      // A copy, not the live array. The loop keeps pushing to `this.transcript`
      // as tools settle and turns complete, and a builder handed the live
      // reference would see context that did not exist when it was called —
      // which also makes anything it recorded about the request untrue after the
      // fact. `readonly TranscriptItem[]` promises a snapshot; this supplies one.
      transcript: [...this.transcript],
      handoff: this.handoff,
      toolNames: tools.names(),
    });

    // The handoff is context for the turn that follows a switch, not standing
    // context for the rest of the task.
    this.handoff = null;

    // The secret leaves `CredentialManager` and enters the provider layer here,
    // and goes nowhere else: it is never logged, never written to the ledger and
    // never attached to an outcome. `sign` receives the whole request because
    // some providers authenticate through the URL or a body signature rather
    // than a header, and it applies auth over the builder's headers so a prompt
    // builder cannot override credentials.
    // Only the most recent progress append is tracked. Each one supersedes the
    // last (every entry carries the whole text so far), so awaiting the newest is
    // awaiting all of them: the ledger serializes appends, so once the newest has
    // resolved every earlier one already has. Keeping the full list instead grew
    // one promise per few hundred characters of output for no benefit. An
    // already-resolved promise rather than null, so the wait below needs no
    // special case for a turn that streamed less than one progress interval.
    let progress: Promise<unknown> = Promise.resolve();
    const now = this.deps.now ?? Date.now;

    /**
     * Runs one endpoint to a proposal.
     *
     * Pure with respect to side effects: it produces text and tool-call
     * *requests* and commits none of them.
     *
     * Only the primary writes `STREAM_PROGRESS` and only the primary's tokens
     * reach the observer. Two models streaming into one record would interleave
     * their half-sentences, and the loser's text is discarded anyway.
     */
    const runLeg = async (
      legModel: ModelRef,
      legCredentialId: string,
      legSecret: string,
      legAdapter: ProviderAdapter,
      isPrimary: boolean,
      legSignal: AbortSignal,
    ): Promise<LegResult> => {
      const collected: Collected = { text: '', toolCalls: [], stop: null };
      const startedAt = now();
      let firstTokenAt: number | null = null;
      let flushedChars = 0;

      // The secret leaves `CredentialManager` and enters the provider layer
      // here, and goes nowhere else: never logged, never written to the ledger,
      // never attached to an outcome.
      const built = legAdapter.sign(unsigned, legSecret);

      const legOutcome = await streamTurn(
        {
          fetchImpl,
          decoder: legAdapter.createDecoder(),
          ...(this.deps.connectTimeoutMs === undefined
            ? {}
            : { connectTimeoutMs: this.deps.connectTimeoutMs }),
          ...(this.deps.idleTimeoutMs === undefined
            ? {}
            : { idleTimeoutMs: this.deps.idleTimeoutMs }),
        },
        {
          url: built.url,
          method: built.method,
          headers: built.headers ?? {},
          body: built.body,
          signal: legSignal,
        },
        (event) => {
          if (isPrimary) {
            this.deps.observer?.({ t: 'stream', event });
          }
          // Time-to-first-token, not total duration: total is dominated by how
          // much the model chose to say, which is a property of the request
          // rather than of the endpoint. First-token latency is the part that
          // reflects queueing and load.
          if (firstTokenAt === null && (event.t === 'text' || event.t === 'tool_call')) {
            firstTokenAt = now();
          }
          switch (event.t) {
            case 'text':
              collected.text += event.delta;
              if (isPrimary && collected.text.length - flushedChars >= this.progressEveryChars) {
                flushedChars = collected.text.length;
                // Not awaited: the sink is synchronous. The ledger serializes
                // its own appends, so ordering holds. `appendEventual` skips the
                // fsync because these entries only ever feed REGENERATE_TURN —
                // no side effect depends on them.
                progress = ledger.appendEventual({
                  ...ids,
                  type: 'STREAM_PROGRESS',
                  textSoFar: collected.text,
                });
              }
              break;
            case 'tool_call':
              collected.toolCalls.push({ id: event.id, name: event.name, args: event.args });
              break;
            case 'done':
              collected.stop = event.reason;
              break;
            default:
              // `thinking` and `usage` carry nothing the ledger needs, and
              // reasoning text is deliberately not persisted or forwarded.
              break;
          }
        },
      );

      return {
        model: legModel,
        credentialId: legCredentialId,
        outcome: legOutcome,
        collected,
        latencyMs: (firstTokenAt ?? now()) - startedAt,
      };
    };

    const won = await this.raceLegs(
      runLeg,
      credentialId,
      acquired.secret,
      adapter,
      signal,
    );
    const outcome = won.outcome;
    const collected = won.collected;
    const firstTokenAt = won.latencyMs;
    const startedAt = 0;
    const endpoint: EndpointKey = { model: won.model, credentialId: won.credentialId };

    // A hedge that won is a model change, and a model change is never silent.
    // `PROVIDER_SWITCHED` already exists and recovery already understands it, so
    // no new entry type is needed — and the timeline reads the same whether the
    // switch came from a race or from a failover.
    if (
      won.model.providerId !== this.model.providerId ||
      won.model.modelId !== this.model.modelId
    ) {
      await ledger.append({
        ...ids,
        type: 'PROVIDER_SWITCHED',
        from: this.model,
        to: won.model,
        reason: 'A concurrent request to this model answered first.',
      });
      this.model = won.model;
    }

    // Awaiting the newest append awaits every earlier one, since the ledger
    // serializes them. Swallowed rather than propagated: progress is a hint for
    // recovery, and a turn that succeeded must not be reported as failed because
    // a hint could not be written.
    await progress.catch(() => undefined);

    if (outcome.cancelled) {
      // Deliberately not FAILED and not routed: the user asked for this.
      await ledger.append({
        ...ids,
        type: 'TASK_ABANDONED',
        reason: 'Cancelled by the user.',
      });
      // The user pressing stop is not evidence about the endpoint. Release the
      // slot so a cancelled breaker probe does not stay marked in flight and
      // eject a healthy endpoint forever.
      this.deps.health?.releaseProbeSlot(endpoint);
      return { kind: 'END', result: { kind: 'CANCELLED' } };
    }

    if (outcome.ok) {
      const stop = collected.stop ?? 'stop';
      await ledger.append({
        ...ids,
        type: 'MODEL_RESPONSE_COMPLETED',
        model: this.model,
        reason: stop,
        text: collected.text,
      });

      if (stop === 'truncated' || outcome.truncated) {
        // The request succeeded; the turn did not. Recorded above so the
        // timeline shows what was received, then routed as a failure so no
        // half-formed intent is acted on.
        return this.handleFailure(
          ids,
          credentialId,
          classifyFailure({
            streamEndedEarly: true,
            hadStreamedTokens: outcome.hadStreamedTokens,
          }),
          outcome.hadStreamedTokens,
        );
      }

      await credentials.reportSuccess(credentialId);
      // Recorded only on a turn that actually completed. A truncated turn takes
      // the failure path above, which is right: the request arrived, but the
      // endpoint did not deliver a usable turn.
      this.deps.health?.record(endpoint, {
        ok: true,
        // Falls back to total elapsed when nothing streamed — inventing a zero
        // would report a measurement nobody took.
        latencyMs: (firstTokenAt ?? now()) - startedAt,
      });
      if (collected.text !== '') {
        this.transcript.push({ role: 'assistant', text: collected.text });
      }

      if (collected.toolCalls.length === 0) {
        // The model has claimed it is finished. That is an assertion, and the
        // evidence gate is what turns it into a fact: the project's own checks
        // run, and a task is only DONE when they pass.
        //
        // A failure is handed back as a `note` rather than ending the task,
        // because a type error the model can see is a type error it can fix —
        // and the alternative, stopping with "verification failed", makes the
        // user do work the agent is holding the context to do.
        const gate = await this.verifyBeforeDone();
        if (gate !== null) {
          this.transcript.push({ role: 'note', text: gate });
          // A genuinely new step: the model is being asked to do more work, not
          // to retry the turn it just completed.
          return { kind: 'CONTINUE', sameTurn: false };
        }
        await ledger.append({ ...ids, type: 'TASK_DONE' });
        return { kind: 'END', result: { kind: 'DONE', turns: this.turn } };
      }

      for (const call of collected.toolCalls) {
        const ended = await this.dispatch({
          toolCallId: call.id,
          stepId: ids.stepId,
          attemptId: ids.attemptId,
          toolName: call.name,
          args: call.args,
        });
        if (ended !== null) {
          return { kind: 'END', result: ended };
        }
      }
      // The turn was completed and its tools have been settled, so the next
      // iteration is a genuinely new step.
      return { kind: 'CONTINUE', sameTurn: false };
    }

    const failure = outcome.failure ?? unexpectedFailure(outcome);
    return this.handleFailure(ids, credentialId, failure, outcome.hadStreamedTokens);
  }

  /**
   * Runs the primary endpoint, and a hedge alongside it when one is planned.
   *
   * With hedging off — the default — this calls `runLeg` once and returns, so
   * the code path is the one the loop has always taken: no racer, no timers, no
   * abort controllers layered over a single request.
   *
   * With it on, `planHedge` decides which additional endpoints to engage and
   * when, and `race` runs them. Two rules make that safe:
   *
   *  - **Only the primary writes to the ledger.** A hedge leg that loses must
   *    leave no trace, because a `STREAMING` entry with no
   *    `MODEL_RESPONSE_COMPLETED` is byte-for-byte what an *interrupted turn*
   *    looks like to `planRecovery` — it would try to reconcile a turn that
   *    never happened.
   *  - **A leg only wins on a turn that completed.** A truncated or failed
   *    stream is a failure the racer keeps going past, which is exactly what
   *    lets a hedge rescue a primary that died mid-turn.
   *
   * The primary is always the model the task is pinned to, so a hedge can only
   * ever add an option; it never displaces the user's choice before that choice
   * has had its chance.
   */
  private async raceLegs(
    runLeg: (
      model: ModelRef,
      credentialId: string,
      secret: string,
      adapter: ProviderAdapter,
      isPrimary: boolean,
      signal: AbortSignal,
    ) => Promise<LegResult>,
    primaryCredentialId: string,
    primarySecret: string,
    primaryAdapter: ProviderAdapter,
    signal: AbortSignal | undefined,
  ): Promise<LegResult> {
    const limits = this.deps.hedge;
    const fallbackSignal = signal ?? new AbortController().signal;

    const runPrimaryAlone = (): Promise<LegResult> =>
      runLeg(this.model, primaryCredentialId, primarySecret, primaryAdapter, true, fallbackSignal);

    if (limits === undefined || limits.mode === 'off') {
      return runPrimaryAlone();
    }

    const primary = { model: this.model, credentialId: primaryCredentialId };
    const plan = planHedge({
      candidates: await this.deps.candidates(),
      requirements: this.deps.requirements,
      health: this.deps.hedgeHealth ?? (() => freshEndpointHealth(this.model, primaryCredentialId)),
      admit: this.deps.hedgeAdmit ?? (() => ({ ok: true, probe: false })),
      preferred: primary,
      limits: limits ?? DEFAULT_HEDGE_LIMITS,
      now: (this.deps.now ?? Date.now)(),
    });

    // Anything on the model the task is already pinned to is the primary, not a
    // hedge; racing a model against itself buys nothing and doubles its cost.
    const extra = plan.legs.filter(
      (leg) =>
        leg.model.providerId !== primary.model.providerId ||
        leg.model.modelId !== primary.model.modelId,
    );
    if (extra.length === 0) {
      return runPrimaryAlone();
    }

    interface LegPayload {
      readonly model: ModelRef;
      readonly credentialId: string;
      readonly secret: string;
      readonly adapter: ProviderAdapter;
      readonly primary: boolean;
    }

    const legs: { id: string; startAfterMs: number; payload: LegPayload }[] = [
      {
        id: 'primary',
        startAfterMs: 0,
        payload: {
          model: this.model,
          credentialId: primaryCredentialId,
          secret: primarySecret,
          adapter: primaryAdapter,
          primary: true,
        },
      },
    ];

    for (const [index, leg] of extra.entries()) {
      const adapter = this.deps.adapters.get(leg.model.providerId);
      if (adapter === undefined) {
        continue;
      }
      // The pool picks the key, not the plan. `planHedge` chooses the *model*;
      // which credential is usable right now is `CredentialManager`'s to answer,
      // and asking the plan would let it hand out one that has since cooled.
      const acquired = await this.acquireCredential(leg.model.providerId);
      if (acquired.t === 'blocked') {
        continue;
      }
      legs.push({
        id: `hedge-${index}`,
        startAfterMs: leg.startAfterMs,
        payload: {
          model: leg.model,
          credentialId: acquired.credentialId,
          secret: acquired.secret,
          adapter,
          primary: false,
        },
      });
    }

    if (legs.length === 1) {
      return runPrimaryAlone();
    }

    let primaryResult: LegResult | null = null;

    const outcome = await race<LegPayload, LegResult, LegResult>(
      legs,
      {
        timer: this.deps.timer ?? realTimer,
        onLegStarted: (leg) => {
          if (!leg.payload.primary) {
            this.deps.observer?.({ t: 'hedge', model: leg.payload.model });
          }
        },
        onAbandoned: (leg) => {
          // An aborted leg is not evidence the endpoint is unwell, but it must
          // give back any breaker probe slot it claimed, or that endpoint stays
          // ejected forever.
          this.deps.health?.releaseProbeSlot({
            model: leg.payload.model,
            credentialId: leg.payload.credentialId,
          });
        },
        run: async (leg, legSignal) => {
          const result = await runLeg(
            leg.payload.model,
            leg.payload.credentialId,
            leg.payload.secret,
            leg.payload.adapter,
            leg.payload.primary,
            legSignal,
          );
          if (leg.payload.primary) {
            primaryResult = result;
          }
          return result.outcome.ok && !result.outcome.truncated
            ? { ok: true, value: result }
            : { ok: false, failure: result };
        },
      },
      signal,
    );

    if (outcome.kind === 'won') {
      return outcome.value;
    }

    // Every leg failed, or the user cancelled. The primary's outcome is the one
    // the router should reason about: it is the endpoint the task is pinned to,
    // and routing decisions are made about that model's budget and credential.
    return (
      primaryResult ??
      (outcome.kind === 'exhausted' || outcome.kind === 'cancelled'
        ? outcome.failures[0]?.failure
        : undefined) ??
      runPrimaryAlone()
    );
  }

  // --- failure handling ---

  private async handleFailure(
    ids: { taskId: TaskId; stepId: StepId; attemptId: AttemptId },
    credentialId: string,
    failure: RequestClassification,
    /**
     * Reported by the transport, never inferred from the error class. Recovery
     * uses it to decide whether a turn produced anything at all, so guessing it
     * would corrupt the one signal that distinguishes "nothing happened" from
     * "something happened and we lost the rest of it".
     */
    hadStreamedTokens: boolean,
  ): Promise<TurnStep> {
    const { ledger, credentials } = this.deps;

    // Every request failure funnels through here, truncation included, so this
    // is the one place health has to be told about a bad outcome. The tracker
    // decides what counts as evidence: a rejected key or an invalid request
    // says nothing about whether the endpoint is well.
    this.deps.health?.record(
      { model: this.model, credentialId },
      { ok: false, errorClass: failure.errorClass },
    );

    await ledger.append({
      ...ids,
      type: 'FAILED',
      errorClass: failure.errorClass,
      // `reason` is the classifier's redacted summary. Raw provider bodies and
      // headers never reach here, so no credential material can leak into it.
      message: failure.reason,
      hadStreamedTokens,
    });

    await credentials.reportFailure(credentialId, failure);
    this.attempts.push({
      model: this.model,
      credentialId,
      errorClass: failure.errorClass,
    });

    const decision = route({
      current: this.model,
      currentCredentialId: credentialId,
      failure,
      attempts: this.attempts,
      candidates: await this.deps.candidates(),
      requirements: this.deps.requirements,
      compactionsDone: this.compactions,
      limits: this.limits,
      ...(this.deps.random === undefined ? {} : { random: this.deps.random }),
    });
    this.deps.observer?.({ t: 'decision', decision });

    return this.applyDecision(ids, decision);
  }

  /**
   * Carries out a routing decision.
   *
   * Note what is *not* here: no extra backoff, no second opinion, no fallback
   * when a decision looks unhelpful. The policy is one testable pure function,
   * and duplicating any of it here would make the tested behaviour a lie.
   */
  private async applyDecision(
    ids: { taskId: TaskId; stepId: StepId; attemptId: AttemptId },
    decision: RouteDecision,
  ): Promise<TurnStep> {
    const { ledger } = this.deps;

    switch (decision.kind) {
      case 'RETRY_SAME':
      case 'SWITCH_CREDENTIAL':
        await ledger.append({
          ...ids,
          type: 'RECOVERING',
          decision: `${decision.kind}: ${decision.reason}`,
        });
        await this.sleep(decision.delayMs);
        // Another go at the *same* turn: the model never finished it, so the
        // step — and any side-effect key derived from it — must not move.
        return { kind: 'CONTINUE', sameTurn: true };

      case 'SWITCH_MODEL': {
        await ledger.append({
          ...ids,
          type: 'PROVIDER_SWITCHED',
          from: decision.from,
          to: decision.to,
          reason: decision.reason,
        });
        // Built from the durable ledger rather than from in-memory state, so a
        // handoff after a restart says exactly what a handoff before one would.
        this.handoff = renderHandoff(buildHandoff(await ledger.read(), decision.to));
        this.model = decision.to;
        if (decision.degraded.length > 0) {
          this.transcript.push({
            role: 'note',
            text: `Continuing on a model with fewer capabilities. Reduced: ${decision.degraded.join(', ')}.`,
          });
        }
        await this.sleep(decision.delayMs);
        return { kind: 'CONTINUE', sameTurn: true };
      }

      case 'COMPACT_CONTEXT': {
        // The prefix is load-bearing: `buildHandoff` counts compactions by
        // matching it, and `route` escalates once the budget is spent.
        await ledger.append({
          ...ids,
          type: 'RECOVERING',
          decision: `COMPACT_CONTEXT: ${decision.reason}`,
        });
        this.compactions += 1;
        // Compaction reuses the handoff reconstruction: the smallest faithful
        // restatement of a task we have, and one that already separates what
        // was observed from what was inferred.
        const packet = buildHandoff(await ledger.read(), this.model);
        this.transcript = [{ role: 'note', text: renderHandoff(packet) }];
        return { kind: 'CONTINUE', sameTurn: true };
      }

      case 'ESCALATE':
        await ledger.append({
          ...ids,
          type: 'ESCALATED',
          question: decision.question,
          sideEffectKey: null,
        });
        return { kind: 'END', result: { kind: 'ESCALATED', question: decision.question } };

      case 'GIVE_UP':
        await ledger.append({ ...ids, type: 'TASK_ABANDONED', reason: decision.reason });
        return { kind: 'END', result: { kind: 'ABANDONED', reason: decision.reason } };
    }
  }

  // --- tools ---

  /**
   * Runs one tool call, checkpointing first when it could change the workspace.
   *
   * Returns a terminal `LoopResult` only when the call parks the task, and null
   * when the loop should carry on.
   */
  private async dispatch(request: ToolCallRequest): Promise<LoopResult | null> {
    const { ledger, runner, tools } = this.deps;

    if (!tools.has(request.toolName)) {
      // A hallucinated tool name. Recorded as a failure and fed back as
      // context; it is not a side effect, so it never enters the runner.
      const message = `Unknown tool "${request.toolName}". Available tools: ${tools.names().join(', ')}.`;
      await ledger.append({
        taskId: this.deps.taskId,
        stepId: request.stepId,
        attemptId: request.attemptId,
        type: 'FAILED',
        errorClass: 'TOOL',
        message,
        hadStreamedTokens: false,
      });
      this.transcript.push({ role: 'tool_result', toolCallId: request.toolCallId, text: message });
      return null;
    }

    if (tools.get(request.toolName).safety !== 'pure') {
      await this.checkpoint(`before ${request.toolName}`);
    }

    const outcome = await runner.run(request);
    this.deps.observer?.({ t: 'tool', toolName: request.toolName, outcome });

    switch (outcome.kind) {
      case 'EXECUTED':
        if (request.toolName === 'propose_plan') {
          let title = 'Implementation Plan';
          let planMarkdown = outcome.summary;
          try {
            const parsed = JSON.parse(outcome.summary);
            title = parsed.title;
            planMarkdown = parsed.plan_markdown;
          } catch (e) {
            // fallback if string parsing failed
          }
          await ledger.append({
            taskId: this.deps.taskId,
            stepId: request.stepId,
            attemptId: request.attemptId,
            type: 'PLAN_PROPOSED',
            title,
            planMarkdown,
          });
          return { kind: 'PLAN_PROPOSED', title, planMarkdown };
        }
        this.transcript.push({
          role: 'tool_result',
          toolCallId: request.toolCallId,
          text: outcome.summary,
        });
        return null;

      case 'ADOPTED':
        this.transcript.push({
          role: 'note',
          toolCallId: request.toolCallId,
          text: `Not run again: ${outcome.evidence}.`,
        });
        return null;

      case 'FAILED':
        // A failed tool is information, not the end of the task: the model gets
        // the error and can choose differently.
        this.transcript.push({
          role: 'tool_result',
          toolCallId: request.toolCallId,
          text: `Failed: ${outcome.message}`,
        });
        return null;

      case 'ESCALATED':
        await ledger.append({
          taskId: this.deps.taskId,
          stepId: request.stepId,
          attemptId: request.attemptId,
          type: 'ESCALATED',
          question: outcome.question,
          sideEffectKey: outcome.sideEffectKey,
        });
        return { kind: 'ESCALATED', question: outcome.question };
    }
  }

  /**
   * Takes a snapshot, if one is possible.
   *
   * Checkpoints are intentionally *not* written to the ledger. A checkpoint is
   * a git ref whose existence is verifiable directly (`CheckpointStore.list`),
   * so recording it again would create a second source of truth that could
   * disagree with the object database. When no snapshot could be taken the
   * caller is told through the observer instead of the loop pretending one
   * exists.
   */
  private async checkpoint(label: string): Promise<void> {
    const store = this.deps.checkpoints;
    if (store === undefined || store === null) {
      return;
    }
    const outcome = await store.create(this.deps.taskId, label);
    this.deps.observer?.({ t: 'checkpoint', outcome });
  }

  // --- ids ---

  /**
   * Ids for the current attempt.
   *
   * One step per turn, one attempt per streaming try. `stepId` feeds the
   * side-effect key, so it deliberately does *not* change between attempts of
   * the same turn: the same tool call retried after a provider failure is the
   * same effect, and must not look like a new one. `turnLoop` is what upholds
   * that — it advances `turn` only when a turn is actually finished with — and
   * the attempt counter carries everything that varies per try.
   *
   * `attemptId` is unique across a task without a global sequence: `turn` only
   * ever increases, and `attemptsThisTurn` restarts at zero for each new turn.
   */
  private ids(): { taskId: TaskId; stepId: StepId; attemptId: AttemptId } {
    this.attemptsThisTurn += 1;
    return {
      taskId: this.deps.taskId,
      stepId: `${this.deps.taskId}#turn-${this.turn}` as StepId,
      attemptId: `${this.deps.taskId}#turn-${this.turn}-attempt-${this.attemptsThisTurn}` as AttemptId,
    };
  }

  // --- credentials ---

  /**
   * Obtains a usable key for a provider.
   *
   * The routed `credentialId` is not forced here. `CredentialManager` owns
   * health state, and it has already cooled or disabled the key that just
   * failed, so asking it for "the next usable key" yields the routed one
   * without two components duplicating the same bookkeeping.
   */
  private async acquireCredential(
    providerId: string,
  ): Promise<
    | { readonly t: 'ok'; readonly credentialId: string; readonly secret: string }
    | { readonly t: 'blocked'; readonly question: string }
  > {
    const { credentials } = this.deps;

    for (let attempt = 0; attempt < 2; attempt++) {
      const choice = await credentials.next(providerId);

      if (choice.t === 'credential') {
        return { t: 'ok', credentialId: choice.ref.credentialId, secret: choice.secret };
      }

      if (choice.t === 'none') {
        return {
          t: 'blocked',
          question: `CodeRelay has no usable credential for "${providerId}" (${choice.reason}). Add or re-enable one to continue this task.`,
        };
      }

      // Every key is cooling. Waiting is only honest while the wait is within
      // the policy's budget; beyond that the user should decide.
      if (attempt === 1 || choice.retryAfterMs > this.limits.maxWaitMs) {
        return {
          t: 'blocked',
          question: `Every credential for "${providerId}" is rate limited or cooling down (${choice.reason}). Wait and resume, or add another key.`,
        };
      }
      await this.sleep(choice.retryAfterMs);
    }

    /* c8 ignore next */
    return { t: 'blocked', question: `No credential could be selected for "${providerId}".` };
  }
}

/**
 * Whether a ledger records anything a resumed model would need to know.
 *
 * `TASK_STARTED` alone is not progress: the objective is passed to the model
 * regardless, so summarising a task that never got past its own first entry would
 * add a "here is what happened" note saying nothing happened. Entries that merely
 * record an attempt (`RECOVERING`, `STREAM_PROGRESS`, `FAILED`) are excluded for
 * the same reason — they describe CodeRelay's plumbing, not work the model did,
 * and `buildHandoff` already folds the relevant ones into its narrative when
 * there is real work to narrate alongside them.
 */
function hasProgress(entries: readonly LedgerEntry[]): boolean {
  return entries.some(
    (e) =>
      e.type === 'MODEL_RESPONSE_COMPLETED' ||
      e.type === 'TOOL_REQUESTED' ||
      e.type === 'TOOL_EXECUTING' ||
      e.type === 'TOOL_COMPLETED' ||
      e.type === 'TOOL_RECONCILED',
  );
}

/**
 * Health for an endpoint nothing has been recorded about.
 *
 * Used when the caller supplies no health source. Every field is null or zero
 * because nothing has been observed — which `planHedge` reads as `unknown`, and
 * ranks behind a proven endpoint rather than ahead of one.
 */
function freshEndpointHealth(model: ModelRef, credentialId: string): EndpointHealth {
  return {
    key: { model, credentialId },
    successRate: null,
    latencyMs: null,
    estimatedTailMs: null,
    consecutiveFailures: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    lastOutcomeAt: null,
    lastErrorClass: null,
    breaker: { kind: 'closed' },
  };
}

/**
 * A failed outcome with no classification should be impossible.
 *
 * `streamTurn` sets `failure` whenever `ok` is false, but the loop must not
 * crash if that ever changes, and it must not silently invent a retryable
 * verdict either. UNKNOWN with `requestRetryable: false` is the honest default.
 */
function unexpectedFailure(outcome: StreamOutcome): RequestClassification {  return {
    errorClass: 'UNKNOWN',
    requestRetryable: false,
    retryAfterMs: null,
    rotateCredential: false,
    reason: `The attempt did not succeed and no classification was reported (HTTP ${outcome.httpStatus ?? 'none'}).`,
  };
}
