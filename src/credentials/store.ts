/**
 * Multi-key credential storage and rotation.
 *
 * Two things live here, deliberately kept apart:
 *
 *  - **Key material**, in `SecretStorage`. It is written once, read only at the
 *    moment a request is built, and never copied anywhere else. No log line, no
 *    ledger entry, no error message in this project carries a secret.
 *  - **Metadata and health**, in a plain key/value store. Ids, labels and
 *    failure counts are not secrets, and keeping them separate means the
 *    rotation logic is fully testable without touching a keychain.
 *
 * Rotation exists because a task should survive one key being rate-limited or
 * revoked. The rules are intentionally conservative:
 *
 *  - A credential rejected outright (401/403) is **disabled**, not cooled down.
 *    Retrying a revoked key on a timer is how an account gets flagged for abuse.
 *  - A throttled credential (429) is **cooled** for as long as the provider
 *    asked, then returns to the pool. It is still valid; it is just busy.
 *  - When every credential is cooling, the caller is told *when* one frees up
 *    rather than being handed a key that is certain to fail. Waiting is a
 *    decision the policy layer makes with the ledger in hand, not something
 *    this module does behind its back.
 *
 * Both VS Code interfaces are narrowed to the handful of methods used, so the
 * whole module runs under `node --test` with no editor present.
 */
import type { CredentialRef } from '../core/types.js';
import type { Classification } from '../recovery/classify.js';

/** The subset of `vscode.SecretStorage` this module needs. */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The subset of `vscode.Memento` this module needs. */
export interface MetadataStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

/** Non-secret bookkeeping for one credential. */
export interface CredentialRecord {
  readonly providerId: string;
  readonly credentialId: string;
  readonly label: string;
  readonly addedAt: string;
  /** Set when the provider rejected the key outright. Requires user action. */
  readonly disabledReason: string | null;
  /**
   * Turned off by the user rather than by a provider rejection.
   *
   * Kept separate from `disabledReason` because the two need different
   * treatment: a rejected key is a fault to surface and fix, while a key the
   * user parked is a deliberate choice that must not be presented as a problem
   * — and must not be silently re-enabled by anything automatic.
   */
  readonly userDisabled: boolean;
  /**
   * Preference order within a provider. Lower is tried first.
   *
   * A tiebreak, not an override: health still comes first, so a high-priority
   * key that is rate limited or failing does not block a healthy one. Priority
   * decides between keys that are equally usable — which is exactly the case a
   * user wants control over, e.g. spend a work key before a personal one.
   */
  readonly priority: number;
  /** Epoch ms until which this credential is throttled. */
  readonly coolingUntil: number | null;
  readonly consecutiveFailures: number;
  readonly lastUsedAt: string | null;
  readonly lastFailureReason: string | null;
}

/** What `next()` found. A union so "no key" cannot be mistaken for "a key". */
export type CredentialChoice =
  | {
      readonly t: 'credential';
      readonly ref: CredentialRef;
      /** Live key material. Put it straight into a header; do not store or log it. */
      readonly secret: string;
    }
  | { readonly t: 'none'; readonly reason: string }
  | {
      readonly t: 'all_cooling';
      readonly retryAfterMs: number;
      readonly reason: string;
    };

export const METADATA_KEY = 'coderelay.credentials';

/**
 * The priority every credential starts at.
 *
 * Shared rather than incrementing, so untouched keys are peers and rotation
 * spreads across them. See `add` for why that is the right default.
 */
export const DEFAULT_PRIORITY = 0;
const SECRET_PREFIX = 'coderelay.secret.';

/** Cooldown applied when a provider throttles us without saying for how long. */
const DEFAULT_COOLDOWN_MS = 60_000;

function secretKey(credentialId: string): string {
  return `${SECRET_PREFIX}${credentialId}`;
}

function toRef(record: CredentialRecord): CredentialRef {
  return {
    providerId: record.providerId,
    credentialId: record.credentialId,
    label: record.label,
  };
}

export interface CredentialManagerDeps {
  readonly secrets: SecretStore;
  readonly metadata: MetadataStore;
  readonly now?: () => number;
  /** Injected so ids are deterministic in tests. */
  readonly newId?: () => string;
}

