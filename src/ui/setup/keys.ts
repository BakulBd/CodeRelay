/**
 * The credential pool, as rows a panel can draw.
 *
 * Adding a second API key was possible before this existed, but only one at a
 * time through the wizard and only manageable from a command palette pick. The
 * panel itself showed a bare count — "2 key(s) stored" — which is the least
 * useful true thing it could say: it cannot tell you *which* key is rate
 * limited, which one the provider rejected, or which one the next request will
 * use. This turns the pool into rows.
 *
 * Pure, so the wording is asserted by `node --test` rather than read off a
 * screen. Every field below is derived from what `CredentialManager` recorded —
 * a cooldown the provider imposed, a rejection it sent, the time a key was last
 * used. Nothing is a synthetic health score, because nothing measures one.
 *
 * **No part of a key is ever displayed.** Not a prefix, not a suffix, not a
 * masked form. A credential is identified by the label the user gave it and by
 * nothing else, because a masked key is still key material and the panel is the
 * one place it would be easy to leak.
 */
import type { CredentialRecord } from '../../credentials/store.js';

/** What state a key is in. Never carried by colour alone in the view. */
export type KeyStatus =
  /** Usable, and the pool will draw on it. */
  | 'ready'
  /** Rate limited or backing off. Comes back on its own. */
  | 'cooling'
  /** The provider rejected it. Needs replacing, not re-enabling. */
  | 'rejected'
  /** The user turned it off. */
  | 'off';

export interface KeyRow {
  readonly credentialId: string;
  /** The label the user gave it. Never any part of the secret. */
  readonly label: string;
  readonly status: KeyStatus;
  /** A short phrase for the row, e.g. "cooling for 38s". */
  readonly statusText: string;
  /** Supporting detail, or null when the status says everything. */
  readonly detail: string | null;
  /** A single character, so status survives with no colour at all. */
  readonly glyph: string;
  /** True for the key the next request would actually use. */
  readonly next: boolean;
  /** Position in the pool, 1-based, for the reorder controls. */
  readonly position: number;
  /** Whether promoting this key would change anything. */
  readonly canPromote: boolean;
  /** The whole row as one sentence, for a screen reader. */
  readonly spoken: string;
}

export interface KeyPool {
  readonly providerId: string;
  readonly rows: readonly KeyRow[];
  /** A one-line summary for the header, or null when there are no keys. */
  readonly summary: string | null;
  /**
   * Why the provider cannot be used at all, or null when it can.
   *
   * Distinct from a per-key problem: every key being rejected and every key
   * being switched off are different situations with different fixes, and the
   * header says which.
   */
  readonly blocked: string | null;
}

const GLYPHS: Readonly<Record<KeyStatus, string>> = {
  ready: '●',
  cooling: '◐',
  rejected: '✗',
  off: '○',
};

/**
 * Which key the pool would hand out next.
 *
 * Mirrors `CredentialManager.next`: health first, then the user's stated
 * priority, then least recently used. It is re-derived here rather than asked
 * for because `next()` *consumes* a key — it records the use — and a panel must
 * never change what it is describing merely by describing it.
 *
 * The duplication is deliberate and narrow, and it is the reason
 * `test/ui/keys.test.ts` asserts the two agree.
 */
function nextCredentialId(records: readonly CredentialRecord[], now: number): string | null {
  const usable = records.filter(
    (r) =>
      r.disabledReason === null &&
      !r.userDisabled &&
      (r.coolingUntil === null || r.coolingUntil <= now),
  );
  if (usable.length === 0) {
    return null;
  }
  const ordered = [...usable].sort((a, b) => {
    if (a.consecutiveFailures !== b.consecutiveFailures) {
      return a.consecutiveFailures - b.consecutiveFailures;
    }
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return usedAt(a) - usedAt(b);
  });
  return ordered[0]?.credentialId ?? null;
}

