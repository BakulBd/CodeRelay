/**
 * Guided setup: endpoint, model, key.
 *
 * Built entirely from `QuickPick` and `InputBox` rather than a webview, because
 * VS Code's own pickers already have fuzzy matching, keyboard navigation, screen
 * reader support and theming, and a custom form would be a worse version of all
 * four. The wizard's whole job is to write ordinary rows into
 * `coderelay.providers` and `coderelay.models` — settings the user can read and
 * edit afterwards, not hidden state.
 *
 * What it will not do:
 *
 * - **It does not invent a model id, a context window or a capability.** Those
 *   are declared by the user for the reasons `catalog.ts` gives, and a wizard
 *   that guessed them would reintroduce the stale table that module exists to
 *   avoid. It asks, with a link to the vendor's own model list.
 * - **It does not test the endpoint.** A provider that is down right now is still
 *   correctly configured, and a setup flow that refused one would be wrong more
 *   often than the user.
 * - **It never puts a key in settings.** The secret goes from a password input
 *   straight to `CredentialManager.add`, which writes it to the OS keychain.
 */
import {
  ConfigurationTarget,
  ProgressLocation,
  Uri,
  env,
  window,
  workspace,
  type QuickPickItem,
} from 'vscode';
import type { CredentialManager } from '../credentials/store.js';
import {
  ModelCatalog,
  type ModelConfig,
  type ProviderConfig,
} from '../providers/catalog.js';
import { discoverModels } from '../providers/discovery.js';
import { createFetch } from '../providers/node-fetch.js';
import { PROVIDER_PRESETS, type ProviderPreset } from '../providers/presets.js';

const CONFIG_SECTION = 'coderelay';

/** Reads the catalog without prompting. Null when settings cannot be parsed. */
function quietCatalog(): ModelCatalog | null {
  const config = workspace.getConfiguration(CONFIG_SECTION);
  try {
    return ModelCatalog.fromSettings(config.get('providers'), config.get('models'));
  } catch {
    return null;
  }
}

function rawModels(): unknown[] {
  const value = workspace.getConfiguration(CONFIG_SECTION).get('models');
  return Array.isArray(value) ? [...value] : [];
}

/**
 * Where a setting should be written.
 *
 * Workspace scope when a folder is open, because an endpoint is usually a
 * property of the project — a work Azure resource for one repository, a personal
 * key for another. Falls back to global so the wizard still works with no folder.
 */
function target(): ConfigurationTarget {
  return workspace.workspaceFolders === undefined
    ? ConfigurationTarget.Global
    : ConfigurationTarget.Workspace;
}

/**
 * Collects a key for one endpoint.
 *
 * `password: true` keeps it out of the input history and off screen. It goes
 * straight into `CredentialManager.add` and is never held in a variable that
 * outlives this call, never logged, and never interpolated into a message.
 */
