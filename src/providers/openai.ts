/**
 * OpenAI Chat Completions streaming decoder, and by extension every
 * OpenAI-compatible endpoint (OpenRouter, NVIDIA NIM, Azure OpenAI, vLLM,
 * Ollama's compatible mode, and others).
 *
 * Wire format: unnamed SSE events whose `data` is a `chat.completion.chunk`
 * object, terminated by the literal sentinel `data: [DONE]`.
 *
 * Two properties this decoder is built around:
 *
 *  - **`[DONE]` is the only clean end.** A `finish_reason` tells us *why* the
 *    model stopped, but the stream is not over until the sentinel arrives.
 *    Treating the last chunk as the end would report a truncated response as a
 *    complete one.
 *  - **Tool calls accumulate by index, not by id.** Only the first fragment of
 *    a call carries `id` and `function.name`; later fragments carry just an
 *    `index` and more `arguments` text. A call is emitted when `finish_reason`
 *    closes the choice, never before, so partial JSON is never acted upon.
 */
import type {
  ModelCapabilities,
  ModelRef,
  NormalizedEvent,
  ToolCallId,
} from '../core/types.js';
import {
  ProviderStreamError,
  bearerAuth,
  newDecoderScope,
  normalizeStopReason,
  parseToolArgs,
  synthesizedToolCallId,
  type BuiltRequest,
  type CompletionDecoder,
  type ProviderAdapter,
  type RequestSigner,
  type StreamDecoder,
} from './adapter.js';

import type { SseEvent } from './sse.js';

/** The sentinel that terminates an OpenAI-style stream. */
export const DONE_SENTINEL = '[DONE]';

interface PartialToolCall {
  id: ToolCallId | null;
  name: string | null;
  fragments: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class OpenAiDecoder implements StreamDecoder {
  /** Tool calls under construction, keyed by the `index` the API assigns. */
  private readonly toolCalls = new Map<number, PartialToolCall>();
  /** Per-stream scope, so a synthesized id cannot repeat across turns. */
  private readonly scope = newDecoderScope();
  private finishReason: string | null = null;
  private sawDone = false;
  private inputTokens = 0;
  private outputTokens = 0;

  decode(event: SseEvent): NormalizedEvent[] {
    const data = event.data.trim();
    if (data === '') {
      return [];
    }
    if (data === DONE_SENTINEL) {
      return this.handleDone();
    }

    let payload: Record<string, unknown> | null;
    try {
      payload = asRecord(JSON.parse(data));
    } catch {
      throw new ProviderStreamError('OpenAI-compatible stream sent an unparseable chunk', null);
    }
    if (payload === null) {
      return [];
    }

    // Some compatible gateways report failures as a 200 stream carrying an
    // error object. Surfacing it is the only way the router can react.
    const error = asRecord(payload['error']);
    if (error !== null) {
      throw new ProviderStreamError(
        asString(error['message']) ?? 'OpenAI-compatible stream reported an error',
        asString(error['type']),
      );
    }

    const out: NormalizedEvent[] = [];
    this.readUsage(payload);

    const choices = payload['choices'];
    if (!Array.isArray(choices)) {
      return out;
    }

    for (const raw of choices) {
      const choice = asRecord(raw);
      if (choice === null) {
        continue;
      }
      out.push(...this.readDelta(asRecord(choice['delta'])));

      const finish = asString(choice['finish_reason']);
      if (finish !== null) {
        this.finishReason = finish;
        // The choice is closed, so any accumulated arguments are complete.
        out.push(...this.flushToolCalls());
      }
    }

    return out;
  }

  finish(): { events: NormalizedEvent[]; incomplete: boolean } {
    // Discard rather than emit: arguments that never finished arriving must not
    // become a side effect.
    this.toolCalls.clear();
    return { events: [], incomplete: !this.sawDone };
  }

  private readUsage(payload: Record<string, unknown>): void {
    const usage = asRecord(payload['usage']);
    if (typeof usage?.['prompt_tokens'] === 'number') {
      this.inputTokens = usage['prompt_tokens'];
    }
    if (typeof usage?.['completion_tokens'] === 'number') {
      this.outputTokens = usage['completion_tokens'];
    }
  }

  private readDelta(delta: Record<string, unknown> | null): NormalizedEvent[] {
    if (delta === null) {
      return [];
    }
    const out: NormalizedEvent[] = [];

    const content = asString(delta['content']);
    if (content !== null && content !== '') {
      out.push({ t: 'text', delta: content });
    }

    // DeepSeek-style reasoning traces on otherwise OpenAI-shaped endpoints.
    const reasoning =
      asString(delta['reasoning_content']) ?? asString(delta['reasoning']);
    if (reasoning !== null && reasoning !== '') {
      out.push({ t: 'thinking', delta: reasoning });
    }

    const calls = delta['tool_calls'];
    if (Array.isArray(calls)) {
      for (const rawCall of calls) {
        this.accumulate(asRecord(rawCall));
      }
    }
    return out;
  }

  private accumulate(call: Record<string, unknown> | null): void {
    if (call === null) {
      return;
    }
    // `index` identifies the call across fragments. Without it we cannot tell
    // two parallel calls apart, so the fragment is unusable.
    const index = call['index'];
    if (typeof index !== 'number') {
      return;
    }

    let entry = this.toolCalls.get(index);
    if (entry === undefined) {
      entry = { id: null, name: null, fragments: [] };
      this.toolCalls.set(index, entry);
    }

    const id = asString(call['id']);
    if (id !== null && id !== '') {
      entry.id = id as ToolCallId;
    }

    const fn = asRecord(call['function']);
    const name = asString(fn?.['name']);
    if (name !== null && name !== '') {
      entry.name = name;
    }
    const args = asString(fn?.['arguments']);
    if (args !== null) {
      entry.fragments.push(args);
    }
  }

  private flushToolCalls(): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];

