/**
 * Credential storage and rotation.
 *
 * The properties worth guarding here are about what *must not* happen: a secret
 * must not leak into metadata, a revoked key must not be retried on a timer, and
 * a failure that had nothing to do with the credential must not count against
 * it. The last one matters more than it looks — penalising a key for every
 * network blip would eventually disable a whole account's worth of valid keys.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CredentialManager,
  METADATA_KEY,
  type CredentialRecord,
  type MetadataStore,
  type SecretStore,
} from '../../src/credentials/store.js';
import type { Classification } from '../../src/recovery/classify.js';

/** In-memory doubles standing in for SecretStorage and a Memento. */
class FakeSecrets implements SecretStore {
  readonly entries = new Map<string, string>();
  readonly deleted: string[] = [];

  async get(key: string): Promise<string | undefined> {
    return this.entries.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.entries.delete(key);
  }
}

class FakeMetadata implements MetadataStore {
  readonly entries = new Map<string, unknown>();
  /**
   * Delay applied inside `update`, in event-loop turns.
   *
   * A real `Memento.update` is asynchronous, so a write is not visible to the
   * next reader the instant it is requested. Zero here would make every
   * read-modify-write atomic by accident and hide exactly the race worth
   * testing.
   */
  ticks = 0;

  get<T>(key: string): T | undefined {
    return this.entries.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    // Snapshot before yielding: a caller must not be able to mutate the array
    // it handed over while the write is in flight.
    const snapshot = JSON.parse(JSON.stringify(value));
    for (let i = 0; i < this.ticks; i += 1) {
      await Promise.resolve();
    }
    // Round-trip through JSON the way a real Memento persists, so anything
    // unserializable would fail here rather than in production.
    this.entries.set(key, snapshot);
  }
}

interface Harness {
  readonly manager: CredentialManager;
  readonly secrets: FakeSecrets;
  readonly metadata: FakeMetadata;
  setNow(ms: number): void;
}