export class CredentialManager {
  private readonly secrets: SecretStore;
  private readonly metadata: MetadataStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  /**
   * Serializes every read-modify-write on the metadata store.
   *
   * Health updates are a full-array rewrite over a value read a moment earlier,
   * so two concurrent ones lose a write — and this is reachable on the ordinary
   * path: `next()` stamps `lastUsedAt` for the attempt about to start while the
   * previous attempt's `reportFailure` is still stamping `coolingUntil`. Losing
   * the latter puts a rate-limited key straight back into rotation, which is the
   * one thing rotation exists to prevent.
   *
   * The chain is the same device `ExecutionLedger` uses for appends: each
   * mutation waits for the previous one to finish before it reads, so a stale
   * read is impossible rather than merely unlikely.
   */
  private mutations: Promise<void> = Promise.resolve();

  constructor(deps: CredentialManagerDeps) {
    this.secrets = deps.secrets;
    this.metadata = deps.metadata;
    this.now = deps.now ?? Date.now;
    this.newId =
      deps.newId ?? (() => `cred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  }

  /** All records, in insertion order. Never includes key material. */
  records(): readonly CredentialRecord[] {
    const stored = this.metadata.get<CredentialRecord[]>(METADATA_KEY);
    if (!Array.isArray(stored)) {
      return [];
    }
    // Records written before `priority` and `userDisabled` existed are missing
    // both. Normalising on read rather than migrating on write means an upgrade
    // needs no migration step at all, and a downgrade cannot corrupt anything —
    // and it matters concretely: an undefined `priority` reaching the sort
    // comparator yields NaN, which makes the ordering arbitrary rather than
    // merely wrong.
    return stored.map((record) => ({
      ...record,
      priority: typeof record.priority === 'number' ? record.priority : DEFAULT_PRIORITY,
      userDisabled: record.userDisabled === true,
    }));
  }

  list(providerId?: string): readonly CredentialRef[] {
    return this.records()
      .filter((r) => providerId === undefined || r.providerId === providerId)
      .map(toRef);
  }

  find(credentialId: string): CredentialRecord | null {
    return this.records().find((r) => r.credentialId === credentialId) ?? null;
  }

  /**
   * Stores a new credential.
   *
   * The secret is written to `SecretStorage` first: a record pointing at a
   * secret that does not exist is a worse state than a secret with no record,
   * because the first breaks rotation while the second is merely garbage.
   */
  async add(providerId: string, label: string, secret: string): Promise<CredentialRef> {
    const trimmed = secret.trim();
    if (trimmed === '') {
      throw new Error('A credential cannot be empty.');
    }

    const credentialId = this.newId();
    await this.secrets.store(secretKey(credentialId), trimmed);

    const record: CredentialRecord = {
      providerId,
      credentialId,
      // Fall back to something identifiable rather than an empty row in the UI.
      label: label.trim() === '' ? `${providerId} key` : label.trim(),
      addedAt: new Date(this.now()).toISOString(),
      disabledReason: null,
      coolingUntil: null,
      consecutiveFailures: 0,
      lastUsedAt: null,
      lastFailureReason: null,
      userDisabled: false,
      // Every key starts at the same priority, so keys the user has expressed
      // no preference between spread load evenly by least-recently-used rather
      // than one being hammered. Priority only starts to discriminate once the
      // user actually orders them — which is what makes it a preference rather
      // than an accident of the order keys were pasted in.
      priority: DEFAULT_PRIORITY,
    };

    // Appending inside the serialized section, so a key added while a health
    // update is in flight cannot be dropped by that update's rewrite.
    await this.mutate(() => [...this.records(), record]);
    return toRef(record);
  }

  /**
   * Reads one specific credential's secret, for testing that key alone.
   *
   * Deliberately narrow and deliberately separate from `next()`. `next()` is
   * rotation: it picks whichever key should serve the next request and records
   * the use. This answers a different question — "is *this* key good?" — which
   * is unanswerable through rotation, because with three keys configured the
   * pool decides which one you tested and you learn nothing about the other two.
   *
   * It records nothing. A connection test is a question, and answering it must
   * not move a key's position in the rotation or mark it as recently used.
   *
   * Returns null when the record is unknown or the keychain has no entry for
   * it, which is the same state `next()` treats as a broken record.
   */
  async secretOf(credentialId: string): Promise<string | null> {
    const record = this.find(credentialId);
    if (record === null) {
      return null;
    }
    const secret = await this.secrets.get(secretKey(credentialId));
    return secret === undefined || secret === '' ? null : secret;
  }

  /**
   * Turns a credential on or off by hand.
   *
   * Deliberately cannot clear `disabledReason`: that flag means the provider
   * rejected the key, and letting a toggle overrule the provider would put a
   * key back into rotation that is known not to work. Re-enabling a rejected
   * key means replacing it.
   */
  async setEnabled(credentialId: string, enabled: boolean): Promise<void> {
    await this.patch(credentialId, { userDisabled: !enabled });
  }

  /**
   * Reorders a provider's keys.
   *
   * Takes the whole ordered list rather than one index, because a move is a
   * rearrangement of a sequence and applying it one element at a time leaves
   * intermediate states where two keys claim the same slot.
   */
  async reorder(providerId: string, orderedIds: readonly string[]): Promise<void> {
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    await this.mutate(() =>
      this.records().map((record) =>
        record.providerId === providerId && rank.has(record.credentialId)
          ? { ...record, priority: rank.get(record.credentialId) ?? record.priority }
          : record,
      ),
    );
  }

  /** Removes the record and the secret. Missing either one is not an error. */
  async remove(credentialId: string): Promise<boolean> {
    // Delete the secret even when no record exists, so a half-removed
    // credential cannot leave key material behind in the keychain.
    await this.secrets.delete(secretKey(credentialId));

    let existed = false;
    await this.mutate(() => {
      const remaining = this.records().filter((r) => r.credentialId !== credentialId);
      existed = remaining.length !== this.records().length;
      return remaining;
    });
    return existed;
  }

  /**
   * Picks the credential to use next for a provider.
   *
   * Selection is least-recently-used among the healthy ones, which spreads load
   * evenly instead of hammering the first key until it throttles. A credential
   * whose secret has vanished from the keychain is reported rather than silently
   * skipped: the user deleted something, and hiding that would leave them
   * wondering why a key they can see is never used.
   */
  async next(providerId: string): Promise<CredentialChoice> {
    const forProvider = this.records().filter((r) => r.providerId === providerId);
    if (forProvider.length === 0) {
      return { t: 'none', reason: `No credential is configured for ${providerId}.` };
    }

    const enabled = forProvider.filter((r) => r.disabledReason === null && !r.userDisabled);
    if (enabled.length === 0) {
      // The two reasons need different words because they need different fixes:
      // one is a broken key, the other is a switch the user threw.
      const allParked = forProvider.every((r) => r.userDisabled);
      return {
        t: 'none',
        reason: allParked
          ? `Every ${providerId} credential is turned off. Turn one back on to use this provider.`
          : `Every ${providerId} credential has been disabled after being rejected. ` +
            'Add a valid key or re-enable one.',
      };
    }

    const at = this.now();
    const ready = enabled.filter((r) => r.coolingUntil === null || r.coolingUntil <= at);

    if (ready.length === 0) {
      const soonest = Math.min(...enabled.map((r) => r.coolingUntil ?? at));
      return {
        t: 'all_cooling',
        retryAfterMs: Math.max(0, soonest - at),
        reason: `All ${providerId} credentials are rate limited.`,
      };
    }

    // Health, then the user's stated preference, then least recently used.
    //
    // Health leads deliberately: priority is a preference between keys that
    // would both work, and letting it outrank failure history would send every
    // request to a key that is currently failing simply because it was listed
    // first. Least-recently-used breaks the remaining ties so load spreads
    // evenly across equal keys rather than hammering one.
    const ordered = [...ready].sort((a, b) => {
      if (a.consecutiveFailures !== b.consecutiveFailures) {
        return a.consecutiveFailures - b.consecutiveFailures;
      }
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return usedAt(a) - usedAt(b);
    });

    for (const record of ordered) {
      const secret = await this.secrets.get(secretKey(record.credentialId));
      if (secret !== undefined && secret !== '') {
        await this.patch(record.credentialId, {
          lastUsedAt: new Date(at).toISOString(),
        });
        return { t: 'credential', ref: toRef(record), secret };
      }
      // The record exists but the keychain does not have the key. Disable it so
      // rotation stops choosing a credential that can never work.
      await this.patch(record.credentialId, {
        disabledReason: 'The stored secret is missing from the OS keychain.',
      });
    }

    return {
      t: 'none',
      reason:
        `No usable ${providerId} credential remains: the stored secrets are missing ` +
        'from the OS keychain. Re-enter the key.',
    };
  }

  /** Clears the failure counter after the credential worked. */
  async reportSuccess(credentialId: string): Promise<void> {
    const record = this.find(credentialId);
    if (record === null) {
      return;
    }
    await this.patch(credentialId, {
      consecutiveFailures: 0,
      coolingUntil: null,
      lastFailureReason: null,
    });
  }

  /**
   * Records a failure attributable to this credential.
   *
   * Only acts when the classifier said the credential is implicated. A network
   * failure or a malformed request is not the key's fault, and penalising it
   * would eventually disable every key for reasons unrelated to any of them.
   */
  async reportFailure(credentialId: string, failure: Classification): Promise<void> {
    const record = this.find(credentialId);
    if (record === null) {
      return;
    }

    if (failure.errorClass === 'AUTH') {
      // Rejected outright. Retrying on a timer risks an abuse flag, so this
      // needs a human, not a backoff.
      await this.patch(credentialId, {
        disabledReason: failure.reason,
        consecutiveFailures: record.consecutiveFailures + 1,
        lastFailureReason: failure.reason,
      });
      return;
    }

    if (failure.rotateCredential) {
      // Throttled: still valid, just busy. Honour the provider's own delay.
      await this.patch(credentialId, {
        coolingUntil: this.now() + (failure.retryAfterMs ?? DEFAULT_COOLDOWN_MS),
        consecutiveFailures: record.consecutiveFailures + 1,
        lastFailureReason: failure.reason,
      });
      return;
    }

    // Everything else is not this credential's fault; leave its health alone.
  }

  /** Clears a disable flag after the user says the key is good again. */
  async enable(credentialId: string): Promise<boolean> {
    if (this.find(credentialId) === null) {
      return false;
    }
    await this.patch(credentialId, {
      disabledReason: null,
      coolingUntil: null,
      consecutiveFailures: 0,
    });
    return true;
  }

  private async patch(credentialId: string, changes: Partial<CredentialRecord>): Promise<void> {
    // The read is deliberately *inside* the serialized section: reading outside
    // it is precisely the race this exists to close.
    await this.mutate(() =>
      this.records().map((r) => (r.credentialId === credentialId ? { ...r, ...changes } : r)),
    );
  }

  /**
   * Applies one mutation with exclusive access to the metadata store.
   *
   * `build` is called only once its turn arrives, so it always sees the result
   * of every mutation queued before it. A rejection is contained: the chain is
   * advanced with a settled promise so one failed write cannot wedge every
   * later one, while the failure still propagates to its own caller.
   */
  private async mutate(
    build: () => readonly CredentialRecord[] | Promise<readonly CredentialRecord[]>,
  ): Promise<void> {
    const run = this.mutations.then(async () => {
      await this.metadata.update(METADATA_KEY, await build());
    });
    this.mutations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function usedAt(record: CredentialRecord): number {
  if (record.lastUsedAt === null) {
    return 0; // never used sorts first, so a new key gets a turn immediately
  }
  const parsed = Date.parse(record.lastUsedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/*
 * There is deliberately no `authHeaders` here.
 *
 * Turning a secret into a request is the provider layer's job
 * (`ProviderAdapter.sign`), not this module's. A `(providerId, secret) ->
 * headers` helper looks convenient but cannot express Azure OpenAI's
 * `api-version` query parameter, Gemini's key-as-query-parameter, or Bedrock
 * SigV4's signature over the request body — and it would put a hard-coded
 * provider name in a module that is otherwise provider-agnostic. This module's
 * responsibility ends at handing out a live secret and tracking the health of
 * the key it came from.
 */
