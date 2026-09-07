/**
 * AUTO MODEL: choosing which model starts a task, and being able to say why.
 *
 * `route()` answers "this failed, where next". `planHedge()` answers "how many
 * at once". This answers the question that comes before both: *given what this
 * task is, which model should do it?*
 *
 * The requirement that shapes the whole module is the last line of the brief:
 * **never silently change models.** A selector that cannot explain itself is a
 * selector that changes models silently, whatever it prints. So the return type
 * carries `reasons` and `rejected` as first-class data, not as a log line — the
 * panel renders exactly the facts the decision was made from, and if the
 * explanation looks wrong the decision *was* wrong.
 *
 * ## Why roles rather than one ranking
 *
 * A model that is excellent at writing code can be the wrong choice for reading
 * a stack trace, because the two want different things: debugging wants context
 * window above all — the failing file, the trace, and the test output have to
 * fit at once — while planning wants reasoning and does not need tool calling
 * at all. One global "best model" ordering cannot express that, and pretending
 * it can is how a tool ends up burning a frontier model on a lint fix.
 *
 * ## What this deliberately does not do
 *
 * No learned ranking, and no quality score. CodeRelay has no ground truth about
 * whether a model's *answer* was good — only whether the request succeeded, how
 * fast, and what it cost. Inventing a "quality" number from those would be a
 * fabricated statistic, and the brief rules those out. Every input here is
 * either declared by the user (capabilities, price) or measured (health).
 */
import type { ModelCapabilities, ModelRef } from '../core/types.js';
import { DEFAULT_HEALTH_LIMITS, grade, type EndpointHealth, type HealthLimits } from './health.js';
import type { Candidate } from './route.js';
import { targetMatches, type RuleTarget } from './rules.js';

/** What a task is currently doing. Drives what "best" means. */
export type TaskRole = 'plan' | 'code' | 'debug' | 'review' | 'test' | 'fallback';

export const TASK_ROLES: readonly TaskRole[] = [
  'plan',
  'code',
  'debug',
  'review',
  'test',
  'fallback',
];

/** Human wording. One definition, shared by every surface. */
export const ROLE_LABELS: Readonly<Record<TaskRole, string>> = {
  plan: 'Planning',
  code: 'Coding',
  debug: 'Debugging',
  review: 'Review',
  test: 'Testing',
  fallback: 'Fallback',
};

/**
 * What each role weighs, and what it cannot do without.
 *
 * `requires` is a hard gate: a model that fails it is not a candidate at all.
 * The weights are only used to order what survives, so a bad weight can pick a
 * worse model but can never pick an unusable one.
 */
interface RoleProfile {
  /** Capabilities without which the role cannot be performed. */
  readonly requires: {
    readonly toolCalling: boolean;
    readonly minContextWindow: number;
  };
  /** Relative importance, 0..1, of each measurable property. */
  readonly weights: {
    readonly reasoning: number;
    readonly context: number;
    readonly speed: number;
    readonly cost: number;
  };
  /** Shown in the explanation, so the profile itself is inspectable. */
  readonly wants: string;
}

const PROFILES: Readonly<Record<TaskRole, RoleProfile>> = {
  // Planning reads and thinks; it does not edit. Tool calling is genuinely
  // optional here, which is what lets a strong reasoning model with no tool
  // support still be the right choice for this one role.
  plan: {
    requires: { toolCalling: false, minContextWindow: 16_000 },
    weights: { reasoning: 1, context: 0.6, speed: 0.1, cost: 0.3 },
    wants: 'reasoning depth',
  },
  code: {
    requires: { toolCalling: true, minContextWindow: 32_000 },
    weights: { reasoning: 0.6, context: 0.7, speed: 0.4, cost: 0.4 },
    wants: 'tool calling and a large context',
  },
  // Debugging is the context-hungriest role: the failing file, the stack trace
  // and the test output all have to be in the window at the same time.
  debug: {
    requires: { toolCalling: true, minContextWindow: 64_000 },
    weights: { reasoning: 0.9, context: 1, speed: 0.2, cost: 0.2 },
    wants: 'a large context window and strong reasoning',
  },
  review: {
    requires: { toolCalling: false, minContextWindow: 32_000 },
    weights: { reasoning: 0.9, context: 0.8, speed: 0.2, cost: 0.4 },
    wants: 'careful reading over speed',
  },
  // Running and fixing tests is mechanical and repetitive, so this is the role
  // where a cheap fast model earns its place.
  test: {
    requires: { toolCalling: true, minContextWindow: 16_000 },
    weights: { reasoning: 0.3, context: 0.4, speed: 0.9, cost: 0.9 },
    wants: 'speed and low cost',
  },
  // Fallback exists to keep a task alive. It asks for as little as possible, so
  // that "nothing is available" is as rare as it can be.
  fallback: {
    requires: { toolCalling: true, minContextWindow: 8_000 },
    weights: { reasoning: 0.2, context: 0.3, speed: 0.6, cost: 0.6 },
    wants: 'anything that can keep the task moving',
  },
};

