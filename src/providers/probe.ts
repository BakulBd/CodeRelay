/**
 * "Test Connection": one real request, and a verdict a user can act on.
 *
 * The point of this module is that it is **not** a bespoke health check. It goes
 * through `createRequestBuilder`, `ProviderAdapter.sign` and `streamTurn` — the
 * same three pieces a task uses — so a pass means the configured row actually
 * works, and a failure is the failure a task would have hit. A separate
 * "is it up?" path that issued a simpler request would be able to pass while real
 * traffic failed, which is worse than having no test at all.
 *
 * Two consequences worth stating:
 *
 * - **It costs a token or two.** The probe asks for a single token of output. A
 *   check that sent no request could not distinguish a wrong `maxTokensField`
 *   from a working endpoint, and that field is the one this project keeps warning
 *   about because it 400s every attempt.
 * - **It reports the classifier's verdict, not its own.** `classifyFailure`
 *   already knows the difference between a rejected key, a forbidden model and a
 *   rate limit. Re-deriving that here would eventually disagree with the router,
 *   and then the test would be confidently wrong.
 *
 * Key material passes through `sign` and is never returned, logged, or included
 * in a verdict.
 */
import type { ModelRef } from '../core/types.js';

import type { RequestErrorClass } from '../recovery/classify.js';
import type { ModelCatalog } from './catalog.js';
import { createRequestBuilder } from './requests.js';
import { streamTurn, type FetchLike } from './transport.js';

/** What a probe concluded. One of these, never a bare boolean. */
export type ProbeVerdict =
  /** The endpoint answered and the stream decoded. The configuration works. */
  | { readonly t: 'ok'; readonly elapsedMs: number; readonly sawOutput: boolean }
  /** The request was attempted and failed. `errorClass` is the router's own. */
  | {
      readonly t: 'failed';
      readonly errorClass: RequestErrorClass;
      readonly httpStatus: number | null;
      readonly reason: string;
      readonly retryAfterMs: number | null;
      readonly elapsedMs: number;
    }
  /** Nothing was sent, because the configuration cannot produce a request. */
  | { readonly t: 'unconfigured'; readonly reason: string }
  /** The user cancelled. Not a result about the endpoint. */
  | { readonly t: 'cancelled' };

export interface ProbeDeps {
  readonly catalog: ModelCatalog;
  readonly fetchImpl: FetchLike;
  /**
   * Supplies a usable secret for a provider, or explains why there is none.
   *
   * A function rather than a `CredentialManager` so this module never depends on
   * credential storage, and so a probe cannot report a key's health as a side
   * effect: a test connection is a question, and answering it must not take a
   * key out of rotation.
   */
  readonly secretFor: (
    providerId: string,
  ) => Promise<{ readonly t: 'secret'; readonly secret: string } | { readonly t: 'none'; readonly reason: string }>;
  readonly signal?: AbortSignal;
  /** Injected for deterministic elapsed times under test. */
  readonly now?: () => number;
  readonly connectTimeoutMs?: number | null;
  readonly idleTimeoutMs?: number | null;
}

/**
 * The smallest prompt that still exercises the real path.
 *
 * Deliberately not empty: several endpoints reject a request with no messages,
 * and a probe that tripped over that would report a broken endpoint for a working
 * one. "Reply with OK" is one token of work.
 */
const PROBE_OBJECTIVE = 'Connection test. Reply with the single word OK.';

/**
 * Attempts one real request against a configured model.
 *
 * Never throws for an endpoint problem — that is the *answer*, returned as a
 * verdict. It throws only for a programming error, which a caller cannot handle
 * anyway.
 */
export async function probeModel(deps: ProbeDeps, model: ModelRef): Promise<ProbeVerdict> {
  const now = deps.now ?? Date.now;
  const { catalog } = deps;

  const provider = catalog.provider(model.providerId);
  if (provider === null) {
    return {
      t: 'unconfigured',
      reason: `No endpoint named "${model.providerId}" is configured.`,
    };
  }
  const entry = catalog.entry(model);
  if (entry === null) {
    return {
      t: 'unconfigured',
      reason:
        `"${model.modelId}" is not declared against "${model.providerId}", so CodeRelay does ` +
        'not know its output limit and cannot build a request.',
    };
  }

  const adapter = catalog.adapterMap().get(model.providerId);
  if (adapter === undefined) {

    return {
      t: 'unconfigured',
      reason: `CodeRelay has no adapter for the "${provider.kind}" protocol.`,
    };
  }

  const acquired = await deps.secretFor(model.providerId);
  if (acquired.t === 'none') {
    return { t: 'unconfigured', reason: acquired.reason };
  }

  // The real builder, so a wrong `maxTokensField` or base URL fails here exactly
  // as it would during a task.
  const build = createRequestBuilder({ catalog, toolSpecs: [] });
  const unsigned = build({
    model,
    objective: PROBE_OBJECTIVE,
    transcript: [],
    handoff: null,
    // No tools: this asks "can we reach it", not "can it call tools", and the
    // latter is a declared capability rather than something to discover.
    toolNames: [],
  });

  const signed = adapter.sign(unsigned, acquired.secret);
  const started = now();

  let sawOutput = false;
  const outcome = await streamTurn(
    {
      fetchImpl: deps.fetchImpl,
      decoder: adapter.createDecoder(),
      ...(deps.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: deps.connectTimeoutMs }),
      ...(deps.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: deps.idleTimeoutMs }),
    },
    {
      url: signed.url,
      ...(signed.method === undefined ? {} : { method: signed.method }),
      headers: signed.headers ?? {},
      ...(signed.body === undefined ? {} : { body: signed.body }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
    (event) => {
      if (event.t === 'text' && event.delta !== '') {
        sawOutput = true;
      }
    },
  );

  const elapsedMs = now() - started;

  if (outcome.cancelled) {
    return { t: 'cancelled' };
  }
  if (outcome.ok) {
    return { t: 'ok', elapsedMs, sawOutput };
  }

  const failure = outcome.failure;
  return {
    t: 'failed',
    errorClass: failure?.errorClass ?? 'UNKNOWN',
    httpStatus: outcome.httpStatus,
    reason: failure?.reason ?? 'The request failed without a stated reason.',
    retryAfterMs: failure?.retryAfterMs ?? null,
    elapsedMs,
  };
}

