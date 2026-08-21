/**
 * The host side of the setup panel.
 *
 * Owns the wizard state and performs the effects the pure reducers cannot:
 * testing connections, asking endpoints what they serve, writing credentials to
 * SecretStorage, and committing settings.
 *
 * Guarantees:
 * - The key lives only in memory until save and moves straight to SecretStorage.
 * - Nothing is committed until save.
 * - Changes to providers and models are immediately synced to configuration
 *   and model selector.
 */
import type { WorkspaceConfiguration } from 'vscode';
import { ConfigurationTarget } from 'vscode';
import type { CredentialManager } from '../../credentials/store.js';
import { createAdapter, type ModelConfig, type ProviderConfig } from '../../providers/catalog.js';
import { discoverModels } from '../../providers/discovery.js';
import { buildProviderConfig } from '../../providers/presets.js';
import { createFetch } from '../../providers/node-fetch.js';
import type { SetupField } from '../webview/protocol.js';
import { presentSetup, type SetupViewModel } from './present.js';
import {
  addManualModel,
  back,
  beginBusy,
  chooseProvider,
  connectionProblem,
  editConnection,
  editExistingProvider,
  initialState,
  noteDiscovery,
  noteError,
  noteKey,
  noteSaved,
  noteTest,
  openManage,
  presetOf,
  reorderModel,
  savingProblem,
  setDefaultModel,
  setModelFilter,
  startAddProvider,
  toggleModel,
  type ConfiguredProviderSummary,
  type SetupState,
} from './wizard.js';

const CONFIG_SECTION = 'coderelay';

export interface SetupDeps {
  readonly credentials: CredentialManager;
  readonly config: () => WorkspaceConfiguration;
  /** Called after every state change so the panel repaints. */
  readonly onChange: () => void;
  /** Called once the configuration has been written, so the trees refresh. */
  readonly onSaved: () => Promise<void>;
  readonly onSelectModel?: (model: { providerId: string; modelId: string }) => Promise<void>;
}

export class SetupController {
  private state: SetupState = initialState();
  /**
   * The key, held only until save.
   *
   * A field rather than part of `state` for one reason: state is serialised into
   * a webview message on every render, and a key in it would be posted to the
   * frame on every keystroke.
   */
  private secret = '';
  private active = false;

  constructor(private readonly deps: SetupDeps) {}

  /** True while the panel should show setup rather than the task view. */
  get isOpen(): boolean {
    return this.active;
  }

  open(mode?: 'wizard' | 'manage', editProviderId?: string): void {
    this.secret = '';
    const configured = this.loadConfiguredSummaries();

    if (editProviderId) {
      this.edit(editProviderId);
      return;
    }

    if (mode === 'manage' || (mode === undefined && configured.length > 0)) {
      this.state = openManage(this.state, configured);
    } else {
      this.state = startAddProvider(this.state, configured);
    }
    this.active = true;
    this.deps.onChange();
  }

  close(): void {
    this.active = false;
    this.secret = '';
    this.state = initialState();
    this.deps.onChange();
  }

  model(): SetupViewModel {
    return presentSetup(this.state);
  }

  openManage(): void {
    const configured = this.loadConfiguredSummaries();
    this.secret = '';
    this.state = openManage(this.state, configured);
    this.deps.onChange();
  }

  openAdd(): void {
    const configured = this.loadConfiguredSummaries();
    this.secret = '';
    this.state = startAddProvider(this.state, configured);
    this.deps.onChange();
  }

  edit(providerId: string): void {
    const providers = this.deps.config().get<ProviderConfig[]>('providers') ?? [];
    const models = this.deps.config().get<ModelConfig[]>('models') ?? [];
    const targetProvider = providers.find((p) => p.id === providerId);

    if (!targetProvider) {
      this.openAdd();
      return;
    }

    const providerModels = models.filter((m) => m.provider === providerId).map((m) => m.model);
    const storedKeys = this.deps.credentials.list(providerId).length;

    this.secret = '';
    this.state = editExistingProvider(this.state, targetProvider, providerModels, storedKeys);
    this.active = true;
    this.deps.onChange();
  }