/** Why a candidate was not chosen. Always displayable. */
export interface RejectedCandidate {
  readonly model: ModelRef;
  readonly reason: string;
}

export interface Selection {
  readonly model: ModelRef;
  readonly credentialId: string;
  readonly role: TaskRole;
  /**
   * The facts this decision rests on, each already a sentence.
   *
   * Rendered verbatim under "Why this model?". Every entry is either something
   * the user declared or something CodeRelay measured — never a judgement about
   * how good the model is at the task.
   */
  readonly reasons: readonly string[];
  /** Candidates that were considered and passed over, with the reason. */
  readonly rejected: readonly RejectedCandidate[];
  /** Score in [0,1], for ordering only. Never shown as a quality rating. */
  readonly score: number;
}

export interface SelectInput {
  readonly candidates: readonly Candidate[];
  readonly role: TaskRole;
  /** Observed health per endpoint. Missing means unknown, which is not bad. */
  readonly health?: (model: ModelRef, credentialId: string) => EndpointHealth;
  /**
   * A model the user pinned. Chosen whenever it is usable at all.
   *
   * The whole point of AUTO is that it is opt-in; a user who picked a model has
   * already answered this question, and overriding them would be exactly the
   * silent switch the brief forbids.
   */
  readonly pinned?: ModelRef | null;
  /**
   * Targets from a matching routing rule, strongest first.
   *
   * Applied after the hard gates and before scoring, so a rule can reorder what
   * is usable but can never make an unusable model usable. A rule pointing at a
   * model with no key does not stop the task; it is skipped and the automatic
   * choice stands.
   */
  readonly ruleTargets?: readonly RuleTarget[];
  /** The rule's own words, prepended to the reasons when one applied. */
  readonly ruleReason?: string | null;
  readonly healthLimits?: HealthLimits;
  readonly now?: number;
}

export type SelectOutcome =
  | { readonly ok: true; readonly selection: Selection }
  /** Nothing usable. Carries every rejection so the panel can say why. */
  | {
      readonly ok: false;
      readonly reason: string;
      readonly rejected: readonly RejectedCandidate[];
    };

/**
 * Normalise a context window to 0..1 across the candidates actually available.
 *
 * Relative rather than absolute: "200k is big" stops being true the moment a
 * 2M-token model exists, and a hard-coded ceiling would silently stop
 * discriminating between the models a user actually has.
 */
function normalise(value: number, max: number): number {
  return max <= 0 ? 0 : Math.min(1, value / max);
}

function reasoningScore(caps: ModelCapabilities): number {
  switch (caps.reasoning) {
    case 'explicit':
      return 1;
    case 'implicit':
      return 0.6;
    case 'none':
      return 0.2;
  }
}

/** The cheapest and dearest declared prices among the candidates. */
export interface CostRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Cost, inverted and normalised across the *priced* candidates only.
 *
 * Two rules, both of which were wrong in the first version:
 *
 *  - **An undeclared price is not "free".** A model with no price scores a
 *    neutral 0.5 rather than winning outright, or "cheapest" would come to mean
 *    "least documented".
 *  - **Unpriced models must not distort the scale.** Normalising against a
 *    maximum that included zero-cost entries made the only *priced* model the
 *    most expensive one by construction, scoring it zero — so a genuinely cheap
 *    model lost to one whose price nobody had written down.
 *
 * When fewer than two distinct prices are declared there is no basis for
 * ranking on cost at all, and everything scores 0.5. That is a real absence of
 * information rather than a tie broken by accident.
 */
function costScore(caps: ModelCapabilities, range: CostRange): number {
  const cost = caps.costPerMTokIn + caps.costPerMTokOut;
  if (cost <= 0) {
    return 0.5;
  }
  const span = range.max - range.min;
  if (span <= 0) {
    return 0.5;
  }
  return 1 - (cost - range.min) / span;
}

