/**
 * The credential pool view.
 *
 * Two properties carry this file. First, **no part of a key is ever shown** —
 * the panel is the easiest place to leak one and a masked key is still key
 * material. Second, the row marked "next" must agree with the key
 * `CredentialManager` would actually hand out; a panel that points at the wrong
 * key is worse than one that points at none.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { describeAge, presentKeyPool } from '../../src/ui/setup/keys.js';
import {
  CredentialManager,
  type CredentialRecord,
  type MetadataStore,
  type SecretStore,
} from '../../src/credentials/store.js';

const NOW = 1_000_000;

function record(over: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    providerId: 'anthropic',
    credentialId: 'cred-1',
    label: 'work key',
    addedAt: '2026-01-01T00:00:00.000Z',
    disabledReason: null,
    coolingUntil: null,
    consecutiveFailures: 0,
    lastUsedAt: null,
    lastFailureReason: null,
    userDisabled: false,
    priority: 0,
    ...over,
  };
}

// --- the secret never appears ---------------------------------------------

test('no part of a key reaches the view model', () => {
  const secret = 'sk-ant-SUPERSECRET-0123456789';
  const pool = presentKeyPool(
    'anthropic',
    [record({ label: 'work key', lastFailureReason: `rejected: ${secret}` })],
    NOW,
  );

  const serialised = JSON.stringify(pool);
  assert.ok(!serialised.includes(secret), 'the secret must never reach the panel');
  assert.ok(!serialised.includes('SUPERSECRET'), 'not even a fragment of it');
  assert.equal(pool.rows[0]?.label, 'work key', 'a key is identified by its label alone');
});

// --- statuses --------------------------------------------------------------

test('the four states are distinguished, each with its own glyph', () => {
  const pool = presentKeyPool(
    'anthropic',
    [
      record({ credentialId: 'a', label: 'ready', priority: 0 }),
      record({ credentialId: 'b', label: 'cooling', priority: 1, coolingUntil: NOW + 38_000 }),
      record({ credentialId: 'c', label: 'rejected', priority: 2, disabledReason: '401' }),
      record({ credentialId: 'd', label: 'off', priority: 3, userDisabled: true }),
    ],
    NOW,
  );

  assert.deepEqual(pool.rows.map((r) => r.status), ['ready', 'cooling', 'rejected', 'off']);
  assert.equal(new Set(pool.rows.map((r) => r.glyph)).size, 4, 'status must survive without colour');
  assert.equal(pool.rows[1]?.statusText, 'cooling for 38s');
});

test('a rejected key and a switched-off key do not read alike', () => {
  const rejected = presentKeyPool('anthropic', [record({ disabledReason: 'bad key' })], NOW);
  const off = presentKeyPool('anthropic', [record({ userDisabled: true })], NOW);

  assert.match(rejected.blocked ?? '', /Add a working key/);
  assert.match(off.blocked ?? '', /Turn one back on/);
  assert.notEqual(rejected.blocked, off.blocked, 'they need different fixes');
});

test('every key cooling is reported as temporary', () => {
  const pool = presentKeyPool(
    'anthropic',
    [record({ coolingUntil: NOW + 5_000 })],
    NOW,
  );
  assert.match(pool.blocked ?? '', /clears on its own/);
});

test('a usable key means the provider is not blocked', () => {
  const pool = presentKeyPool(
    'anthropic',
    [record({ credentialId: 'a' }), record({ credentialId: 'b', disabledReason: '401', priority: 1 })],
    NOW,
  );
  assert.equal(pool.blocked, null);
  assert.match(pool.summary ?? '', /2 keys · 1 ready · 1 rejected/);
});

// --- the "next" marker must be true ---------------------------------------

test('the row marked next is the key the manager would actually hand out', async () => {
  // Built through the real manager so the two orderings cannot silently drift.
  const secrets = new Map<string, string>();
  const meta = new Map<string, unknown>();
  const store: SecretStore = {
    get: async (k) => secrets.get(k),
    store: async (k, v) => void secrets.set(k, v),
    delete: async (k) => void secrets.delete(k),
  };
  const metadata: MetadataStore = {
    get: <T,>(k: string) => meta.get(k) as T | undefined,
    update: async (k, v) => void meta.set(k, v),
  };
  let n = 0;
  const manager = new CredentialManager({
    secrets: store,
    metadata,
    newId: () => `cred-${++n}`,
    now: () => NOW,
  });

  const first = await manager.add('anthropic', 'first', 'k1');
  const second = await manager.add('anthropic', 'second', 'k2');
  await manager.reorder('anthropic', [second.credentialId, first.credentialId]);

  const chosen = await manager.next('anthropic');
  assert.ok(chosen.t === 'credential');

  const pool = presentKeyPool('anthropic', manager.records(), NOW);
  const marked = pool.rows.find((r) => r.next);
  assert.equal(
    marked?.credentialId,
    chosen.ref.credentialId,
    'the panel must point at the key the pool will really use',
  );
});

test('a cooling key is never marked next', () => {
  const pool = presentKeyPool(
    'anthropic',
    [
      record({ credentialId: 'a', priority: 0, coolingUntil: NOW + 10_000 }),
      record({ credentialId: 'b', priority: 1 }),
    ],
    NOW,
  );
  assert.equal(pool.rows.find((r) => r.next)?.credentialId, 'b');
});

test('when nothing is usable no row is marked next', () => {
  const pool = presentKeyPool('anthropic', [record({ userDisabled: true })], NOW);
  assert.equal(pool.rows.some((r) => r.next), false, 'marking one would be a lie');
});

// --- ordering and controls -------------------------------------------------

test('rows are listed in the order the pool would try them', () => {
  const pool = presentKeyPool(
    'anthropic',
    [
      record({ credentialId: 'b', label: 'second', priority: 1 }),
      record({ credentialId: 'a', label: 'first', priority: 0 }),
    ],
    NOW,
  );
  assert.deepEqual(pool.rows.map((r) => r.label), ['first', 'second']);
  assert.deepEqual(pool.rows.map((r) => r.position), [1, 2]);
});

test('promoting the first key is not offered, because it would do nothing', () => {
  const pool = presentKeyPool(
    'anthropic',
    [record({ credentialId: 'a', priority: 0 }), record({ credentialId: 'b', priority: 1 })],
    NOW,
  );
  assert.equal(pool.rows[0]?.canPromote, false);
  assert.equal(pool.rows[1]?.canPromote, true);
});

test('only this provider’s keys appear', () => {
  const pool = presentKeyPool(
    'anthropic',
    [record({ credentialId: 'a' }), record({ credentialId: 'b', providerId: 'openai' })],
    NOW,
  );
  assert.equal(pool.rows.length, 1);
});

test('a provider with no keys yields no summary rather than an empty one', () => {
  const pool = presentKeyPool('anthropic', [], NOW);
  assert.deepEqual(pool.rows, []);
  assert.equal(pool.summary, null);
  assert.equal(pool.blocked, null, 'nothing configured is not the same as nothing usable');
});

// --- detail ----------------------------------------------------------------

test('recent failures and last use are reported when known', () => {
  const pool = presentKeyPool(
    'anthropic',
    [record({ consecutiveFailures: 2, lastUsedAt: new Date(NOW - 120_000).toISOString() })],
    NOW,
  );
  assert.match(pool.rows[0]?.detail ?? '', /2 recent failures/);
  assert.match(pool.rows[0]?.detail ?? '', /last used 2m ago/);
});

test('a key never used reports no age at all', () => {
  const pool = presentKeyPool('anthropic', [record({ lastUsedAt: null })], NOW);
  assert.equal(pool.rows[0]?.detail, null, 'an unused key has nothing to report, not "never"');
});

test('ages read naturally at every scale', () => {
  // A realistic clock: the scale test needs a `now` large enough that
  // subtracting two days stays positive.
  const clock = Date.parse('2026-09-07T12:00:00.000Z');
  assert.equal(describeAge(clock - 10_000, clock), 'just now');
  assert.equal(describeAge(clock - 300_000, clock), '5m ago');
  assert.equal(describeAge(clock - 7_200_000, clock), '2h ago');
  assert.equal(describeAge(clock - 172_800_000, clock), '2d ago');
  assert.equal(describeAge(0, clock), 'at an unknown time');
});

test('every row carries a spoken sentence', () => {
  const pool = presentKeyPool(
    'anthropic',
    [record({ credentialId: 'a' }), record({ credentialId: 'b', priority: 1, userDisabled: true })],
    NOW,
  );
  for (const row of pool.rows) {
    assert.ok(row.spoken.length > 0);
    assert.ok(row.spoken.includes(row.label));
  }
  assert.match(pool.rows[0]?.spoken ?? '', /next in line/);
});

// --- per-key testing -------------------------------------------------------

test('a specific key can be read for testing without disturbing rotation', async () => {
  const secrets = new Map<string, string>();
  const meta = new Map<string, unknown>();
  const store: SecretStore = {
    get: async (k) => secrets.get(k),
    store: async (k, v) => void secrets.set(k, v),
    delete: async (k) => void secrets.delete(k),
  };
  const metadata: MetadataStore = {
    get: <T,>(k: string) => meta.get(k) as T | undefined,
    update: async (k, v) => void meta.set(k, v),
  };
  let n = 0;
  const manager = new CredentialManager({
    secrets: store,
    metadata,
    newId: () => `cred-${++n}`,
    now: () => NOW,
  });

  const first = await manager.add('anthropic', 'first', 'secret-one');
  const second = await manager.add('anthropic', 'second', 'secret-two');

  // The pool would hand out `first`; asking about `second` must still work,
  // which is the whole point — otherwise a user with one bad key in three
  // cannot find out which one it is.
  assert.equal(await manager.secretOf(second.credentialId), 'secret-two');
  assert.equal(await manager.secretOf(first.credentialId), 'secret-one');

  // And it records nothing: a test is a question, not a use.
  assert.equal(manager.find(second.credentialId)?.lastUsedAt, null);
  assert.equal(manager.find(first.credentialId)?.lastUsedAt, null);
});

test('reading an unknown or empty credential yields null rather than throwing', async () => {
  const meta = new Map<string, unknown>();
  const manager = new CredentialManager({
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
    },
    metadata: {
      get: <T,>(k: string) => meta.get(k) as T | undefined,
      update: async (k, v) => void meta.set(k, v),
    },
    newId: () => 'cred-1',
    now: () => NOW,
  });

  assert.equal(await manager.secretOf('does-not-exist'), null);

  const added = await manager.add('anthropic', 'ghost', 'k1');
  // Record present, keychain empty — the same broken state `next()` guards for.
  assert.equal(await manager.secretOf(added.credentialId), null);
});
