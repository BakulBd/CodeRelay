/**
 * The concurrency plan.
 *
 * `planHedge` is pure, so every case below is a literal input and an exact
 * expected plan. The questions being asked are the ones that decide whether
 * this feature is worth its cost: does it stay out of the way when everything
 * is fine, does it pick a *different* provider rather than the same one twice,
 * and can a user find out why an endpoint was skipped.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HEDGE_LIMITS,
  hedgeDelayMs,
  planHedge,
  type HedgeInput,
  type HedgeLimits,
} from '../../src/policy/hedge.js';
import {
  DEFAULT_HEALTH_LIMITS,
  HealthTracker,
  type EndpointHealth,
} from '../../src/policy/health.js';
import type { Candidate, Requirements } from '../../src/policy/route.js';
import type { ModelCapabilities, ModelRef } from '../../src/core/types.js';

const CAPS: ModelCapabilities = {
  streaming: true,
  toolCalling: true,
  parallelToolCalls: true,
  vision: false,
  reasoning: 'none',
  structuredOutput: true,
  contextWindow: 200_000,
  maxOutput: 8_192,
  costPerMTokIn: 3,
  costPerMTokOut: 15,
};

const REQUIREMENTS: Requirements = {
  toolCalling: true,
  vision: false,
  minContextWindow: 8_000,
};

function candidate(
  providerId: string,
  modelId: string,
  credentialIds: readonly string[],
  caps: Partial<ModelCapabilities> = {},
): Candidate {
  return {
    model: { providerId, modelId },
    capabilities: { ...CAPS, ...caps },
    readyCredentialIds: credentialIds,
    coolingRetryAfterMs: null,
  };
}

/** An input with everything healthy and admitting, unless overridden. */
function input(overrides: Partial<HedgeInput> = {}): HedgeInput {
  const tracker = new HealthTracker({ now: () => 1_000 });
  return {
    candidates: [],
    requirements: REQUIREMENTS,
    health: (model, credentialId) => tracker.get({ model, credentialId }),
    admit: () => ({ ok: true, probe: false }),
    now: 1_000,
    ...overrides,
  };
}

/** Health with a known tail latency, for delay assertions. */
function healthWithTail(model: ModelRef, credentialId: string, tailMs: number): EndpointHealth {
  return {
    key: { model, credentialId },
    successRate: 1,
    latencyMs: tailMs / 2,
    estimatedTailMs: tailMs,
    consecutiveFailures: 0,
    totalSuccesses: 10,
    totalFailures: 0,
    lastOutcomeAt: 900,
    lastErrorClass: null,
    breaker: { kind: 'closed' },
  };
}

// --- the default shape -----------------------------------------------------

test('the default plan is one request plus one armed hedge', () => {
  const plan = planHedge(
    input({
      candidates: [
        candidate('anthropic', 'sonnet', ['k1']),
        candidate('openai', 'gpt', ['k2']),
      ],
    }),
  );

  assert.equal(plan.legs.length, 2);
  assert.equal(plan.legs[0]?.reason, 'primary');
  assert.equal(plan.legs[0]?.startAfterMs, 0);
  assert.equal(plan.legs[1]?.reason, 'hedge-slow');
  assert.ok(
    (plan.legs[1]?.startAfterMs ?? 0) > 0,
    'the hedge must be armed, not fired — otherwise every turn pays twice',
  );
});

test('mode off produces exactly one leg and says why the rest were dropped', () => {
  const limits: HedgeLimits = { ...DEFAULT_HEDGE_LIMITS, mode: 'off' };
  const plan = planHedge(
    input({
      limits,
      candidates: [
        candidate('anthropic', 'sonnet', ['k1']),
        candidate('openai', 'gpt', ['k2']),
      ],
    }),
  );

  assert.equal(plan.legs.length, 1);
  assert.equal(plan.legs[0]?.reason, 'primary');
  assert.deepEqual(
    plan.skipped.map((s) => s.reason),
    ['mode-off'],
  );
});

test('race mode fires everything at once', () => {
  const limits: HedgeLimits = { ...DEFAULT_HEDGE_LIMITS, mode: 'race', maxInFlight: 3 };
  const plan = planHedge(
    input({
      limits,
      candidates: [
        candidate('anthropic', 'sonnet', ['k1']),
        candidate('openai', 'gpt', ['k2']),
        candidate('gemini', 'flash', ['k3']),
      ],
    }),
  );

  assert.equal(plan.legs.length, 3);
  assert.deepEqual(
    plan.legs.map((l) => l.startAfterMs),
    [0, 0, 0],
  );
  assert.deepEqual(
    plan.legs.slice(1).map((l) => l.reason),
    ['hedge-race', 'hedge-race'],
  );
});

