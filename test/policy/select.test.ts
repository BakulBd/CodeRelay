/**
 * AUTO MODEL selection, and the explanation it owes the user.
 *
 * The brief's hard rule is "never silently change models", so the assertions
 * here are as much about the *reasons* as about the choice: a selector that
 * picks well but cannot say why is still changing models silently.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROLE_LABELS,
  TASK_ROLES,
  selectModel,
  type SelectInput,
  type TaskRole,
} from '../../src/policy/select.js';
import type { EndpointHealth } from '../../src/policy/health.js';
import type { Candidate } from '../../src/policy/route.js';
import type { ModelCapabilities, ModelRef } from '../../src/core/types.js';

const CAPS: ModelCapabilities = {
  streaming: true,
  toolCalling: true,
  parallelToolCalls: true,
  vision: false,
  reasoning: 'implicit',
  structuredOutput: true,
  contextWindow: 200_000,
  maxOutput: 8_192,
  costPerMTokIn: 3,
  costPerMTokOut: 15,
};

function candidate(
  providerId: string,
  modelId: string,
  caps: Partial<ModelCapabilities> = {},
  credentialIds: readonly string[] = ['k1'],
): Candidate {
  return {
    model: { providerId, modelId },
    capabilities: { ...CAPS, ...caps },
    readyCredentialIds: credentialIds,
    coolingRetryAfterMs: null,
  };
}

function health(over: Partial<EndpointHealth> = {}): EndpointHealth {
  return {
    key: { model: { providerId: 'p', modelId: 'm' }, credentialId: 'k1' },
    successRate: null,
    latencyMs: null,
    estimatedTailMs: null,
    consecutiveFailures: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    lastOutcomeAt: null,
    lastErrorClass: null,
    breaker: { kind: 'closed' },
    ...over,
  };
}

const input = (over: Partial<SelectInput> = {}): SelectInput => ({
  candidates: [],
  role: 'code',
  now: 1_000,
  ...over,
});

function chosen(outcome: ReturnType<typeof selectModel>): { model: ModelRef; reasons: readonly string[] } {
  assert.ok(outcome.ok, 'expected a selection');
  return { model: outcome.selection.model, reasons: outcome.selection.reasons };
}

// --- hard gates ------------------------------------------------------------

test('a model that cannot call tools is refused for coding, with a stated reason', () => {
  const outcome = selectModel(
    input({
      role: 'code',
      candidates: [candidate('a', 'no-tools', { toolCalling: false })],
    }),
  );

  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.match(outcome.rejected[0]?.reason ?? '', /cannot call tools/);
});

test('the same model is perfectly acceptable for planning', () => {
  const outcome = selectModel(
    input({
      role: 'plan',
      candidates: [candidate('a', 'no-tools', { toolCalling: false, reasoning: 'explicit' })],
    }),
  );

  assert.ok(outcome.ok, 'planning reads and thinks; it does not edit');
  assert.equal(outcome.selection.model.modelId, 'no-tools');
});

test('a context window below the role floor is refused, and the numbers are shown', () => {
  const outcome = selectModel(
    input({ role: 'debug', candidates: [candidate('a', 'small', { contextWindow: 16_000 })] }),
  );

  assert.ok(!outcome.ok);
  assert.match(outcome.rejected[0]?.reason ?? '', /16,000/);
  assert.match(outcome.rejected[0]?.reason ?? '', /64,000/);
});

test('a model with no stored key is refused as a setup problem', () => {
  const outcome = selectModel(input({ candidates: [candidate('a', 'm', {}, [])] }));
  assert.ok(!outcome.ok);
  assert.match(outcome.rejected[0]?.reason ?? '', /no usable API key/);
});

test('an ejected endpoint is not offered', () => {
  const outcome = selectModel(
    input({
      candidates: [candidate('a', 'down')],
      health: () => health({ breaker: { kind: 'open', openUntil: 9_000, consecutiveTrips: 1 } }),
    }),
  );

  assert.ok(!outcome.ok);
  assert.match(outcome.rejected[0]?.reason ?? '', /out of rotation/);
});

test('no candidates at all is reported distinctly from none qualifying', () => {
  const none = selectModel(input({ candidates: [] }));
  assert.ok(!none.ok);
  assert.match(none.reason, /No models are configured/);

  const unqualified = selectModel(
    input({ candidates: [candidate('a', 'm', { toolCalling: false })] }),
  );
  assert.ok(!unqualified.ok);
  assert.match(unqualified.reason, /meets what coding needs/);
});

// --- the pin wins ----------------------------------------------------------

test('a model the user pinned is always chosen, and says so', () => {
  const outcome = selectModel(
    input({
      candidates: [
        candidate('a', 'better', { reasoning: 'explicit', contextWindow: 1_000_000 }),
        candidate('b', 'pinned'),
      ],
      pinned: { providerId: 'b', modelId: 'pinned' },
    }),
  );

  const { model, reasons } = chosen(outcome);
  assert.equal(model.modelId, 'pinned', 'overriding a pin is the silent switch the brief forbids');
  assert.deepEqual(reasons, ['you chose this model']);
});

test('a pin to an unusable model does not silently succeed', () => {
  const outcome = selectModel(
    input({
      role: 'code',
      candidates: [candidate('b', 'pinned', { toolCalling: false })],
      pinned: { providerId: 'b', modelId: 'pinned' },
    }),
  );
  assert.equal(outcome.ok, false);
});

// --- roles actually differ -------------------------------------------------

test('debugging prefers the larger context; testing prefers the cheaper model', () => {
  const big = candidate('a', 'big', { contextWindow: 1_000_000, costPerMTokIn: 15, costPerMTokOut: 75 });
  const cheap = candidate('b', 'cheap', { contextWindow: 128_000, costPerMTokIn: 0.1, costPerMTokOut: 0.4 });

  assert.equal(chosen(selectModel(input({ role: 'debug', candidates: [big, cheap] }))).model.modelId, 'big');
  assert.equal(chosen(selectModel(input({ role: 'test', candidates: [big, cheap] }))).model.modelId, 'cheap');
});

test('planning prefers explicit reasoning', () => {
  const thinker = candidate('a', 'thinker', { reasoning: 'explicit' });
  const plain = candidate('b', 'plain', { reasoning: 'none', contextWindow: 400_000 });

  const { model, reasons } = chosen(selectModel(input({ role: 'plan', candidates: [thinker, plain] })));
  assert.equal(model.modelId, 'thinker');
  assert.ok(reasons.some((r) => /explicit reasoning/.test(r)));
});

test('every role has a label and a usable profile', () => {
  const pool = [candidate('a', 'm', { reasoning: 'explicit', contextWindow: 200_000 })];
  for (const role of TASK_ROLES) {
    assert.ok(ROLE_LABELS[role].length > 0);
    const outcome = selectModel(input({ role, candidates: pool }));
    assert.ok(outcome.ok, `${role} must be able to select from a capable model`);
    assert.ok(outcome.selection.reasons.length > 0, `${role} must explain itself`);
  }
});

// --- honesty in the explanation -------------------------------------------

test('an unpriced model does not win the cost dimension by default', () => {
  // Three candidates, so cost is actually rankable: an unpriced model must not
  // beat the cheapest priced one just by declaring nothing.
  const unpriced = candidate('a', 'unpriced', { costPerMTokIn: 0, costPerMTokOut: 0 });
  const cheap = candidate('b', 'cheap', { costPerMTokIn: 0.01, costPerMTokOut: 0.01 });
  const dear = candidate('c', 'dear', { costPerMTokIn: 30, costPerMTokOut: 120 });

  const { model } = chosen(
    selectModel(input({ role: 'test', candidates: [unpriced, cheap, dear] })),
  );
  assert.equal(model.modelId, 'cheap', 'an undeclared price is not "free"');
});

test('unpriced models do not distort the cost scale for the ones that are priced', () => {
  // The regression this pins: normalising against a maximum that included
  // zero-cost entries made the only priced model the dearest by construction.
  const unpriced = candidate('a', 'unpriced', { costPerMTokIn: 0, costPerMTokOut: 0 });
  const cheap = candidate('b', 'cheap', { costPerMTokIn: 0.01, costPerMTokOut: 0.01 });

  const outcome = selectModel(input({ role: 'test', candidates: [unpriced, cheap] }));
  assert.ok(outcome.ok);
  // With one declared price there is no basis to rank on cost, so neither is
  // penalised — but the priced one must not be scored as the most expensive.
  assert.ok(outcome.selection.score > 0, 'a lone priced model must not score zero on cost');
});

test('a model nobody has used is never described as healthy', () => {
  const { reasons } = chosen(selectModel(input({ candidates: [candidate('a', 'fresh')] })));
  assert.ok(
    !reasons.some((r) => /responding normally|unknown/i.test(r)),
    'no evidence is not a selling point, and naming it would read as a warning',
  );
});

test('a measured success rate is quoted only with enough observations', () => {
  const one = chosen(
    selectModel(
      input({
        candidates: [candidate('a', 'm')],
        health: () => health({ successRate: 1, totalSuccesses: 1, lastOutcomeAt: 900 }),
      }),
    ),
  );
  assert.ok(one.reasons.some((r) => r === 'responding normally'));
  assert.ok(!one.reasons.some((r) => /%/.test(r)), 'one outcome is not a rate');

  const many = chosen(
    selectModel(
      input({
        candidates: [candidate('a', 'm')],
        health: () => health({ successRate: 0.95, totalSuccesses: 19, totalFailures: 1, lastOutcomeAt: 900 }),
      }),
    ),
  );
  assert.ok(many.reasons.some((r) => /95% of recent requests succeeded/.test(r)));
});

test('a degraded model that is chosen anyway says why', () => {
  const { reasons } = chosen(
    selectModel(
      input({
        candidates: [candidate('a', 'only')],
        health: () => health({ successRate: 0.3, totalSuccesses: 3, totalFailures: 7, lastOutcomeAt: 900 }),
      }),
    ),
  );
  assert.ok(reasons.some((r) => /despite recent failures/.test(r)));
});

test('a healthy model outranks a degraded one', () => {
  const outcome = selectModel(
    input({
      candidates: [candidate('a', 'sick'), candidate('b', 'well')],
      health: (model) =>
        model.providerId === 'a'
          ? health({ successRate: 0.2, totalSuccesses: 2, totalFailures: 8, lastOutcomeAt: 900 })
          : health({ successRate: 1, totalSuccesses: 10, lastOutcomeAt: 900 }),
    }),
  );
  assert.equal(chosen(outcome).model.modelId, 'well');
});

test('every model not chosen carries a reason it was not', () => {
  const outcome = selectModel(
    input({
      candidates: [
        candidate('a', 'winner', { contextWindow: 500_000 }),
        candidate('b', 'runner-up'),
        candidate('c', 'too-small', { contextWindow: 1_000 }),
      ],
    }),
  );

  assert.ok(outcome.ok);
  const reasons = new Map(outcome.selection.rejected.map((r) => [r.model.modelId, r.reason]));
  assert.match(reasons.get('runner-up') ?? '', /scored lower/);
  assert.match(reasons.get('too-small') ?? '', /context window/);
  assert.equal(reasons.has('winner'), false, 'the chosen model is not a rejection');
});

test('selection is deterministic for the same inputs', () => {
  const args = input({
    candidates: [candidate('a', 'one'), candidate('b', 'two', { contextWindow: 300_000 })],
  });
  const first = selectModel(args);
  const second = selectModel(args);
  assert.deepEqual(first, second, 'an explanation that changes between renders is not checkable');
});

// --- routing rules ---------------------------------------------------------

test('a routing rule outranks the automatic score', () => {
  const better = candidate('a', 'better', { reasoning: 'explicit', contextWindow: 1_000_000 });
  const preferred = candidate('b', 'preferred');

  const outcome = selectModel(
    input({
      candidates: [better, preferred],
      ruleTargets: [{ modelId: 'preferred' }],
      ruleReason: 'your routing rule “Debug on B” prefers preferred',
    }),
  );

  const { model, reasons } = chosen(outcome);
  assert.equal(model.modelId, 'preferred');
  assert.equal(reasons[0], 'your routing rule “Debug on B” prefers preferred');
});

test('a rule pointing at an unusable model is skipped, not an error', () => {
  const outcome = selectModel(
    input({
      role: 'code',
      candidates: [
        candidate('a', 'no-tools', { toolCalling: false }),
        candidate('b', 'usable'),
      ],
      ruleTargets: [{ modelId: 'no-tools' }],
      ruleReason: 'rule prefers no-tools',
    }),
  );

  assert.equal(
    chosen(outcome).model.modelId,
    'usable',
    'a preference must never become an outage',
  );
});

test('a rule pointing at a model with no key falls through to the automatic choice', () => {
  const outcome = selectModel(
    input({
      candidates: [candidate('a', 'keyless', {}, []), candidate('b', 'usable')],
      ruleTargets: [{ modelId: 'keyless' }],
    }),
  );
  assert.equal(chosen(outcome).model.modelId, 'usable');
});

test('a rule falls back to its second target when the first cannot run', () => {
  const outcome = selectModel(
    input({
      role: 'code',
      candidates: [
        candidate('a', 'first', { toolCalling: false }),
        candidate('b', 'second'),
        candidate('c', 'third'),
      ],
      ruleTargets: [{ modelId: 'first' }, { modelId: 'second' }],
    }),
  );
  assert.equal(chosen(outcome).model.modelId, 'second');
});

test('a provider-wide rule matches any of its models', () => {
  const outcome = selectModel(
    input({
      candidates: [candidate('openai', 'gpt'), candidate('anthropic', 'sonnet')],
      ruleTargets: [{ providerId: 'anthropic' }],
    }),
  );
  assert.equal(chosen(outcome).model.providerId, 'anthropic');
});

test('a pinned model still beats a routing rule', () => {
  const outcome = selectModel(
    input({
      candidates: [candidate('a', 'pinned'), candidate('b', 'ruled')],
      pinned: { providerId: 'a', modelId: 'pinned' },
      ruleTargets: [{ modelId: 'ruled' }],
    }),
  );
  assert.equal(
    chosen(outcome).model.modelId,
    'pinned',
    'the user choosing a model outranks the user writing a rule about models',
  );
});

test('models passed over by a rule say that is why', () => {
  const outcome = selectModel(
    input({
      candidates: [candidate('a', 'chosen'), candidate('b', 'other')],
      ruleTargets: [{ modelId: 'chosen' }],
    }),
  );
  assert.ok(outcome.ok);
  assert.match(outcome.selection.rejected[0]?.reason ?? '', /routing rule/);
});
