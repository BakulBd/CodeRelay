/**
 * The model catalog: which endpoints exist, and what their models can do.
 *
 * ## Why capabilities come from configuration rather than from this file
 *
 * Every adapter in this directory returns `null` from `capabilities()`, on the
 * stated grounds that a fabricated context window causes exactly the silent
 * truncation CodeRelay exists to prevent. That is the right call, but it leaves
 * `route()` unable to build a single `Candidate` — and `Candidate.capabilities`
 * is not optional, because a capability-gated router cannot gate on a value it
 * does not have. A catalog hard-coded here would have to be wrong eventually:
 * model line-ups change monthly, so shipping them inside an extension means a
 * release per model launch, and any entry that goes stale becomes a confident
 * lie about a context window.
 *
 * So capabilities are *declared*, by whoever configures the extension, and this
 * module's job is to validate the declaration rather than to invent it. The
 * distinction that matters: CodeRelay never claims a model can do something. It
 * records what it was told, and `route()` gates on that. A user who mis-declares
 * a context window gets a `CONTEXT` failure and a compaction, which is the same
 * path as any other overflow — recoverable, and visibly attributable.
 *
 * Unknown optional capabilities default to *absent*, never to present. A model
 * declared without `vision` is treated as having no vision, so the router will
 * not send it an image; the opposite default would let a silent downgrade
 * through, which `route()`'s `degraded` list exists to prevent.
 *
 * ## Why an endpoint is a configuration entry too
 *
 * `OpenAiCompatibleAdapter` already takes `providerId` and a signer as
 * constructor arguments precisely because OpenAI, OpenRouter, NVIDIA, Azure and
 * a local server speak one wire format and differ only in URL and auth. This
 * module is where that observation is turned into data: an endpoint is a row,
 * not a subclass, so adding "my company's vLLM box" needs no code.
 */
import type { ModelCapabilities, ModelRef } from '../core/types.js';
import {
  bearerAuth,
  type BuiltRequest,
  type ProviderAdapter,
  type RequestSigner,
} from './adapter.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';
import { OpenAiCompatibleAdapter } from './openai.js';

/**
 * The wire protocol an endpoint speaks.
 *
 * Three, not one per vendor: `openai` covers every endpoint that speaks Chat
 * Completions, which is most of the target list.
 */
export type ProviderKind = 'anthropic' | 'openai' | 'gemini';

/**
 * How an endpoint expects a credential.
 *
 * Only meaningful for `kind: 'openai'`, where the same protocol is served behind
 * three different auth schemes. `anthropic` and `gemini` each have exactly one,
 * applied by their own adapter.
 */
export type AuthScheme = 'bearer' | 'api-key-header' | 'none';

export interface ProviderConfig {
  /**
   * Stable id, recorded in the ledger and used to key credentials.
   *
   * Distinct from `kind`: "openrouter" and "nvidia" are both `kind: 'openai'`,
   * and the ledger needs to say which one actually ran.
   */
  readonly id: string;
  readonly kind: ProviderKind;
  /** Origin and base path, without the endpoint-specific suffix. No trailing slash. */
  readonly baseUrl: string;
  readonly auth?: AuthScheme;
  /**
   * The API version.
   *
   * A query parameter for Azure OpenAI (`?api-version=`), and a path segment for
   * Gemini (`/v1beta/`). One field for both because it is the same fact in both
   * places, and because pinning it in settings means a new API version does not
   * need a release.
   */
  readonly apiVersion?: string;
  /**
   * Which field carries the output-token cap, for `kind: 'openai'` endpoints.
   *
   * Not guessable: newer OpenAI models require `max_completion_tokens` and reject
   * `max_tokens`, while most third-party gateways accept only `max_tokens`.
   * Getting it wrong is a 400 on every single attempt — a failure mode failover
   * cannot route around — so it is declared rather than inferred. `'none'` omits
   * the cap entirely and lets the endpoint apply its own default.
   */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens' | 'none';
  /** Extra request headers, e.g. OpenRouter's attribution headers. Never secrets. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * A model, as declared by configuration.
 *
 * `contextWindow`, `maxOutput` and `toolCalling` are required rather than
 * defaulted. Defaulting `toolCalling` either way is a trap: `true` lets the
 * router send tool definitions to a model that cannot use them, and `false`
 * silently removes the model from a task whose `Requirements.toolCalling` is set.
 * Making it explicit costs one field in settings and removes a whole class of
 * "why did it never pick this model" confusion.
 */
export interface ModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly toolCalling: boolean;
  readonly streaming?: boolean;
  readonly parallelToolCalls?: boolean;
  readonly vision?: boolean;
  readonly reasoning?: 'none' | 'implicit' | 'explicit';
  readonly structuredOutput?: boolean;
  /** USD per million tokens. Used only to break ties between failover targets. */
  readonly costPerMTokIn?: number;
  readonly costPerMTokOut?: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(rec: Record<string, unknown>, field: string, what: string): string {
  const value = rec[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${what} is missing a non-empty "${field}".`);
  }
  return value.trim();
}

function requirePositiveInt(rec: Record<string, unknown>, field: string, what: string): number {
  const value = rec[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${what} needs "${field}" to be a positive number.`);
  }
  return Math.floor(value);
}

