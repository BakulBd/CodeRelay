/**
 * HTTP streaming transport.
 *
 * This is the layer that turns bytes on a socket into `NormalizedEvent`s and,
 * when something goes wrong, into a `Classification` the recovery policy can act
 * on. It deliberately knows nothing about any particular provider: the caller
 * supplies the URL, headers, body and a decoder, so the same transport serves
 * Anthropic, every OpenAI-compatible endpoint, and a local server.
 *
 * Three decisions worth stating outright, because each of them is the difference
 * between a recoverable task and a corrupted one:
 *
 *  - **A cancelled request is not a failed request.** If the caller aborts, the
 *    outcome says `cancelled`, not "retryable network error". Treating a user's
 *    cancellation as a transient fault would resume work they asked to stop.
 *  - **"Stream ended" and "turn finished" are separate facts.** The transport
 *    asks the decoder whether the turn actually completed; a socket that closed
 *    politely after half a response is still an incomplete turn.
 *  - **Nothing is retried here.** This function performs exactly one attempt and
 *    reports what happened. Retry, failover and credential rotation are policy
 *    decisions that need the ledger, and the ledger is not this layer's business.
 *
 * `fetch` is injected rather than imported so the failure paths can be tested
 * without a network, which is the only way to test them deterministically.
 */
import type { NormalizedEvent } from '../core/types.js';
import { classifyFailure, type RequestClassification } from '../recovery/classify.js';
import { ProviderStreamError, type StreamDecoder } from './adapter.js';
import { SseParser } from './sse.js';


/** A response body, in either of the two shapes Node hands us. */
export interface ByteReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  releaseLock?(): void;
}

export interface ByteStreamLike {
  getReader(): ByteReaderLike;
}

export type ByteBody = AsyncIterable<Uint8Array> | ByteStreamLike;

/** The subset of `Response` this transport uses. */
export interface HttpResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ByteBody | null;
  text(): Promise<string>;
}

export interface HttpRequestInitLike {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type FetchLike = (url: string, init: HttpRequestInitLike) => Promise<HttpResponseLike>;

export interface StreamRequest {
  readonly url: string;
  readonly method?: string;
  /**
   * Sent verbatim. Credentials live here, so nothing in this module logs,
   * echoes or stores headers — not in an outcome, not in a reason string.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface TransportDeps {
  readonly fetchImpl: FetchLike;
  /** One decoder per attempt: decoders are stateful and must not be reused. */
  readonly decoder: StreamDecoder;
  /** Injected for deterministic `Retry-After` date arithmetic in tests. */
  readonly now?: () => number;
  readonly maxErrorBodyChars?: number;
  /**
   * Longest wait for response headers, in ms. `null` disables the limit.
   *
   * Separate from the idle limit because the two describe different failures: a
   * provider that never answers at all, versus one that answered and then went
   * quiet. Both are stalls, and without them a task waits forever on a socket
   * that no longer carries anything — the one failure mode no amount of
   * downstream retry policy can detect.
   */
  readonly connectTimeoutMs?: number | null;
  /**
   * Longest gap between two body chunks, in ms. `null` disables the limit.
   *
   * Generous by default: a reasoning model can legitimately think for a long
   * time after headers arrive but before the first token, and killing that would
   * turn a working request into a failure.
   */
  readonly idleTimeoutMs?: number | null;
}

export interface StreamOutcome {
  /** True only when the decoder confirmed the turn finished. */
  readonly ok: boolean;
  /** The caller aborted. Not a failure, and never something to retry. */
  readonly cancelled: boolean;
  /** Whether any model output reached the sink before the stream ended. */
  readonly hadStreamedTokens: boolean;
  /** The SSE framing was cut mid-event, so the final frame was discarded. */
  readonly truncated: boolean;
  readonly httpStatus: number | null;
  /**
   * Null exactly when `ok` is true.
   *
   * Typed as a *request* classification because that is all this layer can
   * observe: transport and HTTP evidence, never the outcome of an effect. The
   * routing policy relies on that narrowing to stay exhaustive.
   */
  readonly failure: RequestClassification | null;
}

export type EventSink = (event: NormalizedEvent) => void;

const DEFAULT_ERROR_BODY_CHARS = 500;
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/** Which limit elapsed. Null means neither did. */
type StallPhase = 'connect' | 'idle';

/**
 * Bounds how long one attempt may wait, without conflating a stall with a
 * cancellation.
 *
 * The distinction is the whole reason this is a class rather than an
 * `AbortSignal.timeout()` call. Both a user cancelling and a deadline elapsing
 * abort the same request, and the transport must tell them apart afterwards: a
 * cancelled attempt is terminal and must never be retried, while a stalled one
 * is a transient fault that should be. So the deadline owns its own controller,
 * records *why* it aborted, and the caller's signal is chained into it rather
 * than replaced.
 */
class AttemptDeadline {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private phase: StallPhase | null = null;
  private readonly controller = new AbortController();
  private readonly forward = (): void => this.controller.abort();
  /** Created once and reused: it can only reject once, and races must not leak listeners. */
  private abortPromise: Promise<never> | null = null;

