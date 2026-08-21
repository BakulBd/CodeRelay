/**
 * The provider setup wizard & manager: state, transitions, and pure reducers.
 *
 * Pure. No `vscode` import, no network, no filesystem — the host performs the
 * effects (testing a connection, listing models, writing settings, SecretStorage)
 * and folds the results back in here. That is what makes a multi-step flow with
 * async steps testable at all, and it is why every rule below is a `node --test`
 * assertion rather than something a person has to click through to verify.
 *
 * Guaranteed properties:
 * 1. **The API key never lives in wizard state.** It goes from input straight
 *    to `CredentialManager`, and only boolean flags / key counts are kept here.
 *    State is serialised into webview messages on every render, so a key held
 *    here would be posted into a browser frame on every keystroke.
 * 2. **Nothing is written until the user saves.** Settings and credentials are
 *    committed in one step, so abandoning the wizard halfway leaves no
 *    half-configured provider.
 * 3. **Never send users to VS Code generic QuickPick / Settings UI.** All
 *    provider creation, editing, multi-key rotation, model selection, and fallback
 *    management are fully represented here.
 */
import type { ProviderConfig, ProviderKind } from '../../providers/catalog.js';
import { PROVIDER_PRESETS, findPreset, type ProviderPreset } from '../../providers/presets.js';

export type SetupStep = 'provider' | 'connect' | 'models' | 'saved' | 'manage';

/** Summary of an already configured provider for the management view. */
export interface ConfiguredProviderSummary {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly keyCount: number;
  readonly modelCount: number;
  readonly isConfigured: boolean;
  readonly defaultModel?: string | null;
}

/** The outcome of a connection test, as the panel needs to show it. */
export interface TestOutcome {
  readonly ok: boolean;
  /** Plain language. Never a stack trace, never a response body. */
  readonly message: string;
  readonly elapsedMs?: number;
}

/**
 * Everything the wizard knows.
 *
 * Deliberately flat and JSON-safe: it is posted to the webview verbatim.
 */
export interface SetupState {
  readonly step: SetupStep;
  readonly mode: 'wizard' | 'manage';
  readonly configuredProviders: readonly ConfiguredProviderSummary[];
  readonly presetKey: string | null;
  readonly isEditing: boolean;
  readonly editingOriginalId: string | null;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiVersion: string;
  /** Whether a new key has been entered in this session. **Never the key itself.** */
  readonly hasKey: boolean;
  /** Number of pre-existing keys already stored in SecretStorage for this provider. */
  readonly storedKeyCount: number;
  readonly busy: 'testing' | 'discovering' | 'saving' | null;
  readonly test: TestOutcome | null;
  /** Model ids the endpoint reported, if it offers a listing. */
  readonly discovered: readonly string[];
  /** Whether discovery has been attempted, so "none found" can differ from "not asked". */
  readonly didDiscover: boolean;
  /** Model ids the user has chosen to enable, in priority order. */
  readonly chosen: readonly string[];
  /** The first-choice model. Fallbacks are the rest of `chosen`, in order. */
  readonly defaultModel: string | null;
  /** Filter query for searching through discovered models. */
  readonly modelFilter: string;
  /** Blocking problem with the current step, if any. */
  readonly error: string | null;
}

export function initialState(
  configuredProviders: readonly ConfiguredProviderSummary[] = [],
  mode: 'wizard' | 'manage' = 'wizard',
): SetupState {
  return {
    step: mode === 'manage' ? 'manage' : 'provider',
    mode,
    configuredProviders: [...configuredProviders],
    presetKey: null,
    isEditing: false,
    editingOriginalId: null,
    providerId: '',
    baseUrl: '',
    apiVersion: '',
    hasKey: false,
    storedKeyCount: 0,
    busy: null,
    test: null,
    discovered: [],
    didDiscover: false,
    chosen: [],
    defaultModel: null,
    modelFilter: '',
    error: null,
  };
}

/** The preset backing the current selection, if one is chosen. */
export function presetOf(state: SetupState): ProviderPreset | null {
  if (state.presetKey !== null) {
    return findPreset(state.presetKey);
  }
  // If editing an existing provider without a preset key, find preset by kind/baseUrl
  return PROVIDER_PRESETS.find((p) => p.suggestedId === state.providerId) ?? null;
}

/**
 * Opens the manage providers view.
 */
export function openManage(
  state: SetupState,
  configuredProviders: readonly ConfiguredProviderSummary[],
): SetupState {
  return {
    ...initialState(configuredProviders, 'manage'),
    step: 'manage',
    mode: 'manage',
  };
}

