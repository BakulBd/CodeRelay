/**
 * Drives the real compiled setup wizard against a fake `vscode` module.
 *
 * Not a unit test and not part of `pnpm test`: it exists to answer one question
 * that reading code cannot: *if a user actually walks the onboarding flow, does a
 * working configuration come out the other side?* It loads `out/src/ui/setup.js`
 * — the same file that ships — with `require('vscode')` satisfied by the stub
 * below, answers every prompt the way a person would, and prints what landed in
 * settings and in the keychain.
 *
 * The Extension Development Host is still the authority on how this *looks*. This
 * harness is the authority on what it *writes*, which is the half a screenshot
 * cannot show.
 *
 * Run: node .vscode/harness/wizard.js
 */
'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const out = path.join(process.cwd(), 'out', 'src');

// --- the fake workbench ---

/** Answers queued in the order the wizard will ask for them. */
let script = [];
let asked = [];

function nextAnswer(kind, label) {
  const step = script.shift();
  asked.push(`${kind}: ${label}`);
  if (step === undefined) {
    throw new Error(`the wizard asked more than the script answers (${kind}: ${label})`);
  }
  return step;
}

/** Settings, as a plain two-level map, with the write target recorded. */
const settings = new Map();
const writes = [];
const secrets = new Map();
const notices = [];
const opened = [];

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const QuickPickItemKind = { Separator: -1, Default: 0 };

const vscode = {
  ConfigurationTarget,
  QuickPickItemKind,
  Uri: {
    parse: (value) => ({ toString: () => value, scheme: value.split(':')[0] }),
    file: (value) => ({ fsPath: value, scheme: 'file' }),
  },
  env: {
    openExternal: async (uri) => {
      opened.push(String(uri.toString()));
      return true;
    },
  },
  window: {
    showQuickPick: async (items, options) => {
      const list = await items;
      const choice = nextAnswer('pick', options?.title ?? '(untitled)');
      if (choice === null) return undefined;
      const found = list.find(
        (i) => i.label === choice || i.label?.replace(/^\$\([a-z-]+\)\s*/, '') === choice,
      );
      if (found === undefined) {
        throw new Error(
          `no item labelled ${JSON.stringify(choice)}; offered: ${list
            .filter((i) => i.kind !== QuickPickItemKind.Separator)
            .map((i) => i.label)
            .join(' | ')}`,
        );
      }
      if (found.kind === QuickPickItemKind.Separator) {
        throw new Error(`${choice} is a separator, not a selectable option`);
      }
      return found;
    },
    showInputBox: async (options) => {
      const value = nextAnswer(options?.password === true ? 'secret' : 'input', options?.title ?? '(untitled)');
      if (value === null) return undefined;
      // The wizard's own validator gets to reject it, exactly as in the real UI.
      if (typeof options?.validateInput === 'function') {
        const problem = await options.validateInput(value);
        if (problem !== null && problem !== undefined && problem !== '') {
          throw new Error(`the wizard rejected ${JSON.stringify(value)}: ${problem}`);
        }
      }
      return value;
    },
    showInformationMessage: async (message, ...rest) => {
      notices.push(['info', message]);
      const actions = rest.filter((r) => typeof r === 'string');
      return actions.length === 0 ? undefined : nextAnswer('notice', message);
    },
    showWarningMessage: async (message, ...rest) => {
      notices.push(['warn', message]);
      const actions = rest.filter((r) => typeof r === 'string');
      return actions.length === 0 ? undefined : nextAnswer('notice', message);
    },
    showErrorMessage: async (message) => {
      notices.push(['error', message]);
      return undefined;
    },
    setStatusBarMessage: () => ({ dispose() {} }),
  },
  workspace: {
    // One folder open, so the wizard writes workspace settings.
    workspaceFolders: [{ uri: { fsPath: path.join(process.cwd(), '.vscode', 'sandbox') } }],
    getConfiguration: (section) => ({
      get: (key) => settings.get(`${section}.${key}`),
      update: async (key, value, target) => {
        settings.set(`${section}.${key}`, value);
        writes.push({ key: `${section}.${key}`, target });
      },
    }),
  },
  commands: {
    executeCommand: async (command, ...args) => {
      opened.push(`${command} ${args.join(' ')}`.trim());
      return undefined;
    },
  },
};

// Satisfy `require('vscode')` for every module loaded from here on.
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return realResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

// --- the real modules under test ---

