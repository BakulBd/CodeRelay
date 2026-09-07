/**
 * Endpoint health and the circuit breaker.
 *
 * The clock is injected, so every timing assertion below is exact rather than
 * approximate. The cases are written as the questions a user would ask when a
 * provider they can reach is not being used — "why is it skipping my key?",
 * "when will it try again?" — because a breaker whose decisions cannot be
 * explained is one that will be turned off.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HEALTH_LIMITS,
  HealthTracker,
  endpointId,
  grade,
  isHealthEvidence,
  openDurationMs,
  type EndpointKey,
  type HealthLimits,
} from '../../src/policy/health.js';
import type { ErrorClass, ModelRef } from '../../src/core/types.js';

const model = (providerId: string, modelId = 'm1'): ModelRef => ({ providerId, modelId });
const key = (providerId: string, credentialId = 'k1'): EndpointKey => ({
  model: model(providerId),
  credentialId,
});

/** A clock the test drives by hand. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test('an endpoint nobody has used reports unknown, not healthy', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const health = tracker.get(key('anthropic'));

  assert.equal(health.successRate, null);
  assert.equal(health.latencyMs, null);
  assert.equal(health.totalSuccesses, 0);
  assert.equal(
    grade(health, c.now()),
    'unknown',
    'no evidence must not be presented as a clean record',
  );
});

test('endpointId separates fields so two different endpoints cannot collide', () => {
  const a = endpointId({ model: { providerId: 'a b', modelId: 'c' }, credentialId: 'd' });
  const b = endpointId({ model: { providerId: 'a', modelId: 'b c' }, credentialId: 'd' });
  assert.notEqual(a, b);
});

// --- the breaker -----------------------------------------------------------

test('the breaker trips only after the configured number of consecutive failures', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const k = key('openai');

  tracker.record(k, { ok: false, errorClass: 'RETRYABLE' });
  tracker.record(k, { ok: false, errorClass: 'RETRYABLE' });
  assert.equal(tracker.admit(k).ok, true, 'two failures is not yet an outage');

  const tripped = tracker.record(k, { ok: false, errorClass: 'RETRYABLE' });
  assert.equal(tripped.breaker.kind, 'open');
  assert.equal(tracker.admit(k).ok, false);
});

test('one success in a failing streak resets the count, so a flaky endpoint is not ejected', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const k = key('openai');

  tracker.record(k, { ok: false, errorClass: 'RETRYABLE' });
  tracker.record(k, { ok: false, errorClass: 'RETRYABLE' });
  tracker.record(k, { ok: true, latencyMs: 400 });
  tracker.record(k, { ok: false, errorClass: 'RETRYABLE' });
  tracker.record(k, { ok: false, errorClass: 'RETRYABLE' });

  assert.equal(tracker.admit(k).ok, true);
  assert.equal(tracker.get(k).consecutiveFailures, 2);
});

test('an open breaker refuses traffic and reports how long is left', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const k = key('openai');
  for (let i = 0; i < 3; i += 1) {
    tracker.record(k, { ok: false, errorClass: 'NETWORK' });
  }

  c.advance(5_000);
  const admission = tracker.admit(k);
  assert.equal(admission.ok, false);
  assert.ok(!admission.ok);
  assert.equal(admission.reason, 'breaker-open');
  assert.equal(admission.retryAfterMs, DEFAULT_HEALTH_LIMITS.openMs - 5_000);
});

test('exactly one probe is admitted when the timeout expires', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const k = key('openai');
  for (let i = 0; i < 3; i += 1) {
    tracker.record(k, { ok: false, errorClass: 'NETWORK' });
  }
  c.advance(DEFAULT_HEALTH_LIMITS.openMs);

  const first = tracker.admit(k);
  assert.equal(first.ok, true);
  assert.ok(first.ok);
  assert.equal(first.probe, true, 'the first request through is the probe');

  const second = tracker.admit(k);
  assert.equal(second.ok, false, 'a second concurrent caller must not also be told yes');
  assert.ok(!second.ok);
  assert.equal(second.reason, 'probe-in-flight');
});

test('a successful probe closes the breaker and resets the trip count', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const k = key('openai');
  for (let i = 0; i < 3; i += 1) {
    tracker.record(k, { ok: false, errorClass: 'NETWORK' });
  }
  c.advance(DEFAULT_HEALTH_LIMITS.openMs);
  tracker.admit(k);

  const recovered = tracker.record(k, { ok: true, latencyMs: 250 });
  assert.equal(recovered.breaker.kind, 'closed');
  assert.equal(tracker.admit(k).ok, true);

  // The next outage must start at the short timeout again, not the doubled one.
  for (let i = 0; i < 3; i += 1) {
    tracker.record(k, { ok: false, errorClass: 'NETWORK' });
  }
  const reopened = tracker.get(k).breaker;
  assert.ok(reopened.kind === 'open');
  assert.equal(reopened.openUntil - c.now(), DEFAULT_HEALTH_LIMITS.openMs);
});

test('a failed probe re-opens immediately and waits longer next time', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const k = key('openai');
  for (let i = 0; i < 3; i += 1) {
    tracker.record(k, { ok: false, errorClass: 'NETWORK' });
  }
  c.advance(DEFAULT_HEALTH_LIMITS.openMs);
  tracker.admit(k);

  const again = tracker.record(k, { ok: false, errorClass: 'NETWORK' });
  assert.ok(again.breaker.kind === 'open');
  assert.equal(
    again.breaker.openUntil - c.now(),
    DEFAULT_HEALTH_LIMITS.openMs * 2,
    'a second trip must back off further, or a bad hour becomes a retry storm',
  );
});

test('the open period doubles but is capped', () => {
  const limits: HealthLimits = { ...DEFAULT_HEALTH_LIMITS, openMs: 1_000, maxOpenMs: 4_000 };
  assert.equal(openDurationMs(1, limits), 1_000);
  assert.equal(openDurationMs(2, limits), 2_000);
  assert.equal(openDurationMs(3, limits), 4_000);
  assert.equal(openDurationMs(9, limits), 4_000, 'capped');
  assert.equal(openDurationMs(9_999, limits), 4_000, 'no overflow at absurd trip counts');
});

// --- what counts as evidence ----------------------------------------------

test('a rejected key never trips the breaker', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const k = key('anthropic');

  for (let i = 0; i < 6; i += 1) {
    tracker.record(k, { ok: false, errorClass: 'AUTH' });
  }

  assert.equal(
    tracker.admit(k).ok,
    true,
    'a bad key is handled by rotation; ejecting the endpoint would hide the real problem',
  );
  assert.equal(tracker.get(k).successRate, null, 'and it is not evidence about latency either');
  assert.equal(tracker.get(k).lastErrorClass, 'AUTH', 'but it is still worth displaying');
});

test('only endpoint-level failures are treated as health evidence', () => {
  const endpointLevel: ErrorClass[] = ['RETRYABLE', 'NETWORK', 'STREAM', 'UNKNOWN'];
  const requestLevel: ErrorClass[] = ['AUTH', 'FORBIDDEN', 'CONFIG', 'CONTEXT', 'TLS_UNTRUSTED'];

  for (const errorClass of endpointLevel) {
    assert.equal(isHealthEvidence(errorClass), true, errorClass);
  }
  for (const errorClass of requestLevel) {
    assert.equal(isHealthEvidence(errorClass), false, errorClass);
  }
});

// --- latency ---------------------------------------------------------------

test('latency and the tail estimate build from observations only', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const k = key('anthropic');

  const first = tracker.record(k, { ok: true, latencyMs: 500 });
  assert.equal(first.latencyMs, 500, 'the first sample is the estimate');
  assert.equal(
    first.estimatedTailMs,
    500,
    'one sample gives no spread, so the tail cannot exceed the mean yet',
  );

  tracker.record(k, { ok: true, latencyMs: 2_500 });
  const health = tracker.get(k);
  assert.ok(health.latencyMs !== null && health.latencyMs > 500);
  assert.ok(
    health.estimatedTailMs !== null && health.estimatedTailMs > health.latencyMs,
    'a spread in the samples must push the tail above the mean',
  );
});

test('a failure decays the success rate without erasing the latency history', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const k = key('anthropic');
  tracker.record(k, { ok: true, latencyMs: 600 });
  const before = tracker.get(k).latencyMs;

  tracker.record(k, { ok: false, errorClass: 'RETRYABLE' });
  const after = tracker.get(k);

  assert.equal(after.latencyMs, before, 'a failure has no latency to report');
  assert.ok(after.successRate !== null && after.successRate < 1);
});

// --- grading and staleness -------------------------------------------------

test('grade separates ejected, degraded, healthy and unknown', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });

  const healthy = key('a');
  tracker.record(healthy, { ok: true, latencyMs: 100 });
  assert.equal(grade(tracker.get(healthy), c.now()), 'healthy');

  const degraded = key('b');
  tracker.record(degraded, { ok: true, latencyMs: 100 });
  tracker.record(degraded, { ok: false, errorClass: 'RETRYABLE' });
  tracker.record(degraded, { ok: false, errorClass: 'RETRYABLE' });
  assert.equal(grade(tracker.get(degraded), c.now()), 'degraded');

  const ejected = key('c');
  for (let i = 0; i < 3; i += 1) {
    tracker.record(ejected, { ok: false, errorClass: 'NETWORK' });
  }
  assert.equal(grade(tracker.get(ejected), c.now()), 'ejected');

  assert.equal(grade(tracker.get(key('d')), c.now()), 'unknown');
});

test('observations older than the stale window are forgotten entirely', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const k = key('openai');
  for (let i = 0; i < 3; i += 1) {
    tracker.record(k, { ok: false, errorClass: 'NETWORK' });
  }

  c.advance(DEFAULT_HEALTH_LIMITS.staleAfterMs + 1);

  assert.equal(tracker.get(k).successRate, null, 'yesterday is not evidence about today');
  assert.equal(tracker.admit(k).ok, true);
  assert.equal(tracker.snapshot().length, 0);
});

test('releasing a probe slot does not record an outcome', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  const k = key('openai');
  for (let i = 0; i < 3; i += 1) {
    tracker.record(k, { ok: false, errorClass: 'NETWORK' });
  }
  c.advance(DEFAULT_HEALTH_LIMITS.openMs);
  tracker.admit(k);
  const failuresBefore = tracker.get(k).totalFailures;

  tracker.releaseProbeSlot(k);

  assert.equal(tracker.get(k).totalFailures, failuresBefore, 'an abort is not a failure');
  const readmitted = tracker.admit(k);
  assert.equal(readmitted.ok, true, 'and the slot must be usable again');
  assert.ok(readmitted.ok);
  assert.equal(readmitted.probe, true);
});

test('snapshot reports every live endpoint for the Models view', () => {
  const c = clock();
  const tracker = new HealthTracker({ now: c.now });
  tracker.record(key('a'), { ok: true, latencyMs: 100 });
  tracker.record(key('b'), { ok: false, errorClass: 'RETRYABLE' });

  assert.equal(tracker.snapshot().length, 2);
  tracker.reset();
  assert.equal(tracker.snapshot().length, 0);
});