test('maxInFlight caps the plan and the excess is reported, not hidden', () => {
  const plan = planHedge(
    input({
      limits: { ...DEFAULT_HEDGE_LIMITS, maxInFlight: 2 },
      candidates: [
        candidate('anthropic', 'sonnet', ['k1']),
        candidate('openai', 'gpt', ['k2']),
        candidate('gemini', 'flash', ['k3']),
      ],
    }),
  );

  assert.equal(plan.legs.length, 2);
  assert.deepEqual(
    plan.skipped.map((s) => s.reason),
    ['in-flight-limit'],
  );
});

// --- diversity -------------------------------------------------------------

test('the hedge prefers a different provider over a second key on the same one', () => {
  const plan = planHedge(
    input({
      candidates: [
        candidate('anthropic', 'sonnet', ['k1', 'k2']),
        candidate('openai', 'gpt', ['k3']),
      ],
    }),
  );

  assert.equal(plan.legs[0]?.model.providerId, 'anthropic');
  assert.equal(
    plan.legs[1]?.model.providerId,
    'openai',
    'a second key on the same provider shares the rate limit that just failed',
  );
});

test('a second key on the same provider is still preferred over the same key twice', () => {
  const plan = planHedge(
    input({
      candidates: [candidate('anthropic', 'sonnet', ['k1', 'k2'])],
    }),
  );

  assert.equal(plan.legs.length, 2);
  assert.equal(plan.legs[0]?.credentialId, 'k1');
  assert.equal(plan.legs[1]?.credentialId, 'k2');
});

test('one model with one key yields one leg and nothing to hedge with', () => {
  const plan = planHedge(input({ candidates: [candidate('ollama', 'llama', ['local'])] }));
  assert.equal(plan.legs.length, 1);
  assert.deepEqual(plan.skipped, []);
});

// --- health drives the order ----------------------------------------------

test('a healthy endpoint is preferred over one with no track record', () => {
  const anthropic = candidate('anthropic', 'sonnet', ['k1']);
  const openai = candidate('openai', 'gpt', ['k2']);
  const known = healthWithTail(openai.model, 'k2', 4_000);

  const plan = planHedge(
    input({
      // Deliberately listed with the unproven one first, so only health can
      // explain the resulting order.
      candidates: [anthropic, openai],
      health: (model, credentialId) =>
        model.providerId === 'openai'
          ? known
          : {
              ...known,
              key: { model, credentialId },
              successRate: null,
              latencyMs: null,
              estimatedTailMs: null,
              totalSuccesses: 0,
            },
    }),
  );

  assert.equal(plan.legs[0]?.model.providerId, 'openai');
});

test('an ejected endpoint is skipped and the reason is recorded', () => {
  const plan = planHedge(
    input({
      candidates: [
        candidate('anthropic', 'sonnet', ['k1']),
        candidate('openai', 'gpt', ['k2']),
      ],
      admit: (model) =>
        model.providerId === 'anthropic'
          ? { ok: false, probe: false }
          : { ok: true, probe: false },
    }),
  );

  assert.equal(plan.legs.length, 1);
  assert.equal(plan.legs[0]?.model.providerId, 'openai');
  assert.deepEqual(
    plan.skipped.map((s) => ({ p: s.model.providerId, r: s.reason })),
    [{ p: 'anthropic', r: 'breaker-open' }],
  );
});

test('a leg admitted as a probe is marked so a failure re-opens the breaker', () => {
  const plan = planHedge(
    input({
      candidates: [candidate('anthropic', 'sonnet', ['k1'])],
      admit: () => ({ ok: true, probe: true }),
    }),
  );
  assert.equal(plan.legs[0]?.probe, true);
});

test('the pinned model stays primary even when another is healthier', () => {
  const anthropic = candidate('anthropic', 'sonnet', ['k1']);
  const openai = candidate('openai', 'gpt', ['k2']);

  const plan = planHedge(
    input({
      candidates: [openai, anthropic],
      preferred: { model: anthropic.model, credentialId: 'k1' },
      health: (model, credentialId) =>
        model.providerId === 'openai'
          ? healthWithTail(model, credentialId, 1_000)
          : {
              ...healthWithTail(model, credentialId, 1_000),
              successRate: null,
              estimatedTailMs: null,
            },
    }),
  );

  assert.equal(
    plan.legs[0]?.model.providerId,
    'anthropic',
    'a user who picked a model must not have it silently demoted',
  );
});

