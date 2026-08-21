import type { ErrorClass } from '../core/types.js';

/**
 * The error classes a *request* failure can have.
 *
 * `TOOL` and `FILESYSTEM` are excluded by construction. Those describe things
 * that went wrong while executing an effect, they are recorded directly by
 * `ToolRunner`, and they are resolved from the ledger by `planRecovery` — never
 * by re-routing a request. Excluding them here means the routing policy can be
 * exhaustive over what it actually receives, instead of carrying a branch for
 * inputs that cannot arrive.
 */
export type RequestErrorClass = Exclude<ErrorClass, 'TOOL' | 'FILESYSTEM'>;


/** Everything the classifier can look at. Adapters populate what they know. */
export interface FailureContext {
  /** HTTP status, if a response was received at all. */
  readonly status?: number;
  /** Node/undici error code, e.g. ECONNRESET, ENOTFOUND, CERT_HAS_EXPIRED. */
  readonly code?: string;
  readonly message?: string;
  /** Response content-type, used to spot proxies returning HTML for a JSON API. */
  readonly contentType?: string;
  /** True if any model tokens arrived before the failure. */
  readonly hadStreamedTokens?: boolean;
  /** True if the SSE stream ended without a terminal event. */
  readonly streamEndedEarly?: boolean;
}

export interface Classification {
  readonly errorClass: ErrorClass;
  /** Whether the *network request* may be retried. Says nothing about side effects. */
  readonly requestRetryable: boolean;
  /** Suggested delay before a retry, when the provider told us one. */
  readonly retryAfterMs: number | null;
  /** Whether the current credential should be taken out of rotation. */
  readonly rotateCredential: boolean;
  /** Short explanation for the timeline. Must be safe to display. */
  readonly reason: string;
}

/**
 * A classification that came from attempting a request.
 *
 * This is what `classifyFailure` returns, and it is narrower than
 * `Classification` on purpose: the classifier is only ever handed transport and
 * HTTP evidence, so it cannot produce `TOOL` or `FILESYSTEM`. Stating that in
 * the type means the routing policy downstream can be exhaustive over what can
 * actually reach it, and a tool failure cannot be smuggled into a routing
 * decision by accident.
 */
export interface RequestClassification extends Classification {
  readonly errorClass: RequestErrorClass;
}

/** Network-level codes that indicate a transient transport problem. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  // TLS handshake that failed for transport reasons rather than trust reasons.
  // Distinct from the codes below, and genuinely worth retrying.
  'EPROTO',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
]);


/**
 * TLS failures that mean the certificate chain itself is wrong.
 *
 * These are surfaced immediately rather than retried, because burning a retry
 * budget on a misconfigured corporate proxy just delays the real diagnosis.
 * Claude Code makes the same distinction — its error reference notes that
 * certificate validation failures are reported on the first attempt while
 * transient TLS conditions such as handshake timeouts are still retried.
 */
const TLS_TRUST_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
]);

/**
 * Statuses worth retrying with backoff. 529 is Anthropic's overload signal.
 *
 * 409 and 425 are deliberately absent. A conflict is a genuine disagreement
 * about state that will recur on an identical retry, and `Too Early` only
 * arises from TLS early data, which this transport never sends. Treating either
 * as transient would spend the attempt budget on a failure that cannot clear.
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);


/**
 * Classifies a failure so the recovery policy can act on cause rather than
 * treating everything as "retry".
 *
 * Order matters: the most specific and most consequential signals are checked
 * first. In particular, credential problems are decided before generic status
 * handling so a 401 can never be mistaken for something retryable.
 */
