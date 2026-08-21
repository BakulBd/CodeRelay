/**
 * HTTP streaming transport.
 *
 * `fetch` is injected, so every failure mode below is reproduced exactly rather
 * than approximated: a dead socket, a captive portal, an expired certificate, a
 * provider error inside a 200, a stream that stops one frame short of finishing.
 * These are the situations the extension exists to survive, and they cannot be
 * tested against a real endpoint on demand.
 *
 * The distinction this file cares most about: **the request outcome and the task
 * outcome are different things.** A socket can close politely, with a 200 and no
 * error at all, and still leave the turn unfinished.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalizedEvent } from '../../src/core/types.js';
import { ProviderStreamError, type StreamDecoder } from '../../src/providers/adapter.js';
import { OpenAiDecoder } from '../../src/providers/openai.js';
import {
  parseRetryAfter,
  streamTurn,
  type ByteBody,
  type FetchLike,
  type HttpRequestInitLike,
  type HttpResponseLike,
  type StreamOutcome,
} from '../../src/providers/transport.js';

const encoder = new TextEncoder();

interface FakeResponseSpec {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Wire text, optionally pre-split to model TCP segmentation. */
  readonly chunks?: readonly string[];
  /** Raw bytes, for testing multi-byte characters split across segments. */
  readonly byteChunks?: readonly Uint8Array[];
  readonly body?: ByteBody | null;
  readonly text?: string;
  /** Thrown partway through the body, modelling a mid-stream socket failure. */
  readonly throwAfter?: { readonly chunks: number; readonly error: unknown };
}

function headersOf(map: Readonly<Record<string, string>>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function fakeResponse(spec: FakeResponseSpec): HttpResponseLike {
  const status = spec.status ?? 200;
  const headers = headersOf(spec.headers ?? { 'content-type': 'text/event-stream' });

  let body: ByteBody | null;
  if (spec.body !== undefined) {
    body = spec.body;
  } else if (spec.byteChunks !== undefined) {
    body = generate(spec.byteChunks, spec.throwAfter);
  } else if (spec.chunks !== undefined) {
    body = generate(
      spec.chunks.map((c) => encoder.encode(c)),
      spec.throwAfter,
    );
  } else {
    body = null;
  }

  return {
    status,
    headers,
    body,
    async text() {
      if (spec.text === undefined) {
        throw new Error('this response has no readable body');
      }
      return spec.text;
    },
  };
}

async function* generate(
  chunks: readonly Uint8Array[],
  throwAfter?: { readonly chunks: number; readonly error: unknown },
): AsyncGenerator<Uint8Array> {
  let emitted = 0;
  for (const chunk of chunks) {
    if (throwAfter !== undefined && emitted === throwAfter.chunks) {
      throw throwAfter.error;
    }
    yield chunk;
    emitted += 1;
  }
  if (throwAfter !== undefined && emitted === throwAfter.chunks) {
    throw throwAfter.error;
  }
}

interface Ran {
  readonly outcome: StreamOutcome;
  readonly events: NormalizedEvent[];
  readonly init: HttpRequestInitLike | null;
  readonly url: string | null;
}

interface RunOptions {
  readonly decoder?: StreamDecoder;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly method?: string;
  readonly connectTimeoutMs?: number | null;
  readonly idleTimeoutMs?: number | null;
  /** Observes the init `fetch` actually received, including the chained signal. */
  readonly onInit?: (init: HttpRequestInitLike) => void;
}

/** The error a real `fetch` rejects with once its signal aborts. */
function abortError(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** Rejects as soon as `signal` aborts, mirroring real network primitives. */
function abortable<T>(value: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return value;
  }
  return Promise.race([
    value,
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    }),
  ]);
}

/**
 * A body that stops yielding when the signal aborts.
 *
 * The idle deadline aborts the controller; a real response stream then errors.
 * A fake generator that simply awaits for ever would keep the attempt pending
 * instead, so it is wrapped to fail the same way.
 */
async function* abortableBody(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  for (;;) {
    const next = await abortable(iterator.next(), signal);
    if (next.done === true) {
      return;
    }
    yield next.value;
  }
}

