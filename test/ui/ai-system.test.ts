/**
 * AI System, Models API & Provider Diagnostics Tests.
 *
 * Verifies that:
 * 1. Provider Playground runs capability diagnostics (connection, streaming, tool calling, structured output).
 * 2. Inbound message protocol accepts and bounds all model, playground, and setup interactions.
 * 3. Presentation view model accurately surfaces configured providers, candidate models, capabilities, and health.
 * 4. Model selection changes the active starting model in the UI.
 * 5. Notification Center accurately logs diagnostic test outcomes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProviderPlayground } from '../../src/providers/playground.js';
import { parseInbound } from '../../src/ui/webview/protocol.js';
import { present } from '../../src/ui/webview/present.js';
import { NotificationCenter } from '../../src/ui/state/notifications.js';
import { DEFAULT_SETTINGS } from '../../src/ui/state/settings.js';

test('ProviderPlayground executes connection, streaming, tool call, and structured output probes', async () => {
  const playground = new ProviderPlayground();

  // Connection probe
  const connResult = await playground.runTest('anthropic', 'claude-3-7-sonnet', 'connection');
  assert.equal(connResult.testType, 'connection');
  assert.equal(connResult.success, true);
  assert.ok(connResult.durationMs >= 0);
  assert.ok(connResult.outputSnippet?.includes('Endpoint reachable'));

  // Streaming probe
  const streamResult = await playground.runTest('openai', 'gpt-4o', 'streaming');
  assert.equal(streamResult.testType, 'streaming');
  assert.equal(streamResult.success, true);
  assert.ok(streamResult.outputSnippet?.includes('stream'));

  // Tool calling probe
  const toolResult = await playground.runTest('gemini', 'gemini-1.5-pro', 'tool_call');
  assert.equal(toolResult.testType, 'tool_call');
  assert.equal(toolResult.success, true);
  assert.ok(toolResult.outputSnippet?.includes('Tool call schema'));

  // Structured output probe
  const schemaResult = await playground.runTest('ollama', 'llama3', 'structured_output');
  assert.equal(schemaResult.testType, 'structured_output');
  assert.equal(schemaResult.success, true);
  assert.ok(schemaResult.outputSnippet?.includes('JSON schema'));
});

test('Inbound protocol validates model selection, playground probes, and setup actions', () => {
  // selectModel
  assert.deepEqual(
    parseInbound({ kind: 'selectModel', providerId: 'anthropic', modelId: 'claude-3-7-sonnet' }),
    { kind: 'selectModel', providerId: 'anthropic', modelId: 'claude-3-7-sonnet' },
  );

  // runPlayground
  assert.deepEqual(
    parseInbound({ kind: 'runPlayground', providerId: 'gemini', modelId: 'gemini-1.5-pro', testType: 'tool_call' }),
    { kind: 'runPlayground', providerId: 'gemini', modelId: 'gemini-1.5-pro', testType: 'tool_call' },
  );

  // setup actions from AI System tab
  assert.deepEqual(parseInbound({ kind: 'setupOpenAdd' }), { kind: 'setupOpenAdd' });
  assert.deepEqual(parseInbound({ kind: 'setupOpenManage' }), { kind: 'setupOpenManage' });
  assert.deepEqual(parseInbound({ kind: 'setupTestConnection' }), { kind: 'setupTestConnection' });
  assert.deepEqual(
    parseInbound({ kind: 'setupEditProvider', providerId: 'anthropic' }),
    { kind: 'setupEditProvider', providerId: 'anthropic' },
  );
  assert.deepEqual(
    parseInbound({ kind: 'setupDeleteProvider', providerId: 'ollama' }),
    { kind: 'setupDeleteProvider', providerId: 'ollama' },
  );
});

test('TaskViewModel presents candidates with capabilities, active status, providers, and health', () => {
  const model = present({
    taskId: null,
    projection: null,
    live: false,
    blocked: null,
    selectedModel: { providerId: 'anthropic', modelId: 'claude-3-7-sonnet' },
    verifying: false,
    activeNavTab: 'ai',
    settings: DEFAULT_SETTINGS,
    candidates: [
      {
        model: { providerId: 'anthropic', modelId: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
        capabilities: {
          streaming: true,
          toolCalling: true,
          structuredOutputs: true,
          nativeReasoning: true,
          contextWindow: 200_000,
          maxOutput: 8_192,
        },
        isSelected: true,
      },
      {
        model: { providerId: 'openai', modelId: 'gpt-4o', label: 'GPT-4o' },
        capabilities: {
          streaming: true,
          toolCalling: true,
          structuredOutputs: true,
          nativeReasoning: false,
          contextWindow: 128_000,
          maxOutput: 4_096,
        },
        isSelected: false,
      },
    ],
    configuredProviders: [
      { id: 'anthropic', kind: 'anthropic', modelCount: 1, keyCount: 2, defaultModel: 'claude-3-7-sonnet' },
      { id: 'openai', kind: 'openai', baseUrl: 'https://api.openai.com/v1', modelCount: 1, keyCount: 1, defaultModel: 'gpt-4o' },
    ],
    health: [
      { providerId: 'anthropic/claude-3-7-sonnet', state: 'healthy', latencyMs: 310 },
      { providerId: 'openai/gpt-4o', state: 'degraded', latencyMs: 1450, lastError: 'RETRYABLE' },
    ],
  });

  // Verify candidates
  assert.equal(model.candidates.length, 2);
  assert.equal(model.candidates[0]?.isSelected, true);
  assert.equal(model.candidates[0]?.capabilities?.nativeReasoning, true);
  assert.equal(model.candidates[1]?.isSelected, false);
  assert.equal(model.candidates[1]?.capabilities?.contextWindow, 128_000);

  // Verify configured providers
  assert.equal(model.configuredProviders.length, 2);
  assert.equal(model.configuredProviders[0]?.id, 'anthropic');
  assert.equal(model.configuredProviders[0]?.keyCount, 2);
  assert.equal(model.configuredProviders[1]?.baseUrl, 'https://api.openai.com/v1');

  // Verify health records
  assert.equal(model.health.length, 2);
  assert.equal(model.health[0]?.state, 'healthy');
  assert.equal(model.health[1]?.state, 'degraded');
  assert.equal(model.health[1]?.lastError, 'RETRYABLE');
});

test('NotificationCenter accurately logs diagnostic test outcomes with model_diagnostic kind', () => {
  const center = new NotificationCenter();

  const notif = center.add({
    kind: 'model_diagnostic',
    title: '✓ Probe Passed: anthropic/claude-3-7-sonnet',
    message: 'STREAMING test passed in 142ms: Received 12 chunks via normalized stream',
  });

  assert.equal(notif.kind, 'model_diagnostic');
  assert.ok(notif.title.includes('anthropic/claude-3-7-sonnet'));
  assert.equal(center.unreadCount(), 1);
  assert.equal(center.list().length, 1);
});
