import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_PRESETS } from '../../src/providers/presets.js';
import { ModelCatalog } from '../../src/providers/catalog.js';
import { resolveModelAlias } from '../../src/providers/aliases.js';
import { buildCapabilityMatrix, determineStructuredOutputStrategy } from '../../src/providers/detection.js';
import { ProviderPlayground } from '../../src/providers/playground.js';
import type { Candidate } from '../../src/policy/route.js';

test('every provider preset maps to a wire format CodeRelay implements', () => {
  // A descriptor table once declared eight "supported protocols" while only
  // three adapters existed, so `CUSTOM_REST` and `OPENAI_RESPONSES` were listed
  // as supported with nothing behind them. The real contract is narrower and
  // checkable: every preset must name a kind an adapter actually handles.
  const implemented = new Set(['anthropic', 'openai', 'gemini']);
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(
      implemented.has(preset.kind),
      `${preset.key} declares kind "${preset.kind}", which has no adapter`,
    );
  }
});

test('the setup wizard offers every standard provider', () => {
  // Asserted against `presets.ts`, which is what the guided setup actually
  // reads. A second provider list existed and said the same thing; two lists of
  // what CodeRelay supports is one more than can stay correct.
  const ids = PROVIDER_PRESETS.map((p) => p.key);
  assert.ok(ids.includes('anthropic'));
  assert.ok(ids.includes('openai'));
  assert.ok(ids.includes('gemini'));
  assert.ok(ids.includes('nvidia'));
  assert.ok(ids.includes('openrouter'));
  assert.ok(ids.includes('azure'));
  assert.ok(ids.includes('ollama'));
  assert.ok(ids.includes('lmstudio'));
  assert.ok(ids.includes('deepseek'));
  assert.ok(ids.includes('groq'));
  assert.ok(ids.includes('cerebras'));
  assert.ok(ids.includes('fireworks'));
});

test('a custom OpenAI-compatible endpoint configures through the real catalog', () => {
  // The wired path for custom providers is `ModelCatalog`, which reads the
  // provider list from settings. A separate registry would be a second place
  // that decides what a provider is, and the two would eventually disagree
  // about which endpoints exist.
  const catalog = ModelCatalog.of(
    [
      {
        id: 'my-vllm',
        kind: 'openai',
        baseUrl: 'https://vllm.internal.corp/v1',
        auth: 'bearer',
      },
    ],
    [
      {
        provider: 'my-vllm',
        model: 'llama-3-70b',
        contextWindow: 128_000,
        maxOutput: 4_096,
        toolCalling: true,
      },
    ],
  );

  assert.equal(catalog.isConfigured(), true);
  const provider = catalog.provider('my-vllm');
  assert.ok(provider !== null);
  assert.equal(provider.baseUrl, 'https://vllm.internal.corp/v1');

  // The provider record carries no secret: keys live in SecretStorage and are
  // referenced by id, so a configuration blob is safe to share or commit.
  const serialised = JSON.stringify(provider);
  assert.ok(!/sk-|secret|token|apiKey/i.test(serialised), 'a provider profile must hold no key');
});

test('capability detection and structured output fallback hierarchy', () => {
  assert.equal(
    determineStructuredOutputStrategy({
      streaming: true,
      toolCalling: true,
      parallelToolCalls: false,
      vision: false,
      reasoning: 'none',
      structuredOutput: true,
      contextWindow: 128000,
      maxOutput: 4096,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
    }),
    'native_json_schema',
  );

  assert.equal(
    determineStructuredOutputStrategy({
      streaming: true,
      toolCalling: true,
      parallelToolCalls: false,
      vision: false,
      reasoning: 'none',
      structuredOutput: false,
      contextWindow: 128000,
      maxOutput: 4096,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
    }),
    'tool_schema_enforcement',
  );

  assert.equal(
    determineStructuredOutputStrategy({
      streaming: true,
      toolCalling: false,
      parallelToolCalls: false,
      vision: false,
      reasoning: 'none',
      structuredOutput: false,
      contextWindow: 128000,
      maxOutput: 4096,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
    }),
    'constrained_json_prompt',
  );
});

test('model alias system resolves logical aliases correctly', () => {
  const candidates: Candidate[] = [
    {
      model: { providerId: 'anthropic', modelId: 'claude-3-7-sonnet' },
      readyCredentialIds: ['cred-1'],
      coolingRetryAfterMs: null,
      capabilities: {
        streaming: true,
        toolCalling: true,
        parallelToolCalls: false,
        vision: true,
        reasoning: 'explicit',
        structuredOutput: true,
        contextWindow: 200_000,
        maxOutput: 8_192,
        costPerMTokIn: 3,
        costPerMTokOut: 15,
      },
    },
    {
      model: { providerId: 'google', modelId: 'gemini-1.5-flash' },
      readyCredentialIds: ['cred-2'],
      coolingRetryAfterMs: null,
      capabilities: {
        streaming: true,
        toolCalling: true,
        parallelToolCalls: false,
        vision: true,
        reasoning: 'none',
        structuredOutput: true,
        contextWindow: 1_000_000,
        maxOutput: 8_192,
        costPerMTokIn: 0.35,
        costPerMTokOut: 1.05,
      },
    },
    {
      model: { providerId: 'ollama', modelId: 'qwen2.5-coder' },
      readyCredentialIds: ['cred-3'],
      coolingRetryAfterMs: null,
      capabilities: {
        streaming: true,
        toolCalling: true,
        parallelToolCalls: false,
        vision: false,
        reasoning: 'none',
        structuredOutput: false,
        contextWindow: 32_000,
        maxOutput: 4_096,
        costPerMTokIn: 0,
        costPerMTokOut: 0,
      },
    },
  ];

  const bestCoder = resolveModelAlias('best-coder', candidates);
  assert.equal(bestCoder.resolvedModel?.modelId, 'claude-3-7-sonnet');

  const fast = resolveModelAlias('fast', candidates);
  assert.equal(fast.resolvedModel?.modelId, 'gemini-1.5-flash');

  const local = resolveModelAlias('local', candidates);
  assert.equal(local.resolvedModel?.modelId, 'qwen2.5-coder');

  const longCtx = resolveModelAlias('long-context', candidates);
  assert.equal(longCtx.resolvedModel?.modelId, 'gemini-1.5-flash');
});

test('provider playground runs capability tests', async () => {
  const playground = new ProviderPlayground();
  const connResult = await playground.runTest('anthropic', 'claude-3-7-sonnet', 'connection');
  assert.ok(connResult.success);
  assert.ok(connResult.durationMs > 0);
  assert.match(connResult.outputSnippet ?? '', /reachable/i);
});
