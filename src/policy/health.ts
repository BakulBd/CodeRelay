/**
 * Endpoint health: what we have actually observed each (model, credential) do.
 *
 * Scope, stated up front because a health model that overreaches is how a
 * router starts refusing to use a provider that works fine: this module records
 * outcomes and answers two questions — *is this endpoint currently worth
 * trying?* and *how long does it usually take?* It decides nothing about side
 * effects, nothing about which model is better at a task, and it never sees key
 * material. It is a memory of observations, and every number it reports is one
 * somebody measured.
 *
 * Why this exists at all. `route()` already refuses to repeat an attempt that
 * is *known* to fail — a rejected credential, an exhausted budget, a
 * non-retryable class. That is per-task and evidence-only, which is right for
 * deciding what to do about the failure in hand. It cannot help with the other
 * half of the problem: a provider that has been failing for the last ten
 * minutes is still offered as a fresh candidate to the next task, because the
 * previous task's attempt list died with it. Health is the part that persists
 * across tasks, so a degraded endpoint stops being chosen *before* it wastes a
 * turn proving it is still degraded.
 *
 * Three deliberate design decisions:
 *
 *  1. **EWMA, not a window.** A ring buffer of the last N outcomes needs N
 *     tuned per endpoint, and an endpoint that is used twice an hour would be
 *     judged on evidence from yesterday. An exponentially weighted moving
 *     average decays on its own, needs one constant, and costs two numbers per
 *     endpoint. `SUCCESS_ALPHA` is deliberately faster than `LATENCY_ALPHA`:
 *     an outage should be believed quickly, a latency estimate should not swing
 *     on one slow response.
 *
 *  2. **The breaker trips on consecutive failures, not on the average.** A rate
 *     that has decayed to 0.4 could be one bad minute inside a good hour, and
 *     tripping on it would eject an endpoint that is mostly fine. Consecutive
 *     failures are unambiguous: nothing has succeeded since the streak began.
 *     The average is what *recovery* is judged on, so an endpoint that flaps
 *     open/closed does not immediately get full traffic back.
 *
 *  3. **Half-open lets exactly one request through.** An open breaker that
 *     re-admits everything on expiry is a synchronized retry against the
 *     provider that just failed — the thundering-herd failure that
 *     ContinuityBench (arXiv:2607.15899) found turns a rate limit into a
 *     permanent lockout. One probe answers the same question at 1/N the cost,
 *     and a failed probe re-opens the breaker with a longer timeout.
 *
 * Clock and randomness are injected. A health model whose behaviour depends on
 * wall-clock time is one that can only be tested by sleeping, and a flaky test
 * for a reliability feature is worse than no test.
 */
import type { ErrorClass, ModelRef } from '../core/types.js';

/** Identifies one endpoint: a model reached with one specific credential. */
export interface EndpointKey {
  readonly model: ModelRef;
  readonly credentialId: string;
}

/**
 * Stable string form of an endpoint, used as a map key.
 *
 * Field-separated with a character that cannot appear in any component, so
 * `{providerId: 'a|b', modelId: 'c'}` cannot collide with
 * `{providerId: 'a', modelId: 'b|c'}`. Provider and model ids are validated
 * elsewhere, but a key function that relies on validation happening somewhere
 * else is one that breaks quietly when the validation moves.
 */
export function endpointId(key: EndpointKey): string {
  return `${key.model.providerId}\0${key.model.modelId}\0${key.credentialId}`;
}

/** Whether the breaker is admitting traffic, and why. */
export type BreakerState =
  /** Normal. Everything is admitted. */
  | { readonly kind: 'closed' }
  /**
   * Ejected. Nothing is admitted until `openUntil`.
   *
   * `consecutiveTrips` drives the backoff: an endpoint that fails its probe and
   * re-opens waits longer each time, so a provider having a bad hour is asked
   * once a minute rather than once a second.
   */
  | {
      readonly kind: 'open';
      readonly openUntil: number;
      readonly consecutiveTrips: number;
    }
  /**
   * The timeout has expired and exactly one probe may go through.
   *
   * `probeInFlight` is what makes "exactly one" true under concurrency. Hedged
   * racing can ask about the same endpoint twice in the same tick, and without
   * this both would be told yes.
   */
  | {
      readonly kind: 'half-open';
      readonly consecutiveTrips: number;
      readonly probeInFlight: boolean;
    };