function harness(startMs = Date.parse('2026-01-01T00:00:00Z')): Harness {
  const secrets = new FakeSecrets();
  const metadata = new FakeMetadata();
  let now = startMs;
  let counter = 0;

  const manager = new CredentialManager({
    secrets,
    metadata,
    now: () => now,
    newId: () => {
      counter += 1;
      return `cred_${counter}`;
    },
  });

  return {
    manager,
    secrets,
    metadata,
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

const AUTH_FAILURE: Classification = {
  errorClass: 'AUTH',
  requestRetryable: true,
  retryAfterMs: null,
  rotateCredential: true,
  reason: 'Credential rejected (401). Rotating to the next key.',
};

const THROTTLED: Classification = {
  errorClass: 'RETRYABLE',
  requestRetryable: true,
  retryAfterMs: 5_000,
  rotateCredential: true,
  reason: 'Provider returned 429.',
};

const NETWORK_FAILURE: Classification = {
  errorClass: 'NETWORK',
  requestRetryable: true,
  retryAfterMs: 2_000,
  rotateCredential: false,
  reason: 'Network failure (ECONNRESET).',
};

test('an added credential is retrievable and its secret lives only in SecretStorage', async () => {
  const h = harness();
  const ref = await h.manager.add('anthropic', 'personal key', 'sk-ant-secret');

  assert.equal(ref.providerId, 'anthropic');
  assert.equal(ref.credentialId, 'cred_1');
  assert.equal(ref.label, 'personal key');

  // The key material must not be anywhere in the metadata store.
  const serialized = JSON.stringify([...h.metadata.entries.values()]);
  assert.doesNotMatch(serialized, /sk-ant-secret/);
  assert.equal(h.secrets.entries.get('coderelay.secret.cred_1'), 'sk-ant-secret');
});

test('a CredentialRef never carries key material', async () => {
  const h = harness();
  const ref = await h.manager.add('openai', 'work', 'sk-openai-secret');

  assert.doesNotMatch(JSON.stringify(ref), /sk-openai-secret/);
  assert.deepEqual(Object.keys(ref).sort(), ['credentialId', 'label', 'providerId']);
});

test('a surrounding-whitespace paste is trimmed before storage', async () => {
  // Copying a key out of a dashboard usually brings a newline with it, and a
  // trailing newline in an auth header is a 401 that looks like a bad key.
  const h = harness();
  await h.manager.add('openai', 'work', '  sk-padded\n');

  assert.equal(h.secrets.entries.get('coderelay.secret.cred_1'), 'sk-padded');
});

test('an empty credential is refused rather than stored', async () => {
  const h = harness();
  await assert.rejects(() => h.manager.add('openai', 'blank', '   '), /cannot be empty/);
  assert.equal(h.manager.records().length, 0);
});

test('a blank label falls back to something identifiable', async () => {
  const h = harness();
  const ref = await h.manager.add('openrouter', '  ', 'sk-x');

  assert.equal(ref.label, 'openrouter key');
});

test('next returns the stored secret and records the use', async () => {
  const h = harness();
  await h.manager.add('anthropic', 'personal', 'sk-ant-1');

  const choice = await h.manager.next('anthropic');

  assert.equal(choice.t, 'credential');
  assert.ok(choice.t === 'credential');
  assert.equal(choice.secret, 'sk-ant-1');
  assert.equal(choice.ref.credentialId, 'cred_1');
  assert.equal(h.manager.find('cred_1')?.lastUsedAt, '2026-01-01T00:00:00.000Z');
});

test('no credential for a provider is reported, not thrown', async () => {
  const h = harness();
  await h.manager.add('anthropic', 'personal', 'sk-ant-1');

  const choice = await h.manager.next('openai');

  assert.equal(choice.t, 'none');
  assert.ok(choice.t === 'none');
  assert.match(choice.reason, /No credential is configured for openai/);
});

test('rotation spreads work across keys instead of hammering the first', async () => {
  const h = harness();
  await h.manager.add('openai', 'one', 'sk-1');
  await h.manager.add('openai', 'two', 'sk-2');

  const first = await h.manager.next('openai');
  h.setNow(Date.parse('2026-01-01T00:00:10Z'));
  const second = await h.manager.next('openai');
  h.setNow(Date.parse('2026-01-01T00:00:20Z'));
  const third = await h.manager.next('openai');

  assert.ok(first.t === 'credential' && second.t === 'credential' && third.t === 'credential');
  // Least-recently-used, so the two keys alternate.
  assert.equal(first.ref.credentialId, 'cred_1');
  assert.equal(second.ref.credentialId, 'cred_2');
  assert.equal(third.ref.credentialId, 'cred_1');
});

test('a rejected credential is disabled, not merely cooled', async () => {
  // A revoked key retried on a timer is how an account gets flagged for abuse,
  // so this needs a human rather than a backoff.
  const h = harness();
  await h.manager.add('openai', 'revoked', 'sk-dead');
  await h.manager.add('openai', 'good', 'sk-live');

  await h.manager.reportFailure('cred_1', AUTH_FAILURE);

  const record = h.manager.find('cred_1');
  assert.equal(record?.disabledReason, AUTH_FAILURE.reason);
  assert.equal(record?.coolingUntil, null);

  // Rotation moves on, and never comes back to the dead key.
  for (let i = 0; i < 3; i += 1) {
    h.setNow(Date.parse('2026-01-01T00:00:00Z') + i * 10_000);
    const choice = await h.manager.next('openai');
    assert.ok(choice.t === 'credential');
    assert.equal(choice.ref.credentialId, 'cred_2');
  }
});

test('every credential rejected means no key, with an actionable reason', async () => {
  const h = harness();
  await h.manager.add('openai', 'one', 'sk-1');
  await h.manager.reportFailure('cred_1', AUTH_FAILURE);

  const choice = await h.manager.next('openai');

  assert.ok(choice.t === 'none');
  assert.match(choice.reason, /disabled after being rejected/);
});

test('a throttled credential cools for the delay the provider asked for', async () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const h = harness(start);
  await h.manager.add('openai', 'one', 'sk-1');
  await h.manager.add('openai', 'two', 'sk-2');

  await h.manager.reportFailure('cred_1', THROTTLED);

  assert.equal(h.manager.find('cred_1')?.coolingUntil, start + 5_000);
  // Still valid, so it is not disabled — just busy.
  assert.equal(h.manager.find('cred_1')?.disabledReason, null);

  const during = await h.manager.next('openai');
  assert.ok(during.t === 'credential');
  assert.equal(during.ref.credentialId, 'cred_2');

  // Once the cooldown expires it rejoins the pool.
  h.setNow(start + 6_000);
  await h.manager.reportFailure('cred_2', THROTTLED);
  h.setNow(start + 12_000);
  const after = await h.manager.next('openai');
  assert.ok(after.t === 'credential');
  assert.equal(after.ref.credentialId, 'cred_1');
});

test('a throttle with no stated delay still gets a cooldown', async () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const h = harness(start);
  await h.manager.add('openai', 'one', 'sk-1');

  await h.manager.reportFailure('cred_1', { ...THROTTLED, retryAfterMs: null });

  assert.equal(h.manager.find('cred_1')?.coolingUntil, start + 60_000);
});

