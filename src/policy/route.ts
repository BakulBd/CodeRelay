/**
 * Routing policy: where should the *next request* go after this one failed?
 *
 * Scope, stated up front because getting this wrong is how a failover feature
 * corrupts a workspace: this module decides nothing about side effects. Whether
 * an interrupted tool call may be re-run is decided by `planRecovery`, from the
 * durable ledger and observed files. `route()` only answers the narrower
 * question of which model and credential the next attempt should use, and how
 * long to wait first.
 *
 * The rules follow one principle: never repeat an attempt that is already known
 * to fail. That means
 *
 *  - a credential the provider rejected in this task is never offered again,
 *    even if the credential store has not caught up yet;
 *  - a failure the classifier marked non-retryable never becomes a retry of the
 *    same model, no matter how much attempt budget is left;
 *  - a model that has exhausted its per-model attempt budget stops being a
 *    candidate rather than being retried "one more time".
 *
 * Where a decision rests on evidence (the provider returned 401, so this key is
 * bad) it is tagged `observed`. Where it rests on a guess (an unclassified error
 * *might* not happen on a different provider) it is tagged `inferred`, and the
 * UI must not present the two in the same voice.
 *
 * Backoff is deterministic. Jitter is deliberately absent: this is a single-user
 * editor extension, not a fleet, so there is no thundering herd to spread out,
 * and a deterministic delay is one that can be tested.
 */
import type { ErrorClass, ModelCapabilities, ModelRef } from '../core/types.js';
import type { Classification, RequestClassification } from '../recovery/classify.js';

/**
 * A failure that came from attempting a request.
 *
 * Narrowed to `RequestErrorClass` so `TOOL` and `FILESYSTEM` cannot be passed
 * here at all. Those are settled from the ledger by `planRecovery`, and the
 * previous version of this module carried a live-looking `GIVE_UP` branch for
 * them that nothing could reach — and that would have abandoned tasks which
 * should continue, since a failing test is information the model can act on.
 *
 * Aliased rather than redeclared so there is exactly one definition of "a
 * classified request failure" in the codebase.
 */
export type RequestFailure = RequestClassification;

/** One attempt that already happened in this task. */
export interface PastAttempt {
  readonly model: ModelRef;
  readonly credentialId: string;
  readonly errorClass: ErrorClass;
}

/**
 * A model the task could move to.
 *
 * `readyCredentialIds` is the caller's view of the credential store *right now*
 * — ids only, never key material. `coolingRetryAfterMs` is how long until a
 * throttled credential frees up, so the policy can choose between waiting and
 * moving.
 */
export interface Candidate {
  readonly model: ModelRef;
  readonly capabilities: ModelCapabilities;
  readonly readyCredentialIds: readonly string[];
  readonly coolingRetryAfterMs: number | null;
}

/** What the task actually needs from a model. Gates every failover target. */
export interface Requirements {
  readonly toolCalling: boolean;
  readonly vision: boolean;
  readonly minContextWindow: number;
}

export interface RouteLimits {
  /** Attempts allowed against one model before it is abandoned. */
  readonly maxAttemptsPerModel: number;
  /** Attempts allowed across the whole task before the user is asked. */
  readonly maxTotalAttempts: number;
  /** Longest delay the policy will impose without asking the user. */
  readonly maxWaitMs: number;
  readonly baseBackoffMs: number;
  /** How many times a task may be compacted before context loss is escalated. */
  readonly contextCompactionsAllowed: number;
}

export const DEFAULT_LIMITS: RouteLimits = {
  maxAttemptsPerModel: 3,
  maxTotalAttempts: 8,
  maxWaitMs: 60_000,
  baseBackoffMs: 1_000,
  contextCompactionsAllowed: 1,
};

export interface RouteInput {
  readonly current: ModelRef;
  readonly currentCredentialId: string;
  readonly failure: RequestFailure;

  /** Every attempt so far, including the one that just failed. */
  readonly attempts: readonly PastAttempt[];
  /** All usable models, including the current one. */
  readonly candidates: readonly Candidate[];
  readonly requirements: Requirements;
  /** Context compactions already performed in this task. */
  readonly compactionsDone?: number;
  readonly limits?: RouteLimits;
}

