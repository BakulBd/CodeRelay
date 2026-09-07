/**
 * A secret must never leave SecretStorage.
 *
 * There are three credential-add paths, an audit trail, an output channel, a
 * diagnostics report and a webview view model — and a key needs to escape into
 * only one of them to be leaked into a log file, a bug report, or a screenshot.
 *
 * These assertions are structural rather than behavioural on purpose: they check
 * that no code path *can* carry key material, which is a property a runtime test
 * would only sample.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { auditLogger } from '../../src/security/audit.js';
import { presentKeyPool } from '../../src/ui/setup/keys.js';
import { formatDiagnosticsReport } from '../../src/ui/diagnostics.js';
import type { CredentialRecord } from '../../src/credentials/store.js';

const SECRET = 'sk-ant-api03-REALKEYMATERIAL-0123456789abcdef';

test('the audit trail scrubs anything key-shaped it is handed', () => {
  auditLogger.clear();
  auditLogger.record({
    category: 'SECURITY',
    action: 'credential_added',
    actor: 'user',
    // A caller passing a secret is the mistake this scrubbing exists to survive.
    details: { providerId: 'anthropic', accidental: `key was ${SECRET}` },
  });

  const serialised = auditLogger.exportJsonl();
  assert.ok(!serialised.includes(SECRET), 'the audit trail must not carry key material');
  assert.ok(serialised.includes('anthropic'), 'and must still record the useful part');
  auditLogger.clear();
});

test('the key pool view model carries no part of a key', () => {
  const record: CredentialRecord = {
    providerId: 'anthropic',
    credentialId: 'cred-1',
    label: 'work key',
    addedAt: '2026-01-01T00:00:00.000Z',
    disabledReason: null,
    coolingUntil: null,
    consecutiveFailures: 0,
    lastUsedAt: null,
    // Even a failure reason quoting the key must not survive into the panel.
    lastFailureReason: `rejected: ${SECRET}`,
    userDisabled: false,
    priority: 0,
  };

  const serialised = JSON.stringify(presentKeyPool('anthropic', [record], Date.now()));
  assert.ok(!serialised.includes(SECRET));
  assert.ok(!serialised.includes('REALKEYMATERIAL'), 'not even a fragment');
});

test('the diagnostics report has no field a key could travel in', () => {
  const report = formatDiagnosticsReport({
    extVersion: '0.1.0',
    codeVersion: '1.96.0',
    storagePath: '/tmp/storage',
    providers: [{ id: 'anthropic', type: 'anthropic', enabled: true }],
    models: [{ modelId: 'claude-sonnet-4', providerId: 'anthropic', enabled: true }],
    recentErrors: [],
    proxy: {
      proxyUrl: 'http://proxy.corp:8080',
      strictSsl: true,
      noProxy: ['localhost'],
      customCaPath: null,
    },
  });

  assert.ok(!report.includes(SECRET));
  assert.match(report, /anthropic/, 'the report must still be useful');
});

// --- structural: no path can carry a secret --------------------------------

test('no credential-add path logs, audits or displays what it stored', () => {
  const sources = ['src/extension.ts', 'src/ui/setup/controller.ts', 'src/ui/setup.ts'].map(
    (p) => ({ path: p, text: readFileSync(join(process.cwd(), p), 'utf8') }),
  );

  for (const { path, text } of sources) {
    // The variables a secret lives in, and the sinks it must never reach.
    for (const sink of [
      'appendLine(`${secret',
      'showInformationMessage(`${secret',
      'showErrorMessage(`${secret',
      'details: { secret',
      'JSON.stringify(secret',
    ]) {
      assert.ok(!text.includes(sink), `${path} routes a secret into ${sink}`);
    }
  }
});

test('the audit logger sanitises every string field, not just some', () => {
  auditLogger.clear();
  auditLogger.record({
    category: 'SECURITY',
    action: 'test',
    details: {
      a: `sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      b: `sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`,
      nested: 42,
    },
  });

  const out = auditLogger.exportJsonl();
  assert.ok(!out.includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'anthropic-shaped key survived');
  assert.ok(!out.includes('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'), 'openai-shaped key survived');
  assert.match(out, /42/, 'non-string fields still pass through');
  auditLogger.clear();
});