  async deleteProvider(providerId: string): Promise<void> {
    try {
      const settings = this.deps.config();
      const providers = (settings.get<ProviderConfig[]>('providers') ?? []).filter(
        (p) => p.id !== providerId,
      );
      const models = (settings.get<ModelConfig[]>('models') ?? []).filter(
        (m) => m.provider !== providerId,
      );

      const target = this.configTarget();
      await settings.update('providers', providers, target);
      await settings.update('models', models, target);

      // Remove credentials from SecretStorage
      const creds = this.deps.credentials.list(providerId);
      for (const cred of creds) {
        await this.deps.credentials.remove(cred.credentialId);
      }

      await this.deps.onSaved();
      const configured = this.loadConfiguredSummaries();
      this.state = openManage(this.state, configured);
    } catch (err: unknown) {
      this.state = noteError(
        this.state,
        err instanceof Error ? err.message : 'Could not delete provider.',
      );
    }
    this.deps.onChange();
  }

  choose(presetKey: string): void {
    this.secret = '';
    this.state = chooseProvider(this.state, presetKey, this.existingProviderIds());
    this.deps.onChange();
  }

  editField(field: SetupField, value: string): void {
    if (field === 'apiKey') {
      this.secret = value;
      this.state = noteKey(this.state, value.trim() !== '');
    } else {
      this.state = editConnection(this.state, field, value);
    }
    this.deps.onChange();
  }

  filterModels(query: string): void {
    this.state = setModelFilter(this.state, query);
    this.deps.onChange();
  }

  goBack(): void {
    this.state = back(this.state);
    this.deps.onChange();
  }

  toggleModel(modelId: string): void {
    this.state = toggleModel(this.state, modelId);
    this.deps.onChange();
  }

  addModel(modelId: string): void {
    this.state = addManualModel(this.state, modelId);
    this.deps.onChange();
  }

  setDefault(modelId: string): void {
    this.state = setDefaultModel(this.state, modelId);
    this.deps.onChange();
  }

  reorder(modelId: string, direction: -1 | 1): void {
    this.state = reorderModel(this.state, modelId, direction);
    this.deps.onChange();
  }

  /** The primary button action. */
  async primary(): Promise<void> {
    switch (this.state.step) {
      case 'manage':
        this.openAdd();
        return;
      case 'provider':
        return;
      case 'connect':
        await this.testAndDiscover();
        return;
      case 'models':
        await this.save();
        return;
      case 'saved':
        this.close();
        return;
    }
  }

  /** Explicit test connection button. */
  async testConnectionOnly(): Promise<void> {
    await this.testAndDiscover({ stayOnCurrentStep: true });
  }

  /** Re-asks the endpoint for its model list, from the models step. */
  async refreshModels(): Promise<void> {
    await this.testAndDiscover({ stayOnCurrentStep: true });
  }

  /**
   * Tests connection and discovers models.
   */
  private async testAndDiscover(options: { stayOnCurrentStep?: boolean } = {}): Promise<void> {
    const problem = connectionProblem(this.state);
    if (problem !== null) {
      this.state = noteError(this.state, problem);
      this.deps.onChange();
      return;
    }

    this.state = beginBusy(this.state, options.stayOnCurrentStep ? 'discovering' : 'testing');
    this.deps.onChange();

    const config = this.draftProviderConfig();
    if (config === null) {
      this.state = noteError(this.state, 'That provider is not recognised.');
      this.deps.onChange();
      return;
    }

    // Use entered secret or retrieve existing secret for this provider
    let secretToUse = this.secret;
    if (secretToUse.trim() === '' && this.state.isEditing) {
      const choice = await this.deps.credentials.next(config.id);
      if (choice.t === 'credential') {
        secretToUse = choice.secret;
      }
    }

    const startedAt = Date.now();
    const result = await discoverModels(config, {
      fetchImpl: createFetch(),
      adapter: createAdapter(config),
      secret: secretToUse,
    });
    const elapsedMs = Date.now() - startedAt;

    if (result.kind === 'ok') {
      this.state = noteTest(this.state, {
        ok: true,
        message:
          result.modelIds.length === 0
            ? `Connected successfully (${elapsedMs}ms). Endpoint reported 0 models.`
            : `Connected (${elapsedMs}ms). ${result.modelIds.length} model(s) available.`,
        elapsedMs,
      });
      this.state = noteDiscovery(this.state, { ok: true, modelIds: result.modelIds });
    } else {
      this.state = noteTest(this.state, {
        ok: false,
        message: result.reason,
        elapsedMs,
      });
      this.state = noteDiscovery(this.state, { ok: false, reason: result.reason });
    }

    if (options.stayOnCurrentStep && this.state.step === 'connect') {
      // Keep on connect step if just testing connection
      this.state = { ...this.state, step: 'connect' };
    }

    this.deps.onChange();
  }

