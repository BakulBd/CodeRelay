/**
 * Turning observed endpoint health into words.
 *
 * Pure, like every other module under `ui/state`: it takes health records and
 * returns finished display strings, so what the Models view says can be
 * asserted by `node --test` rather than by looking at a tree in a running
 * editor.
 *
 * Two rules govern everything here, and they are the same two the rest of the
 * interface already follows:
 *
 *  1. **Unknown is never healthy.** An endpoint nobody has used has no evidence
 *     behind it. Reporting it as healthy would be the same lie as a header
 *     claiming "0 tokens" for a measurement nobody took, so it reports nothing
 *     at all and the row simply omits a health phrase.
 *
 *  2. **Never state a number that was not measured.** A success rate appears
 *     only once there are outcomes to average, and a latency only once
 *     something has actually streamed. There is no "100%" for an endpoint with
 *     one success and no failures — one observation is not a rate — and no
 *     "0 ms" for one that has never answered.
 *
 * A model is usually reachable through several keys, so the model-level summary
 * has to combine them. It combines by *best*, not by worst or by average:
 * "can this model run right now" is answered by its healthiest usable key, and
 * a single cooling key must not make a model with three good ones look broken.
 * The count of degraded or ejected keys is reported separately, because that is
 * a different question and hiding it would make a half-broken provider look
 * fine.
 */
import {
  DEFAULT_HEALTH_LIMITS,
  grade,
  type EndpointHealth,
  type HealthGrade,
  type HealthLimits,
} from '../../policy/health.js';

/** What the Models view needs in order to draw one model row. */
export interface HealthSummary {
  /**
   * The best grade among this model's endpoints.
   *
   * `unknown` when nothing has been observed, which is also what an empty input
   * produces — a model with no recorded endpoints and a model whose endpoints
   * have no outcomes are the same state as far as evidence goes.
   */
  readonly grade: HealthGrade;
  /** Short phrase for the row, or `null` when there is nothing worth saying. */
  readonly text: string | null;
  /** Longer sentence for the tooltip, or `null`. */
  readonly detail: string | null;
  /** How many endpoints are currently ejected by the breaker. */
  readonly ejectedCount: number;
  /** How many are usable but failing more than they should. */
  readonly degradedCount: number;
  /** Milliseconds until the soonest ejected endpoint is retried, if any. */
  readonly retryInMs: number | null;
}

/** Ordering used to pick the best grade. Lower is better. */
const RANK: Record<HealthGrade, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  ejected: 3,
};

/**
 * Combine every endpoint for one model into a single summary.
 *
 * `now` is passed in rather than read from the clock so a test can place an
 * ejection window exactly, and so two rows rendered in the same refresh cannot
 * disagree about what time it is.
 */
export function summarizeHealth(
  endpoints: readonly EndpointHealth[],
  now: number,
  limits: HealthLimits = DEFAULT_HEALTH_LIMITS,
): HealthSummary {
  if (endpoints.length === 0) {
    return {
      grade: 'unknown',
      text: null,
      detail: null,
      ejectedCount: 0,
      degradedCount: 0,
      retryInMs: null,
    };
  }

  let best: HealthGrade = 'ejected';
  let ejectedCount = 0;
  let degradedCount = 0;
  let retryInMs: number | null = null;

  for (const endpoint of endpoints) {
    const g = grade(endpoint, now, limits);
    if (RANK[g] < RANK[best]) {
      best = g;
    }
    if (g === 'ejected') {
      ejectedCount += 1;
      if (endpoint.breaker.kind === 'open') {
        const remaining = endpoint.breaker.openUntil - now;
        if (retryInMs === null || remaining < retryInMs) {
          retryInMs = remaining;
        }
      }
    } else if (g === 'degraded') {
      degradedCount += 1;
    }
  }

  return {
    grade: best,
    text: phraseFor(best, ejectedCount, degradedCount, retryInMs),
    detail: detailFor(best, endpoints, ejectedCount, degradedCount, retryInMs),
    ejectedCount,
    degradedCount,
    retryInMs,
  };
}

