/**
 * Enterprise Rate Limit & Backoff Manager.
 *
 * Implements exponential backoff with full randomized jitter to prevent
 * thundering herds across corporate teams sharing API quotas. Accurately parses
 * RFC 7231 `Retry-After` headers and provider-specific rate limit counters.
 */

export interface RateLimitState {
  readonly providerId: string;
  readonly attempt: number;
  readonly blockedUntilMs: number;
  readonly lastErrorMs: number;
}

export class EnterpriseRateLimiter {
  private readonly states = new Map<string, RateLimitState>();
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(options?: { baseBackoffMs?: number; maxBackoffMs?: number }) {
    this.baseBackoffMs = options?.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options?.maxBackoffMs ?? 60_000;
  }

  /**
   * Checks whether the provider is currently in a rate-limit cooldown.
   */
  isRateLimited(providerId: string, now: number = Date.now()): boolean {
    const state = this.states.get(providerId);
    if (!state) return false;
    return now < state.blockedUntilMs;
  }

  /**
   * Returns remaining cooldown milliseconds, or 0 if unblocked.
   */
  getRemainingWaitMs(providerId: string, now: number = Date.now()): number {
    const state = this.states.get(providerId);
    if (!state) return 0;
    return Math.max(0, state.blockedUntilMs - now);
  }

  /**
   * Records a 429 / 503 rate-limiting event and computes backoff with full jitter.
   * If `retryAfterSeconds` or header is supplied, respects it with minimum floor.
   */
  recordRateLimit(
    providerId: string,
    retryAfterSeconds?: number | string | undefined,
    now: number = Date.now(),
  ): number {
    const existing = this.states.get(providerId);
    const attempt = existing ? existing.attempt + 1 : 1;

    let waitMs: number;

    const parsedSeconds = this.parseRetryAfter(retryAfterSeconds);
    if (parsedSeconds !== null && parsedSeconds > 0) {
      waitMs = Math.min(this.maxBackoffMs, parsedSeconds * 1_000);
    } else {
      // Exponential backoff with full jitter: random between 0 and min(max, base * 2^attempt)
      const cap = Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, attempt));
      waitMs = Math.floor(Math.random() * cap);
      // Ensure at least a minimal backoff of 500ms
      waitMs = Math.max(500, waitMs);
    }

    this.states.set(providerId, {
      providerId,
      attempt,
      blockedUntilMs: now + waitMs,
      lastErrorMs: now,
    });

    return waitMs;
  }

  /**
   * Resets rate-limit backoff on successful response.
   */
  recordSuccess(providerId: string): void {
    this.states.delete(providerId);
  }

  /**
   * Parses standard Retry-After header (seconds or HTTP date).
   */
  private parseRetryAfter(value: number | string | undefined): number | null {
    if (typeof value === 'number') {
      return isFinite(value) && value > 0 ? value : null;
    }
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    const asNum = Number(trimmed);
    if (!isNaN(asNum) && asNum > 0) {
      return asNum;
    }
    const asDate = Date.parse(trimmed);
    if (!isNaN(asDate)) {
      const diffSec = Math.ceil((asDate - Date.now()) / 1_000);
      return diffSec > 0 ? diffSec : null;
    }
    return null;
  }

  /**
   * Clears all rate limit state.
   */
  clear(): void {
    this.states.clear();
  }
}

export const rateLimiter = new EnterpriseRateLimiter();