function requireBoolean(rec: Record<string, unknown>, field: string, what: string): boolean {
  const value = rec[field];
  if (typeof value !== 'boolean') {
    throw new ConfigError(
      `${what} needs "${field}" to be true or false. It is required rather than ` +
        'assumed, because guessing it either hides a model from the router or ' +
        'sends tool definitions to a model that cannot use them.',
    );
  }
  return value;
}

function optionalBoolean(rec: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = rec[field];
  return typeof value === 'boolean' ? value : fallback;
}

function optionalNumber(rec: Record<string, unknown>, field: string, fallback: number): number {
  const value = rec[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

const KINDS: readonly ProviderKind[] = ['anthropic', 'openai', 'gemini'];
const AUTH_SCHEMES: readonly AuthScheme[] = ['bearer', 'api-key-header', 'none'];
const MAX_TOKENS_FIELDS = ['max_tokens', 'max_completion_tokens', 'none'] as const;
const REASONING = ['none', 'implicit', 'explicit'] as const;

/** Validates one provider row from user settings. */
export function parseProviderConfig(raw: unknown): ProviderConfig {
  const rec = asRecord(raw, 'A provider entry');
  const id = requireString(rec, 'id', 'A provider entry');
  const kindRaw = requireString(rec, 'kind', `Provider "${id}"`);
  if (!KINDS.includes(kindRaw as ProviderKind)) {
    throw new ConfigError(
      `Provider "${id}" has kind "${kindRaw}". Supported kinds: ${KINDS.join(', ')}.`,
    );
  }
  const baseUrl = requireString(rec, 'baseUrl', `Provider "${id}"`).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ConfigError(`Provider "${id}" needs an http(s) baseUrl, not "${baseUrl}".`);
  }

  const authRaw = rec['auth'];
  let auth: AuthScheme | undefined;
  if (typeof authRaw === 'string') {
    if (!AUTH_SCHEMES.includes(authRaw as AuthScheme)) {
      throw new ConfigError(
        `Provider "${id}" has auth "${authRaw}". Supported: ${AUTH_SCHEMES.join(', ')}.`,
      );
    }
    auth = authRaw as AuthScheme;
  }

  const headersRaw = rec['headers'];
  let headers: Record<string, string> | undefined;
  if (headersRaw !== undefined) {
    headers = {};
    for (const [key, value] of Object.entries(asRecord(headersRaw, `Provider "${id}" headers`))) {
      if (typeof value !== 'string') {
        throw new ConfigError(`Provider "${id}" header "${key}" must be a string.`);
      }
      headers[key] = value;
    }
  }

  const apiVersion = typeof rec['apiVersion'] === 'string' ? rec['apiVersion'] : undefined;

  const fieldRaw = rec['maxTokensField'];
  let maxTokensField: ProviderConfig['maxTokensField'];
  if (typeof fieldRaw === 'string') {
    if (!(MAX_TOKENS_FIELDS as readonly string[]).includes(fieldRaw)) {
      throw new ConfigError(
        `Provider "${id}" has maxTokensField "${fieldRaw}". Supported: ${MAX_TOKENS_FIELDS.join(', ')}.`,
      );
    }
    maxTokensField = fieldRaw as ProviderConfig['maxTokensField'];
  }

  return {
    id,
    kind: kindRaw as ProviderKind,
    baseUrl,
    ...(auth === undefined ? {} : { auth }),
    ...(apiVersion === undefined ? {} : { apiVersion }),
    ...(maxTokensField === undefined ? {} : { maxTokensField }),
    ...(headers === undefined ? {} : { headers }),
  };
}

/** Validates one model row from user settings. */
export function parseModelConfig(raw: unknown): ModelConfig {
  const rec = asRecord(raw, 'A model entry');
  const provider = requireString(rec, 'provider', 'A model entry');
  const model = requireString(rec, 'model', `Model on provider "${provider}"`);
  const what = `Model "${provider}/${model}"`;

  const reasoningRaw = rec['reasoning'];
  const reasoning =
    typeof reasoningRaw === 'string' && (REASONING as readonly string[]).includes(reasoningRaw)
      ? (reasoningRaw as ModelConfig['reasoning'])
      : 'none';

  return {
    provider,
    model,
    contextWindow: requirePositiveInt(rec, 'contextWindow', what),
    maxOutput: requirePositiveInt(rec, 'maxOutput', what),
    toolCalling: requireBoolean(rec, 'toolCalling', what),
    streaming: optionalBoolean(rec, 'streaming', true),
    parallelToolCalls: optionalBoolean(rec, 'parallelToolCalls', false),
    vision: optionalBoolean(rec, 'vision', false),
    reasoning,
    structuredOutput: optionalBoolean(rec, 'structuredOutput', false),
    costPerMTokIn: optionalNumber(rec, 'costPerMTokIn', 0),
    costPerMTokOut: optionalNumber(rec, 'costPerMTokOut', 0),
  };
}

/**
 * Expands a declaration into the full capability record the router gates on.
 *
 * Absent optional capabilities become `false`/`'none'`, never `true`. An
 * over-claim would let `route()` pick a model that cannot do the job and report
 * nothing degraded; an under-claim merely makes the model ineligible, which is
 * visible and fixable.
 */
export function resolveCapabilities(entry: ModelConfig): ModelCapabilities {
  return {
    streaming: entry.streaming ?? true,
    toolCalling: entry.toolCalling,
    parallelToolCalls: entry.parallelToolCalls ?? false,
    vision: entry.vision ?? false,
    reasoning: entry.reasoning ?? 'none',
    structuredOutput: entry.structuredOutput ?? false,
    contextWindow: entry.contextWindow,
    maxOutput: entry.maxOutput,
    costPerMTokIn: entry.costPerMTokIn ?? 0,
    costPerMTokOut: entry.costPerMTokOut ?? 0,
  };
}

/**
 * Signs with an `api-key` header, which is Azure OpenAI's scheme.
 *
 * The `api-version` query parameter Azure also requires is *not* added here: the
 * request builder owns the URL and already knows the configured version, and
 * splitting URL construction across two modules is how a signer ends up
 * double-appending a query string.
 */
export const apiKeyHeaderAuth: RequestSigner = (request: BuiltRequest, secret: string) => ({
  ...request,
  headers: { ...(request.headers ?? {}), 'api-key': secret },
});

/**
 * Applies no credential at all.
 *
 * For a local runtime that does not authenticate. The secret is ignored rather
 * than sent as an empty header, because some servers reject a malformed
 * `Authorization` more readily than a missing one.
 */
export const noAuth: RequestSigner = (request: BuiltRequest) => request;

function signerFor(config: ProviderConfig): RequestSigner {
  switch (config.auth ?? 'bearer') {
    case 'api-key-header':
      return apiKeyHeaderAuth;
    case 'none':
      return noAuth;
    case 'bearer':
      return bearerAuth;
  }
}

/**
 * Builds the adapter for one endpoint.
 *
 * The capability table passed to `OpenAiCompatibleAdapter` stays empty on
 * purpose. Capabilities are resolved from configuration by `ModelCatalog`, and
 * feeding the same data in twice would create two sources of truth that could
 * disagree — with the adapter's copy being the one nothing validates.
 */
export function createAdapter(config: ProviderConfig): ProviderAdapter {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicAdapter();
    case 'gemini':
      return new GeminiAdapter();
    case 'openai':
      return new OpenAiCompatibleAdapter(config.id, {}, signerFor(config));
  }
}

