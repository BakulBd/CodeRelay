/**
 * What a connection test tells the user.
 *
 * `describeVerdict` is the whole reason the probe splits I/O from wording: the
 * sentences are the product here. A test that reports "failed" has told the user
 * nothing they did not already know — the useful part is *which* of the six
 * distinguishable failures it was, because each has a different fix and three of
 * them mean the configuration is actually fine.
 *
 * These assert the distinctions, not the prose. Rewording is expected; collapsing
 * two different causes into one message is the regression.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeVerdict, type ProbeVerdict } from '../../src/providers/probe.js';

const MODEL = { providerId: 'nvidia', modelId: 'meta/llama-3.3-70b-instruct' };

function failure(over: Partial<Extract<ProbeVerdict, { t: 'failed' }>>): ProbeVerdict {
  return {
    t: 'failed',
    errorClass: 'UNKNOWN',
    httpStatus: null,
    reason: 'something went wrong',
    retryAfterMs: null,
    elapsedMs: 120,
    ...over,
  };
}

test('a pass names the model, so a multi-provider setup is unambiguous', () => {
  const described = describeVerdict({ t: 'ok', elapsedMs: 412, sawOutput: true }, MODEL);
  assert.equal(described.ok, true);
  assert.ok(described.headline.includes('nvidia'));
  assert.ok(described.headline.includes('meta/llama-3.3-70b-instruct'));
  assert.ok(described.detail.includes('412'), 'the elapsed time is the latency answer');
});

test('a clean stream with no text is still a pass, and says why', () => {
  // Worth distinguishing: the endpoint and the key are both fine, so calling this
  // a failure would send the user to fix something that is not broken.
  const described = describeVerdict({ t: 'ok', elapsedMs: 90, sawOutput: false }, MODEL);
  assert.equal(described.ok, true);
  assert.ok(/credential are fine|without emitting/i.test(described.detail));
});

test('a rejected key and a forbidden model are never the same message', () => {
  const auth = describeVerdict(failure({ errorClass: 'AUTH', httpStatus: 401 }), MODEL);
  const forbidden = describeVerdict(failure({ errorClass: 'FORBIDDEN', httpStatus: 403 }), MODEL);

  assert.notEqual(auth.headline, forbidden.headline);
  // The distinction that matters: one needs a new key, the other does not.
  assert.ok(/key/i.test(auth.headline));
  assert.ok(/not allowed|permitted/i.test(forbidden.headline));
  assert.ok(
    /nothing is wrong with the key/i.test(forbidden.detail),
    'a 403 must not send the user off to replace a working key',
  );
});

test('a 400 points at the output-token field, which is the usual cause', () => {
  const described = describeVerdict(failure({ errorClass: 'CONFIG', httpStatus: 400 }), MODEL);
  assert.equal(described.ok, false);
  // This is the field the whole codebase warns about: wrong, it 400s every
  // attempt, and failover cannot route around a malformed request.
  assert.ok(described.detail.includes('max_completion_tokens'));
  assert.ok(described.detail.includes('max_tokens'));
});

test('offline and rate-limited are distinguished, and a rate limit states the wait', () => {
  const offline = describeVerdict(failure({ errorClass: 'NETWORK' }), MODEL);
  const limited = describeVerdict(
    failure({ errorClass: 'RETRYABLE', httpStatus: 429, retryAfterMs: 30_000 }),
    MODEL,
  );

  assert.notEqual(offline.headline, limited.headline);
  assert.ok(/could not reach/i.test(offline.headline));
  assert.ok(/rate limited/i.test(limited.headline));
  assert.ok(limited.detail.includes('30 seconds'), 'the provider told us how long to wait');
});

test('a rate limit says the configuration is correct, because it is', () => {
  const limited = describeVerdict(failure({ errorClass: 'RETRYABLE', httpStatus: 429 }), MODEL);
  assert.ok(/configured correctly|transient/i.test(limited.detail));
});

test('a TLS failure names the proxy, which is nearly always the cause', () => {
  const described = describeVerdict(failure({ errorClass: 'TLS_UNTRUSTED' }), MODEL);
  assert.ok(/certificate/i.test(described.headline));
  assert.ok(/proxy/i.test(described.detail));
});

test('an HTTP status is reported when there was one, and not invented when there was not', () => {
  const withStatus = describeVerdict(failure({ errorClass: 'AUTH', httpStatus: 401 }), MODEL);
  assert.ok(withStatus.detail.includes('HTTP 401'));

  const withoutStatus = describeVerdict(failure({ errorClass: 'NETWORK' }), MODEL);
  assert.ok(!withoutStatus.detail.includes('HTTP'), 'no status means none is claimed');
});

test('nothing-sent is not reported as a failed request', () => {
  // The distinction: the endpoint was never asked, so it has not been judged.
  const described = describeVerdict(
    { t: 'unconfigured', reason: 'No credential is configured for nvidia.' },
    MODEL,
  );
  assert.equal(described.ok, false);
  assert.ok(/nothing was sent/i.test(described.headline));
  assert.ok(described.detail.includes('No credential is configured'));
});

test('a cancellation says nothing about the endpoint', () => {
  const described = describeVerdict({ t: 'cancelled' }, MODEL);
  assert.equal(described.ok, false);
  assert.ok(/cancelled/i.test(described.headline));
  assert.equal(described.detail, '', 'no verdict was reached, so none is offered');
});

test('every failure class produces a headline that is not the word "Error"', () => {
  const classes = [
    'RETRYABLE',
    'NETWORK',
    'TLS_UNTRUSTED',
    'AUTH',
    'FORBIDDEN',
    'CONFIG',
    'CONTEXT',
    'STREAM',
    'UNKNOWN',
  ] as const;
  for (const errorClass of classes) {
    const described = describeVerdict(failure({ errorClass }), MODEL);
    assert.notEqual(described.headline.trim(), 'Error');
    assert.notEqual(described.headline.trim(), '');
    assert.notEqual(described.detail.trim(), '', `${errorClass} offered no next step`);
    // The class name itself is an implementation detail, not an explanation.
    assert.ok(
      !described.headline.includes(errorClass),
      `${errorClass} leaked its class name into the headline`,
    );
  }
});

test('the reason from the classifier is carried through rather than replaced', () => {
  // The classifier often names the specific model or limit, which is the most
  // useful sentence available. Discarding it in favour of generic advice would
  // lose that.
  const described = describeVerdict(
    failure({ errorClass: 'CONFIG', reason: 'model "gpt-9" does not exist' }),
    MODEL,
  );
  assert.ok(described.detail.includes('model "gpt-9" does not exist'));
});