function phraseFor(
  best: HealthGrade,
  ejectedCount: number,
  degradedCount: number,
  retryInMs: number | null,
): string | null {
  switch (best) {
    case 'unknown':
      // Deliberately silent. A row that says "unknown" next to every model the
      // user has not run yet is noise, and it would read as a warning.
      return null;
    case 'healthy':
      // Worth saying only when it is not the whole story: one healthy key
      // alongside two ejected ones is a different situation from three healthy
      // ones, and the row is the only place that shows it.
      if (ejectedCount > 0) {
        return `${ejectedCount} key${ejectedCount === 1 ? '' : 's'} unavailable`;
      }
      if (degradedCount > 0) {
        return `${degradedCount} key${degradedCount === 1 ? '' : 's'} unreliable`;
      }
      return null;
    case 'degraded':
      return 'unreliable lately';
    case 'ejected':
      return retryInMs === null
        ? 'not responding'
        : `not responding · retry ${formatWait(retryInMs)}`;
  }
}

function detailFor(
  best: HealthGrade,
  endpoints: readonly EndpointHealth[],
  ejectedCount: number,
  degradedCount: number,
  retryInMs: number | null,
): string | null {
  switch (best) {
    case 'unknown':
      return 'No requests have been made to this model yet, so there is nothing measured to report.';
    case 'healthy': {
      const measured = describeBest(endpoints);
      if (ejectedCount > 0) {
        return (
          `Usable. ${ejectedCount} of ${endpoints.length} keys are temporarily out of rotation ` +
          `after repeated failures; CodeRelay retries them on its own.${measured}`
        );
      }
      if (degradedCount > 0) {
        return (
          `Usable. ${degradedCount} of ${endpoints.length} keys have been failing more often ` +
          `than the rest and are tried last.${measured}`
        );
      }
      return `Responding normally.${measured}`;
    }
    case 'degraded':
      return (
        'This model has been failing often enough that CodeRelay tries healthier ones first. ' +
        'It is still used when nothing better is available.' + describeBest(endpoints)
      );
    case 'ejected':
      return (
        'Every key for this model has failed repeatedly, so CodeRelay has stopped sending ' +
        'requests to it for now. ' +
        (retryInMs === null
          ? 'It will be probed again shortly.'
          : `One probe request goes out in about ${formatWait(retryInMs)}; if it succeeds the ` +
            'model returns to normal use immediately.')
      );
  }
}

/**
 * A measured phrase for the healthiest endpoint, or nothing.
 *
 * Returns an empty string rather than null so callers can concatenate without a
 * conditional — and, more importantly, an endpoint with a single observation
 * contributes no rate, because one outcome is not an average.
 */
function describeBest(endpoints: readonly EndpointHealth[]): string {
  let chosen: EndpointHealth | null = null;
  for (const endpoint of endpoints) {
    if (endpoint.successRate === null) {
      continue;
    }
    if (chosen === null || endpoint.successRate > (chosen.successRate ?? -1)) {
      chosen = endpoint;
    }
  }
  if (chosen === null) {
    return '';
  }

  const parts: string[] = [];
  const observations = chosen.totalSuccesses + chosen.totalFailures;
  if (observations >= 2 && chosen.successRate !== null) {
    parts.push(`${Math.round(chosen.successRate * 100)}% of recent requests succeeded`);
  }
  if (chosen.latencyMs !== null) {
    parts.push(`typically responds in ${formatWait(chosen.latencyMs)}`);
  }
  return parts.length === 0 ? '' : ` Best key: ${parts.join(', ')}.`;
}

/**
 * A duration in words.
 *
 * Rounds up to whole seconds above a second, because "retry in 0s" reads as
 * "now" for something that has not happened yet, and reports sub-second values
 * in milliseconds so a fast local model is not described as taking "0s".
 */
export function formatWait(ms: number): string {
  if (ms < 1_000) {
    return `${Math.max(1, Math.round(ms))}ms`;
  }
  const seconds = Math.ceil(ms / 1_000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

/**
 * The theme icon and colour for a grade.
 *
 * Colour is never the only signal: the caller pairs this with the phrase from
 * `summarizeHealth` and repeats both in the accessible label, so a row remains
 * readable with no colour perception at all.
 */
export function healthIcon(g: HealthGrade): { icon: string; colour: string | null } {
  switch (g) {
    case 'healthy':
      return { icon: 'pass', colour: 'testing.iconPassed' };
    case 'unknown':
      return { icon: 'circle-outline', colour: null };
    case 'degraded':
      return { icon: 'warning', colour: 'notificationsWarningIcon.foreground' };
    case 'ejected':
      return { icon: 'error', colour: 'notificationsErrorIcon.foreground' };
  }
}
