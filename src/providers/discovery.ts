/**
 * Asking a provider which models it will serve.
 *
 * This is the only place CodeRelay learns model *ids* from a provider rather
 * than from the user. It deliberately does not learn anything else. A listing
 * endpoint reports what exists, not what it costs or how big its context window
 * is — OpenAI's `/models` returns an id, an owner and a creation date, and
 * nothing about capability. So discovery fills in the one field it can know and
 * leaves `contextWindow`, `maxOutput` and `toolCalling` to be confirmed by the
 * person setting the provider up.
 *
 * Guessing those instead would be worse than asking: the router gates failover
 * on them, and a wrong context window is a confident lie that shows up as a
 * mid-task failure the user cannot explain.
 *
 * The three protocols disagree about the envelope, so each branch below is
 * written against one documented response shape. Anything else is reported as a
 * failure with a reason the user can act on, never as a guessed fallback.
 */
import type { ProviderAdapter } from './adapter.js';
import type { ProviderConfig } from './catalog.js';
import type { FetchLike } from './transport.js';

export type DiscoveryResult =
  /**
   * The provider answered with a list. May legitimately be empty.
   *
   * There is deliberately no `unsupported` case. All three protocols document a
   * listing endpoint, and an OpenAI-compatible server that does not implement
   * one answers 404 — which is already `failed`, with a reason that names the
   * base URL as the thing to check.
   */
  | { readonly kind: 'ok'; readonly modelIds: readonly string[] }
  /** The request was made and failed. `reason` is safe to show a user. */
  | { readonly kind: 'failed'; readonly reason: string };

export interface DiscoveryDeps {
  readonly fetchImpl: FetchLike;
  /** Applies credentials. The secret never leaves the adapter. */
  readonly adapter: ProviderAdapter;
  readonly secret: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Lists the models an endpoint will serve.
 *
 * Never throws: a setup wizard that explodes on an unreachable endpoint is worse
 * than one that says "could not reach it, type the model id instead".
 */
export async function discoverModels(
  config: ProviderConfig,
  deps: DiscoveryDeps,
): Promise<DiscoveryResult> {
  const url = listingUrl(config);
  const signed = deps.adapter.sign({ url, method: 'GET', headers: {} }, deps.secret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await deps.fetchImpl(signed.url, {
      method: 'GET',
      headers: signed.headers ?? {},
      signal: controller.signal,
    });

    if (response.status < 200 || response.status >= 300) {
      return { kind: 'failed', reason: statusReason(response.status) };
    }

    const body = await readBody(response);
    const ids = parseListing(config, body);
    return ids === null
      ? { kind: 'failed', reason: 'The provider answered, but not with a model list.' }
      : { kind: 'ok', modelIds: ids };
  } catch (err: unknown) {
    return { kind: 'failed', reason: transportReason(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** The documented listing endpoint for each protocol. */
function listingUrl(config: ProviderConfig): string {
  const base = config.baseUrl.replace(/\/+$/, '');
  switch (config.kind) {
    case 'openai':
      // `baseUrl` already includes the version segment, by configuration.
      return `${base}/models`;
    case 'anthropic':
      return `${base}/v1/models`;
    case 'gemini':
      return `${base}/${config.apiVersion ?? 'v1beta'}/models`;
  }
}

/**
 * Extracts ids from whichever envelope the provider uses.
 *
 * Returns null when the body is not a listing at all, which is a different fact
 * from an empty list and is reported differently.
 */
export function parseListing(config: ProviderConfig, body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;

  if (config.kind === 'gemini') {
    const models = record['models'];
    if (!Array.isArray(models)) {
      return null;
    }
    // Gemini qualifies every id as `models/<id>`; the generateContent call wants
    // it in the same qualified form the listing returned, minus the prefix.
    return models
      .map((m) => (typeof m === 'object' && m !== null ? (m as Record<string, unknown>)['name'] : null))
      .filter((n): n is string => typeof n === 'string')
      .map((n) => (n.startsWith('models/') ? n.slice('models/'.length) : n));
  }

  // OpenAI and Anthropic both use `{ data: [{ id }] }`.
  const data = record['data'];
  if (!Array.isArray(data)) {
    return null;
  }
  return data
    .map((m) => (typeof m === 'object' && m !== null ? (m as Record<string, unknown>)['id'] : null))
    .filter((id): id is string => typeof id === 'string' && id !== '');
}

async function readBody(response: { text?: () => Promise<string>; body?: unknown }): Promise<unknown> {
  if (typeof response.text !== 'function') {
    return null;
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Plain-language reasons. Never echoes a response body, which may hold a key. */
function statusReason(status: number): string {
  if (status === 401) {
    return 'The API key was rejected (401). Check the key and try again.';
  }
  if (status === 403) {
    return 'The key is valid but not permitted to list models (403).';
  }
  if (status === 404) {
    return 'No model listing at that URL (404). Check the base URL.';
  }
  if (status === 429) {
    return 'Rate limited (429). Wait a moment and try again.';
  }
  return `The provider returned ${status}.`;
}

function transportReason(err: unknown): string {
  const code = (err as { code?: string } | null)?.code
    ?? ((err as { cause?: { code?: string } } | null)?.cause?.code);
  if ((err as { name?: string } | null)?.name === 'AbortError') {
    return 'The provider did not respond in time.';
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'That host could not be resolved. Check the base URL and your connection.';
    case 'ECONNREFUSED':
      return 'The connection was refused. Is the endpoint running?';
    case 'CERT_HAS_EXPIRED':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'The TLS certificate could not be verified. Check your proxy or CA settings.';
    default:
      return 'The endpoint could not be reached.';
  }
}
