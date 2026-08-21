/**
 * OpenAI-compatible stream decoding.
 *
 * Two properties are pinned here, and both are about not acting on a partial
 * intent:
 *
 *  - A tool call is emitted only once its arguments are whole — at
 *    `finish_reason`, or at `[DONE]` if the endpoint never sent one. A stream
 *    that dies mid-arguments produces nothing and reports `incomplete`.
 *  - `[DONE]` is the only clean end. Ending on the last chunk would let a
 *    dropped connection look like a finished turn, which is the failure this
 *    whole project is organised around.
 *
 * Fragments are fed through the real `SseParser` so framing and decoding are
 * exercised together.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelCapabilities, NormalizedEvent } from '../../src/core/types.js';
import { ProviderStreamError } from '../../src/providers/adapter.js';
import { OpenAiCompatibleAdapter, OpenAiDecoder } from '../../src/providers/openai.js';
import { parseSse } from '../../src/providers/sse.js';

type ToolCallEvent = Extract<NormalizedEvent, { t: 'tool_call' }>;
type DoneEvent = Extract<NormalizedEvent, { t: 'done' }>;
type UsageEvent = Extract<NormalizedEvent, { t: 'usage' }>;

interface Decoded {
  readonly events: NormalizedEvent[];
  readonly incomplete: boolean;
  readonly truncated: boolean;
}

function decode(wire: string): Decoded {
  const decoder = new OpenAiDecoder();
  const framed = parseSse(wire);
  const events: NormalizedEvent[] = [];
  for (const event of framed.events) {
    events.push(...decoder.decode(event));
  }
  const tail = decoder.finish();
  events.push(...tail.events);
  return { events, incomplete: tail.incomplete, truncated: framed.end.truncated };
}

/** Decode without closing the turn, for cases expected to throw. */
function decodeStrict(wire: string): NormalizedEvent[] {
  const decoder = new OpenAiDecoder();
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

/** One unnamed `data:` frame, the shape OpenAI actually sends. */
function chunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** A single-choice chunk, the overwhelmingly common case. */
function delta(body: Record<string, unknown>, finishReason: string | null = null): string {
  return chunk({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: body, finish_reason: finishReason }],
  });
}

const DONE = 'data: [DONE]\n\n';

const USAGE_CHUNK = chunk({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [],
  usage: { prompt_tokens: 31, completion_tokens: 7 },
});

test('text deltas across chunks reassemble in order and end cleanly on [DONE]', () => {
  const { events, incomplete } = decode(
    delta({ role: 'assistant', content: '' }) +
      delta({ content: 'Hello' }) +
      delta({ content: ', world' }) +
      delta({}, 'stop') +
      USAGE_CHUNK +
      DONE,
  );

  assert.equal(text(events), 'Hello, world');
  assert.equal(incomplete, false);
  assert.deepEqual(events.slice(-2), [
    { t: 'usage', inputTokens: 31, outputTokens: 7 },
    { t: 'done', reason: 'stop' },
  ]);
});

test('a stream that ends without [DONE] is incomplete even after finish_reason', () => {
  // finish_reason says why the model stopped talking; it does not say the
  // response arrived. A proxy killed after the last chunk looks identical to a
  // clean turn unless the sentinel is required.
  const { events, incomplete } = decode(delta({ content: 'partial answer' }) + delta({}, 'stop'));

  assert.equal(text(events), 'partial answer');
  assert.deepEqual(dones(events), []);
  assert.equal(incomplete, true);
});

test('a stream cut mid-chunk is truncated and the partial chunk is dropped', () => {
  const { events, incomplete, truncated } = decode(
    delta({ content: 'so far' }) + 'data: {"choices":[{"index":0,"delta":{"content":"lo',
  );

  assert.equal(text(events), 'so far');
  assert.equal(truncated, true);
  assert.equal(incomplete, true);
});

