/**
 * The provider contract.
 *
 * Two deliberate design choices, both of which exist to keep recovery honest:
 *
 * 1. **Decoding is separated from transport.** A `StreamDecoder` turns SSE
 *    events into `NormalizedEvent`s and knows nothing about sockets. That means
 *    every provider's wire format — including its truncation behaviour — is
 *    testable with a string, which is why the decoders here have no `fetch` in
 *    sight.
 *
 * 2. **A tool call is emitted only once its arguments are complete.** Both
 *    Anthropic and OpenAI stream tool arguments as JSON fragments. Emitting a
 *    partial call would let the agent loop act on arguments the model never
 *    finished writing, which is a duplicate-or-wrong side effect with extra
 *    steps. Decoders therefore buffer fragments and emit on the provider's
 *    explicit end-of-call signal, or not at all.
 */
import { randomUUID } from 'node:crypto';
import type {
  ModelCapabilities,
  ModelRef,
  NormalizedEvent,
  StopReason,
  ToolCallId,
} from '../core/types.js';
import type { SseEvent } from './sse.js';

/**
 * Turns provider SSE events into normalized events.
 *
 * Stateful: implementations accumulate partial tool arguments across events.
 */
export interface StreamDecoder {
  /** Decodes one SSE event. Returns zero or more normalized events. */
  decode(event: SseEvent): NormalizedEvent[];
  /**
   * Called when the transport closed.
   *
   * Returns whatever can be reported honestly. If a tool call was still being
   * accumulated it is **discarded**, not emitted, and `incomplete` says so.
   */
  finish(): { readonly events: NormalizedEvent[]; readonly incomplete: boolean };
}

/**
 * The HTTP request for one attempt, as a prompt builder produced it.
 *
 * It lives here rather than next to the agent loop because the provider layer is
 * what completes it: `sign` receives the whole request, not just a header bag.
 */
export interface BuiltRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** A provider-side error surfaced inside an otherwise-200 stream. */
export class ProviderStreamError extends Error {
  constructor(
    message: string,
    readonly providerType: string | null,
  ) {
    super(message);
    this.name = 'ProviderStreamError';
  }
}

/**
 * Decodes a complete, non-streamed response body.
 *
 * Separate from `StreamDecoder` because it is a different fact, not a different
 * formatting of the same one: a whole body has no truncation to detect and no
 * partial tool arguments to buffer, so it needs no state and cannot report
 * `incomplete`. A malformed body throws `ProviderStreamError`, which classifies
 * as `STREAM` exactly as a broken stream does.
 *
 * Optional on `ProviderAdapter`: an endpoint that only streams simply does not
 * offer the fallback, and the caller sees that rather than being handed a
 * decoder that cannot work.
 */
export interface CompletionDecoder {
  decodeCompletion(body: string): readonly NormalizedEvent[];
}

export interface ProviderAdapter extends Partial<CompletionDecoder> {
  readonly providerId: string;
  /** Fresh decoder per request, since decoders carry per-stream state. */
  createDecoder(): StreamDecoder;

  capabilities(modelId: string): ModelCapabilities | null;
  /** Model listing is static here; live listing belongs to a later phase. */
  models(): readonly ModelRef[];
  /**
   * Returns the request with credentials applied.
   *
   * Deliberately given the *whole* unsigned request rather than being asked for
   * headers, because a `(providerId, secret) -> headers` shape cannot express
   * several providers on the target list: Azure OpenAI needs `api-version` in the
   * query string, Gemini can carry the key as a query parameter, and Bedrock
   * SigV4 signs a hash of the **body**, so the signer must see everything
   * `buildRequest` produced.
   *
   * Keeping it here also keeps key material inside the provider layer: the agent
   * loop hands the secret over once and never inspects it, and no module outside
   * `src/providers/` has to know a provider's name to authenticate to it.
   *
   * Implementations apply auth *over* the builder's headers, so a prompt builder
   * cannot override credentials by accident.
   */
  sign(request: BuiltRequest, secret: string): BuiltRequest;
}

/**
 * A standalone implementation of `ProviderAdapter.sign`.
 *
 * Extracted as a type so an endpoint that differs from its family *only* in how
 * it authenticates — Azure OpenAI against OpenAI, say — can be a construction
 * rather than a new class.
 */
export type RequestSigner = (request: BuiltRequest, secret: string) => BuiltRequest;

/** Adds `Authorization: Bearer`, which every OpenAI-compatible endpoint accepts. */
export const bearerAuth: RequestSigner = (request, secret) => ({
  ...request,
  headers: { ...(request.headers ?? {}), authorization: `Bearer ${secret}` },
});

/** Maps a provider stop string onto our four cases. Unknown values are truncation. */
export function normalizeStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'end_turn':
    case 'stop':
    case 'stop_sequence':
    case 'STOP':
      return 'stop';
    case 'tool_use':
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'max_tokens':
    case 'length':
    case 'MAX_TOKENS':
      return 'length';
    default:
      // Anything unrecognised — including null, `content_filter`, `refusal` and
      // `pause_turn` — is reported as truncated rather than as a clean stop.
      // Guessing "stop" here would tell recovery the turn finished when it did
      // not, and recovery would then move on with a half-written response.
      return 'truncated';
  }
}

/**
 * A collision-free id for a provider that did not supply one.
 *
 * Gemini below 3.0 emits no `functionCall.id` at all, and some OpenAI-compatible
 * gateways drop `tool_calls[].id`, so those decoders have to synthesize one. The
 * obvious synthesis — the call's index within the stream — is wrong in a way that
 * only shows up on recovery: decoders are created fresh per request, so the
 * counter restarts every turn and turn 2 re-issues `call_0`.
 *
 * That matters because tool-call ids are resolved **task-wide**. `planRecovery`
 * and `buildHandoff` both build their `resolved`/`settled` sets across the whole
 * ledger, so a repeated id makes turn 2's tool call look like it was already
 * settled by turn 1 — the effect is silently skipped, and the handoff reports it
 * as complete when it never ran.
 *
 * Scoping the id to the decoder instance removes the collision without changing
 * anything else. Idempotency is unaffected: `SideEffectKey` is derived from the
 * tool name, normalized arguments and `stepId`, never from this id.
 */
export function newDecoderScope(): string {
  return randomUUID().slice(0, 8);
}

/** The synthesized id for the `ordinal`-th unidentified call of one stream. */
export function synthesizedToolCallId(scope: string, ordinal: number): ToolCallId {
  return `call_${scope}_${ordinal}` as ToolCallId;
}

/** Parses accumulated tool arguments, returning null when they are not valid JSON. */
export function parseToolArgs(fragments: readonly string[]): unknown | null {
  const joined = fragments.join('');
  // An empty argument stream is a call with no arguments, which is legitimate.
  if (joined.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(joined);
  } catch {
    return null;
  }
}
