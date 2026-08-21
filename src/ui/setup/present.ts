/**
 * The setup panel's view model.
 *
 * Same division of labour as `webview/present.ts`: the client receives finished
 * strings and paints them. Every wording decision — including the ones that
 * carry the honesty properties — is made here, under `node --test`.
 */
import type { ProviderPreset } from '../../providers/presets.js';
import {
  connectionProblem,
  presetOf,
  providerChoices,
  savingProblem,
  type ConfiguredProviderSummary,
  type SetupState,
  type SetupStep,
} from './wizard.js';

export interface ProviderChoiceModel {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly category: 'cloud' | 'local' | 'gateway' | 'custom';
  readonly popularModels: readonly string[];
  /** True when the endpoint URL must be typed in. */
  readonly needsUrl: boolean;
  /** True when this endpoint takes no credential. */
  readonly local: boolean;
}

export interface ConfiguredProviderCardModel {
  readonly id: string;
  readonly kind: string;
  readonly baseUrl: string;
  readonly keyCount: number;
  readonly modelCount: number;
  readonly defaultModel: string | null;
  readonly isConfigured: boolean;
}

export interface StepModel {
  readonly id: SetupStep;
  readonly label: string;
  readonly state: 'done' | 'current' | 'upcoming';
}

export interface FieldModel {
  readonly id: 'providerId' | 'baseUrl' | 'apiVersion' | 'apiKey';
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly hint: string;
  /** Rendered as a password field and never echoed back from the host. */
  readonly secret: boolean;
  readonly show: boolean;
  readonly storedCount?: number;
}

export interface ModelRowModel {
  readonly id: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  /** "Default", "Fallback 1", … — the routing order, said in words. */
  readonly role: string | null;
  readonly fallbackIndex: number | null;
}

export interface PopularChipModel {
  readonly modelId: string;
  readonly isAdded: boolean;
}

export interface SetupViewModel {
  readonly kind: 'setup';
  readonly mode: 'wizard' | 'manage';
  readonly step: SetupStep;
  readonly steps: readonly StepModel[];
  readonly title: string;
  readonly subtitle: string;
  readonly isEditing: boolean;
  readonly editingOriginalId: string | null;
  readonly configuredProviders: readonly ConfiguredProviderCardModel[];
  readonly providers: readonly ProviderChoiceModel[];
  readonly fields: readonly FieldModel[];
  readonly models: readonly ModelRowModel[];
  readonly popularChips: readonly PopularChipModel[];
  readonly modelFilter: string;
  /** Set when discovery ran and the endpoint reported nothing. */
  readonly emptyModels: string | null;
  readonly busy: SetupState['busy'];
  readonly test: SetupState['test'];
  readonly error: string | null;
  /** Why the primary action is disabled, or null when it is available. */
  readonly blockedReason: string | null;
  readonly primaryLabel: string;
  readonly canGoBack: boolean;
  readonly savedSummary: string | null;
}

const STEP_LABELS: readonly { readonly id: SetupStep; readonly label: string }[] = [
  { id: 'provider', label: 'Provider' },
  { id: 'connect', label: 'Connect' },
  { id: 'models', label: 'Models' },
  { id: 'saved', label: 'Ready' },
];

export function presentSetup(state: SetupState): SetupViewModel {
  const preset = presetOf(state);
  const index = STEP_LABELS.findIndex((s) => s.id === state.step);

  return {
    kind: 'setup',
    mode: state.mode,
    step: state.step,
    steps:
      state.step === 'manage'
        ? []
        : STEP_LABELS.map((s, i) => ({
            id: s.id,
            label: s.label,
            state: i < index ? 'done' : i === index ? 'current' : 'upcoming',
          })),
    title: titleFor(state, preset),
    subtitle: subtitleFor(state, preset),
    isEditing: state.isEditing,
    editingOriginalId: state.editingOriginalId,
    configuredProviders: state.step === 'manage' ? configuredCards(state.configuredProviders) : [],
    providers: state.step === 'provider' ? providerCards() : [],
    fields: state.step === 'connect' ? fieldsFor(state, preset) : [],
    models: state.step === 'models' ? modelRows(state) : [],
    popularChips: state.step === 'models' ? popularChips(state, preset) : [],
    modelFilter: state.modelFilter,
    emptyModels: emptyModelsNote(state),
    busy: state.busy,
    test: state.test,
    error: state.error,
    blockedReason: blockedReason(state),
    primaryLabel: primaryLabel(state),
    canGoBack:
      state.step === 'connect' ||
      state.step === 'models' ||
      (state.step === 'provider' && state.configuredProviders.length > 0),
    savedSummary: state.step === 'saved' ? savedSummary(state) : null,
  };
}

function configuredCards(
  providers: readonly ConfiguredProviderSummary[],
): readonly ConfiguredProviderCardModel[] {
  return providers.map((p) => ({
    id: p.id,
    kind: p.kind,
    baseUrl: p.baseUrl,
    keyCount: p.keyCount,
    modelCount: p.modelCount,
    defaultModel: p.defaultModel ?? null,
    isConfigured: p.isConfigured,
  }));
}

function providerCards(): readonly ProviderChoiceModel[] {
  return providerChoices().map((p) => ({
    key: p.key,
    label: p.label,
    detail: p.detail,
    category: p.category ?? 'cloud',
    popularModels: p.popularModels ?? [],
    needsUrl: p.needsBaseUrl === true,
    local: p.auth === 'none',
  }));
}

