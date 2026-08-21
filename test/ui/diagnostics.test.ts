/**
 * Diagnostics reporting tests.
 *
 * Guarantees:
 * - Diagnostic reports format all system, provider, model, and error information cleanly.
 * - Empty states (no providers, no models, no errors) render helpful guidance.
 * - Secret credentials, API keys, or raw tokens are never interpolated.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDiagnosticsReport, type DiagnosticsData } from '../../src/ui/diagnostics.js';

test('diagnostics report formats system and configuration data cleanly', () => {
  const data: DiagnosticsData = {
    extVersion: '0.1.0',
    codeVersion: '1.96.0',
    storagePath: '/workspace/.vscode/coderelay',
    providers: [
      { id: 'anthropic-prod', type: 'anthropic', enabled: true },
      { id: 'ollama-local', type: 'openai-compatible', enabled: false },
    ],
    models: [
      { modelId: 'claude-3-7-sonnet', providerId: 'anthropic-prod', enabled: true },
      { modelId: 'deepseek-r1', providerId: 'ollama-local', enabled: false },
    ],
    recentErrors: [
      {
        taskName: 'Refactor login controller',
        errors: [
          { errorClass: 'PROVIDER_TIMEOUT', message: 'Endpoint stalled during stream' },
        ],
      },
    ],
  };

  const report = formatDiagnosticsReport(data);

  assert.match(report, /# CodeRelay Diagnostics/);
  assert.match(report, /CodeRelay Version:\*\* 0\.1\.0/);
  assert.match(report, /VS Code Version:\*\* 1\.96\.0/);
  assert.match(report, /Storage Path:\*\* \/workspace\/\.vscode\/coderelay/);
  assert.match(report, /Configured Providers:\*\* 2/);
  assert.match(report, /`anthropic-prod` \(anthropic\) — Enabled/);
  assert.match(report, /`ollama-local` \(openai-compatible\) — Disabled/);
  assert.match(report, /Configured Models:\*\* 2/);
  assert.match(report, /`claude-3-7-sonnet` \(via `anthropic-prod`\) — Enabled/);
  assert.match(report, /`deepseek-r1` \(via `ollama-local`\) — Disabled/);
  assert.match(report, /### Task: Refactor login controller/);
  assert.match(report, /PROVIDER_TIMEOUT:\*\* Endpoint stalled during stream/);
});

test('diagnostics report handles empty state gracefully', () => {
  const data: DiagnosticsData = {
    extVersion: '0.1.0',
    codeVersion: '1.96.0',
    storagePath: null,
    providers: [],
    models: [],
    recentErrors: [],
  };

  const report = formatDiagnosticsReport(data);

  assert.match(report, /Storage Path:\*\* Not available/);
  assert.match(report, /\(No providers configured\)/);
  assert.match(report, /\(No models configured\)/);
  assert.match(report, /No recent errors found in task history/);
});

test('diagnostics report never contains sensitive token patterns', () => {
  const data: DiagnosticsData = {
    extVersion: '0.1.0',
    codeVersion: '1.96.0',
    storagePath: '/home/user/project',
    providers: [{ id: 'custom-openai', type: 'openai', enabled: true }],
    models: [{ modelId: 'gpt-4o', providerId: 'custom-openai', enabled: true }],
    recentErrors: [],
  };

  const report = formatDiagnosticsReport(data);
  assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(report), 'report must not contain API keys');
  assert.ok(!/password|secret|bearer/i.test(report), 'report must not mention secrets');
});
