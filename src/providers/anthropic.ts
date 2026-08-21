/**
 * Anthropic Messages streaming decoder.
 *
 * Wire format, per Anthropic's streaming documentation: a named-event SSE stream
 * of `message_start`, `content_block_start`, `content_block_delta`,
 * `content_block_stop`, `message_delta`, `message_stop`, plus `ping` keep-alives
 * and `error` events that can appear inside a 200 response.
 *
 * Tool arguments arrive as `input_json_delta` fragments, so a tool call is only
 * emitted at `content_block_stop`, once the JSON is whole. If the stream dies
 * before that, the call is dropped and `finish()` reports `incomplete` — the
 * alternative, guessing at half-written arguments, is how an agent ends up
 * writing a truncated file it was never asked to write.
 */
import type {
  ModelCapabilities,
  ModelRef,
  NormalizedEvent,
  ToolCallId,
} from '../core/types.js';
import {
  ProviderStreamError,
  normalizeStopReason,
  parseToolArgs,
  type BuiltRequest,
  type ProviderAdapter,
  type StreamDecoder,
} from './adapter.js';
import type { SseEvent } from './sse.js';

/** A content block currently open on the stream. */
interface OpenBlock {
  readonly kind: 'text' | 'thinking' | 'tool_use';
  readonly toolCallId: ToolCallId | null;
  readonly toolName: string | null;
  readonly fragments: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class AnthropicDecoder implements StreamDecoder {
  /** Blocks keyed by the index Anthropic assigns them. */
  private readonly blocks = new Map<number, OpenBlock>();
  /** Set by `message_delta`; consumed by `message_stop`. */
  private stopReason: string | null = null;
  private sawMessageStop = false;
  private inputTokens = 0;
  private outputTokens = 0;

  decode(event: SseEvent): NormalizedEvent[] {
    // `ping` carries no data and exists only to keep the socket alive.
    if (event.event === 'ping') {
      return [];
    }

    const payload = event.data === '' ? null : safeJson(event.data);
    if (payload === null) {
      // A named event with an unparseable body is a broken stream, not
      // something to skip quietly: skipping it would lose content silently.
      if (event.data !== '') {
        throw new ProviderStreamError(
          `Anthropic sent an unparseable ${event.event ?? 'unnamed'} event body`,
          event.event,
        );
      }
      return this.decodeEmpty(event.event);
    }

    const type = asString(payload['type']) ?? event.event;
    switch (type) {
      case 'error':
        return this.handleError(payload);
      case 'message_start':
        return this.handleMessageStart(payload);
      case 'content_block_start':
        return this.handleBlockStart(payload);
      case 'content_block_delta':
        return this.handleBlockDelta(payload);
      case 'content_block_stop':
        return this.handleBlockStop(payload);
      case 'message_delta':
        return this.handleMessageDelta(payload);
      case 'message_stop':
        return this.handleMessageStop();
      default:
        // Anthropic documents that new event types may be added, and that
        // clients should ignore ones they do not recognise.
        return [];
    }
  }

  finish(): { events: NormalizedEvent[]; incomplete: boolean } {
    // Any block still open means the stream stopped mid-content. Tool calls in
    // that state are discarded rather than emitted with partial arguments.
    this.blocks.clear();

    // `message_stop` is the only evidence that the turn finished. Without it the
    // stream ended early, whether or not a block happened to be open.
    return { events: [], incomplete: !this.sawMessageStop };
  }

  private decodeEmpty(name: string | null): NormalizedEvent[] {
    // `message_stop` legitimately carries no body in some transports.
    return name === 'message_stop' ? this.handleMessageStop() : [];
  }

  private handleError(payload: Record<string, unknown>): never {
    const error = asRecord(payload['error']);
    const message = asString(error?.['message']) ?? 'Anthropic reported a stream error';
    throw new ProviderStreamError(message, asString(error?.['type']));
  }

  private handleMessageStart(payload: Record<string, unknown>): NormalizedEvent[] {
    const usage = asRecord(asRecord(payload['message'])?.['usage']);
    if (typeof usage?.['input_tokens'] === 'number') {
      this.inputTokens = usage['input_tokens'];
    }
    if (typeof usage?.['output_tokens'] === 'number') {
      this.outputTokens = usage['output_tokens'];
    }
    return [];
  }

  private handleBlockStart(payload: Record<string, unknown>): NormalizedEvent[] {
    const index = payload['index'];
    const block = asRecord(payload['content_block']);
    if (typeof index !== 'number' || block === null) {
      return [];
    }

    const blockType = asString(block['type']);
    if (blockType === 'tool_use') {
      const id = asString(block['id']);
      const name = asString(block['name']);
      if (id === null || name === null) {
        throw new ProviderStreamError('Anthropic tool_use block is missing id or name', 'tool_use');
      }
      this.blocks.set(index, {
        kind: 'tool_use',
        toolCallId: id as ToolCallId,
        toolName: name,
        fragments: [],
      });
      return [];
    }

    this.blocks.set(index, {
      kind: blockType === 'thinking' ? 'thinking' : 'text',
      toolCallId: null,
      toolName: null,
      fragments: [],
    });
    return [];
  }

  private handleBlockDelta(payload: Record<string, unknown>): NormalizedEvent[] {
    const index = payload['index'];
    const delta = asRecord(payload['delta']);
    if (typeof index !== 'number' || delta === null) {
      return [];
    }

    switch (asString(delta['type'])) {
      case 'text_delta': {
        const text = asString(delta['text']);
        return text === null ? [] : [{ t: 'text', delta: text }];
      }
      case 'thinking_delta': {
        const thinking = asString(delta['thinking']);
        return thinking === null ? [] : [{ t: 'thinking', delta: thinking }];
      }
      case 'input_json_delta': {
        const partial = asString(delta['partial_json']);
        const block = this.blocks.get(index);
        if (partial !== null && block !== undefined) {
          block.fragments.push(partial);
        }
        // Nothing is emitted: the arguments are not yet complete.
        return [];
      }
      default:
        // `signature_delta` and future delta types carry nothing we act on.
        return [];
    }
  }

  private handleBlockStop(payload: Record<string, unknown>): NormalizedEvent[] {
    const index = payload['index'];
    if (typeof index !== 'number') {
      return [];
    }
    const block = this.blocks.get(index);
    this.blocks.delete(index);

    if (block === undefined || block.kind !== 'tool_use') {
      return [];
    }
    if (block.toolCallId === null || block.toolName === null) {
      return [];
    }

    const args = parseToolArgs(block.fragments);
    if (args === null) {
      // The block closed but the JSON does not parse. That is a malformed call,
      // and inventing arguments for it would be worse than failing.
      throw new ProviderStreamError(
        `Anthropic tool call ${block.toolName} had unparseable arguments`,
        'tool_use',
      );
    }
    return [{ t: 'tool_call', id: block.toolCallId, name: block.toolName, args }];
  }

  private handleMessageDelta(payload: Record<string, unknown>): NormalizedEvent[] {
    const delta = asRecord(payload['delta']);
    const reason = asString(delta?.['stop_reason']);
    if (reason !== null) {
      this.stopReason = reason;
    }

    const usage = asRecord(payload['usage']);
    if (typeof usage?.['output_tokens'] === 'number') {
      this.outputTokens = usage['output_tokens'];
    }
    if (typeof usage?.['input_tokens'] === 'number') {
      this.inputTokens = usage['input_tokens'];
    }
    return [];
  }

  private handleMessageStop(): NormalizedEvent[] {
    if (this.sawMessageStop) {
      return [];
    }
    this.sawMessageStop = true;
    return [
      { t: 'usage', inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      { t: 'done', reason: normalizeStopReason(this.stopReason) },
    ];
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Static capability data.
 *
 * Deliberately sparse and unversioned-by-guess: only fields we can state from
 * published documentation are filled in, and an unknown model returns null
 * rather than a fabricated default. A wrong context window here would cause
 * silent truncation, which is exactly the failure mode this project is about.
 */
const ANTHROPIC_MODELS: Readonly<Record<string, ModelCapabilities>> = {};

/** The Messages API version this adapter's request shape is written against. */
export const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = 'anthropic';

  createDecoder(): StreamDecoder {
    return new AnthropicDecoder();
  }

  /**
   * Anthropic authenticates with `x-api-key`, not a bearer token, and requires
   * an explicit `anthropic-version` on every request.
   *
   * The version is pinned rather than passed through from the caller: the
   * decoder above is written against this version's event names, so letting a
   * prompt builder choose a different one would silently pair a new wire format
   * with a decoder that cannot read it. Auth is applied last so a builder's
   * headers cannot override it.
   */
  sign(request: BuiltRequest, secret: string): BuiltRequest {
    return {
      ...request,
      headers: {
        ...(request.headers ?? {}),
        'x-api-key': secret,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    };
  }

  capabilities(modelId: string): ModelCapabilities | null {
    return ANTHROPIC_MODELS[modelId] ?? null;
  }

  models(): readonly ModelRef[] {
    return Object.keys(ANTHROPIC_MODELS).map((modelId) => ({
      providerId: this.providerId,
      modelId,
    }));
  }
}
