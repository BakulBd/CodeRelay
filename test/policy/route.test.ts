/**
 * Routing policy decision table.
 *
 * `route()` is pure, so every branch is reachable from a literal input. The
 * cases below are written as the questions a user would ask after a failure —
 * "why did it change model?", "why did it not just retry?" — because a policy
 * whose reasons cannot be explained is one that will be silently wrong.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LIMITS,
  backoffMs,
  route,
  sameModel,
  type Candidate,
  type PastAttempt,
  type Requirements,
  type RouteDecision,
  type RouteInput,
  type RouteLimits,
} from '../../src/policy/route.js';
import type { RequestClassification } from '../../src/recovery/classify.js';
import type { ErrorClass, ModelCapabilities, ModelRef } from '../../src/core/types.js';

// --- narrowing -------------------------------------------------------------
// `assert.ok(d.kind === 'X')` asserts a boolean; it does not narrow `d`. These
// helpers assert and narrow in one step so each test can read the fields it
// cares about without casts scattered through the body.

function expectKind<K extends RouteDecision['kind']>(
  decision: RouteDecision,
  kind: K,
): Extract<RouteDecision, { kind: K }> {
  assert.equal(decision.kind, kind, `expected ${kind}, got ${decision.kind}`);
  return decision as Extract<RouteDecision, { kind: K }>;
}

// --- fixtures --------------------------------------------------------------

const BASE_CAPS: ModelCapabilities = {
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

function caps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { ...BASE_CAPS, ...overrides };
}

const SONNET: ModelRef = { providerId: 'anthropic', modelId: 'sonnet' };
const GPT: ModelRef = { providerId: 'openai', modelId: 'gpt' };
const LOCAL: ModelRef = { providerId: 'ollama', modelId: 'qwen' };

function candidate(
  model: ModelRef,
  overrides: Partial<Omit<Candidate, 'model'>> = {},
): Candidate {
  return {
    model,
    capabilities: overrides.capabilities ?? caps(),
    readyCredentialIds: overrides.readyCredentialIds ?? ['k1'],
    coolingRetryAfterMs: overrides.coolingRetryAfterMs ?? null,
  };
}

function failure(overrides: Partial<RequestClassification> = {}): RequestClassification {
  return {
    errorClass: 'RETRYABLE',
    requestRetryable: true,
    retryAfterMs: null,
    rotateCredential: false,
    reason: 'provider returned 503',
    ...overrides,
  };
}

function attempt(model: ModelRef, credentialId = 'k1', errorClass: ErrorClass = 'RETRYABLE'): PastAttempt {
  return { model, credentialId, errorClass };
}

const NEEDS: Requirements = { toolCalling: true, vision: false, minContextWindow: 8_000 };

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    current: SONNET,
    currentCredentialId: 'k1',
    failure: failure(),
    attempts: [attempt(SONNET)],
    candidates: [candidate(SONNET)],
    requirements: NEEDS,
    ...overrides,
  };
}

// --- global budget ---------------------------------------------------------

test('a task that has burned its total attempt budget gives up rather than looping', () => {
  const attempts = Array.from({ length: DEFAULT_LIMITS.maxTotalAttempts }, () =>
    attempt(SONNET),
  );
  const decision = expectKind(route(input({ attempts })), 'GIVE_UP');
  assert.match(decision.reason, /already failed 8 times/);
  assert.equal(decision.tone, 'observed');
});

test('the spent budget overrides every decision that would continue automatically', () => {
  const limits: RouteLimits = { ...DEFAULT_LIMITS, maxTotalAttempts: 2 };
  const spent = [attempt(SONNET), attempt(SONNET)];

  // A retry the classifier would otherwise allow...
  const retry = expectKind(
    route(
      input({
        limits,
        attempts: spent,
        candidates: [candidate(SONNET)],
        failure: failure({ retryAfterMs: 100 }),
      }),
    ),
    'GIVE_UP',
  );
  assert.match(retry.reason, /already failed 2 times/);
  // The abandoned alternative is named, so the timeline shows what the budget cost.
  assert.match(retry.reason, /would have been RETRY_SAME/);

  // ...and a model switch, which is just as automatic.
  const switched = expectKind(
    route(
      input({
        limits,
        attempts: spent,
        candidates: [candidate(SONNET), candidate(GPT)],
        failure: failure({ errorClass: 'CONFIG', requestRetryable: false }),
      }),
    ),
    'GIVE_UP',
  );
  assert.match(switched.reason, /would have been SWITCH_MODEL/);
});

test('a spent budget does not erase an escalation that tells the user how to fix it', () => {
  // Regression: the budget check used to run *before* classification, so the last
  // attempt at a broken certificate chain reported a generic "too many failures"
  // and discarded the one instruction that would have resolved it. Escalating is
  // already stopping, so the budget has nothing to add.
  const limits: RouteLimits = { ...DEFAULT_LIMITS, maxTotalAttempts: 2 };
  const decision = expectKind(
    route(
      input({
        limits,
        attempts: [attempt(SONNET), attempt(SONNET)],
        candidates: [candidate(SONNET), candidate(GPT)],
        failure: failure({
          errorClass: 'TLS_UNTRUSTED',
          requestRetryable: false,
          reason: 'self-signed certificate in certificate chain',
        }),
      }),
    ),
    'ESCALATE',
  );
  assert.match(decision.question, /CA certificate/);
  assert.doesNotMatch(decision.question, /already failed/);
});

test('a classified give-up keeps its own reason and gains the budget as context', () => {
  // Two different facts — "nothing left to try" and "out of attempts" — and both
  // are true, so neither replaces the other.
  const limits: RouteLimits = { ...DEFAULT_LIMITS, maxTotalAttempts: 2 };
  const decision = expectKind(
    route(
      input({
        limits,
        attempts: [attempt(SONNET), attempt(SONNET)],
        candidates: [candidate(SONNET)],
        failure: failure({ errorClass: 'STREAM', requestRetryable: false }),
      }),
    ),
    'GIVE_UP',
  );
  assert.match(decision.reason, /already failed 2 times/);
  assert.match(decision.reason, /not retryable/);
});


// --- TLS -------------------------------------------------------------------

test('an untrusted certificate escalates instead of failing over, because every provider will fail the same way', () => {
  const decision = expectKind(
    route(
      input({
        failure: failure({
          errorClass: 'TLS_UNTRUSTED',
          requestRetryable: false,
          reason: 'certificate has expired',
        }),
        candidates: [candidate(SONNET), candidate(GPT)],
      }),
    ),
    'ESCALATE',
  );
  assert.match(decision.question, /certificate could not be verified/);
  assert.match(decision.question, /proxy/);
  assert.equal(decision.reason, 'certificate has expired');
  assert.equal(decision.tone, 'observed');
});

// --- failures that routing cannot fix -------------------------------------

test('TOOL and FILESYSTEM failures cannot reach the router at all', () => {
  // This is enforced by the type system rather than by a runtime branch:
  // `RouteInput.failure` is a `RequestClassification`, whose `errorClass`
  // excludes both. The check below is a compile-time assertion written as a
  // runtime one so it shows up as a named test — if `RequestErrorClass` ever
  // widens to include an effect failure, this stops compiling, which is
  // exactly the moment someone should be forced to think about it.
  type Routable = RouteInput['failure']['errorClass'];
  const notRoutable: Exclude<ErrorClass, Routable>[] = ['TOOL', 'FILESYSTEM'];
  assert.deepEqual(notRoutable, ['TOOL', 'FILESYSTEM']);
});

// --- AUTH ------------------------------------------------------------------

const AUTH = failure({
  errorClass: 'AUTH',
  requestRetryable: true,
  rotateCredential: true,
  reason: 'provider rejected the credential (401)',
});

test('a rejected key rotates to a sibling key on the same model, with no delay', () => {
  const decision = expectKind(
    route(
      input({
        failure: AUTH,
        candidates: [candidate(SONNET, { readyCredentialIds: ['k1', 'k2'] })],
      }),
    ),
    'SWITCH_CREDENTIAL',
  );
  assert.equal(decision.credentialId, 'k2');
  assert.deepEqual(decision.model, SONNET);
  assert.equal(decision.delayMs, 0);
  assert.equal(decision.tone, 'observed');
});

test('a key already rejected earlier in this task is never offered again', () => {
  // k2 was rejected on a previous attempt. The credential store may not have
  // caught up, so routing must remember it itself.
  const decision = route(
    input({
      failure: AUTH,
      attempts: [attempt(SONNET, 'k2', 'AUTH'), attempt(SONNET, 'k1', 'AUTH')],
      candidates: [
        candidate(SONNET, { readyCredentialIds: ['k1', 'k2'] }),
        candidate(GPT, { readyCredentialIds: ['k9'] }),
      ],
    }),
  );
  const switched = expectKind(decision, 'SWITCH_MODEL');
  assert.deepEqual(switched.to, GPT);
  assert.equal(switched.credentialId, 'k9');
});

test('when every key for a provider is rejected the task moves to another provider', () => {
  const decision = expectKind(
    route(
      input({
        failure: AUTH,
        candidates: [candidate(SONNET), candidate(GPT, { readyCredentialIds: ['k9'] })],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual(decision.from, SONNET);
  assert.deepEqual(decision.to, GPT);
  assert.equal(decision.delayMs, 0);
  assert.equal(decision.tone, 'observed');
});

test('a rejected key with nowhere to go asks for a valid key instead of retrying', () => {
  const decision = expectKind(route(input({ failure: AUTH })), 'ESCALATE');
  assert.match(decision.question, /Add a valid API key/);
  assert.equal(decision.reason, AUTH.reason);
});

// --- CONTEXT ---------------------------------------------------------------

const CONTEXT = failure({
  errorClass: 'CONTEXT',
  requestRetryable: false,
  reason: 'request exceeds the context window',
});

test('a context overflow compacts first, keeping the model the user chose', () => {
  const decision = expectKind(
    route(input({ failure: CONTEXT, candidates: [candidate(SONNET), candidate(GPT)] })),
    'COMPACT_CONTEXT',
  );
  assert.deepEqual(decision.model, SONNET);
  assert.equal(decision.credentialId, 'k1');
  assert.equal(decision.tone, 'observed');
});

test('after the compaction budget is spent the task moves to a strictly larger window', () => {
  const decision = expectKind(
    route(
      input({
        failure: CONTEXT,
        compactionsDone: 1,
        candidates: [
          candidate(SONNET, { capabilities: caps({ contextWindow: 200_000 }) }),
          // Same size is not an improvement, so it must not be chosen.
          candidate(LOCAL, {
            capabilities: caps({ contextWindow: 200_000 }),
            readyCredentialIds: ['k8'],
          }),
          candidate(GPT, {
            capabilities: caps({ contextWindow: 1_000_000 }),
            readyCredentialIds: ['k9'],
          }),
        ],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual(decision.to, GPT);
  assert.match(decision.reason, /larger window/);
});

test('a context overflow with no larger model asks the user to split the task', () => {
  const decision = expectKind(
    route(
      input({
        failure: CONTEXT,
        compactionsDone: 1,
        candidates: [candidate(SONNET), candidate(GPT, { readyCredentialIds: ['k9'] })],
      }),
    ),
    'ESCALATE',
  );
  assert.match(decision.question, /Split the task/);
});

test('a second compaction is allowed when the limits say so', () => {
  const limits: RouteLimits = { ...DEFAULT_LIMITS, contextCompactionsAllowed: 2 };
  const decision = route(input({ failure: CONTEXT, compactionsDone: 1, limits }));
  assert.equal(decision.kind, 'COMPACT_CONTEXT');
});

// --- CONFIG ----------------------------------------------------------------

const CONFIG = failure({
  errorClass: 'CONFIG',
  requestRetryable: false,
  reason: 'unknown model parameter',
});

test('an invalid request is not retried verbatim; another model is tried and labelled inferred', () => {
  const decision = expectKind(
    route(
      input({
        failure: CONFIG,
        candidates: [candidate(SONNET), candidate(GPT, { readyCredentialIds: ['k9'] })],
      }),
    ),
    'SWITCH_MODEL',
  );
  // We do not know the next provider accepts it either, so the tone must not
  // claim we observed that it will work.
  assert.equal(decision.tone, 'inferred');
  assert.match(decision.reason, /rejected the request as invalid/);
});

test('an invalid request with no alternative model asks the user to check settings', () => {
  const decision = expectKind(route(input({ failure: CONFIG })), 'ESCALATE');
  assert.match(decision.question, /Check the model name/);
  assert.equal(decision.tone, 'observed');
});

// --- transient failures ----------------------------------------------------

test('the first transient failure retries the same model after one base backoff', () => {
  const decision = expectKind(route(input()), 'RETRY_SAME');
  assert.equal(decision.delayMs, DEFAULT_LIMITS.baseBackoffMs);
  assert.deepEqual(decision.model, SONNET);
  assert.equal(decision.credentialId, 'k1');
  assert.match(decision.reason, /retrying the same model in 1000 ms/);
});

test('backoff doubles with each attempt on the same model', () => {
  const two = expectKind(
    route(input({ attempts: [attempt(SONNET), attempt(SONNET)] })),
    'RETRY_SAME',
  );
  assert.equal(two.delayMs, 2_000);
});

test("a provider's own Retry-After overrides the computed backoff", () => {
  const decision = expectKind(
    route(input({ failure: failure({ retryAfterMs: 4_500 }) })),
    'RETRY_SAME',
  );
  assert.equal(decision.delayMs, 4_500);
});

test('a throttled key rotates immediately rather than waiting out the cooldown', () => {
  const decision = expectKind(
    route(
      input({
        failure: failure({ rotateCredential: true, retryAfterMs: 30_000 }),
        candidates: [candidate(SONNET, { readyCredentialIds: ['k1', 'k2'] })],
      }),
    ),
    'SWITCH_CREDENTIAL',
  );
  assert.equal(decision.credentialId, 'k2');
  assert.equal(decision.delayMs, 0);
  assert.match(decision.reason, /rate limited/);
});

test('a throttled key with no sibling falls back to waiting on the same model', () => {
  const decision = expectKind(
    route(input({ failure: failure({ rotateCredential: true, retryAfterMs: 2_000 }) })),
    'RETRY_SAME',
  );
  assert.equal(decision.delayMs, 2_000);
});

test('a wait longer than the policy allows moves the task instead of stalling it', () => {
  const decision = expectKind(
    route(
      input({
        failure: failure({ retryAfterMs: DEFAULT_LIMITS.maxWaitMs + 1 }),
        candidates: [candidate(SONNET), candidate(GPT, { readyCredentialIds: ['k9'] })],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.match(decision.reason, /longer than this task should stall/);
});

test('a model that used up its per-model budget stops being retried', () => {
  const decision = expectKind(
    route(
      input({
        attempts: [attempt(SONNET), attempt(SONNET), attempt(SONNET)],
        candidates: [candidate(SONNET), candidate(GPT, { readyCredentialIds: ['k9'] })],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.match(decision.reason, /failed 3 times/);
});

test('an exhausted model with nowhere to go reports the real wait in seconds', () => {
  const decision = expectKind(
    route(
      input({
        attempts: [attempt(SONNET), attempt(SONNET), attempt(SONNET)],
        failure: failure({ retryAfterMs: 30_000 }),
      }),
    ),
    'ESCALATE',
  );
  assert.match(decision.question, /retrying in 30 s/);
});

test('with no Retry-After the escalation falls back to the soonest credential cooldown', () => {
  const decision = expectKind(
    route(
      input({
        attempts: [attempt(SONNET), attempt(SONNET), attempt(SONNET)],
        candidates: [
          candidate(SONNET, { coolingRetryAfterMs: 45_000 }),
          candidate(LOCAL, { coolingRetryAfterMs: 12_000, readyCredentialIds: [] }),
        ],
      }),
    ),
    'ESCALATE',
  );
  assert.match(decision.question, /retrying in 12 s/);
});

test('a non-retryable stream failure with nothing to fall back on gives up honestly', () => {
  const decision = expectKind(
    route(
      input({
        failure: failure({
          errorClass: 'STREAM',
          requestRetryable: false,
          reason: 'stream ended before any terminal event',
        }),
      }),
    ),
    'GIVE_UP',
  );
  assert.match(decision.reason, /not retryable/);
});

test('a truncated stream on a model with budget left is retried on that model', () => {
  const decision = expectKind(
    route(
      input({
        failure: failure({
          errorClass: 'STREAM',
          requestRetryable: true,
          reason: 'stream ended after partial output',
        }),
      }),
    ),
    'RETRY_SAME',
  );
  assert.equal(decision.delayMs, 1_000);
});

// --- UNKNOWN ---------------------------------------------------------------

const UNKNOWN = failure({
  errorClass: 'UNKNOWN',
  requestRetryable: false,
  reason: 'unrecognised provider error',
});

test('an unclassified failure is never retried on the same model', () => {
  const decision = route(
    input({
      failure: UNKNOWN,
      candidates: [candidate(SONNET), candidate(GPT, { readyCredentialIds: ['k9'] })],
    }),
  );
  assert.notEqual(decision.kind, 'RETRY_SAME');
  const switched = expectKind(decision, 'SWITCH_MODEL');
  assert.equal(switched.tone, 'inferred');
  assert.match(switched.reason, /could not be classified/);
});

test('an unclassified failure with no alternative asks the user to read the timeline', () => {
  const decision = expectKind(route(input({ failure: UNKNOWN })), 'ESCALATE');
  assert.match(decision.question, /could not classify/);
});

// --- candidate eligibility -------------------------------------------------

test('a model that cannot call tools is not a failover target for a task that needs them', () => {
  const decision = route(
    input({
      failure: AUTH,
      candidates: [
        candidate(SONNET),
        candidate(GPT, {
          capabilities: caps({ toolCalling: false }),
          readyCredentialIds: ['k9'],
        }),
      ],
    }),
  );
  assert.equal(decision.kind, 'ESCALATE');
});

test('a model without vision is not a failover target for a task that needs it', () => {
  const decision = route(
    input({
      failure: AUTH,
      requirements: { ...NEEDS, vision: true },
      candidates: [
        candidate(SONNET, { capabilities: caps({ vision: true }) }),
        candidate(GPT, { capabilities: caps({ vision: false }), readyCredentialIds: ['k9'] }),
      ],
    }),
  );
  assert.equal(decision.kind, 'ESCALATE');
});

test('a model whose window is smaller than the task needs is not a failover target', () => {
  const decision = route(
    input({
      failure: AUTH,
      requirements: { ...NEEDS, minContextWindow: 128_000 },
      candidates: [
        candidate(SONNET),
        candidate(GPT, {
          capabilities: caps({ contextWindow: 32_000 }),
          readyCredentialIds: ['k9'],
        }),
      ],
    }),
  );
  assert.equal(decision.kind, 'ESCALATE');
});

test('a model with no ready credential is not a failover target', () => {
  const decision = route(
    input({
      failure: AUTH,
      candidates: [candidate(SONNET), candidate(GPT, { readyCredentialIds: [] })],
    }),
  );
  assert.equal(decision.kind, 'ESCALATE');
});

test('a model that already exhausted its own budget is not a failover target', () => {
  const decision = route(
    input({
      failure: AUTH,
      attempts: [attempt(GPT), attempt(GPT), attempt(GPT), attempt(SONNET, 'k1', 'AUTH')],
      candidates: [candidate(SONNET), candidate(GPT, { readyCredentialIds: ['k9'] })],
    }),
  );
  assert.equal(decision.kind, 'ESCALATE');
});

test('among equally untried models the cheaper one is chosen', () => {
  const decision = expectKind(
    route(
      input({
        failure: AUTH,
        candidates: [
          candidate(SONNET),
          candidate(GPT, {
            capabilities: caps({ costPerMTokIn: 10, costPerMTokOut: 30 }),
            readyCredentialIds: ['k9'],
          }),
          candidate(LOCAL, {
            capabilities: caps({ costPerMTokIn: 0, costPerMTokOut: 0 }),
            readyCredentialIds: ['k8'],
          }),
        ],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual(decision.to, LOCAL);
});

test('a model not yet tried is preferred over a cheaper one that already failed', () => {
  const decision = expectKind(
    route(
      input({
        failure: AUTH,
        attempts: [attempt(LOCAL), attempt(SONNET, 'k1', 'AUTH')],
        candidates: [
          candidate(SONNET),
          candidate(GPT, {
            capabilities: caps({ costPerMTokIn: 10, costPerMTokOut: 30 }),
            readyCredentialIds: ['k9'],
          }),
          candidate(LOCAL, {
            capabilities: caps({ costPerMTokIn: 0, costPerMTokOut: 0 }),
            readyCredentialIds: ['k8'],
          }),
        ],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual(decision.to, GPT);
});

test('the model that just failed is never chosen as its own failover target', () => {
  const decision = route(
    input({
      failure: AUTH,
      candidates: [candidate(SONNET, { readyCredentialIds: ['k1'] })],
    }),
  );
  assert.equal(decision.kind, 'ESCALATE');
});

// --- degradation reporting -------------------------------------------------

test('every capability the destination has less of is named, so no downgrade is silent', () => {
  const decision = expectKind(
    route(
      input({
        failure: AUTH,
        current: SONNET,
        candidates: [
          candidate(SONNET, {
            capabilities: caps({
              vision: true,
              reasoning: 'explicit',
              contextWindow: 200_000,
              maxOutput: 64_000,
            }),
          }),
          candidate(LOCAL, {
            capabilities: caps({
              parallelToolCalls: false,
              vision: false,
              structuredOutput: false,
              streaming: false,
              reasoning: 'none',
              contextWindow: 32_000,
              maxOutput: 4_096,
            }),
            readyCredentialIds: ['k8'],
          }),
        ],
        requirements: { toolCalling: true, vision: false, minContextWindow: 8_000 },
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual([...decision.degraded].sort(), [
    'context window',
    'image input',
    'maximum output length',
    'parallel tool calls',
    'reasoning',
    'streaming',
    'structured output',
  ]);
});

test('a strictly better destination reports no degradation', () => {
  const decision = expectKind(
    route(
      input({
        failure: AUTH,
        candidates: [
          candidate(SONNET),
          candidate(GPT, {
            capabilities: caps({ contextWindow: 1_000_000, maxOutput: 100_000 }),
            readyCredentialIds: ['k9'],
          }),
        ],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual(decision.degraded, []);
});

test('implicit reasoning is a downgrade from explicit but not from none', () => {
  const down = expectKind(
    route(
      input({
        failure: AUTH,
        candidates: [
          candidate(SONNET, { capabilities: caps({ reasoning: 'explicit' }) }),
          candidate(GPT, {
            capabilities: caps({ reasoning: 'implicit' }),
            readyCredentialIds: ['k9'],
          }),
        ],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual(down.degraded, ['reasoning']);

  const up = expectKind(
    route(
      input({
        failure: AUTH,
        candidates: [
          candidate(SONNET, { capabilities: caps({ reasoning: 'none' }) }),
          candidate(GPT, {
            capabilities: caps({ reasoning: 'implicit' }),
            readyCredentialIds: ['k9'],
          }),
        ],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual(up.degraded, []);
});

test('an unknown origin model reports no degradation rather than inventing one', () => {
  // The current model is absent from the candidate list, so there is nothing to
  // compare against. Claiming a downgrade here would be a fabricated fact.
  const decision = expectKind(
    route(
      input({
        failure: AUTH,
        candidates: [candidate(GPT, { readyCredentialIds: ['k9'] })],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual(decision.degraded, []);
});

// --- 403: the pairing is refused, not the key -------------------------------

const FORBIDDEN: RequestClassification = {
  errorClass: 'FORBIDDEN',
  requestRetryable: false,
  retryAfterMs: null,
  rotateCredential: false,
  reason: 'provider returned 403 for this model',
};

test('a 403 moves the model and keeps the key, because only the pairing was refused', () => {
  const decision = expectKind(
    route(
      input({
        failure: FORBIDDEN,
        attempts: [attempt(SONNET, 'k1', 'FORBIDDEN')],
        candidates: [candidate(SONNET), candidate(GPT, { readyCredentialIds: ['k1', 'k2'] })],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual(decision.to, GPT);
  // Not k2: changing one variable beats changing two, and the key is not the
  // thing the provider objected to.
  assert.equal(decision.credentialId, 'k1');
  assert.equal(decision.tone, 'observed');
});

test('a 403 does not carry the key to a model that already refused that same key', () => {
  // k1 has been refused on both SONNET and GPT. Carrying it to GPT anyway would
  // spend an attempt re-learning a fact the history already records.
  const decision = expectKind(
    route(
      input({
        failure: FORBIDDEN,
        attempts: [attempt(SONNET, 'k1', 'FORBIDDEN'), attempt(GPT, 'k1', 'FORBIDDEN')],
        candidates: [candidate(SONNET), candidate(GPT, { readyCredentialIds: ['k1', 'k2'] })],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual(decision.to, GPT);
  assert.equal(decision.credentialId, 'k2');
});

test('with no other model, a 403 tries another key on the same model — but only once', () => {
  const oneModel = [candidate(SONNET, { readyCredentialIds: ['k1', 'k2'] })];

  // First 403 on k1: k2 has not been refused here, so it is worth a try. Marked
  // `inferred` because a sibling key carrying the entitlement is a guess.
  const first = expectKind(
    route(
      input({
        failure: FORBIDDEN,
        attempts: [attempt(SONNET, 'k1', 'FORBIDDEN')],
        candidates: oneModel,
      }),
    ),
    'SWITCH_CREDENTIAL',
  );
  assert.equal(first.credentialId, 'k2');
  assert.equal(first.tone, 'inferred');

  // Second 403, now on k2. k1 is still enabled — a 403 does not disable a key —
  // so without pairing memory the policy would hand k1 back and alternate until
  // the total budget ran out, ending in GIVE_UP instead of a message the user
  // can act on.
  const second = route(
    input({
      currentCredentialId: 'k2',
      failure: FORBIDDEN,
      attempts: [attempt(SONNET, 'k1', 'FORBIDDEN'), attempt(SONNET, 'k2', 'FORBIDDEN')],
      candidates: oneModel,
    }),
  );
  const escalation = expectKind(second, 'ESCALATE');
  assert.match(escalation.question, /account has access/);
});

test('a key refused on one model is still offered on another', () => {
  // The pairing set is keyed per (key, model) precisely so this stays true: a
  // per-credential ban would throw away a key that works fine elsewhere.
  const decision = expectKind(
    route(
      input({
        current: GPT,
        failure: FORBIDDEN,
        // k2 was refused on a *third* model. The pairing set is keyed per
        // (key, model), so that refusal must not disqualify k2 on SONNET.
        // Recording it against SONNET instead would contradict the assertion
        // below: routing back into a pairing the provider already refused is
        // exactly what `forbiddenPairings` exists to prevent.
        attempts: [attempt(LOCAL, 'k2', 'FORBIDDEN'), attempt(GPT, 'k1', 'FORBIDDEN')],
        candidates: [candidate(GPT), candidate(SONNET, { readyCredentialIds: ['k2'] })],
      }),
    ),
    'SWITCH_MODEL',
  );
  assert.deepEqual(decision.to, SONNET);
  assert.equal(decision.credentialId, 'k2');
});

// --- helpers ---------------------------------------------------------------

test('sameModel compares provider and model, not object identity', () => {
  assert.equal(sameModel(SONNET, { ...SONNET }), true);
  assert.equal(sameModel(SONNET, { providerId: 'anthropic', modelId: 'haiku' }), false);
  assert.equal(sameModel(SONNET, { providerId: 'bedrock', modelId: 'sonnet' }), false);
});

test('backoff is deterministic, starts at the base delay and is capped', () => {
  const limits: RouteLimits = { ...DEFAULT_LIMITS, baseBackoffMs: 1_000, maxWaitMs: 5_000 };
  assert.equal(backoffMs(0, limits), 1_000);
  assert.equal(backoffMs(1, limits), 1_000);
  assert.equal(backoffMs(2, limits), 2_000);
  assert.equal(backoffMs(3, limits), 4_000);
  assert.equal(backoffMs(4, limits), 5_000);
  assert.equal(backoffMs(50, limits), 5_000);
});

test('no decision reason or question carries credential material', () => {
  // The policy only ever sees credential *ids*, so this is structural rather
  // than best-effort. The test pins that property against future changes.
  const decisions: RouteDecision[] = [
    route(input({ failure: AUTH })),
    route(input({ failure: UNKNOWN })),
    route(input()),
    route(input({ failure: CONTEXT })),
  ];
  for (const decision of decisions) {
    const text = JSON.stringify(decision);
    assert.ok(!text.includes('sk-'), text);
    assert.ok(!/secret/i.test(text), text);
  }
});

// --- jitter ----------------------------------------------------------------
// Added when hedging made concurrent retries possible. The property that
// matters is not the exact delay but the bounds: a jittered wait must never be
// so short that it re-throttles, nor longer than the budget the policy just
// enforced.

test('omitting the jitter source keeps the delay deterministic', () => {
  const limits = DEFAULT_LIMITS;
  assert.equal(backoffMs(1, limits), backoffMs(1, limits));
  assert.equal(backoffMs(1, limits), limits.baseBackoffMs);
  assert.equal(backoffMs(3, limits), limits.baseBackoffMs * 4);
});

test('equal jitter stays within half the computed delay and the full delay', () => {
  const limits = DEFAULT_LIMITS;
  const plain = backoffMs(3, limits);

  assert.equal(backoffMs(3, limits, () => 0), plain / 2, 'the floor is half, never zero');
  assert.equal(backoffMs(3, limits, () => 1), plain, 'the ceiling is the undithered delay');

  for (const r of [0.01, 0.25, 0.5, 0.75, 0.99]) {
    const jittered = backoffMs(3, limits, () => r);
    assert.ok(
      jittered >= plain / 2 && jittered <= plain,
      `jittered delay ${jittered} must sit inside [${plain / 2}, ${plain}]`,
    );
  }
});

test('a jitter source outside [0,1] cannot exceed the wait budget', () => {
  const limits = DEFAULT_LIMITS;
  const plain = backoffMs(2, limits);
  assert.equal(backoffMs(2, limits, () => 99), plain, 'clamped, not trusted');
  assert.equal(backoffMs(2, limits, () => -5), plain / 2);
  assert.equal(backoffMs(2, limits, () => Number.NaN), plain / 2, 'NaN must not leak into a delay');
});

test('jitter never pushes a delay past the cap', () => {
  const limits: RouteLimits = { ...DEFAULT_LIMITS, baseBackoffMs: 1_000, maxWaitMs: 5_000 };
  for (const r of [0, 0.5, 1]) {
    assert.ok(backoffMs(10, limits, () => r) <= limits.maxWaitMs);
  }
});

test('a provider-supplied retry-after is used exactly, never jittered', () => {
  const decision = route(
    input({
      failure: failure({ retryAfterMs: 7_000, reason: 'rate limited' }),
      random: () => 0,
    }),
  );

  assert.ok(decision.kind === 'RETRY_SAME');
  assert.equal(
    decision.delayMs,
    7_000,
    'the provider told us how long to wait; second-guessing it gets us throttled again',
  );
});
