/**
 * Value formatting for the UI.
 *
 * Pure, and deliberately free of any `vscode` import, so every string the user
 * reads can be asserted in `node --test`. The rules here are not cosmetic:
 *
 * - **An unknown value is never rendered as zero.** `null` in, `null` out, and
 *   the caller omits the field. A task whose token count was never recorded must
 *   not claim to have used none — usage is only observed on a live stream, so
 *   history genuinely does not have it.
 * - **Precision is bounded by what the number means.** Sub-second durations are
 *   noise in an execution log, and a cost of $0.0000001 is not information.
 */

/** Milliseconds in the units used below. */
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * A duration, as short as it can be without becoming ambiguous.
 *
 * Seconds are floored rather than rounded so an elapsed clock never displays a
 * time the task has not yet reached.
 */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  if (ms < SECOND) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  if (ms < MINUTE) {
    const seconds = Math.floor(ms / SECOND);
    // One decimal below ten seconds: the difference between 1.2s and 1.9s is
    // meaningful when reading a tool card, and invisible once floored.
    return ms < 10 * SECOND ? `${(ms / SECOND).toFixed(1)}s` : `${seconds}s`;
  }
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    const seconds = Math.floor((ms % MINUTE) / SECOND);
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/**
 * A token count, abbreviated once it stops being readable in full.
 *
 * The threshold is 10_000 rather than 1_000 because a four-digit count is still
 * easy to read and rounding it away loses more than it saves.
 */
export function formatTokens(count: number | null): string | null {
  if (count === null || !Number.isFinite(count) || count < 0) {
    return null;
  }
  const whole = Math.round(count);
  if (whole < 10_000) {
    return whole.toLocaleString('en-US');
  }
  if (whole < 1_000_000) {
    return `${(whole / 1_000).toFixed(1)}K`;
  }
  return `${(whole / 1_000_000).toFixed(2)}M`;
}

/**
 * A cost in USD, or null when there is nothing honest to show.
 *
 * Null for a cost of exactly zero as well as for an absent one, because zero is
 * what an unpriced model produces: `resolveCapabilities` defaults
 * `costPerMTok*` to 0 when the user did not declare a price, so displaying
 * "$0.00" would present a missing declaration as a free model.
 */
export function formatCost(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd) || usd <= 0) {
    return null;
  }
  if (usd < 0.01) {
    // Four decimals: a cheap task should still show something other than $0.00.
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}

/**
 * Cost of a turn, from declared per-million-token prices.
 *
 * Returns null when neither price was declared, so a catalog that says nothing
 * about cost produces no cost display rather than a confident zero.
 */
export function computeCost(
  inputTokens: number,
  outputTokens: number,
  costPerMTokIn: number,
  costPerMTokOut: number,
): number | null {
  if (costPerMTokIn <= 0 && costPerMTokOut <= 0) {
    return null;
  }
  return (
    (inputTokens / 1_000_000) * Math.max(0, costPerMTokIn) +
    (outputTokens / 1_000_000) * Math.max(0, costPerMTokOut)
  );
}

/**
 * How long ago something happened, for a list of past tasks.
 *
 * Coarse on purpose: the exact second a task last wrote is not what a history
 * list is for, and a precise timestamp is available on hover.
 */
export function formatRelative(iso: string | null, nowMs: number): string | null {
  if (iso === null) {
    return null;
  }
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return null;
  }
  const delta = nowMs - at;
  if (delta < 0) {
    // A clock skew, or a ledger written on another machine. Saying "just now" is
    // less wrong than saying "in 3 hours".
    return 'just now';
  }
  if (delta < MINUTE) {
    return 'just now';
  }
  if (delta < HOUR) {
    const minutes = Math.floor(delta / MINUTE);
    return `${minutes}m ago`;
  }
  if (delta < 24 * HOUR) {
    const hours = Math.floor(delta / HOUR);
    return `${hours}h ago`;
  }
  const days = Math.floor(delta / (24 * HOUR));
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/** `n thing` / `n things`, so no call site has to special-case one. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  const word = count === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${count} ${word}`;
}

/**
 * A line delta, as shown on an edit card.
 *
 * Both halves are always present, including a zero, because "+12 −0" reads as a
 * pure addition while a bare "+12" leaves the reader wondering what was removed.
 */
export function formatLineDelta(added: number, removed: number): string {
  return `+${Math.max(0, added)} \u2212${Math.max(0, removed)}`;
}

/** Collapses whitespace and clips, so one huge string cannot break a layout. */
export function oneLine(text: string, maxChars = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (maxChars <= 1) {
    return flat.slice(0, Math.max(0, maxChars));
  }
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}\u2026` : flat;
}

/**
 * The last two segments of a path, for a compact target label.
 *
 * The tail is what identifies a file to a reader; the full path is kept
 * elsewhere for the tooltip and for opening the editor.
 */
export function shortPath(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length <= 2) {
    return parts.join('/');
  }
  return `\u2026/${parts.slice(-2).join('/')}`;
}

/** The file name alone. */
export function baseName(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}