  /**
   * Commits the provider, credentials, and models.
   */
  private async save(): Promise<void> {
    const problem = savingProblem(this.state);
    if (problem !== null) {
      this.state = noteError(this.state, problem);
      this.deps.onChange();
      return;
    }

    this.state = beginBusy(this.state, 'saving');
    this.deps.onChange();

    try {
      const config = this.draftProviderConfig();
      if (config === null) {
        throw new Error('That provider is not recognised.');
      }

      const settings = this.deps.config();
      const providers = [...(settings.get<ProviderConfig[]>('providers') ?? [])];
      let models = [...(settings.get<ModelConfig[]>('models') ?? [])];

      const existingIndex = providers.findIndex(
        (p) => p.id === config.id || (this.state.isEditing && p.id === this.state.editingOriginalId),
      );

      if (existingIndex === -1) {
        providers.push(config);
      } else {
        providers[existingIndex] = config;
      }

      // If editing, remove old model mappings for this provider so order matches chosen
      if (this.state.isEditing) {
        models = models.filter((m) => m.provider !== (this.state.editingOriginalId ?? config.id));
      }

      for (const modelId of this.state.chosen) {
        const existingModel = models.find((m) => m.provider === config.id && m.model === modelId);
        if (!existingModel) {
          models.push(this.draftModelConfig(config.id, modelId));
        }
      }

      const target = this.configTarget();
      await settings.update('providers', providers, target);
      await settings.update('models', models, target);

      if (this.secret.trim() !== '') {
        await this.deps.credentials.add(config.id, `${config.id} key`, this.secret);
      }
      this.secret = '';

      // Update active default model
      if (this.state.defaultModel && this.deps.onSelectModel) {
        await this.deps.onSelectModel({
          providerId: config.id,
          modelId: this.state.defaultModel,
        });
      }

      this.state = noteSaved(this.state);
      await this.deps.onSaved();
    } catch (err: unknown) {
      this.state = noteError(
        this.state,
        err instanceof Error ? err.message : 'The configuration could not be saved.',
      );
    }
    this.deps.onChange();
  }

  private draftProviderConfig(): ProviderConfig | null {
    const preset = presetOf(this.state);
    if (preset === null) {
      return null;
    }
    return buildProviderConfig(preset, {
      id: this.state.providerId,
      baseUrl: this.state.baseUrl,
      ...(this.state.apiVersion === '' ? {} : { apiVersion: this.state.apiVersion }),
    });
  }

  private draftModelConfig(providerId: string, modelId: string): ModelConfig {
    return {
      provider: providerId,
      model: modelId,
      contextWindow: 128_000,
      maxOutput: 8_192,
      toolCalling: true,
    };
  }

  private loadConfiguredSummaries(): ConfiguredProviderSummary[] {
    const providers = this.deps.config().get<ProviderConfig[]>('providers') ?? [];
    const models = this.deps.config().get<ModelConfig[]>('models') ?? [];

    return providers.map((p) => {
      const pModels = models.filter((m) => m.provider === p.id);
      const keyCount = this.deps.credentials.list(p.id).length;
      return {
        id: p.id,
        kind: p.kind,
        baseUrl: p.baseUrl,
        keyCount,
        modelCount: pModels.length,
        isConfigured: pModels.length > 0 && (p.auth === 'none' || keyCount > 0),
        defaultModel: pModels[0]?.model ?? null,
      };
    });
  }

  private existingProviderIds(): readonly string[] {
    return (this.deps.config().get<ProviderConfig[]>('providers') ?? []).map((p) => p.id);
  }

  private configTarget(): ConfigurationTarget {
    // If workspace is available use Workspace, else Global
    return ConfigurationTarget.Workspace;
  }
}

export { CONFIG_SECTION as SETUP_CONFIG_SECTION };
