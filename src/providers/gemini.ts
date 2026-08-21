/**
 * Google Gemini `generateContent` streaming decoder.
 *
 * Wire format: with `alt=sse`, `:streamGenerateContent` emits unnamed SSE events
 * whose `data` is a `GenerateContentResponse` — `candidates[].content.parts[]`
 * carrying either `text` or a `functionCall`, plus `usageMetadata` and a
 * `finishReason` on the last chunk.
 *
 * Three differences from the OpenAI-shaped endpoints, each of which this decoder
 * has to handle rather than paper over:
 *
 *  - **There is no `[DONE]` sentinel.** The only evidence a turn finished is a
 *    `finishReason`, so that is what `finish()` reports on. A socket that closed
 *    politely before one arrived is an incomplete turn.
 *  - **Function-call arguments arrive whole.** `functionCall.args` is a JSON
 *    object in a single chunk, never a string fragmented across chunks, so a call
 *    is emitted as soon as it is seen. Nothing partial is ever buffered.
 *  - **Calls have no ids.** Gemini identifies a call only by name, so an index is
 *    synthesized. It is stable within a turn, which is all the ledger requires
 *    of a `ToolCallId`.
 */
import type { ModelCapabilities, ModelRef, NormalizedEvent } from '../core/types.js';
import {
  ProviderStreamError,
  newDecoderScope,
  normalizeStopReason,
  synthesizedToolCallId,
  type BuiltRequest,
  type ProviderAdapter,
  type StreamDecoder,
} from './adapter.js';
import type { SseEvent } from './sse.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class GeminiDecoder implements StreamDecoder {
  private finishReason: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  /** Numbers synthesized tool call ids, since Gemini supplies none. */
  private calls = 0;
  /** Per-stream scope, so a synthesized id cannot repeat across turns. */
  private readonly scope = newDecoderScope();

  decode(event: SseEvent): NormalizedEvent[] {
    const data = event.data.trim();
    if (data === '') {
      return [];
    }

    let payload: Record<string, unknown> | null;
    try {
      payload = asRecord(JSON.parse(data));
    } catch {
      throw new ProviderStreamError('Gemini sent an unparseable chunk', null);
    }
    if (payload === null) {
      return [];
    }

    // Gemini reports mid-stream failures as an `error` object inside a 200
    // response. Surfacing it is the only way the router can react to it.
    const error = asRecord(payload['error']);
    if (error !== null) {
      throw new ProviderStreamError(
        asString(error['message']) ?? 'Gemini reported a stream error',
        asString(error['status']),
      );
    }

    this.readUsage(payload);

    // A prompt refused before generation reports no candidates at all, only a
    // block reason. Silently returning nothing would look like an empty answer.
    const feedback = asRecord(payload['promptFeedback']);
    const blocked = asString(feedback?.['blockReason']);
    if (blocked !== null) {
      throw new ProviderStreamError(`Gemini blocked the prompt (${blocked})`, blocked);
    }

    const candidates = payload['candidates'];
    if (!Array.isArray(candidates)) {
      return [];
    }

    const out: NormalizedEvent[] = [];
    for (const raw of candidates) {
      const candidate = asRecord(raw);
      if (candidate === null) {
        continue;
      }
      out.push(...this.readParts(asRecord(candidate['content'])));

      const finish = asString(candidate['finishReason']);
      if (finish !== null) {
        this.finishReason = finish;
      }
    }
    return out;
  }

  /**
   * Gemini has no terminal event, so the turn is complete exactly when a
   * `finishReason` was seen. The usage and done events are emitted here rather
   * than mid-stream because the final token counts arrive with the last chunk.
   */
  finish(): { events: NormalizedEvent[]; incomplete: boolean } {
    if (this.finishReason === null) {
      return { events: [], incomplete: true };
    }
    return {
      events: [
        { t: 'usage', inputTokens: this.inputTokens, outputTokens: this.outputTokens },
        // A tool call was emitted above, but Gemini reports `STOP` even then, so
        // the stop reason is corrected from what was actually seen.
        {
          t: 'done',
          reason: this.calls > 0 ? 'tool_use' : normalizeStopReason(this.finishReason),
        },
      ],
      incomplete: false,
    };
  }

  private readUsage(payload: Record<string, unknown>): void {
    const usage = asRecord(payload['usageMetadata']);
    if (typeof usage?.['promptTokenCount'] === 'number') {
      this.inputTokens = usage['promptTokenCount'];
    }
    if (typeof usage?.['candidatesTokenCount'] === 'number') {
      this.outputTokens = usage['candidatesTokenCount'];
    }
  }

  private readParts(content: Record<string, unknown> | null): NormalizedEvent[] {
    const parts = content?.['parts'];
    if (!Array.isArray(parts)) {
      return [];
    }

    const out: NormalizedEvent[] = [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (part === null) {
        continue;
      }

      const call = asRecord(part['functionCall']);
      if (call !== null) {
        const name = asString(call['name']);
        if (name === null || name === '') {
          throw new ProviderStreamError('Gemini functionCall is missing a name', 'functionCall');
        }
        this.calls += 1;
        out.push({
          t: 'tool_call',
          id: synthesizedToolCallId(this.scope, this.calls),
          name,
          // Absent args means a no-argument call, which is `{}` — not a failure.
          args: call['args'] ?? {},

        });
        continue;
      }

      const text = asString(part['text']);
      if (text === null || text === '') {
        continue;
      }
      // Reasoning summaries are flagged rather than being separate parts.
      out.push(part['thought'] === true ? { t: 'thinking', delta: text } : { t: 'text', delta: text });
    }
    return out;
  }
}

/**
 * Capabilities are left empty for the same reason as the other adapters: a
 * fabricated context window causes exactly the silent truncation this project
 * exists to prevent, so an unknown model returns null and the router treats its
 * capability as unproven.
 */
const GEMINI_MODELS: Readonly<Record<string, ModelCapabilities>> = {};

export class GeminiAdapter implements ProviderAdapter {
  readonly providerId = 'gemini';

  createDecoder(): StreamDecoder {
    return new GeminiDecoder();
  }

  /**
   * Gemini accepts the key as an `x-goog-api-key` header.
   *
   * The header form is used rather than the documented `?key=` query parameter
   * on purpose: a URL carrying key material ends up in proxy logs, crash
   * reports and error messages, and this project's rule is that a secret exists
   * in exactly one place — the request it was signed into.
   */
  sign(request: BuiltRequest, secret: string): BuiltRequest {
    return {
      ...request,
      headers: { ...(request.headers ?? {}), 'x-goog-api-key': secret },
    };
  }

  capabilities(modelId: string): ModelCapabilities | null {
    return GEMINI_MODELS[modelId] ?? null;
  }

  models(): readonly ModelRef[] {
    return Object.keys(GEMINI_MODELS).map((modelId) => ({
      providerId: this.providerId,
      modelId,
    }));
  }
}