export async function promptForKey(
  credentials: CredentialManager,
  config: ProviderConfig,
  preset?: ProviderPreset,
): Promise<boolean> {
  const secret = await window.showInputBox({
    title: `CodeRelay: API key for ${config.id}`,
    prompt:
      'Stored in the OS keychain through VS Code SecretStorage. Never written to your ' +
      'settings, your logs, or the execution timeline.',
    placeHolder: preset?.key === 'anthropic' ? 'sk-ant-…' : 'sk-…',
    password: true,
    ignoreFocusOut: true,
  });
  if (secret === undefined || secret.trim() === '') {
    void window.showWarningMessage(
      `CodeRelay saved "${config.id}" but has no key for it yet. Run "CodeRelay: Add API Key" ` +
        'when you have one.',
    );
    return false;
  }

  try {
    await credentials.add(config.id, 'default', secret);
    return true;
  } catch (err: unknown) {
    // The only throw from `add` is its empty-value guard, which quotes nothing,
    // so this message cannot contain key material.
    void window.showErrorMessage(
      `CodeRelay could not store that key: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Declares one model against an endpoint.
 *
 * The capability questions are asked rather than guessed, and the prompts say
 * why: the router gates failover on these numbers, so a fabricated context window
 * becomes a silent truncation. The vendor's own model list is one click away,
 * because that is the page which is actually current.
 */
export async function addModel(
  credentials: CredentialManager,
  providerId?: string,
): Promise<boolean> {
  const catalog = quietCatalog();
  if (catalog === null || !catalog.hasProviders()) {
    const choice = await window.showWarningMessage(
      'CodeRelay needs an endpoint before a model can be declared against it.',
      'Add an endpoint',
    );
    if (choice === 'Add an endpoint') {
      await window.showInformationMessage('Run "CodeRelay: Add Provider" to set one up.');
    }
    return false;
  }

  let chosenProvider = providerId ?? null;
  if (chosenProvider === null) {
    const configs = catalog.providerConfigs();
    if (configs.length === 1) {
      chosenProvider = configs[0]!.id;
    } else {
      const picked = await window.showQuickPick(
        configs.map((p) => ({
          label: p.id,
          description: `${p.kind} · ${p.baseUrl}`,
          detail:
            catalog.modelsFor(p.id).length === 0
              ? 'no models declared yet'
              : `${catalog.modelsFor(p.id).length} model(s)`,
          id: p.id,
        })),
        { title: 'CodeRelay: which endpoint is this model on?', matchOnDescription: true },
      );
      if (picked === undefined) {
        return false;
      }
      chosenProvider = picked.id;
    }
  }

  const preset = PROVIDER_PRESETS.find((p) => p.kind === catalog.provider(chosenProvider!)?.kind);
  const existing = catalog.modelsFor(chosenProvider).map((m) => m.model);

  // Ask the endpoint what it serves before asking the user to type an id.
  //
  // Only the id is taken from the answer. A listing endpoint reports what
  // exists, not what it can do — OpenAI's `/models` returns an id, an owner and
  // a date — so the capability questions below are still asked. Filling them in
  // from a guess would put a number the router gates failover on into settings
  // without anyone having checked it.
  const discovered = await offerDiscoveredModels(catalog, credentials, chosenProvider, existing);
  if (discovered === 'cancelled') {
    return false;
  }

  const modelId = discovered ?? (await window.showInputBox({
    // Four questions, counted as four. The previous "of 3" ran out before the
    // tool-calling prompt, which reads as a bug the moment a user notices it.
    title: `CodeRelay: model id on ${chosenProvider} (1 of 4)`,

    prompt:
      preset?.key === 'azure'
        ? 'Your Azure deployment name, exactly as it appears in the portal.'
        : 'The model id exactly as the endpoint expects it. CodeRelay does not ship a ' +
          'model list, because one baked into an extension goes stale within a month.',
    placeHolder: 'e.g. the id from the provider\u2019s model list',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed === '') {
        return 'A model id is required.';
      }
      if (existing.includes(trimmed)) {
        return `"${trimmed}" is already declared on ${chosenProvider}.`;
      }
      return null;
    },
  }));
  if (modelId === undefined) {
    return false;
  }

  const contextWindow = await askNumber({
    title: `CodeRelay: context window for ${modelId.trim()} (2 of 4)`,

    prompt:
      'Total input tokens the model accepts. CodeRelay uses it to decide when to compact ' +
      'rather than overflow, so an optimistic number becomes a failed request.',
    value: '200000',
  });
  if (contextWindow === null) {
    return false;
  }

  const maxOutput = await askNumber({
    title: `CodeRelay: max output for ${modelId.trim()} (3 of 4)`,

    prompt: 'Maximum tokens the model may generate in one turn.',
    value: '8192',
  });
  if (maxOutput === null) {
    return false;
  }

  const tools = await window.showQuickPick(
    [
      {
        label: 'Yes, it can call tools',
        detail: 'Required for the agent to read or write files',
        value: true,
      },
      {
        label: 'No',
        detail: 'CodeRelay will not route work to it unless you allow read-only analysis',
        value: false,
      },
    ],
    {
      title: `CodeRelay: can ${modelId.trim()} call tools? (4 of 4)`,

      placeHolder: 'Asked rather than assumed \u2014 guessing either way breaks routing silently',
    },
  );
  if (tools === undefined) {
    return false;
  }

  const model: ModelConfig = {
    provider: chosenProvider,
    model: modelId.trim(),
    contextWindow,
    maxOutput,
    toolCalling: tools.value,
  };

  try {
    await workspace
      .getConfiguration(CONFIG_SECTION)
      .update('models', [...rawModels(), model], target());
  } catch (err: unknown) {
    void window.showErrorMessage(
      `CodeRelay could not save that model: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  // Prices are optional and deliberately not asked for in the main flow: they
  // affect only tie-breaking and the cost display, and an extra required question
  // during setup costs more than the number is worth.
  void window
    .showInformationMessage(
      `CodeRelay can now use ${chosenProvider}/${model.model}.`,
      'Start a task',
      'Add cost info',
    )
    .then(async (choice) => {
      if (choice === 'Start a task') {
        await window.showInformationMessage('Describe what you want done in the CodeRelay view.');
      } else if (choice === 'Add cost info') {
        await openModelSettings();
      }
    });

  return true;
}

async function askNumber(options: {
  title: string;
  prompt: string;
  value: string;
}): Promise<number | null> {
  const entered = await window.showInputBox({
    title: options.title,
    prompt: options.prompt,
    value: options.value,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const n = Number(value.trim());
      if (!Number.isFinite(n) || n <= 0) {
        return 'Enter a positive number.';
      }
      return null;
    },
  });
  if (entered === undefined) {
    return null;
  }
  return Math.floor(Number(entered.trim()));
}

/**
 * Offers the endpoint's own model list, when it has one.
 *
 * Returns the chosen id, `null` to fall through to manual entry, or
 * `'cancelled'` when the user dismissed the picker — which must abort the whole
 * flow rather than quietly becoming "type it yourself", because dismissing a
 * dialog means stop.
 *
 * Discovery is best-effort by design. An endpoint with no listing API, an
 * expired key or a captive portal all end in the same place as before: the user
 * types an id. A setup wizard that dead-ends because a convenience call failed
 * would be worse than one that never offered the convenience.
 */
async function offerDiscoveredModels(
  catalog: ModelCatalog,
  credentials: CredentialManager,
  providerId: string,
  existing: readonly string[],
): Promise<string | null | 'cancelled'> {
  const config = catalog.provider(providerId);
  const adapter = catalog.adapterMap().get(providerId);
  if (config === null || adapter === undefined) {
    return null;
  }

  const choice = await credentials.next(providerId);
  if (choice.t !== 'credential') {
    // No usable key, so there is nothing to authenticate a listing with. Silent
    // on purpose: the user is mid-setup and already knows they have no key.
    return null;
  }

  const result = await window.withProgress(
    { location: ProgressLocation.Notification, title: `CodeRelay: asking ${providerId} for its models…` },
    () => discoverModels(config, { fetchImpl: createFetch(), adapter, secret: choice.secret }),
  );

  if (result.kind !== 'ok' || result.modelIds.length === 0) {
    if (result.kind === 'failed') {
      // Said once, quietly, and then the manual path continues.
      void window.showWarningMessage(`Could not list models: ${result.reason}`);
    }
    return null;
  }

  const MANUAL = Symbol('manual');
  const items: (QuickPickItem & { id: string | typeof MANUAL })[] = result.modelIds
    .filter((id) => !existing.includes(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ label: id, id }));

  if (items.length === 0) {
    return null;
  }
  items.push({
    label: '$(edit) Enter a model id manually',
    detail: 'Use this if the id you want is not listed.',
    id: MANUAL,
  });

  const picked = await window.showQuickPick(items, {
    title: `CodeRelay: model on ${providerId} (1 of 4)`,
    placeHolder: `${items.length - 1} model(s) reported by the endpoint`,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (picked === undefined) {
    return 'cancelled';
  }
  return picked.id === MANUAL ? null : (picked.id as string);
}

export async function openModelSettings(): Promise<void> {
  const { commands } = await import('vscode');
  await commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.models`);
}

/** Opens the vendor's own model list, which is the page that is actually current. */
export async function openModelDocs(preset: ProviderPreset): Promise<void> {
  if (preset.modelsUrl !== undefined) {
    await env.openExternal(Uri.parse(preset.modelsUrl));
  }
}
