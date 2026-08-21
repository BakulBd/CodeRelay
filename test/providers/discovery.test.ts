/**
 * Model discovery.
 *
 * Two properties are worth pinning here. The first is that each provider's
 * envelope is parsed as documented rather than by hopeful duck-typing. The
 * second is the one that keeps the rest of the system honest: discovery learns
 * *ids* and nothing else, so a listing can never quietly populate a context
 * window the router will later gate failover on.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverModels, parseListing } from '../../src/providers/discovery.js';
import type { ProviderConfig } from '../../src/providers/catalog.js';
import type { ProviderAdapter } from '../../src/providers/adapter.js';

const OPENAI: ProviderConfig = { id: 'openai', kind: 'openai', baseUrl: 'https://api.example/v1' };
const ANTHROPIC: ProviderConfig = { id: 'a', kind: 'anthropic', baseUrl: 'https://api.example' };
const GEMINI: ProviderConfig = { id: 'g', kind: 'gemini', baseUrl: 'https://api.example' };

/** Records what it was asked for and answers with a canned response. */
function harness(response: { status: number; body?: string }, capture?: { url?: string }) {
  const adapter = {
    sign: (req: { url: string; headers?: Record<string, string> }, secret: string) => ({
      ...req,
      headers: { ...(req.headers ?? {}), authorization: `Bearer ${secret}` },
    }),
  } as unknown as ProviderAdapter;

  const fetchImpl = async (url: string) => {
    if (capture !== undefined) {
      capture.url = url;
    }
    return {
      status: response.status,
      headers: new Map(),
      text: async () => response.body ?? '',
      body: null,
    };
  };
  return { adapter, fetchImpl: fetchImpl as never, secret: 'sk-test' };
}

test('an OpenAI-compatible listing yields its ids', async () => {
  const seen: { url?: string } = {};
  const result = await discoverModels(
    OPENAI,
    harness({ status: 200, body: JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }) }, seen),
  );
  assert.deepEqual(result, { kind: 'ok', modelIds: ['a', 'b'] });
  assert.equal(seen.url, 'https://api.example/v1/models');
});

test('Anthropic uses the same envelope but a versioned path', async () => {
  const seen: { url?: string } = {};
  const result = await discoverModels(
    ANTHROPIC,
    harness({ status: 200, body: JSON.stringify({ data: [{ id: 'claude-x' }] }) }, seen),
  );
  assert.deepEqual(result, { kind: 'ok', modelIds: ['claude-x'] });
  assert.equal(seen.url, 'https://api.example/v1/models');
});

test('Gemini returns qualified names, and the prefix is stripped', () => {
  const ids = parseListing(GEMINI, {
    models: [{ name: 'models/gemini-x' }, { name: 'models/gemini-y' }, { name: 'bare' }],
  });
  assert.deepEqual(ids, ['gemini-x', 'gemini-y', 'bare']);
});

test('a Gemini listing is requested against the configured api version', async () => {
  const seen: { url?: string } = {};
  await discoverModels(
    { ...GEMINI, apiVersion: 'v1' },
    harness({ status: 200, body: JSON.stringify({ models: [] }) }, seen),
  );
  assert.equal(seen.url, 'https://api.example/v1/models');
});

test('an empty list is a successful answer, not a failure', async () => {
  const result = await discoverModels(
    OPENAI,
    harness({ status: 200, body: JSON.stringify({ data: [] }) }),
  );
  assert.deepEqual(result, { kind: 'ok', modelIds: [] });
});

test('a body that is not a listing is a failure, not an empty list', async () => {
  const result = await discoverModels(OPENAI, harness({ status: 200, body: '{"hello":1}' }));
  assert.equal(result.kind, 'failed');
});

test('malformed JSON does not throw', async () => {
  const result = await discoverModels(OPENAI, harness({ status: 200, body: '<html>nope' }));
  assert.equal(result.kind, 'failed');
});

test('each failing status gets an explanation the user can act on', async () => {
  for (const [status, pattern] of [
    [401, /rejected/i],
    [403, /not permitted/i],
    [404, /base URL/i],
    [429, /rate limited/i],
    [500, /returned 500/],
  ] as const) {
    const result = await discoverModels(OPENAI, harness({ status, body: '{}' }));
    assert.equal(result.kind, 'failed', `status ${status}`);
    if (result.kind === 'failed') {
      assert.match(result.reason, pattern, `status ${status}`);
    }
  }
});

test('a failure reason never echoes the response body, which can carry a key', async () => {
  const leaky = JSON.stringify({ error: { message: 'bad key sk-live-SECRET123' } });
  const result = await discoverModels(OPENAI, harness({ status: 401, body: leaky }));
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') {
    assert.ok(!result.reason.includes('SECRET123'));
  }
});

test('the credential reaches the request only through the adapter', async () => {
  let sentAuth: string | undefined;
  const adapter = {
    sign: (req: { url: string; headers?: Record<string, string> }, secret: string) => ({
      ...req,
      headers: { ...(req.headers ?? {}), authorization: `Bearer ${secret}` },
    }),
  } as unknown as ProviderAdapter;
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
    sentAuth = init.headers['authorization'];
    return { status: 200, headers: new Map(), text: async () => '{"data":[]}', body: null };
  }) as never;

  await discoverModels(OPENAI, { adapter, fetchImpl, secret: 'sk-test' });
  assert.equal(sentAuth, 'Bearer sk-test');
});

test('a transport failure is reported in words, not as an error code', async () => {
  const adapter = { sign: (r: unknown) => r } as unknown as ProviderAdapter;
  const fetchImpl = (async () => {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  }) as never;

  const result = await discoverModels(OPENAI, { adapter, fetchImpl, secret: 'x' });
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') {
    assert.match(result.reason, /connection was refused/i);
    assert.ok(!result.reason.includes('ECONNREFUSED'));
  }
});