  constructor(private readonly external: AbortSignal | undefined) {
    if (external === undefined) {
      return;
    }
    if (external.aborted) {
      this.controller.abort();
      return;
    }
    external.addEventListener('abort', this.forward, { once: true });
  }

  /** Passed to `fetch`, so a deadline actually reaches the socket. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The limit that elapsed, or null when the abort came from elsewhere. */
  get expired(): StallPhase | null {
    return this.phase;
  }

  /**
   * Rejects as soon as this attempt is aborted, by a deadline or by the caller.
   *
   * Raced against the network so a deadline does not depend on the `fetch`
   * implementation honouring `signal`. Node's does, but `FetchLike` is an
   * injection point — a corporate proxy shim, a gateway wrapper or a test double
   * may ignore it, and a limit that only works when the transport cooperates is
   * not a limit. Reused rather than recreated so racing it once per chunk cannot
   * accumulate listeners on a long stream.
   */
  aborted(): Promise<never> {
    if (this.abortPromise === null) {
      this.abortPromise = new Promise<never>((_resolve, reject) => {
        const fail = (): void =>
          reject(Object.assign(new Error('The attempt was aborted'), { name: 'AbortError' }));
        if (this.controller.signal.aborted) {
          fail();
          return;
        }
        this.controller.signal.addEventListener('abort', fail, { once: true });
      });
    }
    return this.abortPromise;
  }

  arm(phase: StallPhase, ms: number | null): void {
    this.clear();
    if (ms === null || ms <= 0) {
      return;
    }
    // Deliberately *not* unref'd. This timer is the only thing that guarantees a
    // stalled attempt ever terminates, and an unref'd timer is skipped whenever
    // nothing else is holding the loop open — which is exactly the situation a
    // provider that accepts a connection and then goes silent can produce. It is
    // cleared by `clear`/`dispose` on every exit path, so it holds the loop for
    // at most one limit while a request is genuinely in flight.
    this.timer = setTimeout(() => {
      this.phase = phase;
      this.controller.abort();
    }, ms);
  }

  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.clear();
    this.external?.removeEventListener('abort', this.forward);
  }
}

/**
 * A stall, classified as the transient fault it is.
 *
 * `NETWORK` rather than `UNKNOWN`: nothing about the request was rejected, so a
 * retry — on this model or another — is the right next move, and `route()`
 * already knows how to spend a budget on one.
 */
function stalled(
  phase: StallPhase,
  ms: number,
  httpStatus: number | null,
  state: MutableState,
): StreamOutcome {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  return failed(httpStatus, state, {
    errorClass: 'NETWORK',
    requestRetryable: true,
    retryAfterMs: null,
    rotateCredential: false,
    reason:
      phase === 'connect'
        ? `The provider did not send a response within ${seconds}s.`
        : `The stream stopped sending data for ${seconds}s before it completed.`,
  });
}