/** How confident the decision is. Never render these two the same way. */
export type DecisionTone = 'observed' | 'inferred';

export type RouteDecision =
  /** Same model, same credential, after a delay. */
  | {
      readonly kind: 'RETRY_SAME';
      readonly model: ModelRef;
      readonly credentialId: string;
      readonly delayMs: number;
      readonly reason: string;
      readonly tone: DecisionTone;
    }
  /** Same model, different key. Cheapest possible failover: nothing changes. */
  | {
      readonly kind: 'SWITCH_CREDENTIAL';
      readonly model: ModelRef;
      readonly credentialId: string;
      readonly delayMs: number;
      readonly reason: string;
      readonly tone: DecisionTone;
    }
  /**
   * A different model, possibly on a different provider.
   *
   * `degraded` names every capability the destination has less of than the
   * origin. A silent downgrade is a correctness bug, not a convenience.
   */
  | {
      readonly kind: 'SWITCH_MODEL';
      readonly from: ModelRef;
      readonly to: ModelRef;
      readonly credentialId: string;
      readonly delayMs: number;
      readonly reason: string;
      readonly degraded: readonly string[];
      readonly tone: DecisionTone;
    }
  /** The request did not fit. Shrink the context before trying again. */
  | {
      readonly kind: 'COMPACT_CONTEXT';
      readonly model: ModelRef;
      readonly credentialId: string;
      readonly reason: string;
      readonly tone: DecisionTone;
    }
  /** Only a human can move this forward. The task parks, it does not die. */
  | {
      readonly kind: 'ESCALATE';
      readonly question: string;
      readonly reason: string;
      readonly tone: DecisionTone;
    }
  /** Nothing left to try that could plausibly work. */
  | {
      readonly kind: 'GIVE_UP';
      readonly reason: string;
      readonly tone: DecisionTone;
    };

export function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/** Deterministic exponential backoff, capped by the policy's wait budget. */
export function backoffMs(priorAttemptsOnModel: number, limits: RouteLimits): number {
  const exponent = Math.max(0, priorAttemptsOnModel - 1);
  const raw = limits.baseBackoffMs * 2 ** exponent;
  return Math.min(raw, limits.maxWaitMs);
}

/**
 * Chooses the next attempt, or explains why there is not one.
 *
 * Pure: every input the decision depends on is an argument, so the whole
 * decision table can be tested without a provider, a keychain or an editor.
 */
export function route(input: RouteInput): RouteDecision {
  const limits = input.limits ?? DEFAULT_LIMITS;
  return withinAttemptBudget(input, limits, decide(input, limits));
}

/**
 * Applies the whole-task attempt budget to a decision that has already been made.
 *
 * Deliberately *after* classification rather than before it. The budget exists to
 * stop the task retrying automatically, so it overrides only the decisions that
 * would do that. An `ESCALATE` is passed through untouched, because escalating is
 * already stopping, and the question it carries is the specific, actionable thing
 * the classifier learned. Checking the budget first turned a `TLS_UNTRUSTED`
 * failure on the last attempt from "trust your proxy's CA certificate" into a
 * generic "this failed too many times", discarding the one message that would
 * have let the user fix it.
 *
 * Everything else becomes `GIVE_UP`, and the budget is named first so the user
 * learns *why* the task stopped here rather than at the next failure. A
 * classified `GIVE_UP` keeps its own reason as well, since "nothing left to try"
 * and "out of attempts" are different facts and both are true.
 */
function withinAttemptBudget(
  input: RouteInput,
  limits: RouteLimits,
  decision: RouteDecision,
): RouteDecision {
  if (input.attempts.length < limits.maxTotalAttempts) {
    return decision;
  }
  if (decision.kind === 'ESCALATE') {
    return decision;
  }

  const spent =
    `This task has already failed ${input.attempts.length} times ` +
    `(limit ${limits.maxTotalAttempts}).`;

  if (decision.kind === 'GIVE_UP') {
    return { kind: 'GIVE_UP', reason: `${spent} ${decision.reason}`, tone: 'observed' };
  }

  return {
    kind: 'GIVE_UP',
    reason:
      `${spent} The next step would have been ${decision.kind}, but continuing to retry ` +
      `automatically would hide a problem rather than solve it: ${input.failure.reason}`,
    tone: 'observed',
  };
}