/** Min and max over candidates that actually declare a price. */
function costRange(costs: readonly number[]): CostRange {
  const priced = costs.filter((c) => c > 0);
  if (priced.length === 0) {
    return { min: 0, max: 0 };
  }
  return { min: Math.min(...priced), max: Math.max(...priced) };
}

/**
 * Speed, from measured latency only.
 *
 * Returns null when nothing has been observed, and the caller then drops the
 * speed term and renormalises rather than substituting a guess. A model that
 * has never been used is not fast and is not slow.
 */
function speedScore(health: EndpointHealth | null, slowestMs: number): number | null {
  if (health === null || health.latencyMs === null) {
    return null;
  }
  return slowestMs <= 0 ? 1 : 1 - normalise(health.latencyMs, slowestMs);
}

/**
 * Choose a model for a role.
 *
 * Pure. The health lookup and the clock are injected, so the same inputs always
 * produce the same choice and the same explanation — which is what makes "why
 * this model?" checkable rather than merely plausible.
 */
export function selectModel(input: SelectInput): SelectOutcome {
  const profile = PROFILES[input.role];
  const now = input.now ?? 0;
  const healthLimits = input.healthLimits ?? DEFAULT_HEALTH_LIMITS;
  const rejected: RejectedCandidate[] = [];

  // Expand to endpoints, gating on the role's hard requirements first so a
  // rejection is always for a stated reason rather than a low score.
  const viable: { candidate: Candidate; credentialId: string; health: EndpointHealth | null }[] =
    [];

  for (const candidate of input.candidates) {
    const caps = candidate.capabilities;
    if (profile.requires.toolCalling && !caps.toolCalling) {
      rejected.push({
        model: candidate.model,
        reason: `cannot call tools, which ${ROLE_LABELS[input.role].toLowerCase()} requires`,
      });
      continue;
    }
    if (caps.contextWindow < profile.requires.minContextWindow) {
      rejected.push({
        model: candidate.model,
        reason: `context window is ${caps.contextWindow.toLocaleString('en-US')}, below the ${profile.requires.minContextWindow.toLocaleString('en-US')} this role needs`,
      });
      continue;
    }
    if (candidate.readyCredentialIds.length === 0) {
      rejected.push({ model: candidate.model, reason: 'no usable API key is stored' });
      continue;
    }

    for (const credentialId of candidate.readyCredentialIds) {
      const health = input.health?.(candidate.model, credentialId) ?? null;
      if (health !== null && grade(health, now, healthLimits) === 'ejected') {
        rejected.push({
          model: candidate.model,
          reason: 'temporarily out of rotation after repeated failures',
        });
        continue;
      }
      viable.push({ candidate, credentialId, health });
    }
  }

  if (viable.length === 0) {
    return {
      ok: false,
      reason:
        input.candidates.length === 0
          ? 'No models are configured.'
          : `No configured model meets what ${ROLE_LABELS[input.role].toLowerCase()} needs.`,
      rejected,
    };
  }

  // A pinned model wins outright whenever it survived the gates. This is
  // checked after gating so a pin to an unusable model still explains itself
  // rather than silently failing.
  if (input.pinned != null) {
    const match = viable.find(
      (v) =>
        v.candidate.model.providerId === input.pinned?.providerId &&
        v.candidate.model.modelId === input.pinned?.modelId,
    );
    if (match !== undefined) {
      return {
        ok: true,
        selection: {
          model: match.candidate.model,
          credentialId: match.credentialId,
          role: input.role,
          reasons: ['you chose this model'],
          rejected: [],
          score: 1,
        },
      };
    }
  }

  // A routing rule outranks the score but not the gates: the first target that
  // survived gating wins outright. A rule naming a model that is missing,
  // uncredentialed or ejected simply does not match anything here, and the
  // automatic choice below stands — a preference must never become an outage.
  for (const target of input.ruleTargets ?? []) {
    const match = viable.find((v) => targetMatches(target, v.candidate.model));
    if (match !== undefined) {
      return {
        ok: true,
        selection: {
          model: match.candidate.model,
          credentialId: match.credentialId,
          role: input.role,
          reasons: [
            ...(input.ruleReason == null ? [] : [input.ruleReason]),
            ...explain(match, profile, input.role, now, healthLimits).slice(1),
          ],
          rejected: viable
            .filter((v) => v !== match)
            .map((v) => ({
              model: v.candidate.model,
              reason: 'a routing rule preferred another model',
            })),
          score: 1,
        },
      };
    }
  }

  const maxContext = Math.max(...viable.map((v) => v.candidate.capabilities.contextWindow));
  const costs = costRange(
    viable.map(
      (v) => v.candidate.capabilities.costPerMTokIn + v.candidate.capabilities.costPerMTokOut,
    ),
  );
  const slowest = Math.max(0, ...viable.map((v) => v.health?.latencyMs ?? 0));

  let best: { entry: (typeof viable)[number]; score: number } | null = null;
  for (const entry of viable) {
    const score = scoreOf(entry, profile, { maxContext, costs, slowest }, now, healthLimits);
    if (best === null || score > best.score) {
      best = { entry, score };
    }
  }
  if (best === null) {
    return { ok: false, reason: 'No model could be scored.', rejected };
  }

  // Everything not chosen becomes a rejection with a reason, so the panel can
  // always answer "why not that one?".
  for (const entry of viable) {
    if (entry === best.entry) {
      continue;
    }
    rejected.push({
      model: entry.candidate.model,
      reason: `scored lower for ${ROLE_LABELS[input.role].toLowerCase()}`,
    });
  }

  return {
    ok: true,
    selection: {
      model: best.entry.candidate.model,
      credentialId: best.entry.credentialId,
      role: input.role,
      reasons: explain(best.entry, profile, input.role, now, healthLimits),
      rejected,
      score: best.score,
    },
  };
}

