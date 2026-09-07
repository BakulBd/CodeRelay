/**
 * Hedging policy: which endpoints should be *in flight at once* for one turn?
 *
 * This is the answer to "run several providers at the same time so one failing
 * does not stall the task". It is a different question from the one `route()`
 * answers. `route()` is reactive and sequential — a request failed, where does
 * the next one go. This is proactive and concurrent — before anything has
 * failed, how many places should we ask, and when.
 *
 * ## Why this is safe, stated before anything else
 *
 * Racing a coding agent sounds dangerous, and done naively it is: two providers
 * both executing tool calls would apply the same edit twice. That is not what
 * happens here, because the loop already separates the two halves of a turn:
 *
 *   `attemptTurn`  produces a *proposal*  — text plus tool-call requests. Pure.
 *                                            Nothing has touched the disk.
 *   `dispatch`     *commits* the proposal — one `ToolRunner`, write-ahead
 *                                            ledger, exactly-once side-effect keys.
 *
 * Hedging races the **proposal** only. The first usable proposal wins, every
 * other racer is aborted before it can be committed, and the winner is then
 * dispatched through the same single-threaded runner as always. No side effect
 * is ever produced by more than one attempt, so every exactly-once guarantee in
 * the existing design is untouched. A losing racer costs input tokens; it
 * cannot cost a duplicated write.
 *
 * That is the invariant the whole feature rests on: **race proposals, commit
 * one.** If anyone ever moves tool execution into `attemptTurn`, this module
 * must be deleted in the same commit.
 *
 * ## Why adaptive rather than always-on
 *
 * Firing every candidate at t=0 is the fastest and the most wasteful: N times
 * the input tokens on every turn, forever, to save latency on the small
 * fraction of turns that are actually slow. The tail-at-scale result is that
 * you get nearly all of the benefit by firing a backup only once the primary
 * has already proven itself slow — the primary answers first the great majority
 * of the time, and the hedge costs nothing on those turns because it is never
 * sent.
 *
 * So the default is `adaptive`: one request goes out, and a second is armed to
 * fire at the primary's own observed tail latency. An endpoint with no history
 * gets a fixed default delay, because a hedge threshold derived from no
 * measurements would be a number pretending to be an estimate.
 *
 * ## Why the backup is chosen for diversity
 *
 * A hedge that goes to the same provider on the same credential shares the
 * thing most likely to be wrong: the rate-limit bucket, the account, the
 * regional outage. The ordering below prefers a different provider, then a
 * different credential on the same provider, and only then anything else — so
 * the second request is correlated with the first as weakly as the configured
 * candidates allow.
 */
import type { ModelRef } from '../core/types.js';
import {
  DEFAULT_HEALTH_LIMITS,
  grade,
  type EndpointHealth,
  type HealthLimits,
} from './health.js';
import type { Candidate, Requirements } from './route.js';

/** How aggressively to run endpoints concurrently. */
export type HedgeMode =
  /** One request at a time. Identical to the pre-hedging behaviour. */
  | 'off'
  /** One request, with a backup armed to fire if the first goes slow. */
  | 'adaptive'
  /** Every permitted endpoint at t=0. Fastest, and pays for every racer. */
  | 'race';

export interface HedgeLimits {
  readonly mode: HedgeMode;
  /**
   * Ceiling on requests in flight for one turn, the primary included.
   *
   * `2` is the default because the second request captures most of the
   * available benefit and the third mostly buys tokens. Raising it is a power
   * user's decision, so it is a setting rather than a heuristic.
   */
  readonly maxInFlight: number;
  /** Floor on the hedge delay, so a fast endpoint is not hedged pointlessly. */
  readonly minHedgeDelayMs: number;
  /** Ceiling, so an endpoint with a terrible estimate still gets hedged. */
  readonly maxHedgeDelayMs: number;
  /** Delay used when the primary has no measured latency yet. */
  readonly unknownHedgeDelayMs: number;
}

export const DEFAULT_HEDGE_LIMITS: HedgeLimits = {
  mode: 'adaptive',
  maxInFlight: 2,
  minHedgeDelayMs: 2_000,
  maxHedgeDelayMs: 20_000,
  unknownHedgeDelayMs: 8_000,
};