/**
 * Performs one streaming attempt.
 *
 * Every event the decoder produces is handed to `sink` as it arrives, so the UI
 * and the ledger see output at the same time the socket does. If the attempt
 * fails, events already delivered are *not* retracted: they happened, and the
 * ledger's job is to record that they happened rather than pretend otherwise.
 */
export async function streamTurn(
  deps: TransportDeps,
  request: StreamRequest,
  sink: EventSink,
): Promise<StreamOutcome> {
  const connectMs =
    deps.connectTimeoutMs === undefined ? DEFAULT_CONNECT_TIMEOUT_MS : deps.connectTimeoutMs;
  const idleMs =
    deps.idleTimeoutMs === undefined ? DEFAULT_IDLE_TIMEOUT_MS : deps.idleTimeoutMs;

  // Owns the signal handed to `fetch`, so a stall reaches the socket rather than
  // being noticed after the fact. Always disposed, so a finished attempt leaves
  // no timer behind to keep the host's event loop alive.
  const deadline = new AttemptDeadline(request.signal);
  try {
    return await runAttempt(deps, request, sink, deadline, connectMs, idleMs);
  } finally {
    deadline.dispose();
  }
}

/**
 * The attempt itself, with the deadline supplied rather than created.
 *
 * Split from `streamTurn` only so the disposal above cannot be forgotten on any
 * of the many early returns below.
 */