function usedAt(record: CredentialRecord): number {
  if (record.lastUsedAt === null) {
    return 0;
  }
  const parsed = Date.parse(record.lastUsedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusOf(record: CredentialRecord, now: number): KeyStatus {
  if (record.disabledReason !== null) {
    return 'rejected';
  }
  if (record.userDisabled) {
    return 'off';
  }
  if (record.coolingUntil !== null && record.coolingUntil > now) {
    return 'cooling';
  }
  return 'ready';
}

function statusText(record: CredentialRecord, status: KeyStatus, now: number): string {
  switch (status) {
    case 'rejected':
      return 'rejected by the provider';
    case 'off':
      return 'turned off';
    case 'cooling': {
      const seconds = Math.ceil(((record.coolingUntil ?? now) - now) / 1000);
      return `cooling for ${seconds}s`;
    }
    case 'ready':
      return 'ready';
  }
}

function detailOf(record: CredentialRecord, status: KeyStatus, now: number): string | null {
  const parts: string[] = [];

  if (status === 'rejected' && record.disabledReason !== null) {
    parts.push(record.disabledReason);
  } else if (record.consecutiveFailures > 0) {
    parts.push(
      `${record.consecutiveFailures} recent failure${record.consecutiveFailures === 1 ? '' : 's'}`,
    );
  }

  if (record.lastUsedAt !== null) {
    parts.push(`last used ${describeAge(usedAt(record), now)}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** A rough age. Never a precise timestamp, which is noise in a dense row. */
export function describeAge(at: number, now: number): string {
  if (at <= 0) {
    return 'at an unknown time';
  }
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Build the pool view for one provider.
 *
 * Rows come back in the order the pool would try them, so the list reads top to
 * bottom as "this one, then this one" — which is the question a user opening it
 * is actually asking.
 */
export function presentKeyPool(
  providerId: string,
  records: readonly CredentialRecord[],
  now: number,
): KeyPool {
  const mine = records
    .filter((r) => r.providerId === providerId)
    .sort((a, b) => a.priority - b.priority || a.addedAt.localeCompare(b.addedAt));

  if (mine.length === 0) {
    return {
      providerId,
      rows: [],
      summary: null,
      blocked: null,
    };
  }

  const next = nextCredentialId(mine, now);

  const rows = mine.map((record, index): KeyRow => {
    const status = statusOf(record, now);
    const text = statusText(record, status, now);
    const detail = detailOf(record, status, now);
    const isNext = record.credentialId === next;

    return {
      credentialId: record.credentialId,
      label: record.label,
      status,
      statusText: text,
      detail,
      glyph: GLYPHS[status],
      next: isNext,
      position: index + 1,
      // Promoting the first key changes nothing, and offering a control that
      // does nothing is worse than not offering it.
      canPromote: index > 0,
      spoken:
        `${record.label}, ${text}${detail === null ? '' : `, ${detail}`}` +
        `${isNext ? ', next in line' : ''}.`,
    };
  });

  const ready = rows.filter((r) => r.status === 'ready').length;
  const cooling = rows.filter((r) => r.status === 'cooling').length;
  const rejected = rows.filter((r) => r.status === 'rejected').length;
  const off = rows.filter((r) => r.status === 'off').length;

  const summaryParts: string[] = [`${rows.length} key${rows.length === 1 ? '' : 's'}`];
  if (ready > 0) {
    summaryParts.push(`${ready} ready`);
  }
  if (cooling > 0) {
    summaryParts.push(`${cooling} cooling`);
  }
  if (rejected > 0) {
    summaryParts.push(`${rejected} rejected`);
  }
  if (off > 0) {
    summaryParts.push(`${off} off`);
  }

  // The three ways a provider becomes unusable need three different sentences,
  // because they need three different fixes: wait, replace, or switch back on.
  let blocked: string | null = null;
  if (ready === 0) {
    if (cooling > 0) {
      blocked = 'Every key is cooling down. This clears on its own.';
    } else if (rejected > 0 && off === 0) {
      blocked = 'Every key was rejected by the provider. Add a working key.';
    } else if (off > 0 && rejected === 0) {
      blocked = 'Every key is turned off. Turn one back on to use this provider.';
    } else {
      blocked = 'No key is usable. Add one, or turn one back on.';
    }
  }

  return { providerId, rows, summary: summaryParts.join(' · '), blocked };
}