export function classifyFailure(ctx: FailureContext): RequestClassification {
  const { status, code, contentType } = ctx;

  // Certificate trust: actionable configuration problem, not a blip.
  if (code && TLS_TRUST_CODES.has(code)) {
    return {
      errorClass: 'TLS_UNTRUSTED',
      requestRetryable: false,
      retryAfterMs: null,
      rotateCredential: false,
      reason: `TLS certificate could not be verified (${code}). Check proxy or CA configuration.`,
    };
  }

  // 401 means the key itself was not accepted. Retrying it is pointless and
  // repeated attempts with a rejected key are what trips abuse detection.
  if (status === 401) {
    return {
      errorClass: 'AUTH',
      requestRetryable: true, // retryable only with a *different* credential
      retryAfterMs: null,
      rotateCredential: true,
      reason: 'Credential rejected (401). Rotating to the next key.',
    };
  }

  // 403 is a different fact, and conflating the two is expensive. Providers use
  // it for "this key is not enabled for this model", "this region is not
  // permitted" and "your organisation blocked this endpoint" — none of which
  // mean the key is bad. Disabling it would take a credential that works
  // everywhere else out of rotation, so the scope of the refusal is left to the
  // router: the pairing is wrong, not the key.
  if (status === 403) {
    return {
      errorClass: 'FORBIDDEN',
      requestRetryable: false,
      retryAfterMs: null,
      rotateCredential: false,
      reason:
        'The provider refused this request (403). The credential is recognised but is not ' +
        'permitted to use this model, endpoint or region.',
    };
  }


  // A JSON API answering with HTML almost always means something intercepted
  // the connection: captive portal, proxy error page, or a gateway notice.
  //
  // Only applied to nominally successful responses. A 5xx that happens to carry
  // an HTML error page is the provider failing, not an interceptor, and saying
  // "captive portal" there would send the user chasing the wrong problem.
  if (
    contentType &&
    (status === undefined || status < 400) &&
    !isJsonish(contentType) &&
    !isEventStream(contentType)
  ) {

    return {
      errorClass: 'STREAM',
      requestRetryable: true,
      retryAfterMs: 2_000,
      rotateCredential: false,
      reason:
        `Expected a JSON or SSE response but received "${contentType}". ` +
        'A proxy or captive portal is probably intercepting the connection.',
    };
  }

  if (status !== undefined && RETRYABLE_STATUS.has(status)) {
    return {
      errorClass: 'RETRYABLE',
      requestRetryable: true,
      retryAfterMs: status === 429 ? 5_000 : 1_000,
      rotateCredential: status === 429, // spread load across keys on throttle
      reason:
        status === 529
          ? 'Provider reported it is overloaded (529).'
          : `Provider returned ${status}.`,
    };
  }

  // Context limits: retrying unchanged cannot help; the request must shrink or
  // move to a larger-context model.
  if (status === 413 || mentionsContextLimit(ctx.message)) {
    return {
      errorClass: 'CONTEXT',
      requestRetryable: false,
      retryAfterMs: null,
      rotateCredential: false,
      reason: 'Request exceeded the model context or output limit.',
    };
  }

  // Remaining 4xx are our fault: bad model id, unsupported parameter, malformed
  // body. Retrying identical input just wastes time and quota.
  if (status !== undefined && status >= 400 && status < 500) {
    return {
      errorClass: 'CONFIG',
      requestRetryable: false,
      retryAfterMs: null,
      rotateCredential: false,
      reason: `Request was rejected as invalid (${status}). Check model id and parameters.`,
    };
  }

  if (code && TRANSIENT_NETWORK_CODES.has(code)) {
    return {
      errorClass: 'NETWORK',
      requestRetryable: true,
      retryAfterMs: 2_000,
      rotateCredential: false,
      reason: `Network failure (${code}).`,
    };
  }

  // Stream died without a terminal event and without an HTTP error. This is the
  // case that motivates the whole ledger: tokens may have arrived, and a tool
  // call may already be in flight, so the request being "retryable" is not the
  // same as the task being safe to replay.
  if (ctx.streamEndedEarly) {
    return {
      errorClass: 'STREAM',
      requestRetryable: true,
      retryAfterMs: 1_000,
      rotateCredential: false,
      reason: ctx.hadStreamedTokens
        ? 'Stream ended mid-response after tokens were received.'
        : 'Stream ended before any content arrived.',
    };
  }

  if (status !== undefined && status >= 500) {
    return {
      errorClass: 'RETRYABLE',
      requestRetryable: true,
      retryAfterMs: 1_000,
      rotateCredential: false,
      reason: `Provider server error (${status}).`,
    };
  }

  return {
    errorClass: 'UNKNOWN',
    requestRetryable: false,
    retryAfterMs: null,
    rotateCredential: false,
    reason: 'Unrecognized failure; not retrying automatically.',
  };
}

function isJsonish(contentType: string): boolean {
  return /application\/(json|x-ndjson)|\+json/i.test(contentType);
}

function isEventStream(contentType: string): boolean {
  return /text\/event-stream/i.test(contentType);
}

/**
 * Whether a provider message describes a context or output limit.
 *
 * Every separator is accepted between the words because the strings providers
 * actually return are error *codes* as often as prose: OpenAI-compatible
 * endpoints send `context_length_exceeded`, Gemini reports
 * `input token count exceeds the maximum`, and Anthropic phrases it as prompt
 * length. Matching only the spaced prose form would leave the code forms falling
 * through to the generic 4xx branch, where a recoverable overflow is classified
 * `CONFIG` and the task dies instead of compacting.
 */
function mentionsContextLimit(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  return (
    /context[ _-]?(length|window|size)/i.test(message) ||
    /(maximum|max)[ _-]?context/i.test(message) ||
    /too[ _-]?many[ _-]?tokens/i.test(message) ||
    /max[ _-]?tokens/i.test(message) ||
    /(prompt|input)[ _-]?(is[ _-]?)?too[ _-]?long/i.test(message) ||
    // "exceeds the maximum number of tokens", "token count exceeds", etc. The
    // two words must be near each other so an unrelated sentence mentioning
    // tokens somewhere does not match.
    /token[s]?[ _-]?(count[ _-]?)?(exceed|exceeds|exceeded)/i.test(message) ||
    /exceed(s|ed)?[^.]{0,40}\btokens?\b/i.test(message)
  );
}