/**
 * Resolved providers and models, indexed for lookup.
 *
 * Construction is where configuration errors surface, so a bad settings file
 * fails at "start a task" with a specific message rather than mid-stream with a
 * provider 404.
 */
export class ModelCatalog {
  private readonly providers = new Map<string, ProviderConfig>();
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly models = new Map<string, ModelConfig>();

  private constructor(
    providers: readonly ProviderConfig[],
    models: readonly ModelConfig[],
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) {
        throw new ConfigError(
          `Provider id "${provider.id}" is configured twice. Ids key credentials and ` +
            'appear in the ledger, so they must be unique.',
        );
      }
      this.providers.set(provider.id, provider);
      this.adapters.set(provider.id, createAdapter(provider));
    }

    for (const model of models) {
      if (!this.providers.has(model.provider)) {
        throw new ConfigError(
          `Model "${model.model}" names provider "${model.provider}", which is not configured.`,
        );
      }
      const key = refKey({ providerId: model.provider, modelId: model.model });
      if (this.models.has(key)) {
        throw new ConfigError(`Model "${model.provider}/${model.model}" is configured twice.`);
      }
      this.models.set(key, model);
    }
  }

  /** Validates raw settings values and builds the catalog. Throws `ConfigError`. */
  static fromSettings(rawProviders: unknown, rawModels: unknown): ModelCatalog {
    const providerList = Array.isArray(rawProviders) ? rawProviders : [];
    const modelList = Array.isArray(rawModels) ? rawModels : [];
    return new ModelCatalog(
      providerList.map(parseProviderConfig),
      modelList.map(parseModelConfig),
    );
  }

  /** Already-validated inputs, for tests and for programmatic construction. */
  static of(providers: readonly ProviderConfig[], models: readonly ModelConfig[]): ModelCatalog {
    return new ModelCatalog(providers, models);
  }

  /** Adapters keyed by `providerId`, in the shape `AgentLoopDeps.adapters` wants. */
  adapterMap(): ReadonlyMap<string, ProviderAdapter> {
    return this.adapters;
  }

  provider(providerId: string): ProviderConfig | null {
    return this.providers.get(providerId) ?? null;
  }

  /**
   * Every configured endpoint, in configuration order.
   *
   * Exists because a provider and a model are configured separately, and a caller
   * that needs the endpoints must not have to infer them from the model list.
   * Deriving them that way — `entries().map(e => e.provider)` — silently reports
   * *no providers* for a user who has added an endpoint but not yet declared a
   * model against it, which is exactly the state someone is in while setting up.
   * That produced a circular dead end: the key command claimed no provider was
   * configured, and configuring a model first needs a working key to be useful.
   */
  providerIds(): readonly string[] {
    return [...this.providers.keys()];
  }

  /** Every configured endpoint. */
  providerConfigs(): readonly ProviderConfig[] {
    return [...this.providers.values()];
  }

  /** True when at least one endpoint exists, whether or not a model names it. */
  hasProviders(): boolean {
    return this.providers.size > 0;
  }

  /** Models declared against one endpoint. */
  modelsFor(providerId: string): readonly ModelConfig[] {
    return this.entries().filter((m) => m.provider === providerId);
  }


  /** Every declared model, in configuration order. */
  entries(): readonly ModelConfig[] {
    return [...this.models.values()];
  }

  refs(): readonly ModelRef[] {
    return this.entries().map((m) => ({ providerId: m.provider, modelId: m.model }));
  }

  entry(ref: ModelRef): ModelConfig | null {
    return this.models.get(refKey(ref)) ?? null;
  }

  /**
   * Capabilities for a model, or null if it is not declared.
   *
   * Configuration wins over anything an adapter claims to know: an explicit
   * declaration is the more specific statement, and it is the one the user can
   * correct without shipping a release.
   */
  capabilities(ref: ModelRef): ModelCapabilities | null {
    const declared = this.models.get(refKey(ref));
    if (declared !== undefined) {
      return resolveCapabilities(declared);
    }
    return this.adapters.get(ref.providerId)?.capabilities(ref.modelId) ?? null;
  }

  /** True when at least one model is usable, i.e. the extension is configured. */
  isConfigured(): boolean {
    return this.models.size > 0;
  }
}

export function refKey(ref: ModelRef): string {
  return `${ref.providerId} ${ref.modelId}`;
}
