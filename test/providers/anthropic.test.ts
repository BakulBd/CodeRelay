/**
 * Anthropic stream decoding.
 *
 * The invariant under test is narrow and it is the whole reason this decoder
 * exists: a tool call reaches the rest of the system only when its arguments are
 * complete. Anthropic sends those arguments as `input_json_delta` fragments, so
 * "complete" means `content_block_stop` arrived. A stream that dies one frame
 * earlier must produce no tool call at all — not a truncated one — because the
 * runner would turn it into a real side effect derived from a guessed intent.
 *
 * Events are fed through the real `SseParser` rather than hand-built `SseEvent`
 * literals so framing and decoding are exercised together, the way they run.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalizedEvent } from '../../src/core/types.js';
import { AnthropicAdapter, AnthropicDecoder } from '../../src/providers/anthropic.js';
import { ProviderStreamError } from '../../src/providers/adapter.js';
import { parseSse } from '../../src/providers/sse.js';

type ToolCallEvent = Extract<NormalizedEvent, { t: 'tool_call' }>;
type DoneEvent = Extract<NormalizedEvent, { t: 'done' }>;
type UsageEvent = Extract<NormalizedEvent, { t: 'usage' }>;

interface Decoded {
  readonly events: NormalizedEvent[];
  readonly incomplete: boolean;
  readonly truncated: boolean;
}

/** Frame `wire` with the real parser, decode every event, then close the turn. */
function decode(wire: string): Decoded {
  const decoder = new AnthropicDecoder();
  const framed = parseSse(wire);
  const events: NormalizedEvent[] = [];
  for (const event of framed.events) {
    events.push(...decoder.decode(event));
  }
  const tail = decoder.finish();
  events.push(...tail.events);
  return { events, incomplete: tail.incomplete, truncated: framed.end.truncated };
}

/** Decode without closing, for the cases that are expected to throw. */
function decodeStrict(wire: string): NormalizedEvent[] {
  const decoder = new AnthropicDecoder();
  const events: NormalizedEvent[] = [];
  for (const event of parseSse(wire).events) {
    events.push(...decoder.decode(event));
  }
  return events;
}

function toolCalls(events: readonly NormalizedEvent[]): ToolCallEvent[] {
  return events.filter((e): e is ToolCallEvent => e.t === 'tool_call');
}

function dones(events: readonly NormalizedEvent[]): DoneEvent[] {
  return events.filter((e): e is DoneEvent => e.t === 'done');
}

function usages(events: readonly NormalizedEvent[]): UsageEvent[] {
  return events.filter((e): e is UsageEvent => e.t === 'usage');
}

function text(events: readonly NormalizedEvent[]): string {
  return events
    .filter((e): e is Extract<NormalizedEvent, { t: 'text' }> => e.t === 'text')
    .map((e) => e.delta)
    .join('');
}

function thinking(events: readonly NormalizedEvent[]): string {
  return events
    .filter((e): e is Extract<NormalizedEvent, { t: 'thinking' }> => e.t === 'thinking')
    .map((e) => e.delta)
    .join('');
}

/** One SSE frame, named the way Anthropic names it. */
function frame(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const MESSAGE_START = frame('message_start', {
  type: 'message_start',
  message: { usage: { input_tokens: 11, output_tokens: 1 } },
});

const TEXT_BLOCK =
  frame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }) +
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello' },
  }) +
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: ', world' },
  }) +
  frame('content_block_stop', { type: 'content_block_stop', index: 0 });

function messageDelta(stopReason: string | null, outputTokens = 9): string {
  return frame('message_delta', {
    type: 'message_delta',
    delta: stopReason === null ? {} : { stop_reason: stopReason },
    usage: { output_tokens: outputTokens },
  });
}

const MESSAGE_STOP = frame('message_stop', { type: 'message_stop' });

test('a text-only turn yields the text, then usage, then done', () => {
  const { events, incomplete } = decode(
    MESSAGE_START + TEXT_BLOCK + messageDelta('end_turn') + MESSAGE_STOP,
  );

  assert.equal(text(events), 'Hello, world');
  assert.equal(incomplete, false);

  // Ordering matters: usage must be settled before the turn is declared done.
  const last = events.slice(-2);
  assert.deepEqual(last, [
    { t: 'usage', inputTokens: 11, outputTokens: 9 },
    { t: 'done', reason: 'stop' },
  ]);
});

test('ping keep-alives produce nothing', () => {
  const { events } = decode(
    MESSAGE_START +
      frame('ping', { type: 'ping' }) +
      TEXT_BLOCK +
      frame('ping', { type: 'ping' }) +
      messageDelta('end_turn') +
      MESSAGE_STOP,
  );

  assert.equal(text(events), 'Hello, world');
  assert.equal(events.length, 4); // two text deltas, usage, done
});

