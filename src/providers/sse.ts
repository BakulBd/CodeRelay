/**
 * Server-sent events framing.
 *
 * Every provider we target streams over SSE, and the failure this project cares
 * about most — a connection that dies mid-response — shows up here first, as a
 * buffer holding half a line. So the parser's contract is deliberately narrow
 * and explicit:
 *
 *  - `push` returns only events terminated by a blank line. A partially received
 *    event is retained, never guessed at.
 *  - `end` reports whether anything was still buffered. A non-empty buffer means
 *    the transport stopped mid-event, which is `STREAM`, not a clean finish.
 *
 * Framing follows the WHATWG HTML event-stream rules: lines end with LF, CR, or
 * CRLF; a leading colon marks a comment; a line with no colon is a field name
 * with an empty value; one leading space after the colon is stripped; and
 * repeated `data` fields are joined with newlines.
 *
 * This layer is intentionally ignorant of provider semantics. Interpreting a
 * `message_stop` or a `[DONE]` sentinel is the adapter's job; conflating the two
 * concerns is how parsers end up silently accepting a truncated response.
 */

/** One dispatched event. `data` is the joined payload, without a trailing newline. */
export interface SseEvent {
  /** The `event:` field, or null when the stream did not name one. */
  readonly event: string | null;
  readonly data: string;
  /** The `id:` field, if present. Retained because some providers resume with it. */
  readonly id: string | null;
  /** The `retry:` field in milliseconds, when it parsed as a valid integer. */
  readonly retryMs: number | null;
}

/** What was left over when the stream stopped. */
export interface SseEndState {
  /**
   * True when bytes were still buffered, i.e. the last event never terminated.
   * Callers must treat this as a truncated stream rather than a clean end.
   */
  readonly truncated: boolean;
  /** The unterminated remainder, for diagnostics. Empty when not truncated. */
  readonly remainder: string;
}

/** Fields accumulated for the event currently being read. */
interface Pending {
  event: string | null;
  data: string[];
  id: string | null;
  retryMs: number | null;
}

const emptyPending = (): Pending => ({ event: null, data: [], id: null, retryMs: null });

export class SseParser {
  /** Bytes received but not yet forming a complete line. */
  private buffer = '';
  private pending: Pending = emptyPending();
  /**
   * Set when a chunk ended exactly on a CR, because the following LF (if any)
   * belongs to the same line terminator and must not open a second line.
   */
  private pendingCr = false;

  /** Feeds a chunk and returns every event completed by it. */
  push(chunk: string): SseEvent[] {
    const events: SseEvent[] = [];
    let text = chunk;

    // A CRLF split across two chunks: swallow the LF that completes it.
    if (this.pendingCr) {
      this.pendingCr = false;
      if (text.startsWith('\n')) {
        text = text.slice(1);
      }
    }

    this.buffer += text;

    for (;;) {
      const line = this.takeLine();
      if (line === null) {
        break;
      }
      const dispatched = this.handleLine(line);
      if (dispatched !== null) {
        events.push(dispatched);
      }
    }

    return events;
  }

  /**
   * Signals that the transport closed.
   *
   * Note what this does *not* do: it does not dispatch the buffered event. The
   * SSE specification only dispatches on a blank line, and a half-received tool
   * call is precisely the thing that must never be acted upon.
   */
  end(): SseEndState {
    const remainder = this.buffer + this.pending.data.join('\n');
    const truncated = remainder.length > 0 || this.pending.event !== null;

    this.buffer = '';
    this.pending = emptyPending();
    this.pendingCr = false;

    return { truncated, remainder };
  }

  /** Extracts the next complete line, or null if none has arrived yet. */
  private takeLine(): string | null {
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch === '\n') {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        return line;
      }
      if (ch === '\r') {
        const line = this.buffer.slice(0, i);
        if (i + 1 < this.buffer.length) {
          // The LF of a CRLF is part of this terminator.
          const skip = this.buffer[i + 1] === '\n' ? 2 : 1;
          this.buffer = this.buffer.slice(i + skip);
        } else {
          // The chunk ended on CR; we cannot yet tell CR from CRLF.
          this.buffer = '';
          this.pendingCr = true;
        }
        return line;
      }
    }
    return null;
  }

  /** Processes one line, returning an event when the line dispatched one. */
  private handleLine(line: string): SseEvent | null {
    if (line === '') {
      return this.dispatch();
    }
    // A leading colon is a comment, commonly used as a keep-alive ping.
    if (line.startsWith(':')) {
      return null;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    switch (field) {
      case 'event':
        this.pending.event = value;
        break;
      case 'data':
        this.pending.data.push(value);
        break;
      case 'id':
        // The spec requires ignoring an id containing NUL.
        if (!value.includes('\u0000')) {
          this.pending.id = value;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(value)) {
          this.pending.retryMs = Number(value);
        }
        break;
      default:
        // Unknown fields are ignored, per the spec, so a provider adding one
        // cannot break parsing.
        break;
    }
    return null;
  }

  private dispatch(): SseEvent | null {
    const { event, data, id, retryMs } = this.pending;
    this.pending = emptyPending();

    // A blank line with no data is a no-op, not an empty event.
    if (data.length === 0 && event === null) {
      return null;
    }
    return { event, data: data.join('\n'), id, retryMs };
  }
}

/** Convenience wrapper for a whole response body already held in memory. */
export function parseSse(text: string): { events: SseEvent[]; end: SseEndState } {
  const parser = new SseParser();
  const events = parser.push(text);
  return { events, end: parser.end() };
}