/**
 * The per-class policy, with no budget arithmetic in it.
 *
 * Split out from `route` so the two concerns stay separable: this answers "what
 * does this kind of failure call for", and `withinAttemptBudget` answers "may the
 * task still act automatically".
 */
function decide(input: RouteInput, limits: RouteLimits): RouteDecision {
  const { failure } = input;

  switch (failure.errorClass) {
    case 'TLS_UNTRUSTED':
      // A broken certificate chain is a machine configuration fact. It will be
      // just as broken on the next provider, so failing over would only mask it.
      return {
        kind: 'ESCALATE',
        question:
          'The provider\u2019s TLS certificate could not be verified. This usually means a ' +
          'corporate proxy is intercepting HTTPS. Trust the proxy\u2019s CA certificate, or ' +
          'point CodeRelay at an endpoint that is not intercepted.',
        reason: failure.reason,
        tone: 'observed',
      };

    case 'AUTH':
      return afterRejectedCredential(input, limits);

    case 'FORBIDDEN':
      return afterForbiddenPairing(input, limits);

    case 'CONTEXT':
      return afterContextOverflow(input, limits);

    case 'CONFIG':
      // The request itself was invalid for this model. Retrying it verbatim is
      // guaranteed to fail again; a different model may accept it.
      return (
        switchModel(
          input,
          limits,
          `This model rejected the request as invalid: ${failure.reason}`,
          'inferred',
        ) ?? {
          kind: 'ESCALATE',
          question:
            'The provider rejected the request as invalid and no alternative model is ' +
            'configured. Check the model name and request settings.',
          reason: failure.reason,
          tone: 'observed',
        }
      );

    case 'RETRYABLE':
    case 'NETWORK':
    case 'STREAM':
      return afterTransientFailure(input, limits);

    case 'UNKNOWN':
      // Deliberately not retried on the same model: an error we cannot explain
      // is one whose retry safety we cannot vouch for either.
      return (
        switchModel(
          input,
          limits,
          `This failure could not be classified, so it is not retried on the same model: ${failure.reason}`,
          'inferred',
        ) ?? {
          kind: 'ESCALATE',
          question:
            'A failure occurred that CodeRelay could not classify, and there is no other ' +
            'model to try. Review the details in the timeline before continuing.',
          reason: failure.reason,
          tone: 'observed',
        }
      );

    default: {
      // Exhaustiveness: adding an ErrorClass without a policy is a build error.
      const never: never = failure.errorClass;
      throw new Error(`Unhandled error class: ${String(never)}`);
    }
  }
}

/**
 * 401. The key itself was rejected, and no amount of waiting fixes a revoked key.
 *
 * Another key on the same provider is preferred over another provider, because
 * it keeps the model — and therefore the task's behaviour — identical.
 */
function afterRejectedCredential(input: RouteInput, limits: RouteLimits): RouteDecision {
  const sibling = otherCredentialOnCurrentModel(input);
  if (sibling !== null) {
    return {
      kind: 'SWITCH_CREDENTIAL',
      model: input.current,
      credentialId: sibling,
      delayMs: 0,
      reason:
        'The provider rejected this key, so the task continues on another key for the ' +
        'same model.',
      tone: 'observed',
    };
  }

  const elsewhere = switchModel(
    input,
    limits,
    'Every configured key for this provider was rejected, so the task moves to another provider.',
    'observed',
  );
  if (elsewhere !== null) {
    return elsewhere;
  }

  return {
    kind: 'ESCALATE',
    question:
      'The provider rejected the credential and there is no other key or provider to fall ' +
      'back to. Add a valid API key to continue this task.',
    reason: input.failure.reason,
    tone: 'observed',
  };
}

/**
 * 403. The key is real and accepted; it is this *pairing* that is refused.
 *
 * The distinction from 401 is the whole point of the separate error class. A 403
 * usually means the account behind an otherwise healthy key is not entitled to
 * this particular model, endpoint or region — often a tier or allow-list
 * decision. Disabling the credential there would throw away a key that works
 * perfectly well for every other model, so the model moves and the key stays.
 *
 * Order: another model on the *same* key first, because that changes one
 * variable instead of two; then another model on any usable key; then, as a
 * guess rather than an observation, another key on the same model, since a key
 * from a different account may carry the entitlement this one lacks.
 */