test('a tool call is emitted at content_block_stop with its arguments parsed', () => {
  const { events, incomplete } = decode(
    MESSAGE_START +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'write_file', input: {} },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: ',"content":"x"}' },
      }) +
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      messageDelta('tool_use') +
      MESSAGE_STOP,
  );

  assert.deepEqual(toolCalls(events), [
    {
      t: 'tool_call',
      id: 'toolu_01',
      name: 'write_file',
      args: { path: 'a.ts', content: 'x' },
    },
  ]);
  assert.equal(dones(events)[0]?.reason, 'tool_use');
  assert.equal(incomplete, false);
});

test('argument fragments emit nothing until the block closes', () => {
  const decoder = new AnthropicDecoder();
  const framed = parseSse(
    MESSAGE_START +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'delete_file' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' },
      }),
  );

  for (const event of framed.events) {
    assert.deepEqual(decoder.decode(event), [], 'no event may escape before the block stops');
  }
});

test('a stream that dies after input_json_delta emits no tool call and reports incomplete', () => {
  // The dangerous shape: the model has told us what it wants to do, the
  // arguments look almost whole, and the connection drops. Emitting here would
  // delete a file chosen by a JSON parser's error recovery.
  const { events, incomplete, truncated } = decode(
    MESSAGE_START +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'delete_file' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"src/imp' },
      }),
  );

  assert.deepEqual(toolCalls(events), []);
  assert.deepEqual(dones(events), []);
  assert.equal(incomplete, true);
  assert.equal(truncated, false); // the last frame was whole; the turn was not
});

test('a stream cut mid-frame is reported as truncated and dispatches nothing for it', () => {
  const { events, incomplete, truncated } = decode(
    MESSAGE_START +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta"',
  );

  assert.equal(text(events), '');
  assert.equal(truncated, true);
  assert.equal(incomplete, true);
});

test('parallel tool blocks at different indices stay separate', () => {
  const { events } = decode(
    MESSAGE_START +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'read_file' },
      }) +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_b', name: 'read_file' },
      }) +
      // Fragments arrive interleaved, which is why the index and not arrival
      // order is what binds a fragment to its call.
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"path":"b.ts"}' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"a.ts"}' },
      }) +
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }) +
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      messageDelta('tool_use') +
      MESSAGE_STOP,
  );

  assert.deepEqual(
    toolCalls(events).map((c) => [c.id, c.args]),
    [
      ['toolu_b', { path: 'b.ts' }],
      ['toolu_a', { path: 'a.ts' }],
    ],
  );
});

test('one open block does not suppress a sibling that already closed', () => {
  const { events, incomplete } = decode(
    MESSAGE_START +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'read_file' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' },
      }) +
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_b', name: 'delete_file' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"pa' },
      }),
  );

  assert.deepEqual(
    toolCalls(events).map((c) => c.id),
    ['toolu_a'],
  );
  assert.equal(incomplete, true);
});

test('thinking deltas are surfaced separately from text', () => {
  const { events } = decode(
    MESSAGE_START +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'weighing options' },
      }) +
      // `signature_delta` is documented but carries nothing we act on.
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'abc' },
      }) +
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      TEXT_BLOCK +
      messageDelta('end_turn') +
      MESSAGE_STOP,
  );

  assert.equal(thinking(events), 'weighing options');
  assert.equal(text(events), 'Hello, world');
});

test('an error event inside a 200 response throws ProviderStreamError', () => {
  // Anthropic can report overload mid-stream with HTTP 200 already sent, so the
  // transport sees success. Only the decoder can tell the router to fail over.
  assert.throws(
    () =>
      decodeStrict(
        MESSAGE_START +
          frame('error', {
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' },
          }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderStreamError);
      assert.equal(error.message, 'Overloaded');
      assert.equal(error.providerType, 'overloaded_error');
      return true;
    },
  );
});

test('an unparseable event body throws rather than being skipped', () => {
  // Skipping quietly would drop content and let the turn look complete.
  assert.throws(
    () => decodeStrict('event: content_block_delta\ndata: {not json}\n\n'),
    ProviderStreamError,
  );
});

test('a tool block whose accumulated JSON is malformed throws', () => {
  assert.throws(
    () =>
      decodeStrict(
        frame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_01', name: 'write_file' },
        }) +
          frame('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path": "a.ts"' },
          }) +
          frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ),
    /unparseable arguments/,
  );
});