/** Runs one attempt against a stubbed transport and collects everything observable. */
async function run(
  responder: FakeResponseSpec | (() => Promise<HttpResponseLike>),
  options: RunOptions = {},
): Promise<Ran> {
  let seenUrl: string | null = null;
  let seenInit: HttpRequestInitLike | null = null;

  const fetchImpl: FetchLike = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    options.onInit?.(init);
    const produced =
      typeof responder === 'function'
        ? responder()
        : Promise.resolve(fakeResponse(responder));
    // A real fetch rejects with AbortError when its signal fires, and the stall
    // deadline relies on exactly that to end an attempt. A fake that ignores the
    // signal cannot stall — it hangs, and node:test reports the case as
    // *cancelled* rather than failed, so the timeout tests silently stop running.
    const response = await abortable(produced, init.signal);
    const body = response.body;
    if (body === null || !(Symbol.asyncIterator in body)) {
      return response;
    }
    return { ...response, body: abortableBody(body, init.signal) };
  };

  const events: NormalizedEvent[] = [];
  const outcome = await streamTurn(
    {
      fetchImpl,
      decoder: options.decoder ?? new OpenAiDecoder(),
      ...(options.now === undefined ? {} : { now: options.now }),
      // Disabled unless a test asks for them, so the existing cases keep
      // measuring what they were written to measure.
      connectTimeoutMs: options.connectTimeoutMs ?? null,
      idleTimeoutMs: options.idleTimeoutMs ?? null,
    },
    {
      url: 'https://api.example.test/v1/chat/completions',
      headers: options.headers ?? { authorization: 'Bearer sk-secret-value' },
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    (event) => events.push(event),
  );

  return { outcome, events, init: seenInit, url: seenUrl };
}

function text(events: readonly NormalizedEvent[]): string {
  return events
    .filter((e): e is Extract<NormalizedEvent, { t: 'text' }> => e.t === 'text')
    .map((e) => e.delta)
    .join('');
}

/** An OpenAI-shaped content chunk. */
function chunk(content: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  })}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