async function runAttempt(
  deps: TransportDeps,
  request: StreamRequest,
  sink: EventSink,
  deadline: AttemptDeadline,
  connectMs: number | null,
  idleMs: number | null,
): Promise<StreamOutcome> {
  const now = deps.now ?? Date.now;
  const state = { hadStreamedTokens: false, truncated: false };

  let response: HttpResponseLike;
  deadline.arm('connect', connectMs);
  try {
    response = await Promise.race([
      deps.fetchImpl(request.url, {
        method: request.method ?? 'POST',
        headers: request.headers,
        body: request.body,
        signal: deadline.signal,
      }),
      deadline.aborted(),
    ]);
  } catch (error: unknown) {
    // Order matters: a stall aborts the same way a cancellation does, and only
    // the deadline knows which one happened. Asking it first is what keeps a
    // timed-out attempt retryable and a user's cancellation terminal.
    const expired = deadline.expired;
    if (expired !== null) {
      return stalled(expired, connectMs ?? 0, null, state);
    }
    if (isAbort(error, request.signal)) {
      return cancelled(null, state);
    }
    // No response at all: only transport-level evidence is available.
    return failed(
      null,
      state,
      classifyFailure({ code: errorCode(error), message: errorMessage(error) }),
    );
  }

  const status = response.status;
  const contentType = response.headers.get('content-type');
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());

  if (status < 200 || status >= 300) {
    const body = await readErrorBody(response, deps.maxErrorBodyChars ?? DEFAULT_ERROR_BODY_CHARS);
    const classification = classifyFailure({
      status,
      message: body,
      ...(contentType === null ? {} : { contentType }),
    });
    // A provider that told us when to come back knows better than our default.
    return failed(
      status,
      state,
      retryAfterMs === null ? classification : { ...classification, retryAfterMs },
    );
  }

  // A 2xx that is not an event stream means something answered instead of the
  // provider — a proxy login page, a gateway notice, a captive portal.
  if (contentType !== null && !isEventStream(contentType)) {
    const classification = classifyFailure({ status, contentType });
    return failed(status, state, classification);
  }

  if (response.body === null) {
    return failed(
      status,
      state,
      classifyFailure({ status, streamEndedEarly: true, hadStreamedTokens: false }),
    );
  }

  const parser = new SseParser();
  const utf8 = new TextDecoder('utf-8');

  // Headers arrived, so the connect limit no longer applies. From here the
  // question is whether the body keeps moving.
  deadline.arm('idle', idleMs);

  try {
    // Raced against the deadline for the same reason as the request above: the
    // body is an injected shape too, and an async iterable that simply never
    // yields again would otherwise park this loop for ever.
    for await (const chunk of raceIterable(iterateBytes(response.body), deadline)) {
      // Any byte — including an SSE comment used as a keep-alive — proves the
      // connection is still live, so the idle window restarts on the chunk
      // rather than on decoded content.
      deadline.arm('idle', idleMs);
      // `stream: true` keeps a multi-byte character split across two TCP
      // segments from being decoded as replacement characters.
      const text = utf8.decode(chunk, { stream: true });
      if (text === '') {
        continue;
      }
      for (const event of parser.push(text)) {
        for (const normalized of deps.decoder.decode(event)) {
          if (isContent(normalized)) {
            state.hadStreamedTokens = true;
          }
          sink(normalized);
        }
      }
    }
  } catch (error: unknown) {
    const expired = deadline.expired;
    if (expired !== null) {
      // Tokens may already have reached the sink; `state` carries that, so
      // recovery still knows the turn produced something.
      state.truncated = parser.end().truncated;
      return stalled(expired, idleMs ?? 0, status, state);
    }
    if (isAbort(error, request.signal)) {
      return cancelled(status, state);
    }
    state.truncated = parser.end().truncated;
    if (error instanceof ProviderStreamError) {
      // An error reported inside a 200 stream. The HTTP layer saw success, so
      // only the decoder could have caught this.
      const classification = classifyFailure({
        streamEndedEarly: true,
        hadStreamedTokens: state.hadStreamedTokens,
      });
      return failed(status, state, {
        ...classification,
        reason: `Provider reported a stream error: ${sanitize(error.message, DEFAULT_ERROR_BODY_CHARS)}`,
      });
    }
    return failed(
      status,
      state,
      classifyFailure({
        code: errorCode(error),
        message: errorMessage(error),
        streamEndedEarly: true,
        hadStreamedTokens: state.hadStreamedTokens,
      }),
    );
  }

  // Flush the last multi-byte sequence, then let the parser report whether the
  // bytes stopped mid-frame.
  const tail = utf8.decode();
  const trailing = tail === '' ? [] : parser.push(tail);
  for (const event of trailing) {
    try {
      for (const normalized of deps.decoder.decode(event)) {
        if (isContent(normalized)) {
          state.hadStreamedTokens = true;
        }
        sink(normalized);
      }
    } catch (error: unknown) {
      state.truncated = parser.end().truncated;
      const classification = classifyFailure({
        streamEndedEarly: true,
        hadStreamedTokens: state.hadStreamedTokens,
      });
      return failed(status, state, {
        ...classification,
        reason:
          error instanceof ProviderStreamError
            ? `Provider reported a stream error: ${sanitize(error.message, DEFAULT_ERROR_BODY_CHARS)}`
            : classification.reason,
      });
    }
  }

  // The body is complete, so no further wait is expected of it.
  deadline.clear();
  state.truncated = parser.end().truncated;

  const finished = deps.decoder.finish();
  for (const normalized of finished.events) {
    sink(normalized);
  }

  if (finished.incomplete) {
    // The socket closed without the provider's terminal event. This is the case
    // the whole ledger exists for: tokens may have arrived and a tool call may
    // have been in flight, so a retryable *request* is not a replayable *task*.
    return failed(
      status,
      state,
      classifyFailure({
        status,
        streamEndedEarly: true,
        hadStreamedTokens: state.hadStreamedTokens,
      }),
    );
  }

  return {
    ok: true,
    cancelled: false,
    hadStreamedTokens: state.hadStreamedTokens,
    truncated: state.truncated,
    httpStatus: status,
    failure: null,
  };
}

interface MutableState {
  hadStreamedTokens: boolean;
  truncated: boolean;
}