const { addProvider, addModel } = require(path.join(out, 'ui', 'setup.js'));
const { CredentialManager } = require(path.join(out, 'credentials', 'store.js'));
const { ModelCatalog } = require(path.join(out, 'providers', 'catalog.js'));
const { buildCandidates } = require(path.join(out, 'app', 'session.js'));
const { createRequestBuilder } = require(path.join(out, 'providers', 'requests.js'));

/**
 * The JSON body the configuration would actually send.
 *
 * Goes through the same builder the transport uses, so a preset that got the
 * output-cap field wrong is caught here rather than by a 400 in front of a user.
 */
function requestBody(catalog, providerId, modelId) {
  const build = createRequestBuilder({ catalog, toolSpecs: [] });
  const request = build({
    model: { providerId, modelId },
    objective: 'add a test',
    transcript: [],
    handoff: null,
    toolNames: [],
  });
  return JSON.parse(request.body);
}



function credentials() {
  const meta = new Map();
  return new CredentialManager({
    secrets: {
      get: async (k) => secrets.get(k),
      store: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    metadata: {
      get: (k) => meta.get(k),
      update: async (k, v) => void meta.set(k, v),
    },
  });
}

function reset() {
  settings.clear();
  writes.length = 0;
  secrets.clear();
  notices.length = 0;
  opened.length = 0;
  asked = [];
}

let failures = 0;
async function scenario(name, answers, check) {
  reset();
  script = [...answers];
  try {
    await check();
    if (script.length > 0) {
      throw new Error(`${script.length} scripted answer(s) were never asked for`);
    }
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    console.log(`        prompts seen:\n          ${asked.join('\n          ')}`);
  }
}

// --- scenarios ---

(async () => {
  console.log('\nDriving the real compiled wizard (out/src/ui/setup.js)\n');

  await scenario(
    'NVIDIA, end to end, produces a routable model',
    [
      'NVIDIA NIM',                  // preset
      'nvidia',                      // endpoint id
      'nvidia-secret-key',           // api key
      'meta/llama-3.3-70b-instruct', // model id
      '131072',                      // context window
      '4096',                        // max output
      'Yes, it can call tools',      // tool calling

    ],
    async () => {
      const creds = credentials();
      const id = await addProvider(creds);
      assert.equal(id, 'nvidia', 'addProvider should return the endpoint id it created');

      const providers = settings.get('coderelay.providers');
      assert.equal(providers.length, 1);
      const [provider] = providers;
      // The facts a user cannot be expected to know, filled in for them.
      assert.equal(provider.kind, 'openai', 'NVIDIA speaks the OpenAI protocol');
      assert.equal(provider.baseUrl, 'https://integrate.api.nvidia.com/v1');
      // `max_tokens` is the default, so `buildProviderConfig` deliberately omits
      // it rather than writing noise into the user's settings file. What matters
      // is the field that ends up on the wire, which is asserted below.
      assert.equal(
        Object.prototype.hasOwnProperty.call(provider, 'maxTokensField'),
        false,
        'the default should not be written out',
      );

      // The key must never be in settings.
      assert.equal(JSON.stringify(providers).includes('nvidia-secret-key'), false);

      const models = settings.get('coderelay.models');
      assert.equal(models.length, 1, 'the wizard should have declared one model');
      assert.deepEqual(models[0], {
        provider: 'nvidia',
        model: 'meta/llama-3.3-70b-instruct',
        contextWindow: 131072,
        maxOutput: 4096,
        toolCalling: true,
      });

      // Everything written workspace-scoped, since a folder is open.
      for (const w of writes) {
        assert.equal(w.target, ConfigurationTarget.Workspace, `${w.key} was not workspace-scoped`);
      }

      // The real test: does the router now consider this model usable?
      const catalog = ModelCatalog.fromSettings(
        settings.get('coderelay.providers'),
        settings.get('coderelay.models'),
      );
      assert.equal(catalog.isConfigured(), true);
      const candidates = buildCandidates(catalog, creds, Date.now());
      assert.equal(candidates.length, 1, 'exactly one candidate expected');
      assert.equal(
        candidates[0].readyCredentialIds.length,
        1,
        'the key the wizard stored should make the model immediately usable',
      );
      assert.equal([...secrets.values()].includes('nvidia-secret-key'), true, 'key not in keychain');

      // What the endpoint will actually receive. This is the assertion worth
      // making: `max_tokens` versus `max_completion_tokens` is a 400 on every
      // attempt when wrong, and failover cannot route around a malformed request.
      const body = requestBody(catalog, 'nvidia', 'meta/llama-3.3-70b-instruct');
      assert.equal(body.max_tokens, 4096, 'NVIDIA expects max_tokens');
      assert.equal('max_completion_tokens' in body, false);
      assert.equal(body.model, 'meta/llama-3.3-70b-instruct');
    },
  );


  await scenario(
    'an endpoint configured but no model yet is still listed — the reported bug',
    ['Anthropic', 'anthropic', 'anthropic-key', null],
    async () => {
      const creds = credentials();
      await addProvider(creds); // cancel at the model-id prompt
      const catalog = ModelCatalog.fromSettings(
        settings.get('coderelay.providers'),
        settings.get('coderelay.models') ?? [],
      );
      // The exact state that produced "Configure a provider in coderelay.providers
      // before adding a credential": an endpoint exists, no model does.
      assert.equal(catalog.isConfigured(), false, 'no model, so nothing is routable yet');
      assert.deepEqual(catalog.providerIds(), ['anthropic']);
      assert.equal(catalog.hasProviders(), true);
      assert.equal(
        catalog.providerConfigs().length,
        1,
        'addCredential enumerates this, so the dead end is gone',
      );
    },
  );

  await scenario(
    'a local endpoint needs no key and is routable anyway',
    ['Ollama (local)', 'ollama', 'qwen2.5-coder', '32768', '8192', 'Yes, it can call tools'],

    async () => {
      const creds = credentials();
      await addProvider(creds); // no key prompt: auth is 'none'
      const [provider] = settings.get('coderelay.providers');
      assert.equal(provider.auth, 'none');
      assert.equal(provider.baseUrl.startsWith('http://localhost'), true);

      const catalog = ModelCatalog.fromSettings(
        settings.get('coderelay.providers'),
        settings.get('coderelay.models'),
      );
      const candidates = buildCandidates(catalog, creds, Date.now());
      assert.equal(
        candidates[0].readyCredentialIds.length,
        1,
        'a local endpoint must be usable without the user inventing a key',
      );
    },
  );

  await scenario(
    'a second endpoint coexists, which is what failover needs',
    ['OpenAI', 'openai', 'openai-key', 'gpt-4o-mini', '128000', '16384', 'Yes, it can call tools'],

    async () => {
      const creds = credentials();
      settings.set('coderelay.providers', [
        { id: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' },
      ]);
      settings.set('coderelay.models', [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          contextWindow: 200000,
          maxOutput: 8192,
          toolCalling: true,
        },
      ]);
      await addProvider(creds);

      const providers = settings.get('coderelay.providers');
      assert.equal(providers.length, 2, 'the existing endpoint must survive');
      assert.deepEqual(providers.map((p) => p.id), ['anthropic', 'openai']);
      assert.equal(
        providers[1].maxTokensField,
        'max_completion_tokens',
        'newer OpenAI models reject max_tokens; the preset must get this right',
      );
      assert.equal(settings.get('coderelay.models').length, 2);
    },
  );

  await scenario(
    'a duplicate endpoint id is refused rather than silently overwriting',
    ['OpenAI', 'openai'],
    async () => {
      settings.set('coderelay.providers', [
        { id: 'openai', kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
      ]);
      let rejected = false;
      try {
        await addProvider(credentials());
      } catch (err) {
        // The stub turns a validator rejection into a throw.
        rejected = /already|taken|unique|use/i.test(err.message);
        if (!rejected) throw err;
      }
      assert.equal(rejected, true, 'reusing an id would silently clobber stored keys');
      assert.equal(settings.get('coderelay.providers').length, 1, 'nothing was overwritten');
    },
  );

  await scenario(
    'Add Model against an existing endpoint needs no re-onboarding',
    ['gemini-2.0-flash', '1048576', '8192', 'Yes, it can call tools'],

    async () => {
      settings.set('coderelay.providers', [
        { id: 'gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
      ]);
      await addModel('gemini');
      const models = settings.get('coderelay.models');
      assert.equal(models.length, 1);
      assert.equal(models[0].provider, 'gemini');
      assert.equal(models[0].contextWindow, 1048576);
    },
  );

  await scenario(
    'a non-numeric context window is rejected, not coerced to NaN',
    ['Anthropic', 'anthropic', 'k', 'claude-sonnet-4', 'lots'],
    async () => {
      let rejected = false;
      try {
        await addProvider(credentials());
      } catch (err) {
        rejected = /number|numeric|digits|whole/i.test(err.message);
        if (!rejected) throw err;
      }
      assert.equal(rejected, true, 'NaN in contextWindow would break routing silently');
    },
  );

  console.log(
    failures === 0
      ? '\nAll wizard scenarios passed.\n'
      : `\n${failures} wizard scenario(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