test('all credentials cooling reports when one frees up', async () => {
  // Handing back a key that is certain to fail would waste an attempt and a
  // ledger entry; the caller needs to know how long to wait instead.
  const start = Date.parse('2026-01-01T00:00:00Z');
  const h = harness(start);
  await h.manager.add('openai', 'one', 'sk-1');
  await h.manager.add('openai', 'two', 'sk-2');

  await h.manager.reportFailure('cred_1', { ...THROTTLED, retryAfterMs: 30_000 });
  await h.manager.reportFailure('cred_2', { ...THROTTLED, retryAfterMs: 10_000 });

  const choice = await h.manager.next('openai');

  assert.ok(choice.t === 'all_cooling');
  // The soonest, not the longest: that is when work can resume.
  assert.equal(choice.retryAfterMs, 10_000);
  assert.match(choice.reason, /rate limited/);
});

test('a failure unrelated to the credential does not penalise it', async () => {
  // ECONNRESET is the network's fault. Counting it against the key would slowly
  // disable every valid credential a user owns.
  const h = harness();
  await h.manager.add('openai', 'one', 'sk-1');

  await h.manager.reportFailure('cred_1', NETWORK_FAILURE);

  const record = h.manager.find('cred_1');
  assert.equal(record?.disabledReason, null);
  assert.equal(record?.coolingUntil, null);
  assert.equal(record?.consecutiveFailures, 0);
});

test('success clears the failure history', async () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const h = harness(start);
  await h.manager.add('openai', 'one', 'sk-1');
  await h.manager.reportFailure('cred_1', THROTTLED);

  await h.manager.reportSuccess('cred_1');

  const record = h.manager.find('cred_1');
  assert.equal(record?.consecutiveFailures, 0);
  assert.equal(record?.coolingUntil, null);
  assert.equal(record?.lastFailureReason, null);
});

test('a healthier credential is preferred over one with recent failures', async () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const h = harness(start);
  await h.manager.add('openai', 'flaky', 'sk-1');
  await h.manager.add('openai', 'steady', 'sk-2');

  await h.manager.reportFailure('cred_1', THROTTLED);
  h.setNow(start + 10_000); // past the cooldown, so both are eligible

  const choice = await h.manager.next('openai');

  assert.ok(choice.t === 'credential');
  assert.equal(choice.ref.credentialId, 'cred_2');
});