/**
 * Starts the provider creation wizard.
 */
export function startAddProvider(
  state: SetupState,
  configuredProviders: readonly ConfiguredProviderSummary[] = state.configuredProviders,
): SetupState {
  return {
    ...initialState(configuredProviders, 'wizard'),
    step: 'provider',
    mode: 'wizard',
  };
}

/**
 * Selects a provider and pre-fills everything the preset already knows.
 *
 * `existingIds` makes the suggested id unique up front rather than failing on
 * save: a user adding a second OpenAI key should land on `openai-2`.
 */
export function chooseProvider(
  state: SetupState,
  presetKey: string,
  existingIds: readonly string[],
): SetupState {
  const preset = findPreset(presetKey);
  if (preset === null) {
    return { ...state, error: 'That provider is not recognised.' };
  }
  return {
    ...state,
    step: 'connect',
    mode: 'wizard',
    isEditing: false,
    editingOriginalId: null,
    presetKey,
    providerId: uniqueId(preset.suggestedId, existingIds),
    baseUrl: preset.baseUrl,
    apiVersion: preset.needsApiVersion === true ? defaultApiVersion(preset.kind) : '',
    hasKey: false,
    storedKeyCount: 0,
    test: null,
    error: null,
    discovered: preset.popularModels ? [...preset.popularModels] : [],
    didDiscover: false,
    chosen: [],
    defaultModel: null,
  };
}

/**
 * Starts editing an already configured provider.
 */
export function editExistingProvider(
  state: SetupState,
  config: ProviderConfig,
  existingModels: readonly string[],
  storedKeyCount: number,
): SetupState {
  const matchingPreset =
    PROVIDER_PRESETS.find((p) => p.kind === config.kind && p.baseUrl === config.baseUrl) ??
    PROVIDER_PRESETS.find((p) => p.kind === config.kind) ??
    findPreset('custom');

  const presetKey = matchingPreset?.key ?? 'custom';
  const defaultModel = existingModels[0] ?? null;

  const popular = matchingPreset?.popularModels ?? [];
  const discovered = [...new Set([...existingModels, ...popular])];

  return {
    ...state,
    step: 'connect',
    mode: 'wizard',
    isEditing: true,
    editingOriginalId: config.id,
    presetKey,
    providerId: config.id,
    baseUrl: config.baseUrl,
    apiVersion: config.apiVersion ?? '',
    hasKey: false,
    storedKeyCount,
    test: null,
    error: null,
    discovered,
    didDiscover: false,
    chosen: [...existingModels],
    defaultModel,
    modelFilter: '',
  };
}

function defaultApiVersion(kind: ProviderKind): string {
  return kind === 'gemini' ? 'v1beta' : '';
}

