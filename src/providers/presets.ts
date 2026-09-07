/**
 * Endpoint presets for the setup wizard.
 *
 * This is the one place in CodeRelay that ships vendor names, and it is worth
 * being precise about what it does and does not claim.
 *
 * **It contains no model ids and no capabilities.** `catalog.ts` explains why at
 * length: a model table inside an extension goes stale within a month and becomes
 * a confident lie about a context window, which the router then gates on. Nothing
 * here changes that — the user still declares every model and every capability.
 *
 * What a preset *does* hold is the small set of facts that are properties of the
 * **endpoint** rather than of the model line-up: the base URL, the wire protocol,
 * the auth scheme, and which field carries the output cap. Those are stable for
 * years, they are pure boilerplate to type, and getting one wrong produces a 400
 * on every single attempt — a failure failover cannot route around, which the
 * request builder already warns about. Removing that particular footgun is the
 * entire point.
 *
 * A preset is a *starting point*, not a constraint: every field lands in
 * `coderelay.providers` as ordinary settings the user can edit afterwards.
 */
import type { AuthScheme, ProviderConfig, ProviderKind } from './catalog.js';

export interface ProviderPreset {
  /** Stable key for the wizard's own list. Not the provider id. */
  readonly key: string;
  /** What the user recognises. */
  readonly label: string;
  /** The default `id` written to settings. Editable before saving. */
  readonly suggestedId: string;
  readonly kind: ProviderKind;
  /** Empty when the endpoint is per-deployment or per-host and must be asked for. */
  readonly baseUrl: string;
  readonly auth: AuthScheme;
  readonly maxTokensField?: ProviderConfig['maxTokensField'];
  /** Shown under the label in the picker. One line. */
  readonly detail: string;
  /** True when `baseUrl` must be supplied by the user. */
  readonly needsBaseUrl?: boolean;
  /** True when the endpoint needs an explicit API version (Azure, Gemini). */
  readonly needsApiVersion?: boolean;
  /** Where to look up model ids. Never a model list — those go stale. */
  readonly modelsUrl?: string;
  /** Curated popular models for 1-click selection if listing is absent or filtered. */
  readonly popularModels?: readonly string[];
  /** Category badge for the UI card. */
  readonly category?: 'cloud' | 'local' | 'gateway' | 'custom';
  /** Example API key placeholder for hints. */
  readonly keyPlaceholder?: string;
  /** Extra headers this endpoint conventionally wants. Never a credential. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The presets, in the order a user is most likely to want them.
 *
 * Every `openai`-kind entry states `maxTokensField` explicitly, because that is
 * the field nobody can guess: newer OpenAI models reject `max_tokens` and require
 * `max_completion_tokens`, while most gateways accept only the former.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    key: 'anthropic',
    label: 'Anthropic',
    suggestedId: 'anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    auth: 'bearer',
    category: 'cloud',
    keyPlaceholder: 'sk-ant-api03-...',
    detail: 'Claude 3.7 & 3.5 models via Anthropic Messages API',
    modelsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models',
    popularModels: [
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ],
  },
  {
    key: 'openai',
    label: 'OpenAI',
    suggestedId: 'openai',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    auth: 'bearer',
    category: 'cloud',
    keyPlaceholder: 'sk-proj-...',
    // Newer OpenAI models reject `max_tokens` outright.
    maxTokensField: 'max_completion_tokens',
    detail: 'GPT-4o, o3-mini, o1 & GPT models via Chat Completions',
    modelsUrl: 'https://platform.openai.com/docs/models',
    popularModels: [
      'gpt-4o',
      'gpt-4o-mini',
      'o3-mini',
      'o1',
      'gpt-4-turbo',
    ],
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    suggestedId: 'gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    auth: 'bearer',
    category: 'cloud',
    keyPlaceholder: 'AIzaSy...',
    detail: 'Gemini 2.0 Flash, Pro & 1.5 models via generateContent',
    modelsUrl: 'https://ai.google.dev/gemini-api/docs/models',
    popularModels: [
      'gemini-2.0-flash',
      'gemini-2.0-pro-exp-02-05',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ],
  },
  {
    key: 'nvidia',
    label: 'NVIDIA NIM',
    suggestedId: 'nvidia',
    kind: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    auth: 'bearer',
    category: 'cloud',
    keyPlaceholder: 'nvapi-...',
    maxTokensField: 'max_tokens',
    detail: 'Llama 3.3, DeepSeek-R1 & NVIDIA hosted models',
    modelsUrl: 'https://build.nvidia.com/models',
    popularModels: [
      'meta/llama-3.3-70b-instruct',
      'deepseek-ai/deepseek-r1',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'mistralai/mistral-large-2-instruct',
    ],
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    suggestedId: 'openrouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    category: 'gateway',
    keyPlaceholder: 'sk-or-v1-...',
    maxTokensField: 'max_tokens',
    detail: 'Unified gateway for Claude, GPT, Llama, DeepSeek & 200+ models',
    modelsUrl: 'https://openrouter.ai/models',
    popularModels: [
      'anthropic/claude-3.7-sonnet',
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
      'deepseek/deepseek-r1',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    // OpenRouter's documented attribution headers. Not secrets.
    headers: { 'HTTP-Referer': 'https://github.com/BakulBd/CodeRelay', 'X-Title': 'CodeRelay' },
  },
  {
    key: 'azure',
    label: 'Azure OpenAI',
    suggestedId: 'azure',
    kind: 'openai',
    baseUrl: '',
    // Azure's own scheme, not a bearer token.
    auth: 'api-key-header',
    category: 'cloud',
    maxTokensField: 'max_completion_tokens',
    detail: 'Your private Azure OpenAI resource deployment',
    needsBaseUrl: true,
    needsApiVersion: true,
  },
  {
    key: 'ollama',
    label: 'Ollama (local)',
    suggestedId: 'ollama',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    // A local runtime that does not authenticate.
    auth: 'none',
    category: 'local',
    maxTokensField: 'max_tokens',
    detail: 'Local models running on this machine (no key required)',
    popularModels: [
      'llama3.3',
      'qwen2.5-coder',
      'deepseek-r1',
      'codellama',
    ],
  },
  {
    key: 'lmstudio',
    label: 'LM Studio (local)',
    suggestedId: 'lmstudio',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    auth: 'none',
    category: 'local',
    maxTokensField: 'max_tokens',
    detail: 'Local models served via LM Studio (no key required)',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    suggestedId: 'deepseek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com',
    auth: 'bearer',
    category: 'cloud',
    keyPlaceholder: 'sk-...',
    maxTokensField: 'max_tokens',
    detail: 'DeepSeek-V3 & DeepSeek-R1 reasoning models',
    modelsUrl: 'https://platform.deepseek.com/api-docs',
    popularModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    key: 'groq',
    label: 'Groq',
    suggestedId: 'groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    auth: 'bearer',
    category: 'cloud',
    keyPlaceholder: 'gsk_...',
    maxTokensField: 'max_tokens',
    detail: 'Ultra-fast LPU inference for Llama 3.3 & DeepSeek-R1',
    modelsUrl: 'https://console.groq.com/docs/models',
    popularModels: ['llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b', 'mixtral-8x7b-32768'],
  },
  {
    key: 'mistral',
    label: 'Mistral AI',
    suggestedId: 'mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    auth: 'bearer',
    category: 'cloud',
    keyPlaceholder: '...',
    maxTokensField: 'max_tokens',
    detail: 'Mistral Large 2, Codestral & Pixtral models',
    modelsUrl: 'https://docs.mistral.ai/getting-started/models/',
    popularModels: ['codestral-latest', 'mistral-large-latest', 'mistral-small-latest'],
  },
  {
    key: 'together',
    label: 'Together AI',
    suggestedId: 'together',
    kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    auth: 'bearer',
    category: 'cloud',
    keyPlaceholder: '...',
    maxTokensField: 'max_tokens',
    detail: 'Open-source frontier models and high-throughput endpoints',
    modelsUrl: 'https://docs.together.ai/docs/inference-models',
    popularModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepseek-ai/DeepSeek-R1'],
  },
  {
    key: 'cerebras',
    label: 'Cerebras',
    suggestedId: 'cerebras',
    kind: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    auth: 'bearer',
    category: 'cloud',
    keyPlaceholder: 'csk-...',
    maxTokensField: 'max_tokens',
    detail: 'Wafer-scale engine inference with instant token generation',
    modelsUrl: 'https://inference-docs.cerebras.ai',
    popularModels: ['llama3.3-70b', 'llama3.1-8b'],
  },
  {
    key: 'fireworks',
    label: 'Fireworks AI',
    suggestedId: 'fireworks',
    kind: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    auth: 'bearer',
    category: 'cloud',
    keyPlaceholder: 'fw_...',
    maxTokensField: 'max_tokens',
    detail: 'Optimized serverless & compound AI system endpoints',
    modelsUrl: 'https://fireworks.ai/models',
    popularModels: ['accounts/fireworks/models/deepseek-r1', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
  },
  {
    key: 'custom',
    label: 'Custom endpoint',
    suggestedId: 'custom',
    kind: 'openai',
    baseUrl: '',
    auth: 'bearer',
    category: 'custom',
    maxTokensField: 'max_tokens',
    detail: 'Any OpenAI-compatible service, gateway or private endpoint',
    needsBaseUrl: true,
  },
];

export function findPreset(key: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.key === key) ?? null;
}

/**
 * Turns a preset plus the user's answers into a settings row.
 *
 * Every optional field is omitted rather than written as a default, so the saved
 * settings stay as small as the endpoint actually requires and a later change to
 * a default is not silently frozen into the user's configuration.
 */
export function buildProviderConfig(
  preset: ProviderPreset,
  answers: {
    readonly id: string;
    readonly baseUrl?: string;
    readonly apiVersion?: string;
  },
): ProviderConfig {
  const baseUrl = (answers.baseUrl ?? preset.baseUrl).replace(/\/+$/, '');
  return {
    id: answers.id,
    kind: preset.kind,
    baseUrl,
    // 'bearer' is the catalog's own default, so writing it adds nothing.
    ...(preset.auth === 'bearer' ? {} : { auth: preset.auth }),
    ...(answers.apiVersion === undefined || answers.apiVersion === ''
      ? {}
      : { apiVersion: answers.apiVersion }),
    // Likewise 'max_tokens' is the default; only a deviation is worth recording.
    ...(preset.maxTokensField === undefined || preset.maxTokensField === 'max_tokens'
      ? {}
      : { maxTokensField: preset.maxTokensField }),
    ...(preset.headers === undefined ? {} : { headers: { ...preset.headers } }),
  };
}

/**
 * A provider id that does not collide with one already configured.
 *
 * Ids key credentials and appear in the ledger, so a duplicate is a `ConfigError`
 * rather than a merge. Suggesting `openai-2` is friendlier than letting the user
 * discover the clash after typing a key.
 */
export function uniqueProviderId(
  suggested: string,
  taken: readonly string[],
): string {
  if (!taken.includes(suggested)) {
    return suggested;
  }
  for (let n = 2; n < 100; n++) {
    const candidate = `${suggested}-${n}`;
    if (!taken.includes(candidate)) {
      return candidate;
    }
  }
  return `${suggested}-${Date.now()}`;
}

/**
 * Whether a base URL is plausible enough to save.
 *
 * Only the two things `parseProviderConfig` will reject, checked here so the
 * wizard can say so while the user is still typing rather than failing after the
 * settings write. Deliberately not a reachability test: an endpoint that is down
 * right now is still correctly configured, and a wizard that refused it would be
 * wrong more often than the user.
 */
export function validateBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return 'An endpoint URL is required.';
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return 'The URL must start with http:// or https://';
  }
  try {
    new URL(trimmed);
  } catch {
    return 'That is not a valid URL.';
  }
  return null;
}

/** Whether a provider id is usable, given the ones already configured. */
export function validateProviderId(
  value: string,
  taken: readonly string[],
): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return 'An id is required. It keys your stored credentials.';
  }
  if (taken.includes(trimmed)) {
    return `"${trimmed}" is already configured. Ids must be unique.`;
  }
  return null;
}