    // Ordered by index so parallel calls are emitted as the model numbered them.
    for (const index of [...this.toolCalls.keys()].sort((a, b) => a - b)) {
      const call = this.toolCalls.get(index)!;
      this.toolCalls.delete(index);

      if (call.name === null) {
        throw new ProviderStreamError(
          `OpenAI-compatible tool call at index ${index} never provided a name`,
          'tool_calls',
        );
      }
      const args = parseToolArgs(call.fragments);
      if (args === null) {
        throw new ProviderStreamError(
          `OpenAI-compatible tool call ${call.name} had unparseable arguments`,
          'tool_calls',
        );
      }
      out.push({
        t: 'tool_call',
        // Some gateways omit the id entirely. The index alone is not enough:
        // it restarts every turn, and ids are resolved task-wide. See
        // `synthesizedToolCallId`.
        id: (call.id as ToolCallId | null | undefined) ?? synthesizedToolCallId(this.scope, index),
        name: call.name,
        args,
      });
    }
    return out;
  }

  private handleDone(): NormalizedEvent[] {
    if (this.sawDone) {
      return [];
    }
    this.sawDone = true;

    // A stream can reach [DONE] with calls still buffered if no finish_reason
    // was ever sent. The sentinel means nothing more is coming, so they are
    // complete and safe to emit.
    const flushed = this.flushToolCalls();

    return [
      ...flushed,
      { t: 'usage', inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      { t: 'done', reason: normalizeStopReason(this.finishReason) },
    ];
  }
}

/**
 * Decodes a non-streamed `chat.completion` body.
 *
 * The non-streaming shape is genuinely simpler than the stream: `message.content`
 * is whole text and `tool_calls[].function.arguments` is a complete JSON string,
 * so nothing accumulates and nothing can be half-arrived. What it must still do
 * is refuse to guess — an unparseable body, a missing choice or unparseable tool
 * arguments all throw `ProviderStreamError`, which classifies as `STREAM` and so
 * routes exactly as a broken stream would.
 */
