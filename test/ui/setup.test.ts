/**
 * The setup wizard & provider manager tests.
 *
 * Guarantees:
 * - The API key is never in wizard state.
 * - Manage mode, provider editing, fallback ordering, and multi-key tracking work purely.
 * - Missing fields and reasons are always explicitly stated.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  reorderModel,
  savingProblem,
  setDefaultModel,
  setModelFilter,
  startAddProvider,
  toggleModel,
} from '../../src/ui/setup/wizard.js';
import { presentSetup } from '../../src/ui/setup/present.js';
import { SetupController } from '../../src/ui/setup/controller.js';

const openai = () => chooseProvider(initialState(), 'openai', []);

// --- the secret ------------------------------------------------------------

test('the API key never appears anywhere in wizard state', () => {
  const state = noteKey(openai(), true);
  const serialised = JSON.stringify(state);
  assert.equal(state.hasKey, true);
  assert.ok(!/apiKey|secret|sk-/i.test(serialised), serialised);
});

test('the key field is never echoed back to the panel', () => {
  const model = presentSetup(noteKey(openai(), true));
  const key = model.fields.find((f) => f.id === 'apiKey');
  assert.ok(key !== undefined);
  assert.equal(key.value, '', 'a stored key must never be sent to the frame');
  assert.equal(key.secret, true);
  assert.match(key.placeholder, /stored/);
});

// --- choosing a provider ---------------------------------------------------

test('choosing a provider pre-fills what the preset already knows', () => {
  const state = openai();
  assert.equal(state.step, 'connect');
  assert.equal(state.providerId, 'openai');
  assert.match(state.baseUrl, /^https:\/\//);
});

test('a second endpoint for the same provider gets a distinct name', () => {
  const state = chooseProvider(initialState(), 'openai', ['openai']);
  assert.equal(state.providerId, 'openai-2');
  const third = chooseProvider(initialState(), 'openai', ['openai', 'openai-2']);
  assert.equal(third.providerId, 'openai-3');
});

test('a custom endpoint starts with no URL, so the user must supply one', () => {
  const state = chooseProvider(initialState(), 'custom', []);
  assert.equal(state.baseUrl, '');
  assert.match(connectionProblem(state) ?? '', /endpoint URL/i);
});

test('an unknown provider key is reported rather than silently ignored', () => {
  assert.match(chooseProvider(initialState(), 'nope', []).error ?? '', /not recognised/);
});

// --- the connect step ------------------------------------------------------

test('every missing field names itself', () => {
  let state = chooseProvider(initialState(), 'custom', []);
  assert.match(connectionProblem(state) ?? '', /endpoint URL/i);

  state = editConnection(state, 'baseUrl', 'https://example.test/v1');
  assert.match(connectionProblem(state) ?? '', /API key/i);

  state = noteKey(state, true);
  assert.equal(connectionProblem(state), null);
});

test('a local endpoint needs no key', () => {
  const state = chooseProvider(initialState(), 'ollama', []);
  assert.equal(connectionProblem(state), null, 'a local runtime has no credential to give');
  const model = presentSetup(state);
  assert.ok(!model.fields.some((f) => f.id === 'apiKey'), 'and is not asked for one');
});

test('an endpoint that needs an API version says so', () => {
  const state = chooseProvider(initialState(), 'azure', []);
  const withUrl = noteKey(editConnection(state, 'baseUrl', 'https://x.openai.azure.com'), true);
  assert.match(connectionProblem(withUrl) ?? '', /API version/i);
  assert.ok(presentSetup(withUrl).fields.some((f) => f.id === 'apiVersion'));
});

test('a malformed URL is rejected with the reason', () => {
  const state = editConnection(noteKey(openai(), true), 'baseUrl', 'ftp://nope');
  assert.match(connectionProblem(state) ?? '', /http/i);
});

test('editing any field invalidates a stale test result', () => {
  const tested = noteTest(noteKey(openai(), true), { ok: true, message: 'Connected.' });
  assert.notEqual(tested.test, null);
  assert.equal(editConnection(tested, 'baseUrl', 'https://other.test/v1').test, null);
  assert.equal(noteKey(tested, true).test, null, 'a new key needs a new test');
});

// --- discovery and models --------------------------------------------------

test('discovery failing still advances, so the user is never stuck', () => {
  const state = noteDiscovery(beginBusy(noteKey(openai(), true), 'discovering'), {
    ok: false,
    reason: 'No model listing at that URL (404).',
  });
  assert.equal(state.step, 'models', 'a missing listing must not trap the wizard');
  assert.match(state.error ?? '', /404/);
  assert.equal(state.busy, null);
});

test('an endpoint with no models explains what to do instead', () => {
  const state = noteDiscovery(openai(), { ok: true, modelIds: [] });
  assert.match(presentSetup(state).emptyModels ?? '', /Enter your model id/);
});

test('discovered models are listed, and enabling one makes it the default', () => {
  let state = noteDiscovery(noteKey(openai(), true), { ok: true, modelIds: ['b', 'a'] });
  assert.deepEqual([...state.discovered], ['a', 'b'], 'sorted, so the list is scannable');

  state = toggleModel(state, 'a');
  assert.deepEqual([...state.chosen], ['a']);
  assert.equal(state.defaultModel, 'a');
});

test('the routing order is stated in words, not implied by position alone', () => {
  let state = noteDiscovery(noteKey(openai(), true), { ok: true, modelIds: ['a', 'b', 'c'] });
  state = toggleModel(toggleModel(toggleModel(state, 'a'), 'b'), 'c');
  const roles = presentSetup(state).models.filter((m) => m.enabled).map((m) => m.role);
  assert.deepEqual(roles, ['Default', 'Fallback 1', 'Fallback 2']);
});

test('disabling the default promotes the next model rather than leaving none', () => {
  let state = noteDiscovery(noteKey(openai(), true), { ok: true, modelIds: ['a', 'b'] });
  state = toggleModel(toggleModel(state, 'a'), 'b');
  assert.equal(state.defaultModel, 'a');

  state = toggleModel(state, 'a');
  assert.deepEqual([...state.chosen], ['b']);
  assert.equal(state.defaultModel, 'b');
});

test('disabling the last model leaves no default, and saving says so', () => {
  let state = noteDiscovery(noteKey(openai(), true), { ok: true, modelIds: ['a'] });
  state = toggleModel(toggleModel(state, 'a'), 'a');
  assert.equal(state.defaultModel, null);
  assert.match(savingProblem(state) ?? '', /at least one model/i);
});

test('promoting a model reorders the fallbacks around it', () => {
  let state = noteDiscovery(noteKey(openai(), true), { ok: true, modelIds: ['a', 'b', 'c'] });
  state = toggleModel(toggleModel(toggleModel(state, 'a'), 'b'), 'c');

  state = setDefaultModel(state, 'c');
  assert.deepEqual([...state.chosen], ['c', 'a', 'b']);
  assert.equal(state.defaultModel, 'c');
});

test('reordering the first entry changes the default, because the first is the default', () => {
  let state = noteDiscovery(noteKey(openai(), true), { ok: true, modelIds: ['a', 'b'] });
  state = toggleModel(toggleModel(state, 'a'), 'b');

  state = reorderModel(state, 'b', -1);
  assert.deepEqual([...state.chosen], ['b', 'a']);
  assert.equal(state.defaultModel, 'b');
});

test('reordering past either end does nothing', () => {
  let state = noteDiscovery(noteKey(openai(), true), { ok: true, modelIds: ['a', 'b'] });
  state = toggleModel(toggleModel(state, 'a'), 'b');
  assert.deepEqual([...reorderModel(state, 'a', -1).chosen], ['a', 'b']);
  assert.deepEqual([...reorderModel(state, 'b', 1).chosen], ['a', 'b']);
});

test('a manually entered model is enabled, and duplicates are refused by name', () => {
  let state = addManualModel(noteKey(openai(), true), 'my-model');
  assert.deepEqual([...state.chosen], ['my-model']);
  assert.equal(state.defaultModel, 'my-model');

  state = addManualModel(state, 'my-model');
  assert.match(state.error ?? '', /already enabled/);
  assert.deepEqual([...state.chosen], ['my-model'], 'and it is not added twice');

  assert.match(addManualModel(state, '   ').error ?? '', /Enter a model id/);
});

// --- manage mode & editing -------------------------------------------------

test('manage mode presents configured providers correctly', () => {
  const configured = [
    {
      id: 'anthropic',
      kind: 'anthropic' as const,
      baseUrl: 'https://api.anthropic.com',
      keyCount: 1,
      modelCount: 2,
      isConfigured: true,
      defaultModel: 'claude-3-7-sonnet-20250219',
    },
  ];

  const state = openManage(initialState(), configured);
  assert.equal(state.step, 'manage');
  assert.equal(state.mode, 'manage');

  const viewModel = presentSetup(state);
  assert.equal(viewModel.step, 'manage');
  assert.equal(viewModel.configuredProviders.length, 1);
  assert.equal(viewModel.configuredProviders[0]?.id, 'anthropic');
  assert.equal(viewModel.configuredProviders[0]?.defaultModel, 'claude-3-7-sonnet-20250219');
});

test('editing an existing provider preserves its configured models and key count', () => {
  const state = editExistingProvider(
    initialState(),
    { id: 'custom-ai', kind: 'openai', baseUrl: 'https://api.custom.com/v1' },
    ['custom-large', 'custom-small'],
    2,
  );

  assert.equal(state.isEditing, true);
  assert.equal(state.providerId, 'custom-ai');
  assert.equal(state.storedKeyCount, 2);
  assert.deepEqual([...state.chosen], ['custom-large', 'custom-small']);
  assert.equal(state.defaultModel, 'custom-large');

  // Since stored keys exist, connection test does not block on empty key input
  assert.equal(connectionProblem(state), null);
});

test('model filtering filters rows in view model', () => {
  let state = noteDiscovery(noteKey(openai(), true), {
    ok: true,
    modelIds: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'claude-3-7'],
  });
  state = setModelFilter(state, 'mini');

  const viewModel = presentSetup(state);
  assert.equal(viewModel.models.length, 2);
  assert.ok(viewModel.models.every((m) => m.id.includes('mini')));
});

// --- navigation and presentation -------------------------------------------

test('going back from models returns to connect, keeping what was entered', () => {
  const state = noteDiscovery(noteKey(openai(), true), { ok: true, modelIds: ['a'] });
  const returned = back(state);
  assert.equal(returned.step, 'connect');
  assert.equal(returned.providerId, 'openai');
  assert.equal(returned.hasKey, true);
});

test('going back from connect returns to the provider list, clearing the draft', () => {
  assert.deepEqual(back(openai()), initialState([], 'wizard'));
});

test('the primary action is blocked with a reason, never silently inert', () => {
  const model = presentSetup(chooseProvider(initialState(), 'custom', []));
  assert.ok(model.blockedReason !== null);
  assert.match(model.blockedReason, /endpoint URL/i);
});

test('a busy step reports progress instead of a blocked reason', () => {
  const model = presentSetup(beginBusy(noteKey(openai(), true), 'testing'));
  assert.equal(model.busy, 'testing');
  assert.match(model.primaryLabel, /Testing/);
  assert.equal(model.blockedReason, null, 'work in progress is not a blocked state');
});

test('the step indicator says where the user is', () => {
  const model = presentSetup(noteDiscovery(noteKey(openai(), true), { ok: true, modelIds: [] }));
  const states = model.steps.map((s) => `${s.id}:${s.state}`);
  assert.deepEqual(states, [
    'provider:done',
    'connect:done',
    'models:current',
    'saved:upcoming',
  ]);
});

test('the final screen states what was configured, including the fallbacks', () => {
  let state = noteDiscovery(noteKey(openai(), true), { ok: true, modelIds: ['a', 'b'] });
  state = noteSaved(toggleModel(toggleModel(state, 'a'), 'b'));

  const summary = presentSetup(state).savedSummary ?? '';
  assert.match(summary, /openai is saved/);
  assert.match(summary, /1 fallback/);
});

test('a failure is reported without clearing the user’s work', () => {
  const state = noteError(noteKey(openai(), true), 'The key was rejected (401).');
  assert.match(state.error ?? '', /401/);
  assert.equal(state.providerId, 'openai', 'an error must not reset the form');
  assert.equal(state.busy, null);
});

test('the provider list offers every configured preset, flagged usefully', () => {
  const cards = presentSetup(initialState()).providers;
  const keys = cards.map((c) => c.key);
  for (const expected of ['anthropic', 'openai', 'gemini', 'nvidia', 'deepseek', 'groq', 'mistral', 'together', 'cerebras', 'fireworks', 'custom']) {
    assert.ok(keys.includes(expected), `missing ${expected}`);
  }
  assert.equal(cards.find((c) => c.key === 'custom')?.needsUrl, true);
  assert.equal(cards.find((c) => c.key === 'ollama')?.local, true);
});

test('SetupController opens cleanly from openAdd, openManage, and edit', () => {
  let changed = 0;
  const mockConfig: Record<string, unknown> = {
    providers: [],
    models: [],
  };
  const controller = new SetupController({
    credentials: {
      list: () => [],
      // The controller reads the pool on every render to draw the key rows.
      records: () => [],
      next: async () => ({ t: 'none', reason: 'none' }),
      add: async () => ({ credentialId: 'c1' }),
      remove: async () => {},
      update: async () => {},
      setEnabled: async () => {},
      reorder: async () => {},
    } as unknown as any,
    config: () => ({
      get: (key: string) => mockConfig[key],
      update: async (key: string, val: unknown) => { mockConfig[key] = val; },
    } as unknown as any),
    onChange: () => { changed++; },
    onSaved: async () => {},
  });

  assert.equal(controller.isOpen, false);
  controller.openAdd();
  assert.equal(controller.isOpen, true, 'openAdd must set isOpen to true');
  assert.equal(changed, 1);
  const addModel = controller.model();
  assert.equal(addModel.kind, 'setup');
  assert.equal(addModel.step, 'provider');

  controller.choose('anthropic');
  assert.equal(controller.isOpen, true);
  const connectModel = controller.model();
  assert.equal(connectModel.step, 'connect');
  assert.equal(connectModel.fields.some((f) => f.id === 'apiKey'), true);

  controller.close();
  assert.equal(controller.isOpen, false);

  controller.openManage();
  assert.equal(controller.isOpen, true, 'openManage must set isOpen to true');
  assert.equal(controller.model().step, 'manage');
});
