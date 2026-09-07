/**
 * Injecting provider failures on purpose, so recovery can be measured.
 *
 * CodeRelay's central claim is that a task survives a provider failing. That is
 * either true or it is marketing, and the difference is whether anyone has made
 * a provider fail on demand and watched what happened. This wraps the real
 * `FetchLike` and makes specified requests fail in specified ways.
 *
 * Two things it is careful not to be:
 *
 *  1. **Not a simulation of the model.** Every request that is *not* faulted
 *     goes to the real provider over the real transport and gets a real
 *     response. What is synthetic is the failure, not the work — so a benchmark
 *     measures the actual recovery path, including the real ledger, the real
 *     checkpointing and the real handoff, rather than a mock of them.
 *
 *  2. **Not random.** Faults fire on request *ordinals*, so the same scenario
 *     produces the same failures every run. A benchmark whose failures move
 *     around cannot be compared against itself, which is the only comparison
 *     that means anything here.
 *
 * The shapes returned are the ones the classifier actually distinguishes — a
 * 429 with a `retry-after`, a 500, a socket error, a stream that stops
 * mid-event — because a fault the classifier maps to `UNKNOWN` measures nothing
 * except the fallback branch.
 */
import type { FetchLike, HttpResponseLike } from '../providers/transport.js';

/** The failure modes worth rehearsing. Each maps to a distinct `ErrorClass`. */
export type FaultKind =
  /** HTTP 429 with a `retry-after`. Classifies as RETRYABLE. */
  | 'rate-limit'
  /** HTTP 500. Classifies as RETRYABLE. */
  | 'server-error'
  /** HTTP 401. Classifies as AUTH, so the key rotates. */
  | 'auth'
  /** A socket-level failure. Classifies as NETWORK. */
  | 'network'
  /** Connection established, then nothing. Classifies as a stall. */
  | 'timeout'
  /** A stream that stops mid-event, so the turn truncates. Classifies as STREAM. */
  | 'partial-stream'
  /** HTTP 400 context length exceeded. Classifies as CONTEXT. */
  | 'context-overflow'
  /** HTTP 503 provider outage. Classifies as RETRYABLE/NETWORK. */
  | 'provider-outage';

export interface Fault {
  /** 1-based index of the request this fires on. */
  readonly onRequest: number;
  readonly kind: FaultKind;
}

export interface FaultScript {
  readonly faults: readonly Fault[];
}

/** What actually happened, so a run can report faults it never reached. */
export interface FaultLog {
  readonly requests: number;
  readonly fired: readonly Fault[];
  readonly unfired: readonly Fault[];
}

const RATE_LIMIT_BODY = JSON.stringify({
  error: { type: 'rate_limit_error', message: 'Injected by CodeRelay benchmark.' },
});

const SERVER_BODY = JSON.stringify({
  error: { type: 'server_error', message: 'Injected by CodeRelay benchmark.' },
});

const AUTH_BODY = JSON.stringify({
  error: { type: 'authentication_error', message: 'Injected by CodeRelay benchmark.' },
});

const CONTEXT_BODY = JSON.stringify({
  error: {
    type: 'invalid_request_error',
    code: 'context_length_exceeded',
    message: 'Injected by CodeRelay benchmark: maximum context length exceeded.',
  },
});

const OUTAGE_BODY = JSON.stringify({
  error: { type: 'service_unavailable', message: 'Injected by CodeRelay benchmark: provider outage.' },
});

function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/** A response body that emits some SSE and then stops without a terminal event. */
function truncatedStream(): HttpResponseLike['body'] {
  // Deliberately valid framing up to the cut: the point is a turn that started
  // and did not finish, which is what recovery has to reason about. A malformed
  // first byte would be a different failure entirely.
  const chunk = new TextEncoder().encode(
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
  );
  let sent = false;
  return {
    getReader() {
      return {
        async read() {
          if (sent) {
            // `done` with no terminal event is exactly what a dropped
            // connection looks like to the decoder.
            return { done: true };
          }
          sent = true;
          return { done: false, value: chunk };
        },
        releaseLock() {
          /* nothing held */
        },
      };
    },
  };
}

/**
 * Wrap a fetch so specified requests fail.
 *
 * Returns the wrapper plus a `log()` reporting what fired. The log matters as
 * much as the run: a scenario whose faults never fired because the task
 * finished in fewer requests has not tested anything, and reporting it as a
 * success would be the fabricated result the brief forbids.
 */