function uniqueId(base: string, existing: readonly string[]): string {
  if (!existing.includes(base)) {
    return base;
  }
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}`;
}

/** Updates one connection field. Any edit invalidates a previous test result. */
export function editConnection(
  state: SetupState,
  field: 'providerId' | 'baseUrl' | 'apiVersion',
  value: string,
): SetupState {
  return { ...state, [field]: value.trim(), test: null, error: null };
}

/**
 * Records that a key was supplied, without keeping it.
 */
export function noteKey(state: SetupState, present: boolean): SetupState {
  return { ...state, hasKey: present, test: null, error: null };
}

/** What is still missing before a connection can be tested. */
export function connectionProblem(state: SetupState): string | null {
  const preset = presetOf(state);
  if (preset === null) {
    return 'Choose a provider first.';
  }
  if (state.providerId === '') {
    return 'Give this endpoint a name.';
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(state.providerId)) {
    return 'Use letters, digits and hyphens for the name.';
  }
  if (state.baseUrl === '') {
    return 'Enter the endpoint URL.';
  }
  if (!/^https?:\/\//i.test(state.baseUrl)) {
    return 'The endpoint URL must start with http:// or https://.';
  }
  if (preset.needsApiVersion === true && state.apiVersion === '') {
    return 'This endpoint needs an API version.';
  }
  // Local runtimes need no key; otherwise either a new key or existing stored key is needed
  const hasAnyKey = state.hasKey || state.storedKeyCount > 0;
  if (preset.auth !== 'none' && !hasAnyKey) {
    return 'Enter an API key.';
  }
  return null;
}

export function beginBusy(state: SetupState, what: NonNullable<SetupState['busy']>): SetupState {
  return { ...state, busy: what, error: null };
}

export function noteTest(state: SetupState, outcome: TestOutcome): SetupState {
  return { ...state, busy: null, test: outcome };
}

/**
 * Records a discovery result and moves to model selection.
 */
export function noteDiscovery(
  state: SetupState,
  result:
    | { readonly ok: true; readonly modelIds: readonly string[] }
    | { readonly ok: false; readonly reason: string },
): SetupState {
  if (!result.ok) {
    return {
      ...state,
      busy: null,
      step: 'models',
      didDiscover: true,
      error: result.reason,
    };
  }

  // Merge discovered with already chosen or popular
  const combined = [...new Set([...state.chosen, ...result.modelIds])].sort((a, b) =>
    a.localeCompare(b),
  );

  return {
    ...state,
    busy: null,
    step: 'models',
    didDiscover: true,
    discovered: combined,
    error: null,
  };
}

/**
 * Updates model search query.
 */
export function setModelFilter(state: SetupState, query: string): SetupState {
  return { ...state, modelFilter: query.trim().toLowerCase() };
}

/**
 * Enables or disables a model.
 */
export function toggleModel(state: SetupState, modelId: string): SetupState {
  const id = modelId.trim();
  if (id === '') {
    return state;
  }
  if (state.chosen.includes(id)) {
    const chosen = state.chosen.filter((m) => m !== id);
    return {
      ...state,
      chosen,
      defaultModel: state.defaultModel === id ? (chosen[0] ?? null) : state.defaultModel,
      error: null,
    };
  }
  const chosen = [...state.chosen, id];
  return { ...state, chosen, defaultModel: state.defaultModel ?? id, error: null };
}

/** Adds a model the listing did not report, for endpoints with no listing API. */
export function addManualModel(state: SetupState, modelId: string): SetupState {
  const id = modelId.trim();
  if (id === '') {
    return { ...state, error: 'Enter a model id.' };
  }
  if (state.chosen.includes(id)) {
    return { ...state, error: `"${id}" is already enabled.` };
  }
  return {
    ...state,
    discovered: state.discovered.includes(id) ? state.discovered : [id, ...state.discovered],
    chosen: [...state.chosen, id],
    defaultModel: state.defaultModel ?? id,
    error: null,
  };
}

/** Promotes a model to first choice (Default). The rest keep their relative order. */
export function setDefaultModel(state: SetupState, modelId: string): SetupState {
  const id = modelId.trim();
  if (!state.chosen.includes(id)) {
    // If not enabled yet, enable it and make it default
    return {
      ...state,
      chosen: [id, ...state.chosen],
      defaultModel: id,
      discovered: state.discovered.includes(id) ? state.discovered : [id, ...state.discovered],
      error: null,
    };
  }
  return {
    ...state,
    defaultModel: id,
    chosen: [id, ...state.chosen.filter((m) => m !== id)],
    error: null,
  };
}

/** Moves a model up or down the fallback order. */
export function reorderModel(state: SetupState, modelId: string, direction: -1 | 1): SetupState {
  const index = state.chosen.indexOf(modelId);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= state.chosen.length) {
    return state;
  }
  const chosen = [...state.chosen];
  const [moved] = chosen.splice(index, 1);
  chosen.splice(target, 0, moved!);
  return { ...state, chosen, defaultModel: chosen[0] ?? null, error: null };
}

/** What is still missing before the configuration can be written. */
export function savingProblem(state: SetupState): string | null {
  if (state.chosen.length === 0) {
    return 'Enable at least one model.';
  }
  if (state.defaultModel === null) {
    return 'Choose a default model.';
  }
  return connectionProblem(state);
}

export function back(state: SetupState): SetupState {
  switch (state.step) {
    case 'models':
      return { ...state, step: 'connect', error: null };
    case 'connect':
      if (state.isEditing || state.mode === 'manage') {
        return { ...state, step: 'manage', mode: 'manage', error: null };
      }
      return initialState(state.configuredProviders, 'wizard');
    case 'provider':
      if (state.configuredProviders.length > 0) {
        return { ...state, step: 'manage', mode: 'manage', error: null };
      }
      return state;
    case 'saved':
      return state.configuredProviders.length > 0
        ? openManage(state, state.configuredProviders)
        : initialState();
    default:
      return state;
  }
}

export function noteSaved(state: SetupState): SetupState {
  return { ...state, busy: null, step: 'saved', error: null };
}

export function noteError(state: SetupState, message: string): SetupState {
  return { ...state, busy: null, error: message };
}

/** The provider list the first step offers. */
export function providerChoices(): readonly ProviderPreset[] {
  return PROVIDER_PRESETS;
}
