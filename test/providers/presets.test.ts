/**
 * Endpoint presets, and the catalog accessors the setup flow needs.
 *
 * The first test in here is a regression test for a real dead end: "Add API Key"
 * derived its provider list from `catalog.entries()`, which returns *models*. A
 * user who had configured an endpoint but not yet declared a model against it was
 * told to "configure a provider before adding a credential" — advice they had
 * already followed. And they could not escape by declaring a model first, because
 * a model is only useful once a key exists.
 *
 * The rest assert the one thing presets are allowed to contain: endpoint facts.
 * No model ids, no capabilities, no context windows — `catalog.ts` sets out at
 * length why a shipped model table becomes a confident lie, and a preset must not
 * reintroduce one through the side door.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelCatalog, parseProviderConfig, type ProviderConfig } from '../../src/providers/catalog.js';
import {
  PROVIDER_PRESETS,
  buildProviderConfig,
  findPreset,
  uniqueProviderId,
  validateBaseUrl,
  validateProviderId,
} from '../../src/providers/presets.js';

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  ...over,
});

// --- the regression ---

test('a configured endpoint is listed even before any model names it', () => {
  // The exact state that produced the dead end. `entries()` is empty here, so any
  // provider list derived from it would be empty too.
  const catalog = ModelCatalog.of([provider()], []);

  assert.deepEqual(catalog.entries(), [], 'no models declared yet, by construction');
  assert.deepEqual(catalog.providerIds(), ['anthropic'], 'the endpoint must still be visible');
  assert.equal(catalog.hasProviders(), true);
  // `isConfigured` is about models and is correctly false — the two questions are
  // different, and conflating them is what broke onboarding.
  assert.equal(catalog.isConfigured(), false);
});

test('providers keep configuration order, since ids key credentials', () => {
  const catalog = ModelCatalog.of(
    [
      provider({ id: 'first' }),
      provider({ id: 'second', kind: 'openai', baseUrl: 'https://api.openai.com/v1' }),
    ],
    [],
  );
  assert.deepEqual(catalog.providerIds(), ['first', 'second']);
  assert.deepEqual(
    catalog.providerConfigs().map((p) => p.id),
    ['first', 'second'],
  );
});

test('an empty catalog reports no providers rather than throwing', () => {
  const catalog = ModelCatalog.of([], []);
  assert.deepEqual(catalog.providerIds(), []);
  assert.equal(catalog.hasProviders(), false);
});

test('models can be listed per endpoint', () => {
  const catalog = ModelCatalog.of(
    [provider({ id: 'a' }), provider({ id: 'b' })],
    [
      { provider: 'a', model: 'm1', contextWindow: 1000, maxOutput: 100, toolCalling: true },
      { provider: 'a', model: 'm2', contextWindow: 1000, maxOutput: 100, toolCalling: true },
      { provider: 'b', model: 'm3', contextWindow: 1000, maxOutput: 100, toolCalling: true },
    ],
  );
  assert.deepEqual(
    catalog.modelsFor('a').map((m) => m.model),
    ['m1', 'm2'],
  );
  assert.deepEqual(
    catalog.modelsFor('b').map((m) => m.model),
    ['m3'],
  );
  assert.deepEqual(catalog.modelsFor('missing'), []);
});

// --- what a preset may contain ---

test('no preset ships a model id, a context window or a capability', () => {
  // The whole reason capabilities are declared by the user. A preset that carried
  // them would go stale and the router gates on those numbers.
  for (const preset of PROVIDER_PRESETS) {
    const keys = Object.keys(preset);
    for (const forbidden of [
      'model',
      'models',
      'modelId',
      'contextWindow',
      'maxOutput',
      'toolCalling',
      'vision',
      'costPerMTokIn',
      'costPerMTokOut',
    ]) {
      assert.ok(!keys.includes(forbidden), `${preset.key} ships "${forbidden}"`);
    }
  }
});

test('no preset carries anything resembling a credential', () => {
  for (const preset of PROVIDER_PRESETS) {
    const serialized = JSON.stringify(preset).toLowerCase();
    for (const smell of ['"apikey"', '"api_key"', '"secret"', '"token"', 'authorization', 'bearer ']) {
      assert.ok(!serialized.includes(smell), `${preset.key} looks like it carries a secret`);
    }
    // Headers exist for attribution only.
    for (const name of Object.keys(preset.headers ?? {})) {
      assert.ok(
        !/^(authorization|x-api-key|api-key)$/i.test(name),
        `${preset.key} sets the auth header "${name}" as a plain header`,
      );
    }
  }
});

test('every preset the user can pick produces a settings row the catalog accepts', () => {
  for (const preset of PROVIDER_PRESETS) {
    const config = buildProviderConfig(preset, {
      id: preset.suggestedId,
      // Supplied for the presets that ask, ignored for the ones that do not.
      baseUrl: preset.needsBaseUrl === true ? 'https://example.invalid/v1' : undefined,
      apiVersion: preset.needsApiVersion === true ? '2024-10-21' : undefined,
    });

    // The real validator, not a copy of it: a preset that cannot round-trip
    // through settings is a preset that produces a broken configuration.
    const parsed = parseProviderConfig(config);
    assert.equal(parsed.id, preset.suggestedId);
    assert.equal(parsed.kind, preset.kind);
    assert.match(parsed.baseUrl, /^https?:\/\//);
    // Built into a live catalog too, which is where duplicate ids and adapter
    // construction are checked.
    assert.doesNotThrow(() => ModelCatalog.of([parsed], []));
  }
});

test('the presets cover the providers the project claims to support', () => {
  const keys = PROVIDER_PRESETS.map((p) => p.key);
  for (const expected of ['anthropic', 'openai', 'gemini', 'nvidia', 'openrouter', 'azure', 'custom']) {
    assert.ok(keys.includes(expected), `no preset for ${expected}`);
  }
  // A local runtime must be offerable, since it is the one that needs no key.
  assert.ok(keys.includes('ollama'));
  // All three wire protocols are reachable from the picker.
  const kinds = new Set(PROVIDER_PRESETS.map((p) => p.kind));
  assert.deepEqual([...kinds].sort(), ['anthropic', 'gemini', 'openai']);
});

test('the output-cap field is stated for every OpenAI-compatible preset', () => {
  // Unguessable, and a wrong value is a 400 on every attempt that failover cannot
  // route around. That is precisely why it is in the preset at all.
  for (const preset of PROVIDER_PRESETS.filter((p) => p.kind === 'openai')) {
    assert.ok(
      preset.maxTokensField !== undefined,
      `${preset.key} leaves maxTokensField to chance`,
    );
  }
  assert.equal(findPreset('openai')?.maxTokensField, 'max_completion_tokens');
  assert.equal(findPreset('nvidia')?.maxTokensField, 'max_tokens');
});

test('a local runtime is marked as needing no authentication', () => {
  assert.equal(findPreset('ollama')?.auth, 'none');
  assert.equal(findPreset('lmstudio')?.auth, 'none');
  // Azure uses its own header rather than a bearer token.
  assert.equal(findPreset('azure')?.auth, 'api-key-header');
});

test('a preset that cannot know its own endpoint says so', () => {
  // Azure is per-resource and a custom endpoint is per-user; both must ask.
  assert.equal(findPreset('azure')?.needsBaseUrl, true);
  assert.equal(findPreset('custom')?.needsBaseUrl, true);
  assert.equal(findPreset('azure')?.baseUrl, '');
  // Everything else supplies one, so the user types nothing.
  for (const preset of PROVIDER_PRESETS.filter((p) => p.needsBaseUrl !== true)) {
    assert.match(preset.baseUrl, /^https?:\/\//, `${preset.key} has no usable default`);
  }
});

// --- building the settings row ---

test('a default is omitted rather than frozen into the user\u2019s settings', () => {
  const config = buildProviderConfig(findPreset('anthropic')!, { id: 'anthropic' });
  // `bearer` and `max_tokens` are the catalog's own defaults; writing them adds
  // noise and pins today's default into a file that outlives it.
  assert.ok(!('auth' in config), 'bearer should not be written');
  assert.ok(!('maxTokensField' in config), 'the default cap field should not be written');
  assert.ok(!('apiVersion' in config));
  assert.ok(!('headers' in config));
});

test('a deviation from a default is always written', () => {
  const azure = buildProviderConfig(findPreset('azure')!, {
    id: 'azure',
    baseUrl: 'https://my-resource.openai.azure.com',
    apiVersion: '2024-10-21',
  });
  assert.equal(azure.auth, 'api-key-header');
  assert.equal(azure.maxTokensField, 'max_completion_tokens');
  assert.equal(azure.apiVersion, '2024-10-21');
});

test('a trailing slash is removed, because the builder appends its own path', () => {
  const config = buildProviderConfig(findPreset('custom')!, {
    id: 'custom',
    baseUrl: 'https://example.invalid/v1///',
  });
  assert.equal(config.baseUrl, 'https://example.invalid/v1');
});

test('attribution headers are copied, not shared with the preset', () => {
  const config = buildProviderConfig(findPreset('openrouter')!, { id: 'openrouter' });
  assert.ok(config.headers !== undefined);
  assert.notEqual(config.headers, findPreset('openrouter')!.headers, 'must not alias the preset');
});

// --- validation ---

test('a duplicate id is refused, and a free one suggested', () => {
  // Ids key credentials and appear in the ledger, so a collision is a ConfigError
  // rather than a merge — better to suggest than to let the user discover it.
  assert.equal(uniqueProviderId('openai', []), 'openai');
  assert.equal(uniqueProviderId('openai', ['openai']), 'openai-2');
  assert.equal(uniqueProviderId('openai', ['openai', 'openai-2']), 'openai-3');

  assert.equal(validateProviderId('fresh', ['openai']), null);
  assert.match(validateProviderId('openai', ['openai']) ?? '', /already configured/);
  assert.match(validateProviderId('   ', []) ?? '', /required/);
});

test('a base URL is checked for exactly what the parser will reject', () => {
  assert.equal(validateBaseUrl('https://api.openai.com/v1'), null);
  assert.equal(validateBaseUrl('http://localhost:11434/v1'), null);
  assert.match(validateBaseUrl('') ?? '', /required/);
  assert.match(validateBaseUrl('api.openai.com') ?? '', /http/);
  assert.match(validateBaseUrl('ftp://example.invalid') ?? '', /http/);

  // The same string the real parser refuses, so the wizard and the parser agree.
  assert.throws(() => parseProviderConfig({ id: 'x', kind: 'openai', baseUrl: 'api.openai.com' }));
});

test('an unknown preset key yields null rather than a fabricated preset', () => {
  assert.equal(findPreset('does-not-exist'), null);
});