function failed(
  httpStatus: number | null,
  state: MutableState,
  failure: RequestClassification,
): StreamOutcome {
  return {
    ok: false,
    cancelled: false,
    hadStreamedTokens: state.hadStreamedTokens,
    truncated: state.truncated,
    httpStatus,
    failure,
  };
}

function cancelled(httpStatus: number | null, state: MutableState): StreamOutcome {
  return {
    ok: false,
    cancelled: true,
    hadStreamedTokens: state.hadStreamedTokens,
    truncated: state.truncated,
    httpStatus,
    failure: {
      errorClass: 'UNKNOWN',
      // Emphatically not retryable: the user asked for this to stop.
      requestRetryable: false,
      retryAfterMs: null,
      rotateCredential: false,
      reason: 'Request was cancelled.',
    },
  };
}

/** Text, thinking and tool calls are model output; usage and done are bookkeeping. */
function isContent(event: NormalizedEvent): boolean {
  return event.t === 'text' || event.t === 'thinking' || event.t === 'tool_call';
}

/**
 * Yields from `source` until it finishes or the deadline aborts.
 *
 * The `next()` promise of a stalled stream never settles, and `for await` has no
 * timeout of its own, so the race has to happen per chunk. `return()` is called
 * on the way out so a generator holding a socket is closed rather than left
 * suspended.
 */
async function* raceIterable(
  source: AsyncGenerator<Uint8Array>,
  deadline: AttemptDeadline,
): AsyncGenerator<Uint8Array> {
  try {
    for (;;) {
      const next = await Promise.race([source.next(), deadline.aborted()]);
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  } finally {
    await source.return(undefined).catch(() => undefined);
  }
}

/**
 * Iterates a body in whichever form it arrived.
 *
 * Node's `fetch` gives a `ReadableStream` that also happens to be async
 * iterable, but that is an implementation detail rather than a guarantee, and
 * test doubles are easier to write as plain async generators. Supporting both
 * costs six lines and removes a class of environment-specific breakage.
 */
async function* iterateBytes(body: ByteBody): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) {
        yield value;
      }
      if (done) {
        return;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Parses `Retry-After`, which is either a delay in seconds or an HTTP date.
 *
 * A malformed value yields null rather than 0: guessing "retry immediately"
 * from an unparseable header is how a client turns a rate limit into a ban.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }

  // `Date.parse` is lenient enough to read "-5" as a year, which would turn a
  // malformed header into "retry immediately" — the one answer this function
  // must never invent. Every HTTP-date form (IMF-fixdate, RFC 850, asctime)
  // contains a month name, so require letters before trusting the parse.
  if (!/[a-z]/i.test(trimmed)) {
    return null;
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return null;
  }
  // A date already in the past means "now", not a negative delay.
  return Math.max(0, at - nowMs);
}

async function readErrorBody(response: HttpResponseLike, limit: number): Promise<string> {
  try {
    return sanitize(await response.text(), limit);
  } catch {
    // A body we cannot read is not worth failing over; the status still classifies.
    return '';
  }
}

/**
 * Trims a provider message to something safe to put in a timeline row: bounded
 * length, no control characters that could mangle the log or the webview.
 */
function sanitize(text: string, limit: number): string {
  const flattened = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flattened.length <= limit ? flattened : `${flattened.slice(0, limit)}…`;
}

function isEventStream(contentType: string): boolean {
  return /text\/event-stream/i.test(contentType);
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) {
    return true;
  }
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Node reports transport failures as `error.code`, sometimes only on `cause`. */
function errorCode(error: unknown): string | undefined {
  const direct = readStringProp(error, 'code');
  if (direct !== undefined) {
    return direct;
  }
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return readStringProp((error as { cause: unknown }).cause, 'code');
  }
  return undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return sanitize(error.message, DEFAULT_ERROR_BODY_CHARS);
  }
  return undefined;
}

function readStringProp(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined;
  }
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : undefined;
}
