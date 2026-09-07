import assert from 'node:assert/strict';
import test from 'node:test';

import { DlpSanitizer, defaultDlp } from '../../src/security/dlp.js';
import { AuditLogger, auditLogger } from '../../src/security/audit.js';
import { EnterpriseRateLimiter, rateLimiter } from '../../src/security/rate-limiter.js';
import { EnterpriseProxyResolver, proxyResolver } from '../../src/security/proxy.js';

test('DLP Sanitizer redacts credentials, API keys, private keys, and JWTs', () => {
  const dlp = new DlpSanitizer();

  const input = `
    AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
    OPENAI_KEY=sk-proj-abc1234567890123456789012345678901234567890_extra
    ANTHROPIC_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789_test
    GOOGLE_KEY=AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q
    GITHUB_PAT=ghp_1234567890abcdefghijklmnopqrstuvwxyz
    DB_URL=postgres://appuser:superSecretPassword123@db.internal.corp:5432/appdb
    JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
  `;

  const result = dlp.sanitize(input);
  assert.ok(result.redactedCount >= 7, `Expected >= 7 redactions, got ${result.redactedCount}`);
  assert.ok(!result.sanitized.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!result.sanitized.includes('superSecretPassword123'));
  assert.ok(!result.sanitized.includes('sk-proj-abc1234567890123456789012345678901234567890'));
  assert.ok(!result.sanitized.includes('sk-ant-api03-'));
  assert.ok(!result.sanitized.includes('ghp_1234567890'));
  assert.ok(result.sanitized.includes('[REDACTED_AWS_ACCESS_KEY]'));
  assert.ok(result.sanitized.includes('[REDACTED_OPENAI_KEY]'));
  assert.ok(result.sanitized.includes('[REDACTED_ANTHROPIC_KEY]'));
  assert.ok(result.sanitized.includes('[REDACTED_GITHUB_TOKEN]'));
  assert.ok(result.sanitized.includes('[REDACTED_PASSWORD]'));
  assert.ok(result.sanitized.includes('[REDACTED_JWT_TOKEN]'));
});

test('DLP Sanitizer identifies sensitive file patterns', () => {
  const dlp = new DlpSanitizer();
  assert.equal(dlp.isSensitiveFile('.env'), true);
  assert.equal(dlp.isSensitiveFile('.env.production'), true);
  assert.equal(dlp.isSensitiveFile('id_rsa'), true);
  assert.equal(dlp.isSensitiveFile('certs/server.key'), true);
  assert.equal(dlp.isSensitiveFile('secret-config.json'), true);
  assert.equal(dlp.isSensitiveFile('src/app.ts'), false);
  assert.equal(dlp.isSensitiveFile('package.json'), false);
});

test('AuditLogger records structured events and automatically sanitizes details', () => {
  const logger = new AuditLogger();

  const event = logger.record({
    category: 'TASK',
    action: 'task_started',
    taskId: 'task-101',
    actor: 'user',
    details: {
      objective: 'Deploy auth with sk-proj-1234567890123456789012345678901234567890',
      safeParam: 'public_repo',
    },
    severity: 'INFO',
  });

  assert.ok(event.id.startsWith('audit-'));
  assert.equal(event.category, 'TASK');
  assert.equal(event.taskId, 'task-101');
  assert.ok(!String(event.details.objective).includes('sk-proj-1234567890'));
  assert.ok(String(event.details.objective).includes('[REDACTED_OPENAI_KEY]'));
  assert.equal(event.details.safeParam, 'public_repo');

  const filtered = logger.list({ category: 'TASK' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.id, event.id);

  const jsonl = logger.exportJsonl();
  assert.ok(jsonl.includes('"category":"TASK"'));
  assert.ok(jsonl.includes('[REDACTED_OPENAI_KEY]'));
});

test('EnterpriseRateLimiter handles jittered backoff and cooldown tracking', () => {
  const limiter = new EnterpriseRateLimiter({ baseBackoffMs: 1000, maxBackoffMs: 30000 });
  const now = 1_000_000;

  assert.equal(limiter.isRateLimited('openai', now), false);
  assert.equal(limiter.getRemainingWaitMs('openai', now), 0);

  // Record 429 with Retry-After: 15s
  const waitMs = limiter.recordRateLimit('openai', 15, now);
  assert.equal(waitMs, 15_000);
  assert.equal(limiter.isRateLimited('openai', now), true);
  assert.equal(limiter.isRateLimited('openai', now + 10_000), true);
  assert.equal(limiter.isRateLimited('openai', now + 16_000), false);
  assert.equal(limiter.getRemainingWaitMs('openai', now + 5_000), 10_000);

  // Success resets state
  limiter.recordSuccess('openai');
  assert.equal(limiter.isRateLimited('openai', now), false);

  // Generic backoff without header uses exponential backoff with floor
  const autoWait = limiter.recordRateLimit('anthropic', undefined, now);
  assert.ok(autoWait >= 500 && autoWait <= 30000);
});

test('EnterpriseProxyResolver resolves environment and NO_PROXY rules', () => {
  const resolver = new EnterpriseProxyResolver();

  const bypassRules = ['localhost', '127.0.0.1', '.internal.corp', 'mycompany.com'];
  assert.equal(resolver.shouldBypassProxy('http://localhost:11434', bypassRules), true);
  assert.equal(resolver.shouldBypassProxy('http://127.0.0.1:8080', bypassRules), true);
  assert.equal(resolver.shouldBypassProxy('https://api.internal.corp/v1', bypassRules), true);
  assert.equal(resolver.shouldBypassProxy('https://mycompany.com/llm', bypassRules), true);
  assert.equal(resolver.shouldBypassProxy('https://api.openai.com/v1', bypassRules), false);
  assert.equal(resolver.shouldBypassProxy('https://api.anthropic.com/v1', bypassRules), false);
});