/** One endpoint the plan wants to run, and when. */
export interface HedgeLeg {
  readonly model: ModelRef;
  readonly credentialId: string;
  /** Milliseconds after the turn starts. `0` for the primary. */
  readonly startAfterMs: number;
  /**
   * Why this leg is in the plan. Shown in the timeline so a user can see that a
   * second provider was engaged, and why, rather than discovering it on a bill.
   */
  readonly reason: 'primary' | 'hedge-slow' | 'hedge-race';
  /** True when this leg is a breaker probe, so a failure re-opens the breaker. */
  readonly probe: boolean;
}

export interface HedgePlan {
  readonly legs: readonly HedgeLeg[];
  /**
   * Endpoints that were considered and refused, with the reason.
   *
   * Kept in the plan rather than dropped so diagnostics can answer "why did it
   * not use my other key?" — a router that silently omits candidates is one
   * nobody can debug.
   */
  readonly skipped: readonly SkippedEndpoint[];
}

export interface SkippedEndpoint {
  readonly model: ModelRef;
  readonly credentialId: string | null;
  readonly reason:
    | 'breaker-open'
    | 'no-credential'
    | 'capability'
    | 'in-flight-limit'
    | 'mode-off';
}

export interface HedgeInput {
  /**
   * Candidates in the router's preference order, best first.
   *
   * Reusing `Candidate` rather than a local shape is deliberate: the Models
   * view, `route()` and this module must never disagree about what is usable,
   * and the surest way to guarantee that is to feed all three the same list.
   */
  readonly candidates: readonly Candidate[];
  readonly requirements: Requirements;
  /** Health for any endpoint the caller knows about. Missing means unknown. */
  readonly health: (model: ModelRef, credentialId: string) => EndpointHealth;
  /**
   * Whether an endpoint may be sent to, and whether it would be a probe.
   *
   * Injected rather than derived from `health` because admission *mutates* the
   * breaker (it claims the half-open probe slot), and a pure planner must not
   * be the thing that mutates it. The caller passes `HealthTracker.admit`.
   */
  readonly admit: (
    model: ModelRef,
    credentialId: string,
  ) => { readonly ok: boolean; readonly probe: boolean };
  /** The endpoint the task is currently pinned to, if any. Always the primary. */
  readonly preferred?: { readonly model: ModelRef; readonly credentialId: string } | null;
  readonly limits?: HedgeLimits;
  readonly healthLimits?: HealthLimits;
  readonly now: number;
}

function meetsRequirements(candidate: Candidate, requirements: Requirements): boolean {
  const caps = candidate.capabilities;
  if (requirements.toolCalling && !caps.toolCalling) {
    return false;
  }
  if (requirements.vision && !caps.vision) {
    return false;
  }
  return caps.contextWindow >= requirements.minContextWindow;
}