test('a complete stream succeeds and delivers events as they arrive', async () => {
  const { outcome, events } = await run({
    chunks: [chunk('Hello'), chunk(', world', 'stop'), DONE],
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.failure, null);
  assert.equal(outcome.httpStatus, 200);
  assert.equal(outcome.hadStreamedTokens, true);
  assert.equal(outcome.truncated, false);
  assert.equal(text(events), 'Hello, world');
  assert.equal(events.at(-1)?.t, 'done');
});

test('the request is sent as POST with the caller headers untouched', async () => {
  const { init, url } = await run(
    { chunks: [chunk('x', 'stop'), DONE] },
    { headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: '{"stream":true}' },
  );

  assert.equal(url, 'https://api.example.test/v1/chat/completions');
  assert.equal(init?.method, 'POST');
  assert.equal(init?.body, '{"stream":true}');
  assert.deepEqual(init?.headers, { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
});

test('SSE frames split across TCP segments are reassembled', async () => {
  // Framing must not depend on where the network happened to cut the bytes.
  const wire = chunk('one') + chunk('two', 'stop') + DONE;
  const { outcome, events } = await run({ chunks: wire.split('') });

  assert.equal(outcome.ok, true);
  assert.equal(text(events), 'onetwo');
});

test('a multi-byte character split across segments is not corrupted', async () => {
  // Decoding each segment independently would turn this into replacement
  // characters, and the model's output would be silently wrong.
  const wire = chunk('héllo 🌍', 'stop') + DONE;
  const bytes = encoder.encode(wire);
  const cut = wire.indexOf('h') + 2; // lands inside the two-byte 'é'

  const { outcome, events } = await run({
    byteChunks: [bytes.subarray(0, cut), bytes.subarray(cut)],
  });

  assert.equal(outcome.ok, true);
  assert.equal(text(events), 'héllo 🌍');
});

test('a ReadableStream-shaped body is read as well as an async iterable', async () => {
  const parts = [chunk('via reader', 'stop'), DONE].map((c) => encoder.encode(c));
  let index = 0;
  const body = {
    getReader: () => ({
      read: async () => {
        if (index < parts.length) {
          const value = parts[index];
          index += 1;
          return { done: false, value };
        }
        return { done: true, value: undefined };
      },
      releaseLock: () => undefined,
    }),
  };

  const { outcome, events } = await run({ body });

  assert.equal(outcome.ok, true);
  assert.equal(text(events), 'via reader');
});

test('a stream that ends without the terminal event is not ok, even at 200', async () => {
  // The headline case. Nothing failed at the HTTP level; the task is still
  // unfinished, and only the decoder knows it.
  const { outcome, events } = await run({ chunks: [chunk('half an ans')] });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.httpStatus, 200);
  assert.equal(outcome.hadStreamedTokens, true);
  assert.equal(outcome.failure?.errorClass, 'STREAM');
  assert.equal(outcome.failure?.requestRetryable, true);
  assert.match(outcome.failure?.reason ?? '', /after tokens were received/);
  assert.equal(text(events), 'half an ans');
});

test('a stream that ends before any content distinguishes itself in the reason', async () => {
  // Retrying is safe here in a way it is not once tokens exist, so the two are
  // never collapsed into one message.
  const { outcome } = await run({ chunks: [': keep-alive\n\n'] });

  assert.equal(outcome.hadStreamedTokens, false);
  assert.match(outcome.failure?.reason ?? '', /before any content arrived/);
});

test('bytes cut mid-frame are reported as truncated and the partial frame is dropped', async () => {
  const { outcome, events } = await run({
    chunks: [chunk('so far'), 'data: {"choices":[{"index":0,"delta":{"content":"lo'],
  });

  assert.equal(outcome.truncated, true);
  assert.equal(outcome.ok, false);
  assert.equal(text(events), 'so far');
});

test('a socket failure mid-stream is classified from its code', async () => {
  const error = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
  const { outcome, events } = await run({
    chunks: [chunk('partial')],
    throwAfter: { chunks: 1, error },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure?.errorClass, 'NETWORK');
  assert.equal(outcome.failure?.requestRetryable, true);
  assert.equal(outcome.hadStreamedTokens, true);
  assert.equal(text(events), 'partial');
});

test('a provider error inside a 200 stream surfaces the provider message', async () => {
  // The transport saw a successful response; only the decoder can raise this.
  const errorChunk = `data: ${JSON.stringify({
    error: { message: 'upstream is overloaded', type: 'server_error' },
  })}\n\n`;

  const { outcome } = await run({ chunks: [chunk('starting'), errorChunk] });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure?.errorClass, 'STREAM');
  assert.match(outcome.failure?.reason ?? '', /Provider reported a stream error/);
  assert.match(outcome.failure?.reason ?? '', /upstream is overloaded/);
});

test('a decoder that throws on the final flushed frame is still reported', async () => {
  // The last frame can arrive without a trailing blank line; it is dispatched on
  // flush, and a throw there must not escape as an unhandled rejection.
  const decoder: StreamDecoder = {
    decode() {
      throw new ProviderStreamError('malformed tail', null);
    },
    finish() {
      return { events: [], incomplete: true };
    },
  };

  const { outcome } = await run({ chunks: ['data: {"choices":[]}\n\n'] }, { decoder });

  assert.equal(outcome.ok, false);
  assert.match(outcome.failure?.reason ?? '', /malformed tail/);
});

test('a rejected credential asks for rotation instead of a blind retry', async () => {
  const { outcome } = await run({
    status: 401,
    headers: { 'content-type': 'application/json' },
    text: '{"error":{"message":"invalid api key"}}',
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.httpStatus, 401);
  assert.equal(outcome.failure?.errorClass, 'AUTH');
  assert.equal(outcome.failure?.rotateCredential, true);
});

test('the failure reason never contains the credential that was sent', async () => {
  const { outcome } = await run(
    { status: 403, headers: { 'content-type': 'application/json' }, text: 'forbidden' },
    { headers: { authorization: 'Bearer sk-super-secret' } },
  );

  assert.doesNotMatch(outcome.failure?.reason ?? '', /sk-super-secret/);
});

test('Retry-After from the provider overrides our default backoff', async () => {
  const { outcome } = await run({
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '30' },
    text: 'slow down',
  });

  assert.equal(outcome.failure?.errorClass, 'RETRYABLE');
  assert.equal(outcome.failure?.retryAfterMs, 30_000);
  assert.equal(outcome.failure?.rotateCredential, true); // spread load across keys
});

test('a Retry-After date is converted against the injected clock', async () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const { outcome } = await run(
    {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'retry-after': 'Thu, 01 Jan 2026 00:00:45 GMT',
      },
      text: 'unavailable',
    },
    { now: () => now },
  );

  assert.equal(outcome.failure?.retryAfterMs, 45_000);
});

test('an error body is read and can change the classification', async () => {
  // Proof the body actually reaches the classifier: a 400 is normally a config
  // error, but a context-limit message means the request must shrink instead.
  const { outcome } = await run({
    status: 400,
    headers: { 'content-type': 'application/json' },
    text: '{"error":{"message":"maximum context length is 200000 tokens"}}',
  });

  assert.equal(outcome.failure?.errorClass, 'CONTEXT');
  assert.equal(outcome.failure?.requestRetryable, false);
});