test('a tool call split so only the first fragment carries id and name', () => {
  // This is the real wire shape: later fragments have nothing but an index and
  // more argument text, which is why accumulation is keyed on index.
  const { events, incomplete } = decode(
    delta({
      tool_calls: [
        { index: 0, id: 'call_abc', type: 'function', function: { name: 'write_file', arguments: '' } },
      ],
    }) +
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a' } }] }) +
      delta({ tool_calls: [{ index: 0, function: { arguments: '.ts","content":"x"}' } }] }) +
      delta({}, 'tool_calls') +
      DONE,
  );

  assert.deepEqual(toolCalls(events), [
    {
      t: 'tool_call',
      id: 'call_abc',
      name: 'write_file',
      args: { path: 'a.ts', content: 'x' },
    },
  ]);
  assert.equal(dones(events)[0]?.reason, 'tool_use');
  assert.equal(incomplete, false);
});

test('argument fragments emit nothing before the choice closes', () => {
  const decoder = new OpenAiDecoder();
  const wire =
    delta({
      tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'delete_file', arguments: '' } }],
    }) + delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] });

  for (const event of parseSse(wire).events) {
    assert.deepEqual(decoder.decode(event), [], 'nothing may escape before finish_reason');
  }
});

test('a tool call interrupted mid-arguments is discarded and reported incomplete', () => {
  const { events, incomplete } = decode(
    delta({
      tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'delete_file', arguments: '' } }],
    }) + delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"src/imp' } }] }),
  );

  assert.deepEqual(toolCalls(events), []);
  assert.equal(incomplete, true);
});

test('parallel calls are emitted in index order regardless of fragment order', () => {
  const { events } = decode(
    delta({
      tool_calls: [
        { index: 0, id: 'call_a', function: { name: 'read_file', arguments: '' } },
        { index: 1, id: 'call_b', function: { name: 'read_file', arguments: '' } },
      ],
    }) +
      // index 1 completes first on the wire; index order is what we emit by.
      delta({ tool_calls: [{ index: 1, function: { arguments: '{"path":"b.ts"}' } }] }) +
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] }) +
      delta({}, 'tool_calls') +
      DONE,
  );

  assert.deepEqual(
    toolCalls(events).map((c) => [c.id, c.args]),
    [
      ['call_a', { path: 'a.ts' }],
      ['call_b', { path: 'b.ts' }],
    ],
  );
});

test('a gateway that omits the id gets a synthesized one', () => {
  const body =
    delta({ tool_calls: [{ index: 0, function: { name: 'list_files', arguments: '{}' } }] }) +
    delta({}, 'tool_calls') +
    DONE;

  const first = toolCalls(decode(body).events)[0]?.id;
  assert.match(String(first), /^call_[0-9a-f]{8}_0$/);

  // The id must be unique across decoders, not merely within one. Ids are
  // resolved task-wide by planRecovery and buildHandoff, so a second turn that
  // re-issued `call_0` would look like the first turn's call had already been
  // settled, and its effect would be silently skipped.
  const second = toolCalls(decode(body).events)[0]?.id;
  assert.notEqual(first, second);
});

test('a call still buffered at [DONE] is flushed by the sentinel', () => {
  // Some compatible servers never send finish_reason. The sentinel means nothing
  // more is coming, so the arguments are as complete as they will ever be.
  const { events, incomplete } = decode(
    delta({
      tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    }) + DONE,
  );

  assert.deepEqual(toolCalls(events), [
    { t: 'tool_call', id: 'call_abc', name: 'read_file', args: { path: 'a.ts' } },
  ]);
  assert.equal(incomplete, false);
});

test('finish_reason flushes before [DONE], and [DONE] does not re-emit the call', () => {
  const { events } = decode(
    delta({
      tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'read_file', arguments: '{}' } }],
    }) +
      delta({}, 'tool_calls') +
      DONE,
  );

  assert.equal(toolCalls(events).length, 1);
  // A duplicated tool call here is a duplicated side effect downstream.
  assert.equal(events.filter((e) => e.t === 'tool_call').length, 1);
});

