/**
 * The relay successor recommendation.
 *
 * This replaced a hardcoded table — Anthropic failed, recommend
 * `gemini-1.5-pro`; anything else, recommend `claude-3-7-sonnet` — which
 * recommended models the user might never have configured, asserted reasons it
 * had not checked ("healthy credential pool"), and could never name a model
 * released after the table was written.
 *
 * So the tests here are mostly about what it must *not* do: never name a model
 * that is not configured, never claim health it did not consult, and never
 * depend on a model id being known in advance.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { recommendSuccessor } from '../../src/ui/webview/present.js';
import type { CandidateModel, EndpointHealthItem, PresentOptions } from '../../src/ui/webview/present.js';
import type { ModelRef } from '../../src/core/types.js';

const INTERRUPTED: ModelRef = { providerId: 'anthropic', modelId: 'claude-sonnet-4' };

function candidate(
  providerId: string,
  modelId: string,
  over: Partial<CandidateModel['capabilities']> = {},
): CandidateModel {
  return {
    model: { providerId, modelId },
    capabilities: { streaming: true, toolCalling: true, contextWindow: 200_000, ...over },
  };
}

function options(
  candidates: readonly CandidateModel[],
  health: readonly EndpointHealthItem[] = [],
): PresentOptions {
  return {
    taskId: 't1',
    projection: null,
    live: false,
    blocked: null,
    selectedModel: null,
    candidates,
    health,
  } as PresentOptions;
}

test('it never recommends a model that is not configured', () => {
  // The old table would have said `gemini-1.5-pro` here regardless.
  const only = candidate('openai', 'gpt-5');
  const result = recommendSuccessor(INTERRUPTED, options([only, candidate('anthropic', 'claude-sonnet-4')]));

  assert.equal(result.model.modelId, 'gpt-5');
  assert.equal(result.model.providerId, 'openai');
});

test('a model released tomorrow is recommendable without a code change', () => {
  // The whole point: nothing here knows this id, and it is still chosen.
  const future = candidate('anthropic', 'claude-opus-9-20281231');
  const result = recommendSuccessor(
    { providerId: 'openai', modelId: 'gpt-5' },
    options([future]),
  );
  assert.equal(result.model.modelId, 'claude-opus-9-20281231');
});

test('it prefers a different provider, because relaying within an outage is not a relay', () => {
  const sameProvider = candidate('anthropic', 'claude-haiku-4');
  const otherProvider = candidate('openai', 'gpt-5');

  const result = recommendSuccessor(INTERRUPTED, options([sameProvider, otherProvider]));
  assert.equal(result.model.providerId, 'openai');
  assert.match(result.reason, /a different provider from anthropic/);
});

test('it falls back to the same provider when that is all there is', () => {
  const result = recommendSuccessor(INTERRUPTED, options([candidate('anthropic', 'claude-haiku-4')]));
  assert.equal(result.model.modelId, 'claude-haiku-4');
  assert.ok(result.reason.length > 0);
});

test('nothing else configured is stated plainly rather than invented', () => {
  const result = recommendSuccessor(INTERRUPTED, options([candidate('anthropic', 'claude-sonnet-4')]));

  assert.deepEqual(result.model, INTERRUPTED);
  assert.match(result.reason, /No other model is configured/);
});

// --- health is consulted, not asserted ------------------------------------

test('a healthy provider outranks a failing one', () => {
  const failing = candidate('openai', 'gpt-5');
  const healthy = candidate('google', 'gemini-3');

  const result = recommendSuccessor(
    INTERRUPTED,
    options([failing, healthy], [
      { providerId: 'openai', state: 'failing' },
      { providerId: 'google', state: 'healthy' },
    ]),
  );

  assert.equal(result.model.providerId, 'google');
  assert.match(result.reason, /responding normally/);
});

test('it never claims health it did not consult', () => {
  // No health entries at all: the old version still said "healthy credential
  // pool" in every case.
  const result = recommendSuccessor(INTERRUPTED, options([candidate('openai', 'gpt-5')]));

  assert.doesNotMatch(result.reason, /responding normally/);
  assert.doesNotMatch(result.reason, /healthy/i);
});

test('a degraded choice says it is a compromise', () => {
  const result = recommendSuccessor(
    INTERRUPTED,
    options([candidate('openai', 'gpt-5')], [{ providerId: 'openai', state: 'degraded' }]),
  );
  assert.match(result.reason, /despite recent failures/);
});

// --- reasons are facts -----------------------------------------------------

test('every stated reason is something declared or measured', () => {
  const result = recommendSuccessor(
    INTERRUPTED,
    options(
      [candidate('openai', 'gpt-5', { contextWindow: 400_000, toolCalling: true })],
      [{ providerId: 'openai', state: 'healthy' }],
    ),
  );

  assert.match(result.reason, /400,000 token context/);
  assert.match(result.reason, /supports tool calling/);
  // No adjectives about quality — nothing measures those.
  for (const claim of ['fidelity', 'deep', 'robust', 'verified failover', 'high reasoning']) {
    assert.ok(!result.reason.toLowerCase().includes(claim), `asserted "${claim}"`);
  }
});

test('a reason is never empty', () => {
  const bare: CandidateModel = { model: { providerId: 'x', modelId: 'y' } };
  const result = recommendSuccessor(INTERRUPTED, options([bare]));
  assert.ok(result.reason.trim().length > 0);
});

test('the larger declared context wins between equals', () => {
  const small = candidate('openai', 'small', { contextWindow: 8_000 });
  const large = candidate('openai', 'large', { contextWindow: 1_000_000 });
  const result = recommendSuccessor(INTERRUPTED, options([small, large]));
  assert.equal(result.model.modelId, 'large');
});