test('an unreadable error body does not mask the status', async () => {
  const { outcome } = await run({ status: 500, headers: { 'content-type': 'application/json' } });

  assert.equal(outcome.failure?.errorClass, 'RETRYABLE');
  assert.equal(outcome.httpStatus, 500);
});

test('a 200 that is not an event stream is treated as interception', async () => {
  // A captive portal or proxy login page answering for the provider.
  const { outcome } = await run({
    headers: { 'content-type': 'text/html; charset=utf-8' },
    chunks: ['<html>Sign in to continue</html>'],
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure?.errorClass, 'STREAM');
  assert.match(outcome.failure?.reason ?? '', /proxy or captive portal/i);
});

test('a 200 with no body at all is an early end, not a success', async () => {
  const { outcome } = await run({ body: null });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure?.errorClass, 'STREAM');
});

test('a missing content-type is tolerated rather than rejected', async () => {
  // Some local servers omit it. Rejecting on that alone would break them for no
  // safety benefit, since the SSE parser validates the framing anyway.
  const { outcome, events } = await run({ headers: {}, chunks: [chunk('local', 'stop'), DONE] });

  assert.equal(outcome.ok, true);
  assert.equal(text(events), 'local');
});

test('an expired certificate is surfaced immediately, not retried', async () => {
  const { outcome } = await run(async () => {
    throw Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.httpStatus, null);
  assert.equal(outcome.failure?.errorClass, 'TLS_UNTRUSTED');
  assert.equal(outcome.failure?.requestRetryable, false);
});

test('a code hidden on error.cause is still found', async () => {
  // Node wraps transport failures as `TypeError: fetch failed` and puts the real
  // code on `cause`. Reading only the top level would classify this as UNKNOWN.
  const { outcome } = await run(async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  });

  assert.equal(outcome.failure?.errorClass, 'NETWORK');
  assert.equal(outcome.failure?.requestRetryable, true);
});

test('an unrecognized transport failure is not retried automatically', async () => {
  const { outcome } = await run(async () => {
    throw new Error('something we have never seen');
  });

  assert.equal(outcome.failure?.errorClass, 'UNKNOWN');
  assert.equal(outcome.failure?.requestRetryable, false);
});

test('cancellation before the response is reported as cancelled, not failed', async () => {
  const controller = new AbortController();
  controller.abort();

  const { outcome } = await run(
    async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    },
    { signal: controller.signal },
  );

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.ok, false);
  // Retrying here would restart work the user explicitly stopped.
  assert.equal(outcome.failure?.requestRetryable, false);
  assert.match(outcome.failure?.reason ?? '', /cancelled/i);
});

test('cancellation mid-stream keeps the tokens already delivered', async () => {
  const controller = new AbortController();
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });

  const { outcome, events } = await run(
    {
      chunks: [chunk('work done so far')],
      throwAfter: { chunks: 1, error: abortError },
    },
    { signal: controller.signal },
  );

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.hadStreamedTokens, true);
  // The text arrived and was real; the ledger records what happened, not what we
  // wish had happened.
  assert.equal(text(events), 'work done so far');
});

test('usage and done alone do not count as streamed tokens', async () => {
  // `hadStreamedTokens` drives recovery decisions, so it has to mean "model
  // output reached the user", not "any event was seen".
  const { outcome } = await run({ chunks: [DONE] });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.hadStreamedTokens, false);
});

test('a tool call counts as streamed output', async () => {
  const toolChunk = `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  })}\n\n`;

  const { outcome, events } = await run({ chunks: [toolChunk, DONE] });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.hadStreamedTokens, true);
  assert.equal(events.filter((e) => e.t === 'tool_call').length, 1);
});

// --- stalls -----------------------------------------------------------------
// A provider that accepts a connection and then says nothing is the one failure
// no downstream retry policy can detect: without a deadline the task waits for
// ever, holding a turn open that will never finish. These cases use tiny limits
// and real timers, so they assert the wiring rather than a mocked clock.

test('a provider that never answers is a retryable stall, not a hang', async () => {
  const { outcome } = await run(
    () =>
      // Never resolves. Only the connect deadline can end this attempt.
      new Promise<HttpResponseLike>(() => {
        /* deliberately never settles */
      }),
    { connectTimeoutMs: 25 },
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.cancelled, false);
  // NETWORK, so `route()` spends a retry or moves model rather than giving up.
  assert.equal(outcome.failure?.errorClass, 'NETWORK');
  assert.equal(outcome.failure?.requestRetryable, true);
  assert.match(outcome.failure?.reason ?? '', /did not send a response/);
});