function afterForbiddenPairing(input: RouteInput, limits: RouteLimits): RouteDecision {
  const forbidden = forbiddenPairings(input.attempts);
  const keptKey = switchModel(
    input,
    limits,
    'The provider recognises this key but will not serve this model with it, so the task ' +
      'continues on another model using the same key.',
    'observed',
    // The destination must accept *this* key, and must not be a pairing the
    // provider has already refused — otherwise pinning the key below would walk
    // straight back into a 403 the attempt history already recorded.
    (candidate) =>
      candidate.readyCredentialIds.includes(input.currentCredentialId) &&
      !forbidden.has(pairKey(input.currentCredentialId, candidate.model)),
  );
  if (keptKey !== null && keptKey.kind === 'SWITCH_MODEL') {
    // `switchModel` picks the first usable key for the destination; for a 403 we
    // specifically want to carry the current one over, so it is pinned here.
    return { ...keptKey, credentialId: input.currentCredentialId };
  }

  const elsewhere = switchModel(
    input,
    limits,
    'This key is not permitted to use this model, so the task continues on another model.',
    'observed',
  );
  if (elsewhere !== null) {
    return elsewhere;
  }

  const sibling = otherCredentialOnCurrentModel(input);
  if (sibling !== null) {
    return {
      kind: 'SWITCH_CREDENTIAL',
      model: input.current,
      credentialId: sibling,
      delayMs: 0,
      reason:
        'This key is not permitted to use this model and there is no other model to move ' +
        'to, so another key is tried in case it carries the missing entitlement.',
      tone: 'inferred',
    };
  }

  return {
    kind: 'ESCALATE',
    question:
      'The provider accepted this key but refused to serve this model with it, and there ' +
      'is no other model or key to fall back to. Check that your account has access to ' +
      'this model, endpoint and region \u2014 the key itself is not the problem.',
    reason: input.failure.reason,
    tone: 'observed',
  };
}

/**
 * The request did not fit in the model's window.
 *
 * Compaction comes first because it preserves the model choice, and repeated
 * compaction is capped: past a point, shrinking the context is deleting the
 * information the task needs, and moving to a larger window is honest where
 * another compaction would not be.
 */
function afterContextOverflow(input: RouteInput, limits: RouteLimits): RouteDecision {
  const done = input.compactionsDone ?? 0;
  if (done < limits.contextCompactionsAllowed) {
    return {
      kind: 'COMPACT_CONTEXT',
      model: input.current,
      credentialId: input.currentCredentialId,
      reason: `The request exceeded this model\u2019s limit: ${input.failure.reason}`,
      tone: 'observed',
    };
  }

  const currentWindow = capabilitiesOf(input, input.current)?.contextWindow ?? 0;
  const bigger = switchModel(
    input,
    limits,
    'The context no longer fits after compaction, so the task moves to a model with a ' +
      'larger window.',
    'observed',
    (candidate) => candidate.capabilities.contextWindow > currentWindow,
  );
  if (bigger !== null) {
    return bigger;
  }

  return {
    kind: 'ESCALATE',
    question:
      'This task no longer fits in the context window of any configured model, and it has ' +
      'already been compacted. Split the task, or add a model with a larger window.',
    reason: input.failure.reason,
    tone: 'observed',
  };
}

/**
 * Rate limits, network drops and truncated streams.
 *
 * Order matters. Rotating a key costs nothing and keeps the model, so it is
 * tried before any delay. Waiting is preferred over changing models when the
 * provider told us how long to wait and that wait is short. Only then does the
 * task change models, because a different model is a different behaviour and
 * that is a real cost to the user even when it succeeds.
 */
