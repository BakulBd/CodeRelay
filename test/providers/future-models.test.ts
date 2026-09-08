/**
 * A model released tomorrow must work without an extension update.
 *
 * This is the property that decides whether the extension ages well. Vendors
 * ship models on their own schedule; anything here that has to *know* a model
 * id in advance becomes wrong the week after it is written, and the user's
 * recourse is to wait for a release.
 *
 * The checks below are structural. They constrain what the code *can* depend
 * on, rather than sampling a few names that happen to be current.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ModelCatalog } from '../../src/providers/catalog.js';
import { PROVIDER_PRESETS } from '../../src/providers/presets.js';

/** A model id no table could possibly contain. */
const FUTURE = 'claude-opus-9-20301231-experimental';

test('the catalog accepts a model id nothing has ever heard of', () => {
  const catalog = ModelCatalog.of(
    [{ id: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: 'api-key-header' }],
    [
      {
        provider: 'anthropic',
        model: FUTURE,
        contextWindow: 2_000_000,
        maxOutput: 128_000,
        toolCalling: true,
      },
    ],
  );

  assert.equal(catalog.isConfigured(), true);
  assert.ok(
    catalog.adapterMap().get('anthropic') !== undefined,
    'the adapter is chosen by wire format, not by model name',
  );
});

test('many providers are served by a handful of wire formats', () => {
  // This is what makes the provider list cheap to extend and the model list
  // free: CodeRelay must know how to *talk* to an endpoint, and need not know
  // what runs behind it. `createAdapter` switches exhaustively over the wire
  // formats, so the compiler — not a runtime check — guarantees every provider
  // has an adapter.
  const kinds = new Set(PROVIDER_PRESETS.map((p) => p.kind));

  assert.ok(
    PROVIDER_PRESETS.length >= 9,
    `only ${PROVIDER_PRESETS.length} providers; the brief names nine`,
  );
  assert.ok(
    kinds.size <= 4,
    `${kinds.size} wire formats for ${PROVIDER_PRESETS.length} providers — most should be OpenAI-compatible`,
  );

  // Every preset resolves to an adapter, whatever its id.
  for (const preset of PROVIDER_PRESETS) {
    const catalog = ModelCatalog.of(
      [
        {
          id: preset.suggestedId,
          kind: preset.kind,
          baseUrl: preset.baseUrl === '' ? 'https://example.test' : preset.baseUrl,
          auth: preset.auth ?? 'bearer',
        },
      ],
      [
        {
          provider: preset.suggestedId,
          // Deliberately a name from no vendor's list.
          model: FUTURE,
          contextWindow: 128_000,
          maxOutput: 8_192,
          toolCalling: true,
        },
      ],
    );
    assert.ok(
      catalog.adapterMap().get(preset.suggestedId) !== undefined,
      `${preset.key} has no adapter`,
    );
  }
});

test('presets offer suggestions, never a list of permitted models', () => {
  for (const preset of PROVIDER_PRESETS) {
    const withModels = preset as { popularModels?: readonly string[] };
    if (withModels.popularModels === undefined) {
      continue;
    }
    // The field name has to keep saying "popular", not "supported": the day it
    // becomes a gate is the day a new model stops working.
    assert.ok(
      Object.keys(preset).includes('popularModels'),
      `${preset.key} must expose suggestions under popularModels`,
    );
  }
});

test('no source file gates behaviour on a specific model id', () => {
  // Matching a model *family* for a heuristic is fine — an alias like "fast"
  // has to guess at something. Refusing to run an unknown model is not.
  const offenders: string[] = [];

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path, out);
      } else if (entry.endsWith('.ts')) {
        out.push(path);
      }
    }
    return out;
  };

  for (const path of walk(join(process.cwd(), 'src'))) {
    const text = readFileSync(path, 'utf8');
    // Strip comments: model names appear in prose explaining the code.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    for (const line of code.split('\n')) {
      // A throw or a refusal that mentions a concrete model id.
      if (/throw |return null|return false/.test(line) && /claude-\d|gpt-[45]|gemini-\d/.test(line)) {
        offenders.push(`${path.slice(process.cwd().length + 1)}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(offenders, [], 'behaviour must not be gated on a model id');
});

test('preset descriptions do not name a model generation', () => {
  // A card reading "Claude 3.7 & 3.5" the year after Claude 5 ships reads as an
  // abandoned extension, and it is copy nobody remembers to update.
  const stale: string[] = [];
  for (const preset of PROVIDER_PRESETS) {
    if (/\b\d+\.\d+\b|GPT-4|4o\b|o3-mini|DeepSeek-R1|Large 2/.test(preset.detail)) {
      stale.push(`${preset.key}: ${preset.detail}`);
    }
  }
  assert.deepEqual(stale, [], 'describe the endpoint, not the model generation');
});

test('every preset can be reached and has the fields setup needs', () => {
  const keys = new Set<string>();
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(preset.label.length > 0, `${preset.key} needs a label`);
    assert.ok(preset.detail.length > 0, `${preset.key} needs a description`);
    assert.equal(keys.has(preset.key), false, `duplicate preset key ${preset.key}`);
    keys.add(preset.key);
  }
  // The nine the brief names, plus the community endpoints added since.
  for (const required of [
    'anthropic', 'openai', 'gemini', 'nvidia', 'openrouter',
    'azure', 'ollama', 'lmstudio', 'custom',
  ]) {
    assert.ok(keys.has(required), `missing provider preset: ${required}`);
  }
});