export function injectFaults(
  inner: FetchLike,
  script: FaultScript,
): { fetchImpl: FetchLike; log: () => FaultLog } {
  let requests = 0;
  const fired: Fault[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    requests += 1;
    const fault = script.faults.find((f) => f.onRequest === requests);
    if (fault === undefined) {
      // Not faulted: a real request to a real provider.
      return inner(url, init);
    }
    fired.push(fault);

    switch (fault.kind) {
      case 'rate-limit':
        return {
          status: 429,
          headers: headers({ 'content-type': 'application/json', 'retry-after': '1' }),
          body: null,
          text: async () => RATE_LIMIT_BODY,
        };

      case 'server-error':
        return {
          status: 500,
          headers: headers({ 'content-type': 'application/json' }),
          body: null,
          text: async () => SERVER_BODY,
        };

      case 'auth':
        return {
          status: 401,
          headers: headers({ 'content-type': 'application/json' }),
          body: null,
          text: async () => AUTH_BODY,
        };

      case 'network': {
        // Thrown, not returned: a socket failure never produces a response, and
        // returning a synthetic 5xx would exercise the wrong classifier branch.
        const error = new Error('ECONNRESET: injected by CodeRelay benchmark');
        (error as { code?: string }).code = 'ECONNRESET';
        throw error;
      }

      case 'timeout': {
        // Never settles. The transport's own deadline is what ends this, which
        // is the behaviour being measured — a fake immediate timeout would skip
        // the code under test.
        await new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted: injected timeout')),
            { once: true },
          );
        });
        throw new Error('unreachable');
      }

      case 'partial-stream':
        return {
          status: 200,
          headers: headers({ 'content-type': 'text/event-stream' }),
          body: truncatedStream(),
          text: async () => '',
        };

      case 'context-overflow':
        return {
          status: 400,
          headers: headers({ 'content-type': 'application/json' }),
          body: null,
          text: async () => CONTEXT_BODY,
        };

      case 'provider-outage':
        return {
          status: 503,
          headers: headers({ 'content-type': 'application/json', 'retry-after': '60' }),
          body: null,
          text: async () => OUTAGE_BODY,
        };
    }
  };

  return {
    fetchImpl,
    log: () => ({
      requests,
      fired: [...fired],
      unfired: script.faults.filter((f) => !fired.includes(f)),
    }),
  };
}

/** Plain wording for a fault, used in the scenario list and the report. */
export const FAULT_LABELS: Readonly<Record<FaultKind, string>> = {
  'rate-limit': 'Rate limited (429)',
  'server-error': 'Provider error (500)',
  auth: 'Key rejected (401)',
  network: 'Connection reset',
  timeout: 'Connection stalled',
  'partial-stream': 'Stream cut mid-turn',
  'context-overflow': 'Context limit exceeded',
  'provider-outage': 'Provider outage (503)',
};

/** The scenarios offered in the Benchmark Lab. */
export interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly script: FaultScript;
}

/**
 * The built-in scenarios.
 *
 * Each faults an early request, because that is where a failure is most likely
 * to lose work: a provider that dies after the first tool call is the case
 * where "did that write land?" actually has to be answered from the ledger.
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'rate-limit',
    label: 'Rate limit on the first request',
    description: 'The provider returns 429 before any work starts.',
    script: { faults: [{ onRequest: 1, kind: 'rate-limit' }] },
  },
  {
    id: 'mid-task-outage',
    label: 'Provider outage mid-task',
    description: 'The second request fails with a 500, after work has begun.',
    script: { faults: [{ onRequest: 2, kind: 'server-error' }] },
  },
  {
    id: 'network-drop',
    label: 'Connection dropped mid-task',
    description: 'The socket resets on the second request.',
    script: { faults: [{ onRequest: 2, kind: 'network' }] },
  },
  {
    id: 'truncated-turn',
    label: 'Stream cut mid-turn',
    description: 'A turn starts streaming and stops without finishing.',
    script: { faults: [{ onRequest: 2, kind: 'partial-stream' }] },
  },
  {
    id: 'key-rejected',
    label: 'API key rejected',
    description: 'The provider returns 401, so the key must rotate.',
    script: { faults: [{ onRequest: 1, kind: 'auth' }] },
  },
  {
    id: 'sustained-outage',
    label: 'Sustained provider outage',
    description: 'Three consecutive failures, forcing a move to another provider.',
    script: {
      faults: [
        { onRequest: 1, kind: 'server-error' },
        { onRequest: 2, kind: 'server-error' },
        { onRequest: 3, kind: 'server-error' },
      ],
    },
  },
];