function sameRef(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/**
 * How long to wait before firing the hedge.
 *
 * Uses the primary's own estimated tail rather than a global constant, so a
 * consistently slow local model is not hedged after two seconds while a fast
 * hosted one waits the same two seconds. Clamped at both ends: the floor stops
 * a fast endpoint being hedged on noise, the ceiling stops a pathological
 * estimate from disabling hedging entirely.
 */
export function hedgeDelayMs(primary: EndpointHealth, limits: HedgeLimits): number {
  const estimate = primary.estimatedTailMs;
  if (estimate === null) {
    return limits.unknownHedgeDelayMs;
  }
  return Math.min(limits.maxHedgeDelayMs, Math.max(limits.minHedgeDelayMs, Math.round(estimate)));
}

/**
 * Build the concurrency plan for one turn.
 *
 * Pure: it reads health and asks `admit`, and returns a description of what to
 * run. Nothing here starts a request. That separation is what makes the whole
 * policy testable from literal inputs, the same property `route()` has.
 */
export function planHedge(input: HedgeInput): HedgePlan {
  const limits = input.limits ?? DEFAULT_HEDGE_LIMITS;
  const healthLimits = input.healthLimits ?? DEFAULT_HEALTH_LIMITS;
  const skipped: SkippedEndpoint[] = [];

  // Expand candidates into concrete endpoints. A model with three ready keys is
  // three endpoints, because the key is half of what can fail.
  const usable: { candidate: Candidate; credentialId: string }[] = [];
  for (const candidate of input.candidates) {
    if (!meetsRequirements(candidate, input.requirements)) {
      skipped.push({ model: candidate.model, credentialId: null, reason: 'capability' });
      continue;
    }
    if (candidate.readyCredentialIds.length === 0) {
      skipped.push({ model: candidate.model, credentialId: null, reason: 'no-credential' });
      continue;
    }
    for (const credentialId of candidate.readyCredentialIds) {
      usable.push({ candidate, credentialId });
    }
  }

  const ordered = orderEndpoints(usable, input, healthLimits);

  // `off` still produces a plan — a one-leg one. Returning an empty plan and
  // making the caller special-case it would put the "how do I run a turn"
  // decision in two places.
  const inFlightCap =
    limits.mode === 'off' ? 1 : Math.max(1, Math.floor(limits.maxInFlight));

  const legs: HedgeLeg[] = [];
  let primaryHealth: EndpointHealth | null = null;

  for (const entry of ordered) {
    if (legs.length >= inFlightCap) {
      skipped.push({
        model: entry.candidate.model,
        credentialId: entry.credentialId,
        reason: limits.mode === 'off' ? 'mode-off' : 'in-flight-limit',
      });
      continue;
    }

    const admission = input.admit(entry.candidate.model, entry.credentialId);
    if (!admission.ok) {
      skipped.push({
        model: entry.candidate.model,
        credentialId: entry.credentialId,
        reason: 'breaker-open',
      });
      continue;
    }

    if (legs.length === 0) {
      primaryHealth = input.health(entry.candidate.model, entry.credentialId);
      legs.push({
        model: entry.candidate.model,
        credentialId: entry.credentialId,
        startAfterMs: 0,
        reason: 'primary',
        probe: admission.probe,
      });
      continue;
    }

    // `race` fires everything at once; `adaptive` staggers each additional leg
    // by another hedge interval, so a third leg does not arrive at the same
    // moment as the second.
    const delay =
      limits.mode === 'race'
        ? 0
        : hedgeDelayMs(primaryHealth ?? emptyHealthFor(entry.candidate.model), limits) *
          legs.length;

    legs.push({
      model: entry.candidate.model,
      credentialId: entry.credentialId,
      startAfterMs: delay,
      reason: limits.mode === 'race' ? 'hedge-race' : 'hedge-slow',
      probe: admission.probe,
    });
  }

  return { legs, skipped };
}

/**
 * Order endpoints: preferred first, then by health, then by candidate order,
 * with diversity applied *after* the primary is fixed.
 *
 * Diversity cannot be applied by a plain sort, because "different provider from
 * the primary" is not a property of an endpoint — it is a property of the pair.
 * So the primary is chosen first, and the rest are re-ranked relative to it.
 */
function orderEndpoints(
  usable: readonly { candidate: Candidate; credentialId: string }[],
  input: HedgeInput,
  healthLimits: HealthLimits,
): readonly { candidate: Candidate; credentialId: string }[] {
  if (usable.length === 0) {
    return [];
  }

  const rank = (entry: { candidate: Candidate; credentialId: string }): number => {
    const preferred = input.preferred;
    if (
      preferred != null &&
      sameRef(entry.candidate.model, preferred.model) &&
      entry.credentialId === preferred.credentialId
    ) {
      return -1;
    }
    const health = input.health(entry.candidate.model, entry.credentialId);
    switch (grade(health, input.now, healthLimits)) {
      case 'healthy':
        return 0;
      // Unknown ranks *behind* healthy and ahead of degraded. An endpoint with
      // no evidence is not a better bet than one with a proven record, and not
      // a worse bet than one that is currently failing.
      case 'unknown':
        return 1;
      case 'degraded':
        return 2;
      case 'ejected':
        return 3;
    }
  };

  // A stable sort by rank keeps the caller's preference order inside each tier,
  // which is what makes "the router's order is respected" true.
  const byRank = [...usable].sort((a, b) => rank(a) - rank(b));
  const primary = byRank[0];
  if (primary === undefined) {
    return [];
  }

  const rest = byRank.slice(1).sort((a, b) => {
    const diversity = diversityScore(a, primary) - diversityScore(b, primary);
    return diversity !== 0 ? diversity : rank(a) - rank(b);
  });

  return [primary, ...rest];
}

/** Lower is more diverse from the primary, so it sorts earlier. */
function diversityScore(
  entry: { candidate: Candidate; credentialId: string },
  primary: { candidate: Candidate; credentialId: string },
): number {
  if (entry.candidate.model.providerId !== primary.candidate.model.providerId) {
    return 0;
  }
  if (entry.credentialId !== primary.credentialId) {
    return 1;
  }
  // Same provider, same key, different model: shares the rate-limit bucket, so
  // it is the weakest hedge available and ranks last.
  return 2;
}

function emptyHealthFor(model: ModelRef): EndpointHealth {
  return {
    key: { model, credentialId: '' },
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
