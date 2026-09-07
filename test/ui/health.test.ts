/**
 * What the Models view says about health.
 *
 * `summarizeHealth` is pure, so every case is a literal input and an exact
 * string. The assertions that matter most are the *silences*: a model nobody
 * has used must not be described, and a rate must not be quoted from a single
 * observation. Those are the two ways a health display turns into a confident
 * lie.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatWait,
  healthIcon,
  summarizeHealth,
} from '../../src/ui/state/health.js';
import {
  DEFAULT_HEALTH_LIMITS,
  type EndpointHealth,
} from '../../src/policy/health.js';
import type { ModelRef } from '../../src/core/types.js';

const MODEL: ModelRef = { providerId: 'anthropic', modelId: 'sonnet' };
const NOW = 100_000;

function endpoint(overrides: Partial<EndpointHealth> = {}): EndpointHealth {
  return {
    key: { model: MODEL, credentialId: 'k1' },
    successRate: null,
    latencyMs: null,
    estimatedTailMs: null,
    consecutiveFailures: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    lastOutcomeAt: null,
    lastErrorClass: null,
    breaker: { kind: 'closed' },
    ...overrides,
  };
}

const healthy = (over: Partial<EndpointHealth> = {}): EndpointHealth =>
  endpoint({
    successRate: 1,
    latencyMs: 800,
    totalSuccesses: 6,
    lastOutcomeAt: NOW - 500,
    ...over,
  });

const ejected = (openUntil: number, over: Partial<EndpointHealth> = {}): EndpointHealth =>
  endpoint({
    successRate: 0.1,
    totalFailures: 4,
    consecutiveFailures: 4,
    lastOutcomeAt: NOW - 100,
    lastErrorClass: 'NETWORK',
    breaker: { kind: 'open', openUntil, consecutiveTrips: 1 },
    ...over,
  });

// --- the silences ----------------------------------------------------------

test('a model nobody has used says nothing at all', () => {
  const summary = summarizeHealth([], NOW);

  assert.equal(summary.grade, 'unknown');
  assert.equal(summary.text, null, 'an unused model must not be labelled in the row');
  assert.equal(summary.ejectedCount, 0);
});

test('an endpoint with no outcomes is unknown, never healthy', () => {
  const summary = summarizeHealth([endpoint()], NOW);

  assert.equal(summary.grade, 'unknown');
  assert.equal(summary.text, null);
  assert.match(summary.detail ?? '', /nothing measured/i);
});

test('a single observation yields no success rate', () => {
  const summary = summarizeHealth(
    [healthy({ totalSuccesses: 1, successRate: 1 })],
    NOW,
  );

  assert.equal(summary.grade, 'healthy');
  assert.doesNotMatch(
    summary.detail ?? '',
    /%/,
    'one outcome is not an average, so no percentage may be quoted',
  );
  assert.match(summary.detail ?? '', /responds in 800ms/);
});

test('a rate is quoted once there are enough observations', () => {
  const summary = summarizeHealth(
    [healthy({ successRate: 0.82, totalSuccesses: 8, totalFailures: 2 })],
    NOW,
  );
  assert.match(summary.detail ?? '', /82% of recent requests succeeded/);
});

test('an endpoint that has never streamed reports no latency', () => {
  const summary = summarizeHealth(
    [healthy({ latencyMs: null, successRate: 0.9, totalSuccesses: 9, totalFailures: 1 })],
    NOW,
  );
  assert.doesNotMatch(summary.detail ?? '', /responds in/);
  assert.match(summary.detail ?? '', /90%/);
});

// --- combining several keys -----------------------------------------------

test('one healthy key keeps the model usable even when others are ejected', () => {
  const summary = summarizeHealth(
    [healthy(), ejected(NOW + 20_000), ejected(NOW + 5_000)],
    NOW,
  );

  assert.equal(
    summary.grade,
    'healthy',
    'a model with a working key is usable, whatever its other keys are doing',
  );
  assert.equal(summary.ejectedCount, 2);
  assert.equal(summary.text, '2 keys unavailable', 'but the damage must still be visible');
});

test('a single unavailable key is phrased in the singular', () => {
  const summary = summarizeHealth([healthy(), ejected(NOW + 9_000)], NOW);
  assert.equal(summary.text, '1 key unavailable');
});

test('every key ejected reports the soonest retry', () => {
  const summary = summarizeHealth(
    [ejected(NOW + 45_000), ejected(NOW + 12_000)],
    NOW,
  );

  assert.equal(summary.grade, 'ejected');
  assert.equal(summary.text, 'not responding · retry 12s');
  assert.equal(summary.retryInMs, 12_000);
  assert.match(summary.detail ?? '', /One probe request goes out/);
});

test('a degraded model is deprioritized, not refused', () => {
  const summary = summarizeHealth(
    [healthy({ successRate: 0.4, totalSuccesses: 4, totalFailures: 6 })],
    NOW,
  );

  assert.equal(summary.grade, 'degraded');
  assert.equal(summary.text, 'unreliable lately');
  assert.match(summary.detail ?? '', /still used when nothing better is available/i);
});

test('healthy keys alongside degraded ones say so', () => {
  const summary = summarizeHealth(
    [healthy(), healthy({ successRate: 0.3, totalSuccesses: 3, totalFailures: 7 })],
    NOW,
  );

  assert.equal(summary.grade, 'healthy');
  assert.equal(summary.degradedCount, 1);
  assert.equal(summary.text, '1 key unreliable');
});

test('an expired ejection is no longer treated as ejected', () => {
  const summary = summarizeHealth([ejected(NOW - 1)], NOW);

  assert.notEqual(
    summary.grade,
    'ejected',
    'a breaker whose window has passed must not keep the model hidden',
  );
  assert.equal(summary.ejectedCount, 0);
});

test('the summary honours the limits it is given', () => {
  const borderline = [healthy({ successRate: 0.75, totalSuccesses: 7, totalFailures: 3 })];

  assert.equal(summarizeHealth(borderline, NOW).grade, 'healthy');
  assert.equal(
    summarizeHealth(borderline, NOW, { ...DEFAULT_HEALTH_LIMITS, degradedBelow: 0.9 }).grade,
    'degraded',
    'a stricter threshold must actually change the verdict',
  );
});

// --- formatting ------------------------------------------------------------

test('durations read naturally at every scale', () => {
  assert.equal(formatWait(250), '250ms');
  assert.equal(formatWait(1_000), '1s');
  assert.equal(formatWait(1_400), '2s', 'rounded up: a wait that has not elapsed is never "now"');
  assert.equal(formatWait(59_000), '59s');
  assert.equal(formatWait(90_000), '2m');
  assert.equal(formatWait(0.4), '1ms', 'a sub-millisecond wait is not "0ms"');
});

test('every grade has an icon, and only unknown is colourless', () => {
  assert.equal(healthIcon('healthy').colour, 'testing.iconPassed');
  assert.equal(healthIcon('degraded').colour, 'notificationsWarningIcon.foreground');
  assert.equal(healthIcon('ejected').colour, 'notificationsErrorIcon.foreground');
  assert.equal(
    healthIcon('unknown').colour,
    null,
    'no evidence must not be coloured as if it were a verdict',
  );
  for (const g of ['healthy', 'unknown', 'degraded', 'ejected'] as const) {
    assert.ok(healthIcon(g).icon.length > 0);
  }
});