function afterTransientFailure(input: RouteInput, limits: RouteLimits): RouteDecision {
  const { failure } = input;

  if (failure.rotateCredential) {
    const sibling = otherCredentialOnCurrentModel(input);
    if (sibling !== null) {
      return {
        kind: 'SWITCH_CREDENTIAL',
        model: input.current,
        credentialId: sibling,
        delayMs: 0,
        reason:
          'This key is rate limited, so the task continues immediately on another key for ' +
          'the same model.',
        tone: 'observed',
      };
    }
  }

  const priorOnModel = attemptsOn(input.attempts, input.current);
  const budgetLeft = priorOnModel < limits.maxAttemptsPerModel;
  const delayMs = failure.retryAfterMs ?? backoffMs(priorOnModel, limits);

  if (failure.requestRetryable && budgetLeft && delayMs <= limits.maxWaitMs) {
    return {
      kind: 'RETRY_SAME',
      model: input.current,
      credentialId: input.currentCredentialId,
      delayMs,
      reason: retryReason(failure, delayMs),
      tone: 'observed',
    };
  }

  const elsewhere = switchModel(
    input,
    limits,
    budgetLeft
      ? `Waiting ${delayMs} ms for this provider is longer than this task should stall, so ` +
          'it continues on another model.'
      : `This model failed ${priorOnModel} times, so the task continues on another model.`,
    'observed',
  );
  if (elsewhere !== null) {
    return elsewhere;
  }

  // Nothing else to move to. If a wait would clear the block, say so with the
  // real number instead of retrying blindly.
  const wait = failure.retryAfterMs ?? soonestCooldown(input);
  if (failure.requestRetryable && wait !== null) {
    return {
      kind: 'ESCALATE',
      question:
        `Every configured model is unavailable. The provider suggests retrying in ` +
        `${Math.ceil(wait / 1000)} s. Wait and resume, or choose a different model.`,
      reason: failure.reason,
      tone: 'observed',
    };
  }

  return {
    kind: 'GIVE_UP',
    reason:
      `No configured model can serve this task and the failure is not retryable: ${failure.reason}`,
    tone: 'observed',
  };
}

function retryReason(failure: Classification, delayMs: number): string {
  const when = delayMs === 0 ? 'immediately' : `in ${delayMs} ms`;
  return `Transient failure, retrying the same model ${when}: ${failure.reason}`;
}

/**
 * Builds a SWITCH_MODEL decision, or null when no candidate qualifies.
 *
 * A candidate qualifies only if it meets the task's requirements, still has
 * attempt budget, has a key ready, and is not the model that just failed.
 * Preference is fewest prior attempts, then lowest cost: an automatic failover
 * that silently moves a task onto the most expensive model available is not a
 * feature the user asked for.
 */
function switchModel(
  input: RouteInput,
  limits: RouteLimits,
  reason: string,
  tone: DecisionTone,
  extra?: (candidate: Candidate) => boolean,
): RouteDecision | null {
  const rejected = rejectedCredentials(input.attempts);
  const forbidden = forbiddenPairings(input.attempts);
  const eligible = input.candidates.filter((candidate) => {
    if (sameModel(candidate.model, input.current)) {
      return false;
    }
    if (!meetsRequirements(candidate.capabilities, input.requirements)) {
      return false;
    }
    if (attemptsOn(input.attempts, candidate.model) >= limits.maxAttemptsPerModel) {
      return false;
    }
    if (usableCredentials(candidate, rejected, forbidden).length === 0) {
      return false;
    }
    return extra === undefined || extra(candidate);
  });

  const best = eligible
    .slice()
    .sort((a, b) => {
      const byAttempts =
        attemptsOn(input.attempts, a.model) - attemptsOn(input.attempts, b.model);
      if (byAttempts !== 0) {
        return byAttempts;
      }
      return cost(a.capabilities) - cost(b.capabilities);
    })
    .at(0);

  if (best === undefined) {
    return null;
  }

  const credentialId = usableCredentials(best, rejected, forbidden)[0];
  if (credentialId === undefined) {
    return null; // unreachable given the filter above; kept so the types stay honest
  }

  return {
    kind: 'SWITCH_MODEL',
    from: input.current,
    to: best.model,
    credentialId,
    delayMs: 0,
    reason,
    degraded: degradations(capabilitiesOf(input, input.current), best.capabilities),
    tone,
  };
}