test('a tool_use block missing id or name throws', () => {
  assert.throws(
    () =>
      decodeStrict(
        frame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', name: 'write_file' },
        }),
      ),
    /missing id or name/,
  );
});

test('a tool call with no argument fragments becomes an empty object', () => {
  const { events } = decode(
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_01', name: 'list_files' },
    }) +
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      messageDelta('tool_use') +
      MESSAGE_STOP,
  );

  assert.deepEqual(toolCalls(events)[0]?.args, {});
});

test('stop reasons map onto the normalized set', () => {
  const cases: ReadonlyArray<readonly [string | null, string]> = [
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['tool_use', 'tool_use'],
    ['max_tokens', 'length'],
    // Anything we have not seen before is treated as a truncated turn, not as a
    // clean stop: assuming success is what silently loses work.
    ['refusal', 'truncated'],
    ['pause_turn', 'truncated'],
    [null, 'truncated'],
  ];

  for (const [raw, expected] of cases) {
    const { events } = decode(MESSAGE_START + messageDelta(raw) + MESSAGE_STOP);
    assert.equal(dones(events)[0]?.reason, expected, `stop_reason ${String(raw)}`);
  }
});

test('usage from message_start is superseded by message_delta', () => {
  const { events } = decode(MESSAGE_START + messageDelta('end_turn', 42) + MESSAGE_STOP);

  assert.deepEqual(usages(events), [{ t: 'usage', inputTokens: 11, outputTokens: 42 }]);
});

test('message_stop emits exactly one usage and done pair even if repeated', () => {
  const { events } = decode(
    MESSAGE_START + messageDelta('end_turn') + MESSAGE_STOP + MESSAGE_STOP,
  );

  assert.equal(usages(events).length, 1);
  assert.equal(dones(events).length, 1);
});

test('message_stop with an empty body still ends the turn', () => {
  // Some proxies forward the event name without a body.
  const { events, incomplete } = decode(
    MESSAGE_START + messageDelta('end_turn') + 'event: message_stop\n\n',
  );

  assert.equal(dones(events).length, 1);
  assert.equal(incomplete, false);
});

test('unrecognized event types are ignored', () => {
  const { events, incomplete } = decode(
    MESSAGE_START +
      frame('something_new', { type: 'something_new', detail: 'from a future API' }) +
      messageDelta('end_turn') +
      MESSAGE_STOP,
  );

  assert.equal(dones(events).length, 1);
  assert.equal(incomplete, false);
});

test('the adapter reports no capabilities for a model it has no data for', () => {
  const adapter = new AnthropicAdapter();

  assert.equal(adapter.providerId, 'anthropic');
  // Unproven beats invented: a guessed context window would cause exactly the
  // silent truncation this project exists to stop.
  assert.equal(adapter.capabilities('claude-not-a-real-model'), null);
  assert.deepEqual(adapter.models(), []);
});

test('each decoder instance starts clean', () => {
  const adapter = new AnthropicAdapter();
  const first = adapter.createDecoder();
  const second = adapter.createDecoder();

  assert.notEqual(first, second);
  assert.equal(second.finish().incomplete, true);
});

test('signing uses x-api-key and pins the API version', () => {
  // Anthropic does not accept a bearer token, and it rejects a request with no
  // `anthropic-version`. The version is pinned by the adapter rather than passed
  // in because the decoder above is written against this version's event names.
  const signed = new AnthropicAdapter().sign(
    { url: 'https://api.anthropic.com/v1/messages', body: '{}' },
    'sk-ant-live',
  );

  assert.equal(signed.headers?.['x-api-key'], 'sk-ant-live');
  assert.equal(signed.headers?.['anthropic-version'], '2023-06-01');
  assert.equal(signed.headers?.['authorization'], undefined);
});

test('signing preserves the rest of the request and cannot be overridden', () => {
  // A prompt builder supplying its own `x-api-key` must not win: credentials are
  // applied last, so a stale or wrong key in a builder cannot be sent instead of
  // the one rotation selected.
  const unsigned = {
    url: 'https://proxy.internal/v1/messages',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-from-builder' },
    body: '{"model":"claude"}',
  };

  const signed = new AnthropicAdapter().sign(unsigned, 'sk-ant-live');

  assert.equal(signed.url, unsigned.url);
  assert.equal(signed.method, 'POST');
  assert.equal(signed.body, unsigned.body);
  assert.equal(signed.headers?.['content-type'], 'application/json');
  assert.equal(signed.headers?.['x-api-key'], 'sk-ant-live');
  // The input is left alone, so the secret cannot leak into a value the caller
  // still holds and might log.
  assert.equal(unsigned.headers['x-api-key'], 'sk-from-builder');
});