/** Everything observed about one endpoint. Pure data; safe to display. */
export interface EndpointHealth {
  readonly key: EndpointKey;
  /** EWMA of outcomes in [0,1]. `null` until the first observation. */
  readonly successRate: number | null;
  /** EWMA of time-to-first-token in ms. `null` until the first success. */
  readonly latencyMs: number | null;
  /**
   * Estimated tail latency in ms, used to decide when a hedge is worthwhile.
   *
   * A real P95 needs the distribution kept; this keeps a second, slower EWMA of
   * the *deviation* from the mean and reports `mean + 2*deviation`. That is a
   * one-number-per-endpoint approximation, and it is labelled `estimated`
   * rather than `p95` so nobody reads it as a measured percentile.
   */
  readonly estimatedTailMs: number | null;
  readonly consecutiveFailures: number;
  readonly totalSuccesses: number;
  readonly totalFailures: number;
  /** When the last outcome was recorded. `null` if never used. */
  readonly lastOutcomeAt: number | null;
  /** The class of the most recent failure, for display. `null` after a success. */
  readonly lastErrorClass: ErrorClass | null;
  readonly breaker: BreakerState;
}

/** Why an endpoint is not currently admitting traffic. */
export type Unavailable =
  | { readonly reason: 'breaker-open'; readonly retryAfterMs: number }
  | { readonly reason: 'probe-in-flight' };

/** The answer to "may I send a request to this endpoint right now?" */
export type Admission =
  | { readonly ok: true; readonly probe: boolean }
  | ({ readonly ok: false } & Unavailable);

export interface HealthLimits {
  /** Consecutive failures that trip the breaker. */
  readonly failuresToTrip: number;
  /** How long the breaker stays open on its first trip. */
  readonly openMs: number;
  /** Ceiling on the open period, however many times it re-trips. */
  readonly maxOpenMs: number;
  /**
   * Success rate below which an endpoint is *deprioritized* but still usable.
   *
   * Distinct from tripping: this reorders candidates, it does not eject them.
   * An endpoint at 0.5 is worth trying second, not worth refusing.
   */
  readonly degradedBelow: number;
  /** Outcomes older than this are discarded entirely rather than decayed. */
  readonly staleAfterMs: number;
}

export const DEFAULT_HEALTH_LIMITS: HealthLimits = {
  failuresToTrip: 3,
  openMs: 15_000,
  maxOpenMs: 300_000,
  degradedBelow: 0.7,
  staleAfterMs: 3_600_000,
};

/**
 * Decay constants.
 *
 * `SUCCESS_ALPHA` at 0.3 means one failure drops a perfect endpoint to 0.7 and
 * three consecutive drop it to ~0.34 — fast enough that the router reacts
 * within a turn or two. `LATENCY_ALPHA` at 0.15 is deliberately slower, because
 * a hedge threshold that chases the last response would fire on every ordinary
 * slow request. `DEVIATION_ALPHA` matches latency so the two move together.
 */
const SUCCESS_ALPHA = 0.3;
const LATENCY_ALPHA = 0.15;
const DEVIATION_ALPHA = 0.15;

/** Multiplier on the deviation EWMA when estimating the tail. */
const TAIL_SIGMAS = 2;

export interface HealthDeps {
  /** Injected so the breaker can be tested without sleeping. */
  readonly now: () => number;
}

/**
 * The outcome of one attempt, as the tracker needs to see it.
 *
 * `latencyMs` is time-to-first-token, not total duration. Total duration is
 * dominated by how much the model chose to say, which is a property of the
 * request rather than of the endpoint's health; time-to-first-token is the part
 * that actually reflects queueing and load, and it is the number a hedge
 * decision needs.
 */
export type AttemptOutcome =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly errorClass: ErrorClass };

/**
 * Failure classes that say nothing about the endpoint's health.
 *
 * A 401 means *this key* is wrong and a 400 means *this request* is wrong;
 * neither is evidence that the provider is unwell, and counting them would
 * trip the breaker on a misconfiguration and then hide the misconfiguration
 * behind an ejected endpoint. `CredentialManager` already takes a rejected key
 * out of rotation, and `route()` already refuses to retry a `CONFIG` failure —
 * so these are handled, just not here.
 *
 * `CONTEXT` is excluded for the same reason: the request was too big, which the
 * next one may not be.
 */
const NOT_HEALTH_EVIDENCE: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
  'AUTH',
  'FORBIDDEN',
  'CONFIG',
  'CONTEXT',
  'TLS_UNTRUSTED',
]);