test('a repeated [DONE] does not produce a second done event', () => {
  const { events } = decode(delta({ content: 'hi' }) + delta({}, 'stop') + DONE + DONE);

  assert.equal(dones(events).length, 1);
  assert.equal(usages(events).length, 1);
});

test('reasoning content is surfaced as thinking, not as answer text', () => {
  const { events } = decode(
    delta({ reasoning_content: 'considering' }) +
      delta({ content: 'answer' }) +
      delta({}, 'stop') +
      DONE,
  );

  assert.equal(thinking(events), 'considering');
  assert.equal(text(events), 'answer');
});

test('the reasoning alias is accepted too', () => {
  const { events } = decode(delta({ reasoning: 'alias form' }) + delta({}, 'stop') + DONE);

  assert.equal(thinking(events), 'alias form');
});

test('a top-level error object inside a 200 stream throws ProviderStreamError', () => {
  // OpenRouter and similar gateways report upstream failures this way after the
  // headers have already claimed success.
  assert.throws(
    () =>
      decodeStrict(
        delta({ content: 'starting' }) +
          chunk({ error: { message: 'upstream provider is overloaded', type: 'server_error' } }),
      ),
    (thrown: unknown) => {
      assert.ok(thrown instanceof ProviderStreamError);
      assert.equal(thrown.message, 'upstream provider is overloaded');
      assert.equal(thrown.providerType, 'server_error');
      return true;
    },
  );
});

test('an unparseable chunk throws rather than being skipped', () => {
  assert.throws(() => decodeStrict('data: {not json}\n\n'), ProviderStreamError);
});

test('a call that never provided a name throws instead of guessing', () => {
  assert.throws(
    () =>
      decodeStrict(
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] }) +
          delta({}, 'tool_calls'),
      ),
    /never provided a name/,
  );
});

test('a call whose accumulated arguments do not parse throws', () => {
  assert.throws(
    () =>
      decodeStrict(
        delta({
          tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'write_file', arguments: '{"path":' } }],
        }) + delta({}, 'tool_calls'),
      ),
    /unparseable arguments/,
  );
});

test('a fragment with no index is dropped as unattributable', () => {
  // Without an index there is no way to tell which parallel call it belongs to,
  // and attaching it to a guess would corrupt real arguments.
  const { events } = decode(
    delta({
      tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    }) +
      delta({ tool_calls: [{ function: { arguments: 'garbage' } }] }) +
      delta({}, 'tool_calls') +
      DONE,
  );

  assert.deepEqual(toolCalls(events), [
    { t: 'tool_call', id: 'call_a', name: 'read_file', args: { path: 'a.ts' } },
  ]);
});

test('finish reasons map onto the normalized set', () => {
  const cases: ReadonlyArray<readonly [string | null, string]> = [
    ['stop', 'stop'],
    ['tool_calls', 'tool_use'],
    ['function_call', 'tool_use'],
    ['length', 'length'],
    // A content filter did not finish the task, so it is not a clean stop.
    ['content_filter', 'truncated'],
    [null, 'truncated'],
  ];

  for (const [raw, expected] of cases) {
    const { events } = decode(delta({ content: 'x' }, raw) + DONE);
    assert.equal(dones(events)[0]?.reason, expected, `finish_reason ${String(raw)}`);
  }
});

test('usage is read from prompt_tokens and completion_tokens', () => {
  const { events } = decode(delta({ content: 'x' }, 'stop') + USAGE_CHUNK + DONE);

  assert.deepEqual(usages(events), [{ t: 'usage', inputTokens: 31, outputTokens: 7 }]);
});

test('a chunk with no usage still reports a usage event, at zero', () => {
  // Downstream cost accounting needs a number it can trust to be "unreported"
  // rather than a missing field it has to guess about.
  const { events } = decode(delta({ content: 'x' }, 'stop') + DONE);

  assert.deepEqual(usages(events), [{ t: 'usage', inputTokens: 0, outputTokens: 0 }]);
});