export function decodeOpenAiCompletion(body: string): readonly NormalizedEvent[] {
  // A whole body carries no stream state, but its ids still land in a ledger that
  // resolves them task-wide, so they get the same per-decode scope.
  const scope = newDecoderScope();
  let payload: Record<string, unknown> | null;
  try {
    payload = asRecord(JSON.parse(body));
  } catch {
    throw new ProviderStreamError('OpenAI-compatible response was not valid JSON', null);
  }
  if (payload === null) {
    throw new ProviderStreamError('OpenAI-compatible response was not an object', null);
  }

  const error = asRecord(payload['error']);
  if (error !== null) {
    throw new ProviderStreamError(
      asString(error['message']) ?? 'OpenAI-compatible endpoint reported an error',
      asString(error['type']),
    );
  }

  const choices = payload['choices'];
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
  if (choice === null) {
    throw new ProviderStreamError('OpenAI-compatible response contained no choices', null);
  }

  const out: NormalizedEvent[] = [];
  const message = asRecord(choice['message']);

  const reasoning =
    asString(message?.['reasoning_content']) ?? asString(message?.['reasoning']);
  if (reasoning !== null && reasoning !== '') {
    out.push({ t: 'thinking', delta: reasoning });
  }

  const content = asString(message?.['content']);
  if (content !== null && content !== '') {
    out.push({ t: 'text', delta: content });
  }

  const calls = message?.['tool_calls'];
  let emittedCalls = 0;
  if (Array.isArray(calls)) {
    for (const [index, rawCall] of calls.entries()) {
      const call = asRecord(rawCall);
      const fn = asRecord(call?.['function']);
      const name = asString(fn?.['name']);
      if (name === null || name === '') {
        throw new ProviderStreamError(
          `OpenAI-compatible tool call at index ${index} provided no name`,
          'tool_calls',
        );
      }
      const args = parseToolArgs([asString(fn?.['arguments']) ?? '']);
      if (args === null) {
        throw new ProviderStreamError(
          `OpenAI-compatible tool call ${name} had unparseable arguments`,
          'tool_calls',
        );
      }
      emittedCalls += 1;
      out.push({
        t: 'tool_call',
        id: (asString(call?.['id']) as ToolCallId | null) ?? synthesizedToolCallId(scope, index),
        name,
        args,
      });
    }
  }

  const usage = asRecord(payload['usage']);
  out.push({
    t: 'usage',
    inputTokens: typeof usage?.['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0,
    outputTokens: typeof usage?.['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0,
  });

  const finish = asString(choice['finish_reason']);
  out.push({
    t: 'done',
    // Some gateways return `stop` even when they returned tool calls. What was
    // actually in the body wins, because the loop dispatches on the stop reason.
    reason: emittedCalls > 0 ? 'tool_use' : normalizeStopReason(finish),
  });
  return out;
}

/**
 * Adapter for any OpenAI-compatible endpoint.
 *

 * `providerId` is supplied by the caller because the same decoder serves
 * OpenAI, OpenRouter, NVIDIA, Azure and local servers; recording which one
 * actually ran matters for the ledger and for health tracking.
 *
 * Capabilities are not guessed. An unknown model returns null, and the router
 * must then treat capability as unproven rather than assume a default.
 *
 * `signer` is injectable for the same reason `providerId` is: several endpoints
 * speak this exact wire format but authenticate differently — Azure OpenAI uses
 * an `api-key` header and an `api-version` query parameter, and a local runtime
 * may want no credential at all. Those are auth differences, not protocol ones,
 * so they are a constructor argument rather than a subclass.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter, CompletionDecoder {
  constructor(
    readonly providerId: string,
    private readonly known: Readonly<Record<string, ModelCapabilities>> = {},
    private readonly signer: RequestSigner = bearerAuth,
  ) {}

  createDecoder(): StreamDecoder {
    return new OpenAiDecoder();
  }

  decodeCompletion(body: string): readonly NormalizedEvent[] {
    return decodeOpenAiCompletion(body);
  }


  sign(request: BuiltRequest, secret: string): BuiltRequest {
    return this.signer(request, secret);
  }

  capabilities(modelId: string): ModelCapabilities | null {
    return this.known[modelId] ?? null;
  }

  models(): readonly ModelRef[] {
    return Object.keys(this.known).map((modelId) => ({
      providerId: this.providerId,
      modelId,
    }));
  }
}