/** True when a failure class is evidence about the endpoint rather than the request. */
export function isHealthEvidence(errorClass: ErrorClass): boolean {
  return !NOT_HEALTH_EVIDENCE.has(errorClass);
}

function freshHealth(key: EndpointKey): EndpointHealth {
  return {
    key,
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

function ewma(previous: number | null, sample: number, alpha: number): number {
  return previous === null ? sample : previous * (1 - alpha) + sample * alpha;
}

/**
 * How long the breaker should stay open after `trips` consecutive trips.
 *
 * Doubling, capped. Exported so the UI can say "cooling for 30s" using the same
 * arithmetic the breaker uses, rather than a second copy that can disagree.
 */
export function openDurationMs(trips: number, limits: HealthLimits): number {
  const exponent = Math.max(0, trips - 1);
  // Guard the shift before it happens: 2 ** 1024 is Infinity, and
  // Math.min(Infinity, cap) is fine, but the intermediate is not worth relying
  // on when the clamp is one comparison.
  if (exponent > 30) {
    return limits.maxOpenMs;
  }
  return Math.min(limits.maxOpenMs, limits.openMs * 2 ** exponent);
}

/**
 * Observed health for every endpoint the extension has used.
 *
 * Deliberately in-memory and per-window. Persisting it across reloads was
 * considered and rejected: a breaker restored from disk would eject an endpoint
 * for an outage that ended while VS Code was closed, and the user would have no
 * way to tell why a provider they can reach is being skipped. Losing the memory
 * on reload costs one extra attempt; keeping it wrongly costs a working
 * provider.
 */
export class HealthTracker {
  private readonly entries = new Map<string, EndpointHealth>();

  constructor(
    private readonly deps: HealthDeps,
    private readonly limits: HealthLimits = DEFAULT_HEALTH_LIMITS,
  ) {}

  /** Current health for an endpoint, fresh if it has never been used. */
  get(key: EndpointKey): EndpointHealth {
    const id = endpointId(key);
    const found = this.entries.get(id);
    if (found === undefined) {
      return freshHealth(key);
    }
    // Staleness is applied on read rather than by a timer: a timer would be a
    // second thing to shut down cleanly, and nothing can observe a stale entry
    // without going through here anyway.
    const last = found.lastOutcomeAt;
    if (last !== null && this.deps.now() - last > this.limits.staleAfterMs) {
      this.entries.delete(id);
      return freshHealth(key);
    }
    return found;
  }

  /** Everything currently known, for the Models view and diagnostics. */
  snapshot(): readonly EndpointHealth[] {
    const now = this.deps.now();
    const live: EndpointHealth[] = [];
    for (const [id, health] of this.entries) {
      const last = health.lastOutcomeAt;
      if (last !== null && now - last > this.limits.staleAfterMs) {
        this.entries.delete(id);
        continue;
      }
      live.push(health);
    }
    return live;
  }

  /**
   * May a request go to this endpoint right now?
   *
   * Mutates on purpose in two places: an expired `open` transitions to
   * `half-open`, and admitting a probe marks it in flight. Both have to happen
   * atomically with the answer, or two concurrent callers both get told they
   * are the probe — which is exactly the herd the breaker exists to prevent.
   */
  admit(key: EndpointKey): Admission {
    const now = this.deps.now();
    const health = this.get(key);
    const breaker = health.breaker;

    if (breaker.kind === 'closed') {
      return { ok: true, probe: false };
    }

    if (breaker.kind === 'open') {
      if (now < breaker.openUntil) {
        return { ok: false, reason: 'breaker-open', retryAfterMs: breaker.openUntil - now };
      }
      this.write({
        ...health,
        breaker: {
          kind: 'half-open',
          consecutiveTrips: breaker.consecutiveTrips,
          probeInFlight: true,
        },
      });
      return { ok: true, probe: true };
    }

    if (breaker.probeInFlight) {
      return { ok: false, reason: 'probe-in-flight' };
    }
    this.write({ ...health, breaker: { ...breaker, probeInFlight: true } });
    return { ok: true, probe: true };
  }

  /**
   * Record what an attempt did.
   *
   * Returns the updated health so a caller that wants to log or display the
   * transition does not have to read it back and race another writer.
   */
  record(key: EndpointKey, outcome: AttemptOutcome): EndpointHealth {
    const now = this.deps.now();
    const health = this.get(key);

    if (outcome.ok) {
      const latency = ewma(health.latencyMs, outcome.latencyMs, LATENCY_ALPHA);
      // Deviation is measured against the *previous* mean, not the one that
      // has already absorbed this sample. Using the updated mean would shrink
      // every deviation toward zero and make the tail estimate useless.
      const deviationSample = Math.abs(outcome.latencyMs - (health.latencyMs ?? outcome.latencyMs));
      const previousDeviation =
        health.estimatedTailMs === null || health.latencyMs === null
          ? null
          : (health.estimatedTailMs - health.latencyMs) / TAIL_SIGMAS;
      const deviation = ewma(previousDeviation, deviationSample, DEVIATION_ALPHA);

      return this.write({
        ...health,
        successRate: ewma(health.successRate, 1, SUCCESS_ALPHA),
        latencyMs: latency,
        estimatedTailMs: latency + TAIL_SIGMAS * deviation,
        consecutiveFailures: 0,
        totalSuccesses: health.totalSuccesses + 1,
        lastOutcomeAt: now,
        lastErrorClass: null,
        // A success always closes the breaker, including from half-open: the
        // probe answered the question it was sent to answer. `consecutiveTrips`
        // resets with it, so the next outage starts at the short timeout again.
        breaker: { kind: 'closed' },
      });
    }

    // A failure that is not evidence about the endpoint updates nothing but the
    // displayed error class. Counting it would trip the breaker on a bad key.
    if (!isHealthEvidence(outcome.errorClass)) {
      return this.write({
        ...health,
        lastOutcomeAt: now,
        lastErrorClass: outcome.errorClass,
        breaker: this.releaseProbe(health.breaker),
      });
    }

    const consecutiveFailures = health.consecutiveFailures + 1;
    const wasProbing = health.breaker.kind === 'half-open';
    const priorTrips =
      health.breaker.kind === 'closed' ? 0 : health.breaker.consecutiveTrips;

    // A failed probe re-opens immediately — the endpoint had its one chance —
    // and counts as another trip so the next wait is longer.
    const shouldTrip = wasProbing || consecutiveFailures >= this.limits.failuresToTrip;

    const breaker: BreakerState = shouldTrip
      ? {
          kind: 'open',
          consecutiveTrips: priorTrips + 1,
          openUntil: now + openDurationMs(priorTrips + 1, this.limits),
        }
      : this.releaseProbe(health.breaker);

    return this.write({
      ...health,
      successRate: ewma(health.successRate, 0, SUCCESS_ALPHA),
      consecutiveFailures,
      totalFailures: health.totalFailures + 1,
      lastOutcomeAt: now,
      lastErrorClass: outcome.errorClass,
      breaker,
    });
  }

  /**
   * Give back a probe slot without recording an outcome.
   *
   * Needed by hedging: a losing racer is aborted, which is not evidence the
   * endpoint is unwell, but it must not leave `probeInFlight` stuck true — that
   * would keep a recovered endpoint ejected forever.
   */
  releaseProbeSlot(key: EndpointKey): void {
    const health = this.get(key);
    if (health.breaker.kind === 'half-open' && health.breaker.probeInFlight) {
      this.write({ ...health, breaker: { ...health.breaker, probeInFlight: false } });
    }
  }

  /** Forget everything. Exposed for the diagnostics view's "reset health" action. */
  reset(): void {
    this.entries.clear();
  }

  private releaseProbe(breaker: BreakerState): BreakerState {
    return breaker.kind === 'half-open' ? { ...breaker, probeInFlight: false } : breaker;
  }

  private write(health: EndpointHealth): EndpointHealth {
    this.entries.set(endpointId(health.key), health);
    return health;
  }
}

/**
 * A one-word summary for the Models view.
 *
 * `unknown` is not `healthy`. An endpoint nobody has used yet has no evidence
 * behind it, and showing it as healthy would be the same lie as reporting
 * "0 tokens" for a measurement nobody took.
 */
export type HealthGrade = 'unknown' | 'healthy' | 'degraded' | 'ejected';

export function grade(
  health: EndpointHealth,
  now: number,
  limits: HealthLimits = DEFAULT_HEALTH_LIMITS,
): HealthGrade {
  if (health.breaker.kind === 'open' && now < health.breaker.openUntil) {
    return 'ejected';
  }
  if (health.successRate === null) {
    return 'unknown';
  }
  return health.successRate < limits.degradedBelow ? 'degraded' : 'healthy';
}