test('a stream that goes quiet mid-response is a retryable stall', async () => {
  async function* stalling(): AsyncGenerator<Uint8Array> {
    yield encoder.encode(chunk('thinking'));
    // Headers and one frame arrived, then the socket goes silent for ever.
    await new Promise(() => {
      /* deliberately never settles */
    });
  }

  const { outcome, events } = await run(
    { body: stalling() },
    { connectTimeoutMs: null, idleTimeoutMs: 25 },
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure?.errorClass, 'NETWORK');
  assert.match(outcome.failure?.reason ?? '', /stopped sending data/);
  // What did arrive is kept: recovery needs to know the turn produced output.
  assert.equal(outcome.hadStreamedTokens, true);
  assert.equal(text(events), 'thinking');
});

test('the idle limit restarts on every chunk, so a slow stream still finishes', async () => {
  async function* slow(): AsyncGenerator<Uint8Array> {
    for (const part of [chunk('a'), chunk('b'), chunk('c', 'stop'), DONE]) {
      // Each gap is under the limit; their sum is well over it. A deadline that
      // measured total duration rather than the gap would fail this stream.
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield encoder.encode(part);
    }
  }

  const { outcome, events } = await run({ body: slow() }, { idleTimeoutMs: 60 });

  assert.equal(outcome.ok, true);
  assert.equal(text(events), 'abc');
});

test('a keep-alive comment counts as activity', async () => {
  // Providers send `: ping` frames precisely to hold a quiet connection open.
  // Restarting the window only on decoded content would kill a healthy stream
  // that is legitimately still thinking.
  async function* pinging(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield encoder.encode(': ping\n\n');
    }
    yield encoder.encode(chunk('finally', 'stop'));
    yield encoder.encode(DONE);
  }

  const { outcome, events } = await run({ body: pinging() }, { idleTimeoutMs: 60 });

  assert.equal(outcome.ok, true);
  assert.equal(text(events), 'finally');
});

test('a user cancellation during a stall is cancelled, never a stall', async () => {
  // The distinction that matters most here. Both abort the same request, and
  // getting it wrong either retries work the user stopped, or abandons a task
  // over a transient fault.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  const { outcome } = await run(
    () =>
      new Promise<HttpResponseLike>(() => {
        /* never settles; the abort is what ends this */
      }),
    { signal: controller.signal, connectTimeoutMs: 5_000 },
  );

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.failure?.requestRetryable, false);
  assert.match(outcome.failure?.reason ?? '', /cancelled/i);
});

test('a signal aborted before the call is honoured, and fetch sees it', async () => {
  const controller = new AbortController();
  controller.abort();

  let sawAbortedSignal: boolean | null = null;
  const { outcome } = await run(
    { chunks: [chunk('x', 'stop'), DONE] },
    {
      signal: controller.signal,
      // The caller's signal is chained into the deadline's own controller, so an
      // already-aborted signal has to be forwarded rather than dropped —
      // otherwise the request would go out despite having been cancelled.
      onInit: (init) => {
        sawAbortedSignal = init.signal?.aborted ?? null;
      },
    },
  );

  assert.equal(sawAbortedSignal, true);
  assert.equal(outcome.cancelled, true);
});

test('timeouts are off when the caller passes null, for a local model', async () => {
  // A local runtime on slow hardware can legitimately exceed any default, and a
  // deadline the user cannot turn off would make CodeRelay unusable there.
  async function* slow(): AsyncGenerator<Uint8Array> {
    await new Promise((resolve) => setTimeout(resolve, 40));
    yield encoder.encode(chunk('eventually', 'stop'));
    yield encoder.encode(DONE);
  }

  const { outcome, events } = await run(
    { body: slow() },
    { connectTimeoutMs: null, idleTimeoutMs: null },
  );

  assert.equal(outcome.ok, true);
  assert.equal(text(events), 'eventually');
});

test('parseRetryAfter reads seconds, dates, and refuses nonsense', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('', now), null);
  assert.equal(parseRetryAfter('  ', now), null);
  assert.equal(parseRetryAfter('5', now), 5_000);
  assert.equal(parseRetryAfter(' 5 ', now), 5_000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now), 60_000);
  // A date in the past means "now", never a negative delay.
  assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now), 0);
  // Garbage yields null so the caller keeps its own backoff, rather than 0,
  // which would hammer a provider that just asked us to wait.
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter('-5', now), null);
});