test('a secret missing from the keychain disables that credential and moves on', async () => {
  // The user deleted the key from the OS keychain. Silently skipping it would
  // leave them wondering why a key they can see is never used.
  const h = harness();
  await h.manager.add('openai', 'ghost', 'sk-1');
  await h.manager.add('openai', 'real', 'sk-2');
  h.secrets.entries.delete('coderelay.secret.cred_1');

  const choice = await h.manager.next('openai');

  assert.ok(choice.t === 'credential');
  assert.equal(choice.ref.credentialId, 'cred_2');
  assert.match(h.manager.find('cred_1')?.disabledReason ?? '', /missing from the OS keychain/);
});

test('every secret missing is reported as no usable credential', async () => {
  const h = harness();
  await h.manager.add('openai', 'ghost', 'sk-1');
  h.secrets.entries.clear();

  const choice = await h.manager.next('openai');

  assert.ok(choice.t === 'none');
  assert.match(choice.reason, /missing/);
});

test('removing a credential deletes the record and the secret', async () => {
  const h = harness();
  await h.manager.add('openai', 'one', 'sk-1');

  assert.equal(await h.manager.remove('cred_1'), true);
  assert.equal(h.manager.records().length, 0);
  assert.equal(h.secrets.entries.has('coderelay.secret.cred_1'), false);
});

test('removing an unknown credential still clears any orphaned secret', async () => {
  // A half-removed credential must not leave key material behind.
  const h = harness();

  assert.equal(await h.manager.remove('cred_missing'), false);
  assert.ok(h.secrets.deleted.includes('coderelay.secret.cred_missing'));
});

test('re-enabling a disabled credential returns it to the pool', async () => {
  const h = harness();
  await h.manager.add('openai', 'one', 'sk-1');
  await h.manager.reportFailure('cred_1', AUTH_FAILURE);

  assert.equal(await h.manager.enable('cred_1'), true);

  const record = h.manager.find('cred_1');
  assert.equal(record?.disabledReason, null);
  assert.equal(record?.consecutiveFailures, 0);

  const choice = await h.manager.next('openai');
  assert.ok(choice.t === 'credential');
});

test('enabling an unknown credential reports failure instead of inventing one', async () => {
  const h = harness();
  assert.equal(await h.manager.enable('cred_nope'), false);
  assert.equal(h.manager.records().length, 0);
});

test('reporting on an unknown credential is a no-op', async () => {
  const h = harness();
  await h.manager.reportFailure('cred_nope', AUTH_FAILURE);
  await h.manager.reportSuccess('cred_nope');

  assert.equal(h.manager.records().length, 0);
});

test('list filters by provider and omits secrets', async () => {
  const h = harness();
  await h.manager.add('anthropic', 'a', 'sk-a');
  await h.manager.add('openai', 'b', 'sk-b');

  assert.equal(h.manager.list().length, 2);
  assert.deepEqual(
    h.manager.list('openai').map((r) => r.credentialId),
    ['cred_2'],
  );
  assert.doesNotMatch(JSON.stringify(h.manager.list()), /sk-/);
});

test('records survive a round trip through the metadata store', async () => {
  // Proof the manager reads persisted state rather than in-memory state, which
  // is what happens after a window reload.
  const h = harness();
  await h.manager.add('openai', 'one', 'sk-1');

  const persisted = h.metadata.get<CredentialRecord[]>(METADATA_KEY);
  assert.equal(persisted?.length, 1);
  assert.equal(persisted?.[0]?.credentialId, 'cred_1');

  const reloaded = new CredentialManager({ secrets: h.secrets, metadata: h.metadata });
  const choice = await reloaded.next('openai');
  assert.ok(choice.t === 'credential');
  assert.equal(choice.secret, 'sk-1');
});

test('a corrupt metadata value is treated as no credentials', async () => {
  const h = harness();
  await h.metadata.update(METADATA_KEY, 'not an array');

  assert.deepEqual(h.manager.records(), []);
  const choice = await h.manager.next('openai');
  assert.ok(choice.t === 'none');
});