function scoreOf(
  entry: { candidate: Candidate; health: EndpointHealth | null },
  profile: RoleProfile,
  maxima: { maxContext: number; costs: CostRange; slowest: number },
  now: number,
  healthLimits: HealthLimits,
): number {
  const caps = entry.candidate.capabilities;
  const w = profile.weights;

  const terms: { weight: number; value: number }[] = [
    { weight: w.reasoning, value: reasoningScore(caps) },
    { weight: w.context, value: normalise(caps.contextWindow, maxima.maxContext) },
    { weight: w.cost, value: costScore(caps, maxima.costs) },
  ];

  // Speed only participates when it has been measured. Dropping the term and
  // renormalising is what stops an unused model being scored as if it were slow.
  const speed = speedScore(entry.health, maxima.slowest);
  if (speed !== null) {
    terms.push({ weight: w.speed, value: speed });
  }

  const totalWeight = terms.reduce((sum, t) => sum + t.weight, 0);
  const base =
    totalWeight === 0 ? 0 : terms.reduce((sum, t) => sum + t.weight * t.value, 0) / totalWeight;

  // Health adjusts rather than dominates: a degraded endpoint is worth trying
  // second, not worth refusing, and ejection was already handled by the gate.
  if (entry.health !== null && grade(entry.health, now, healthLimits) === 'degraded') {
    return base * 0.6;
  }
  return base;
}

/**
 * The sentences shown under "Why this model?".
 *
 * Only facts: what the role needs, what the user declared, what was measured.
 * Nothing here asserts the model is *good* at anything.
 */
function explain(
  entry: { candidate: Candidate; health: EndpointHealth | null },
  profile: RoleProfile,
  role: TaskRole,
  now: number,
  healthLimits: HealthLimits,
): readonly string[] {
  const caps = entry.candidate.capabilities;
  const reasons: string[] = [`${ROLE_LABELS[role].toLowerCase()} favours ${profile.wants}`];

  if (caps.reasoning === 'explicit' && profile.weights.reasoning >= 0.6) {
    reasons.push('declared to support explicit reasoning');
  }
  if (profile.requires.toolCalling && caps.toolCalling) {
    reasons.push('supports tool calling');
  }
  reasons.push(`context window ${caps.contextWindow.toLocaleString('en-US')} tokens`);

  const health = entry.health;
  if (health === null || health.successRate === null) {
    // Silence rather than "unknown health": no evidence is not a selling point,
    // and listing it would read as a warning.
  } else {
    const observations = health.totalSuccesses + health.totalFailures;
    switch (grade(health, now, healthLimits)) {
      case 'healthy':
        reasons.push(
          observations >= 2
            ? `responding normally (${Math.round(health.successRate * 100)}% of recent requests succeeded)`
            : 'responding normally',
        );
        break;
      case 'degraded':
        reasons.push('chosen despite recent failures — nothing healthier is available');
        break;
      default:
        break;
    }
  }
  return reasons;
}