test('an empty data line is ignored', () => {
  const { events, incomplete } = decode('data:\n\n' + delta({ content: 'x' }, 'stop') + DONE);

  assert.equal(text(events), 'x');
  assert.equal(incomplete, false);
});

test('the adapter records which compatible provider ran', () => {
  const capabilities: ModelCapabilities = {
    streaming: true,
    toolCalling: true,
    parallelToolCalls: true,
    vision: false,
    reasoning: 'none',
    structuredOutput: true,
    contextWindow: 128_000,
    maxOutput: 16_384,
    costPerMTokIn: 0,
    costPerMTokOut: 0,
  };
  const adapter = new OpenAiCompatibleAdapter('openrouter', { 'vendor/model': capabilities });

  // One decoder serves every OpenAI-shaped endpoint, but the ledger has to know
  // which one actually served the request.
  assert.equal(adapter.providerId, 'openrouter');
  assert.deepEqual(adapter.capabilities('vendor/model'), capabilities);
  assert.equal(adapter.capabilities('vendor/unknown'), null);
  assert.deepEqual(adapter.models(), [{ providerId: 'openrouter', modelId: 'vendor/model' }]);
});

test('an adapter with no capability data claims no models', () => {
  const adapter = new OpenAiCompatibleAdapter('local');

  assert.deepEqual(adapter.models(), []);
  assert.equal(adapter.capabilities('llama'), null);
  assert.equal(adapter.createDecoder().finish().incomplete, true);
});

test('signing defaults to a bearer token and leaves the rest of the request alone', () => {
  const unsigned = {
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"model":"gpt"}',
  };

  const signed = new OpenAiCompatibleAdapter('openai').sign(unsigned, 'sk-oa');

  assert.equal(signed.headers?.['authorization'], 'Bearer sk-oa');
  assert.equal(signed.headers?.['content-type'], 'application/json');
  assert.equal(signed.url, unsigned.url);
  assert.equal(signed.body, unsigned.body);
  // Not mutated in place, so the caller cannot end up holding the secret.
  assert.equal(Object.hasOwn(unsigned.headers, 'authorization'), false);
});

test('a builder cannot override the credential rotation selected', () => {
  const signed = new OpenAiCompatibleAdapter('openai').sign(
    { url: 'https://api.openai.com/v1/chat/completions', headers: { authorization: 'Bearer stale' } },
    'sk-fresh',
  );

  assert.equal(signed.headers?.['authorization'], 'Bearer sk-fresh');
});

test('an endpoint that authenticates differently needs a signer, not a subclass', () => {
  // Azure OpenAI is the motivating case: same chunk format, but the key goes in
  // an `api-key` header and the deployment requires `api-version` in the query
  // string. A header-only auth hook could not express the second half, which is
  // why `sign` receives the whole request.
  const azure = new OpenAiCompatibleAdapter('azure-openai', {}, (request, secret) => ({
    ...request,
    url: `${request.url}?api-version=2024-10-21`,
    headers: { ...(request.headers ?? {}), 'api-key': secret },
  }));

  const signed = azure.sign(
    { url: 'https://acct.openai.azure.com/openai/deployments/gpt/chat/completions' },
    'azure-secret',
  );

  assert.equal(
    signed.url,
    'https://acct.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21',
  );
  assert.equal(signed.headers?.['api-key'], 'azure-secret');
  assert.equal(signed.headers?.['authorization'], undefined);
  // The wire format is unchanged, which is the point of reusing this adapter.
  assert.equal(azure.createDecoder() instanceof OpenAiDecoder, true);
});

test('a local runtime can decline to send a credential at all', () => {
  // Ollama and vLLM commonly accept no key. Sending `Bearer undefined` is worse
  // than sending nothing, and this is the seam that avoids it.
  const local = new OpenAiCompatibleAdapter('local', {}, (request) => request);
  const signed = local.sign({ url: 'http://127.0.0.1:11434/v1/chat/completions' }, 'ignored');

  assert.equal(signed.headers, undefined);
});