/** Capabilities the destination model has less of than the origin. */
function degradations(
  from: ModelCapabilities | null,
  to: ModelCapabilities,
): readonly string[] {
  if (from === null) {
    return [];
  }
  const out: string[] = [];
  if (from.toolCalling && !to.toolCalling) {
    out.push('tool calling');
  }
  if (from.parallelToolCalls && !to.parallelToolCalls) {
    out.push('parallel tool calls');
  }
  if (from.vision && !to.vision) {
    out.push('image input');
  }
  if (from.structuredOutput && !to.structuredOutput) {
    out.push('structured output');
  }
  if (from.streaming && !to.streaming) {
    out.push('streaming');
  }
  if (reasoningRank(to.reasoning) < reasoningRank(from.reasoning)) {
    out.push('reasoning');
  }
  if (to.contextWindow < from.contextWindow) {
    out.push('context window');
  }
  if (to.maxOutput < from.maxOutput) {
    out.push('maximum output length');
  }
  return out;
}

function reasoningRank(level: ModelCapabilities['reasoning']): number {
  return level === 'explicit' ? 2 : level === 'implicit' ? 1 : 0;
}

function meetsRequirements(caps: ModelCapabilities, need: Requirements): boolean {
  if (need.toolCalling && !caps.toolCalling) {
    return false;
  }
  if (need.vision && !caps.vision) {
    return false;
  }
  return caps.contextWindow >= need.minContextWindow;
}

function cost(caps: ModelCapabilities): number {
  return caps.costPerMTokIn + caps.costPerMTokOut;
}

function capabilitiesOf(input: RouteInput, model: ModelRef): ModelCapabilities | null {
  return input.candidates.find((c) => sameModel(c.model, model))?.capabilities ?? null;
}

function attemptsOn(attempts: readonly PastAttempt[], model: ModelRef): number {
  return attempts.filter((a) => sameModel(a.model, model)).length;
}

/**
 * Credentials the provider rejected during this task.
 *
 * Tracked here as well as in the credential store because the store may not
 * have been updated yet when routing runs, and offering a key that was rejected
 * seconds ago is a wasted attempt at best.
 */
function rejectedCredentials(attempts: readonly PastAttempt[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.errorClass === 'AUTH') {
      out.add(attempt.credentialId);
    }
  }
  return out;
}

function pairKey(credentialId: string, model: ModelRef): string {
  return `${credentialId} ${model.providerId} ${model.modelId}`;
}

/**
 * `(credential, model)` pairs the provider has already refused with a 403.
 *
 * A 403 is a statement about the *pairing*, not about either half of it, which is
 * why `afterForbiddenPairing` keeps the key and moves the model. But that means a
 * 403-ed key stays out of `rejectedCredentials` — correctly, since it may work
 * fine elsewhere — and without this set nothing remembers that it has already
 * been refused *here*. Two keys both lacking an entitlement then alternate on the
 * same model until `maxTotalAttempts` runs out: bounded, but it burns the whole
 * budget re-learning the same fact and ends in `GIVE_UP` rather than in the
 * `ESCALATE` that would tell the user their account lacks access.
 *
 * Keyed per pairing rather than per credential so a key refused for one model is
 * still tried on another, which is the distinction the 403 handler exists to make.
 */
function forbiddenPairings(attempts: readonly PastAttempt[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.errorClass === 'FORBIDDEN') {
      out.add(pairKey(attempt.credentialId, attempt.model));
    }
  }
  return out;
}

function usableCredentials(
  candidate: Candidate,
  rejected: ReadonlySet<string>,
  forbidden: ReadonlySet<string>,
): readonly string[] {
  return candidate.readyCredentialIds.filter(
    (id) => !rejected.has(id) && !forbidden.has(pairKey(id, candidate.model)),
  );
}

/** Another ready key for the model that just failed, excluding the failed one. */
function otherCredentialOnCurrentModel(input: RouteInput): string | null {
  const candidate = input.candidates.find((c) => sameModel(c.model, input.current));
  if (candidate === undefined) {
    return null;
  }
  const rejected = rejectedCredentials(input.attempts);
  const forbidden = forbiddenPairings(input.attempts);
  const usable = candidate.readyCredentialIds.filter(
    (id) =>
      id !== input.currentCredentialId &&
      !rejected.has(id) &&
      !forbidden.has(pairKey(id, input.current)),
  );
  return usable[0] ?? null;
}

/** The shortest cooldown across all candidates, if any is cooling. */
function soonestCooldown(input: RouteInput): number | null {
  const waits = input.candidates
    .map((c) => c.coolingRetryAfterMs)
    .filter((ms): ms is number => ms !== null);
  return waits.length === 0 ? null : Math.min(...waits);
}
