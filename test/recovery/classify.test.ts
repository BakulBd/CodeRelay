/**
 * Failure classification.
 *
 * The point of classifying rather than blanket-retrying is that the right
 * response differs sharply by cause: a bad certificate should be shown to the
 * user at once, a rejected key should rotate, an oversized request should be
 * shrunk, and only genuinely transient conditions should be retried. These tests
 * pin the distinctions that are easy to collapse by accident.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFailure } from '../../src/recovery/classify.js';

test('an untrusted certificate is surfaced immediately, not retried', async () => {
  const c = classifyFailure({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  assert.equal(c.errorClass, 'TLS_UNTRUSTED');
  assert.equal(c.requestRetryable, false);
  assert.match(c.reason, /proxy or CA/i);
});

test('an expired certificate is a trust failure, not a network blip', async () => {
  assert.equal(classifyFailure({ code: 'CERT_HAS_EXPIRED' }).errorClass, 'TLS_UNTRUSTED');
});

// The distinction Claude Code's error reference draws, and the reason TLS is not
// one bucket: a handshake timeout is transient, a bad chain never fixes itself.
test('a transient TLS handshake failure is still retried', async () => {
  const c = classifyFailure({ code: 'ERR_TLS_HANDSHAKE_TIMEOUT' });
  assert.equal(c.errorClass, 'NETWORK');
  assert.equal(c.requestRetryable, true);
});

test('a rejected credential rotates rather than retrying the same key', async () => {
  const c = classifyFailure({ status: 401 });
  assert.equal(c.errorClass, 'AUTH');
  assert.equal(c.rotateCredential, true);
});

test('a forbidden pairing keeps the credential instead of taking it out of rotation', async () => {
  // 403 is not 401. Providers return it for "this key is not enabled for this
  // model", region blocks and org policy — all of which leave the key working
  // everywhere else. Rotating on 403 would disable a healthy credential, and
  // retrying it would fail identically, so it is neither retryable nor a
  // rotation signal: the router moves the *model* instead.
  const c = classifyFailure({ status: 403 });
  assert.equal(c.errorClass, 'FORBIDDEN');
  assert.equal(c.rotateCredential, false);
  assert.equal(c.requestRetryable, false);
  assert.match(c.reason, /not\s+permitted/i);
});

test('a throttle is retried with a longer delay and spreads across keys', async () => {
  const c = classifyFailure({ status: 429 });
  assert.equal(c.errorClass, 'RETRYABLE');
  assert.equal(c.requestRetryable, true);
  assert.equal(c.rotateCredential, true);
  assert.ok((c.retryAfterMs ?? 0) >= 5_000, 'a throttle deserves more than the default backoff');
});

test('provider overload is retryable and named as overload', async () => {
  const c = classifyFailure({ status: 529 });
  assert.equal(c.errorClass, 'RETRYABLE');
  assert.match(c.reason, /overloaded/i);
});

test('ordinary server errors are retryable', async () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(classifyFailure({ status }).errorClass, 'RETRYABLE');
  }
});

test('an unlisted 5xx is still treated as retryable', async () => {
  const c = classifyFailure({ status: 599 });
  assert.equal(c.errorClass, 'RETRYABLE');
  assert.equal(c.requestRetryable, true);
});

// A captive portal answers every request with HTTP 200 and an HTML login page,
// which would otherwise blow up as a JSON parse error far from the cause.
test('HTML on a JSON endpoint is reported as interception', async () => {
  const c = classifyFailure({ status: 200, contentType: 'text/html; charset=utf-8' });
  assert.equal(c.errorClass, 'STREAM');
  assert.match(c.reason, /proxy or captive portal/i);
});

test('SSE and JSON content types are not mistaken for interception', async () => {
  for (const contentType of ['text/event-stream', 'application/json', 'application/vnd.api+json']) {
    const c = classifyFailure({ status: 200, contentType, streamEndedEarly: true });
    assert.match(c.reason, /Stream ended/i);
  }
});

test('an HTML error page on a 5xx is blamed on the provider, not on a proxy', async () => {
  const c = classifyFailure({ status: 503, contentType: 'text/html' });
  assert.equal(c.errorClass, 'RETRYABLE');
  assert.doesNotMatch(c.reason, /captive portal/i);
});

test('an oversized request is a context problem and is not retried unchanged', async () => {
  assert.equal(classifyFailure({ status: 413 }).errorClass, 'CONTEXT');

  const byMessage = classifyFailure({
    status: 400,
    message: 'prompt is too long: 250000 tokens > maximum context length',
  });
  assert.equal(byMessage.errorClass, 'CONTEXT');
  assert.equal(byMessage.requestRetryable, false);
});

test('an invalid request fails fast instead of burning quota', async () => {
  const c = classifyFailure({ status: 400, message: 'unknown model' });
  assert.equal(c.errorClass, 'CONFIG');
  assert.equal(c.requestRetryable, false);
});

test('a 404 is a configuration error, not something to retry', async () => {
  assert.equal(classifyFailure({ status: 404 }).errorClass, 'CONFIG');
});

test('transport-level codes are network failures', async () => {
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
    const c = classifyFailure({ code });
    assert.equal(c.errorClass, 'NETWORK', code);
    assert.equal(c.requestRetryable, true);
  }
});

test('a stream that dies after tokens arrived is distinguished from one that never started', async () => {
  const after = classifyFailure({ streamEndedEarly: true, hadStreamedTokens: true });
  const before = classifyFailure({ streamEndedEarly: true, hadStreamedTokens: false });

  assert.equal(after.errorClass, 'STREAM');
  assert.equal(before.errorClass, 'STREAM');
  // The messages differ because the recovery consequences differ: tokens having
  // arrived means a tool call may already be in flight.
  assert.notEqual(after.reason, before.reason);
});

test('an unrecognized failure is never retried automatically', async () => {
  const c = classifyFailure({ message: 'something strange happened' });
  assert.equal(c.errorClass, 'UNKNOWN');
  assert.equal(c.requestRetryable, false);
  assert.equal(c.retryAfterMs, null);
});

test('an empty context is unknown rather than assumed transient', async () => {
  assert.equal(classifyFailure({}).errorClass, 'UNKNOWN');
});

test('request retryability never implies the task is safe to replay', async () => {
  // Guards the core invariant: retry decisions belong to the transport layer and
  // say nothing about side effects. Only planRecovery may decide that.
  const c = classifyFailure({ streamEndedEarly: true, hadStreamedTokens: true });
  assert.equal(c.requestRetryable, true);
  assert.ok(!('replaySafe' in c), 'classification must not claim replay safety');
});