function titleFor(state: SetupState, preset: ProviderPreset | null): string {
  if (state.step === 'manage') {
    return 'AI Providers & Models';
  }
  switch (state.step) {
    case 'provider':
      return 'Connect an AI provider';
    case 'connect':
      return state.isEditing
        ? `Edit ${state.providerId}`
        : `Connect ${preset?.label ?? 'your provider'}`;
    case 'models':
      return 'Choose models & fallbacks';
    case 'saved':
      return 'Ready to build';
    default:
      return 'CodeRelay Setup';
  }
}

function subtitleFor(state: SetupState, preset: ProviderPreset | null): string {
  if (state.step === 'manage') {
    return 'Manage configured endpoints, API keys in SecretStorage, and fallback priorities.';
  }
  switch (state.step) {
    case 'provider':
      return 'CodeRelay works with standard AI providers, custom endpoints, and local LLMs. You can add multiple providers for failover.';
    case 'connect':
      return preset?.auth === 'none'
        ? 'This endpoint runs on your machine and needs no key.'
        : 'Your API key is stored securely in your OS keychain via VS Code SecretStorage.';
    case 'models':
      return 'The first model is your default starting model. The rest are automatic failover fallbacks in order.';
    case 'saved':
      return 'Your provider configuration, models, and SecretStorage credentials are saved.';
    default:
      return '';
  }
}

function fieldsFor(state: SetupState, preset: ProviderPreset | null): readonly FieldModel[] {
  const needsVersion = preset?.needsApiVersion === true;
  const needsKey = preset !== null && preset.auth !== 'none';
  const all: readonly FieldModel[] = [
    {
      id: 'providerId',
      label: 'Provider Name / ID',
      value: state.providerId,
      placeholder: 'anthropic',
      hint: 'Identifier used for routing, credentials in SecretStorage, and task logs.',
      secret: false,
      show: true,
    },
    {
      id: 'baseUrl',
      label: 'Endpoint URL',
      value: state.baseUrl,
      placeholder: 'https://api.example.com/v1',
      hint:
        preset?.needsBaseUrl === true
          ? 'The base origin URL, without endpoint paths like /chat/completions.'
          : 'Standard endpoint base URL for this provider.',
      secret: false,
      show: true,
    },
    {
      id: 'apiVersion',
      label: 'API Version',
      value: state.apiVersion,
      placeholder: preset?.kind === 'gemini' ? 'v1beta' : '2024-10-21',
      hint: 'Specific API version required by this endpoint.',
      secret: false,
      show: needsVersion,
    },
    {
      id: 'apiKey',
      label: 'API Key',
      value: '',
      placeholder:
        state.storedKeyCount > 0
          ? `${state.storedKeyCount} key(s) in SecretStorage (leave blank to keep, or paste new key)`
          : state.hasKey
            ? '•••••••• stored'
            : preset?.keyPlaceholder ?? 'Paste API key (e.g. sk-...)',
      hint: 'Saved to OS Keychain through VS Code SecretStorage. Never saved to settings.json or git.',
      secret: true,
      show: needsKey,
      storedCount: state.storedKeyCount,
    },
  ];
  return all.filter((f) => f.show);
}

function modelRows(state: SetupState): readonly ModelRowModel[] {
  const rest = state.discovered.filter((id) => !state.chosen.includes(id));
  const filter = state.modelFilter;

  const rows: ModelRowModel[] = [
    ...state.chosen.map((id, i) => ({
      id,
      enabled: true,
      isDefault: id === state.defaultModel,
      role: i === 0 ? 'Default' : `Fallback ${i}`,
      fallbackIndex: i,
    })),
    ...rest.map((id) => ({
      id,
      enabled: false,
      isDefault: false,
      role: null,
      fallbackIndex: null,
    })),
  ];

  if (filter === '') {
    return rows;
  }
  return rows.filter((r) => r.id.toLowerCase().includes(filter));
}

function popularChips(
  state: SetupState,
  preset: ProviderPreset | null,
): readonly PopularChipModel[] {
  const popular = preset?.popularModels ?? [];
  return popular.map((modelId) => ({
    modelId,
    isAdded: state.chosen.includes(modelId),
  }));
}

function emptyModelsNote(state: SetupState): string | null {
  if (state.step !== 'models' || !state.didDiscover) {
    return null;
  }
  if (state.discovered.length > 0 || state.chosen.length > 0) {
    return null;
  }
  return 'This endpoint did not return a model listing. Enter your model id below or pick from recommended models.';
}

function blockedReason(state: SetupState): string | null {
  if (state.busy !== null) {
    return null;
  }
  if (state.step === 'manage') {
    return null;
  }
  switch (state.step) {
    case 'provider':
      return state.presetKey === null ? 'Choose a provider.' : null;
    case 'connect':
      return connectionProblem(state);
    case 'models':
      return savingProblem(state);
    case 'saved':
      return null;
  }
}

function primaryLabel(state: SetupState): string {
  switch (state.busy) {
    case 'testing':
      return 'Testing connection…';
    case 'discovering':
      return 'Discovering models…';
    case 'saving':
      return 'Saving…';
    default:
      break;
  }
  if (state.step === 'manage') {
    return 'Add Provider';
  }
  switch (state.step) {
    case 'provider':
      return 'Continue';
    case 'connect':
      return 'Test & Continue';
    case 'models':
      return state.isEditing ? 'Save Changes' : 'Save & Finish';
    case 'saved':
      return 'Start Coding';
  }
}

function savedSummary(state: SetupState): string {
  const fallbacks = state.chosen.length - 1;
  const models =
    fallbacks <= 0
      ? `${state.defaultModel ?? 'a model'}`
      : `${state.defaultModel ?? 'a model'}, with ${fallbacks} fallback${fallbacks === 1 ? '' : 's'}`;
  return `${state.providerId} is saved. CodeRelay will start tasks on ${models}.`;
}