test('concurrent health updates do not clobber each other', async () => {
  // The reachable version of this race: `next()` stamps `lastUsedAt` for the
  // attempt about to start while the previous attempt's `reportFailure` is still
  // stamping `coolingUntil`. Both rewrite the whole array from a value read a
  // moment earlier, so an unserialized read-modify-write drops one of them — and
  // dropping `coolingUntil` puts a rate-limited key straight back into rotation,
  // which is the one thing rotation exists to prevent.
  const start = Date.parse('2026-01-01T00:00:00Z');
  const h = harness(start);
  await h.manager.add('openai', 'one', 'sk-1');
  await h.manager.add('openai', 'two', 'sk-2');
  h.metadata.ticks = 2;

  const [, choice] = await Promise.all([
    h.manager.reportFailure('cred_1', { ...THROTTLED, retryAfterMs: 30_000 }),
    h.manager.next('openai'),
  ]);

  // `next()` selected on a snapshot taken before the cooling write landed, so it
  // still chose the key that is about to be throttled. That is a stale *read*,
  // not a lost write, and it costs at most one attempt — the loop routes the
  // resulting failure. What must not happen is either write disappearing.
  assert.ok(choice.t === 'credential');
  assert.equal(choice.ref.credentialId, 'cred_1');

  const record = h.manager.find('cred_1');
  assert.equal(record?.coolingUntil, start + 30_000);
  assert.equal(record?.lastUsedAt, '2026-01-01T00:00:00.000Z');
});

test('a credential added during a health update is not dropped by it', async () => {
  const h = harness();
  await h.manager.add('openai', 'one', 'sk-1');
  h.metadata.ticks = 2;

  await Promise.all([
    h.manager.reportFailure('cred_1', THROTTLED),
    h.manager.add('openai', 'two', 'sk-2'),
  ]);

  assert.deepEqual(
    h.manager.records().map((r) => r.credentialId),
    ['cred_1', 'cred_2'],
  );
  assert.notEqual(h.manager.find('cred_1')?.coolingUntil, null);
});

test('a removal concurrent with a health update still removes exactly one record', async () => {
  const h = harness();
  await h.manager.add('openai', 'one', 'sk-1');
  await h.manager.add('openai', 'two', 'sk-2');
  h.metadata.ticks = 2;

  const [removed] = await Promise.all([
    h.manager.remove('cred_1'),
    h.manager.reportFailure('cred_2', THROTTLED),
  ]);

  assert.equal(removed, true);
  assert.deepEqual(
    h.manager.records().map((r) => r.credentialId),
    ['cred_2'],
  );
  assert.notEqual(h.manager.find('cred_2')?.coolingUntil, null);
});

test('a failed write does not wedge later ones', async () => {
  // One rejected `update` must surface to its own caller and leave the queue
  // usable; otherwise a single transient storage error would silently freeze all
  // credential health for the rest of the session.
  const h = harness();
  await h.manager.add('openai', 'one', 'sk-1');

  const original = h.metadata.update.bind(h.metadata);
  let failNext = true;
  h.metadata.update = async (key: string, value: unknown) => {
    if (failNext) {
      failNext = false;
      throw new Error('storage unavailable');
    }
    return original(key, value);
  };

  await assert.rejects(() => h.manager.reportFailure('cred_1', THROTTLED), /storage unavailable/);
  await h.manager.reportSuccess('cred_1');

  assert.equal(h.manager.find('cred_1')?.consecutiveFailures, 0);
});

/*
 * Auth-header assertions used to live here. They are now in
 * `test/providers/anthropic.test.ts` and `test/providers/openai.test.ts`,
 * because turning a secret into a request belongs to `ProviderAdapter.sign` —
 * a header-only helper cannot express a key in a query string or a signature
 * over the body. This module's contract stops at handing out a live secret.
 */
