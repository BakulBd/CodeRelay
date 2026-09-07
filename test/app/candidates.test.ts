/**
 * What the router is allowed to see.
 *
 * `buildCandidates` is the single list `route()`, `selectModel` and the Models
 * view all work from, so a key it wrongly reports as ready becomes a model the
 * router picks and the request then fails on. Two rules matter here, and one of
 * them was broken:
 *
 *  - a key the user switched off is not ready. `CredentialManager.next()`
 *    refused it, but `buildCandidates` never checked `userDisabled`, so the
 *    router counted it as available and could pick a model that cannot run;
 *  - a provider backing off blocks every one of its keys at once, because an
 *    account-level 429 is not fixed by rotating to another key on that account.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCandidates } from '../../src/app/session.js';
import { ModelCatalog } from '../../src/providers/catalog.js';
import {
  CredentialManager,
  type MetadataStore,
  type SecretStore,
} from '../../src/credentials/store.js';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');

function catalog(): ModelCatalog {
  return ModelCatalog.of(
    [{ id: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: 'api-key-header' }],
    [
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        contextWindow: 200_000,
        maxOutput: 8_192,
        toolCalling: true,
      },
    ],
  );
}

function manager(): CredentialManager {
  const secrets = new Map<string, string>();
  const meta = new Map<string, unknown>();
  const secretStore: SecretStore = {
    get: async (k) => secrets.get(k),
    store: async (k, v) => void secrets.set(k, v),
    delete: async (k) => void secrets.delete(k),
  };
  const metadata: MetadataStore = {
    get: <T,>(k: string) => meta.get(k) as T | undefined,
    update: async (k, v) => void meta.set(k, v),
  };
  let n = 0;
  return new CredentialManager({
    secrets: secretStore,
    metadata,
    newId: () => `cred-${++n}`,
    now: () => NOW,
  });
}

test('a key the user switched off is not offered to the router', async () => {
  const credentials = manager();
  const only = await credentials.add('anthropic', 'only key', 'k1');

  const before = buildCandidates(catalog(), credentials, NOW);
  assert.deepEqual(before[0]?.readyCredentialIds, [only.credentialId]);

  await credentials.setEnabled(only.credentialId, false);

  const after = buildCandidates(catalog(), credentials, NOW);
  assert.deepEqual(
    after[0]?.readyCredentialIds,
    [],
    'the router must not pick a model whose only key the pool would refuse',
  );
});

test('buildCandidates and CredentialManager agree about what is usable', async () => {
  const credentials = manager();
  const a = await credentials.add('anthropic', 'a', 'k1');
  await credentials.add('anthropic', 'b', 'k2');
  await credentials.setEnabled(a.credentialId, false);

  const ready = buildCandidates(catalog(), credentials, NOW)[0]?.readyCredentialIds ?? [];
  const chosen = await credentials.next('anthropic');

  assert.ok(chosen.t === 'credential');
  assert.ok(
    ready.includes(chosen.ref.credentialId),
    'the key the pool hands out must be one the router was told about',
  );
  assert.equal(ready.includes(a.credentialId), false);
});

test('a provider backing off makes every one of its keys unavailable', async () => {
  const credentials = manager();
  await credentials.add('anthropic', 'a', 'k1');
  await credentials.add('anthropic', 'b', 'k2');

  const cooling = buildCandidates(catalog(), credentials, NOW, () => 30_000);

  assert.deepEqual(
    cooling[0]?.readyCredentialIds,
    [],
    'an account-level 429 is not fixed by rotating to another key on that account',
  );
  assert.equal(cooling[0]?.coolingRetryAfterMs, 30_000, 'and the wait is reported');
});

test('no provider backoff leaves the keys alone', async () => {
  const credentials = manager();
  await credentials.add('anthropic', 'a', 'k1');

  const normal = buildCandidates(catalog(), credentials, NOW, () => 0);
  assert.equal(normal[0]?.readyCredentialIds.length, 1);
  assert.equal(normal[0]?.coolingRetryAfterMs, null);
});

test('omitting the cooldown callback keeps the original behaviour', async () => {
  const credentials = manager();
  await credentials.add('anthropic', 'a', 'k1');

  assert.deepEqual(
    buildCandidates(catalog(), credentials, NOW).map((c) => c.readyCredentialIds.length),
    buildCandidates(catalog(), credentials, NOW, () => 0).map((c) => c.readyCredentialIds.length),
  );
});