/**
 * A verdict as a headline and a next step.
 *
 * Pure, so every sentence is testable, and separate from `probeModel` so the
 * wording is not entangled with the I/O. The same rule the timeline follows: a
 * failure says what happened and what to do, never just "Error".
 */
export function describeVerdict(
  verdict: ProbeVerdict,
  model: ModelRef,
): { readonly headline: string; readonly detail: string; readonly ok: boolean } {
  switch (verdict.t) {
    case 'ok':
      return {
        ok: true,
        headline: `${model.providerId}/${model.modelId} is working.`,
        detail: verdict.sawOutput
          ? `The endpoint answered and streamed output in ${verdict.elapsedMs} ms.`
          : `The endpoint accepted the request and closed cleanly in ${verdict.elapsedMs} ms, ` +
            'without emitting any text. The connection and the credential are fine.',
      };

    case 'cancelled':
      return { ok: false, headline: 'Connection test cancelled.', detail: '' };

    case 'unconfigured':
      return { ok: false, headline: 'Nothing was sent.', detail: verdict.reason };

    case 'failed':
      return { ok: false, headline: failureHeadline(verdict), detail: failureDetail(verdict) };
  }
}

function failureHeadline(verdict: Extract<ProbeVerdict, { t: 'failed' }>): string {
  switch (verdict.errorClass) {
    case 'AUTH':
      return 'The key was rejected.';
    case 'FORBIDDEN':
      return 'The key is valid, but not allowed to use this model.';
    case 'CONFIG':
      return 'The endpoint rejected the request as invalid.';
    case 'NETWORK':
      return 'Could not reach the endpoint.';
    case 'TLS_UNTRUSTED':
      return 'The endpoint\u2019s certificate could not be verified.';
    case 'RETRYABLE':
      return verdict.httpStatus === 429 ? 'Rate limited.' : 'The endpoint was busy.';
    case 'CONTEXT':
      return 'The endpoint rejected the request as too large.';
    case 'STREAM':
      return 'The response was cut off part-way.';
    default:
      return 'The request failed.';
  }
}

function failureDetail(verdict: Extract<ProbeVerdict, { t: 'failed' }>): string {
  const status = verdict.httpStatus === null ? '' : ` (HTTP ${verdict.httpStatus})`;
  const advice = ((): string => {
    switch (verdict.errorClass) {
      case 'AUTH':
        return 'Check the key, or add a different one. The endpoint itself answered, so the URL is right.';
      case 'FORBIDDEN':
        return 'Check what your account has access to. Nothing is wrong with the key or the URL.';
      case 'CONFIG':
        return (
          'Usually the model id, or the output-token field for this endpoint: newer OpenAI ' +
          'models require max_completion_tokens and reject max_tokens, while most gateways ' +
          'accept only max_tokens.'
        );
      case 'NETWORK':
        return 'Check the base URL, your connection, and whether a local server is running.';
      case 'TLS_UNTRUSTED':
        return 'Usually a corporate proxy intercepting HTTPS. Trust its CA certificate, or use an endpoint that is not intercepted.';
      case 'RETRYABLE':
        return verdict.retryAfterMs === null
          ? 'Transient. The endpoint and the key are configured correctly; try again shortly.'
          : `Transient. The endpoint asked us to wait about ${Math.ceil(verdict.retryAfterMs / 1_000)} seconds.`;
      case 'CONTEXT':
        return 'Surprising for a one-token probe. Check the declared context window against the endpoint\u2019s real limit.';
      case 'STREAM':
        return 'The endpoint is reachable and the key works, but the stream did not complete.';
      default:
        return 'CodeRelay could not classify this failure. The Output panel has the details.';
    }
  })();
  return `${verdict.reason}${status} ${advice}`.trim();
}