// --- requirements ----------------------------------------------------------

test('a model that cannot call tools is refused when the task needs tools', () => {
  const plan = planHedge(
    input({
      candidates: [
        candidate('anthropic', 'sonnet', ['k1'], { toolCalling: false }),
        candidate('openai', 'gpt', ['k2']),
      ],
    }),
  );

  assert.equal(plan.legs.length, 1);
  assert.equal(plan.legs[0]?.model.providerId, 'openai');
  assert.deepEqual(
    plan.skipped.map((s) => s.reason),
    ['capability'],
  );
});

test('a model with no ready credential is refused with a distinguishable reason', () => {
  const plan = planHedge(
    input({ candidates: [candidate('anthropic', 'sonnet', [])] }),
  );

  assert.equal(plan.legs.length, 0);
  assert.deepEqual(
    plan.skipped.map((s) => s.reason),
    ['no-credential'],
    'no key is a setup problem; the UI must not report it as an outage',
  );
});

test('a context window too small for the task is refused', () => {
  const plan = planHedge(
    input({
      requirements: { ...REQUIREMENTS, minContextWindow: 500_000 },
      candidates: [candidate('anthropic', 'sonnet', ['k1'])],
    }),
  );
  assert.deepEqual(
    plan.skipped.map((s) => s.reason),
    ['capability'],
  );
});

test('no candidates at all is an empty plan, not a crash', () => {
  const plan = planHedge(input({ candidates: [] }));
  assert.deepEqual(plan.legs, []);
  assert.deepEqual(plan.skipped, []);
});

// --- the delay -------------------------------------------------------------

test('the hedge delay follows the primary observed tail, clamped at both ends', () => {
  const model: ModelRef = { providerId: 'a', modelId: 'm' };
  const limits = DEFAULT_HEDGE_LIMITS;

  assert.equal(
    hedgeDelayMs(healthWithTail(model, 'k', 6_000), limits),
    6_000,
    'an endpoint that is usually slow should be given its usual time',
  );
  assert.equal(
    hedgeDelayMs(healthWithTail(model, 'k', 100), limits),
    limits.minHedgeDelayMs,
    'a fast endpoint must not be hedged on noise',
  );
  assert.equal(
    hedgeDelayMs(healthWithTail(model, 'k', 999_999), limits),
    limits.maxHedgeDelayMs,
    'a pathological estimate must not disable hedging',
  );
});

test('an endpoint with no measurements gets the stated default, not an invented estimate', () => {
  const model: ModelRef = { providerId: 'a', modelId: 'm' };
  const unknown: EndpointHealth = {
    ...healthWithTail(model, 'k', 0),
    successRate: null,
    latencyMs: null,
    estimatedTailMs: null,
    totalSuccesses: 0,
  };
  assert.equal(hedgeDelayMs(unknown, DEFAULT_HEDGE_LIMITS), DEFAULT_HEDGE_LIMITS.unknownHedgeDelayMs);
});

test('additional legs are staggered rather than arriving together', () => {
  const plan = planHedge(
    input({
      limits: { ...DEFAULT_HEDGE_LIMITS, maxInFlight: 3 },
      candidates: [
        candidate('anthropic', 'sonnet', ['k1']),
        candidate('openai', 'gpt', ['k2']),
        candidate('gemini', 'flash', ['k3']),
      ],
    }),
  );

  const [, second, third] = plan.legs;
  assert.ok(second !== undefined && third !== undefined);
  assert.ok(
    third.startAfterMs > second.startAfterMs,
    'firing both hedges at the same moment is a self-inflicted herd',
  );
});

test('health limits are honoured when grading candidates', () => {
  // A candidate whose success rate sits between two thresholds must be ordered
  // by the limits passed in, not by the module default.
  const anthropic = candidate('anthropic', 'sonnet', ['k1']);
  const openai = candidate('openai', 'gpt', ['k2']);
  const mediocre = { ...healthWithTail(anthropic.model, 'k1', 2_000), successRate: 0.6 };

  const strict = planHedge(
    input({
      candidates: [anthropic, openai],
      healthLimits: { ...DEFAULT_HEALTH_LIMITS, degradedBelow: 0.9 },
      health: (model, credentialId) =>
        model.providerId === 'anthropic'
          ? mediocre
          : healthWithTail(model, credentialId, 2_000),
    }),
  );

  assert.equal(
    strict.legs[0]?.model.providerId,
    'openai',
    '0.6 is degraded under a 0.9 threshold, so it must not lead',
  );
});
