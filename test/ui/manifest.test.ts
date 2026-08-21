/**
 * The manifest's load-bearing claims.
 *
 * `package.json` is the half of a VS Code extension that TypeScript cannot see.
 * A command registered in `activate()` but missing from `contributes.commands`
 * compiles, ships, and then simply does not appear in the Command Palette; a menu
 * entry naming a command that does not exist fails just as quietly. Neither is
 * caught by `tsc`, and neither is visible by reading either file alone — which is
 * precisely why they are asserted here rather than trusted.
 *
 * Written in the same spirit as `stylesheet.test.ts`: not a schema validator, only
 * the specific promises this extension makes about its own surface.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseInbound } from '../../src/ui/webview/protocol.js';

interface CommandContribution {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
  readonly icon?: string;
}

interface MenuContribution {
  readonly command: string;
  readonly when?: string;
  readonly group?: string;
}

interface Manifest {
  readonly contributes: {
    readonly commands: readonly CommandContribution[];
    readonly menus: Readonly<Record<string, readonly MenuContribution[]>>;
    readonly viewsWelcome: readonly { readonly view: string; readonly contents: string }[];
    readonly views: Readonly<Record<string, readonly { readonly id: string; readonly type?: string }[]>>;
  };
}

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;
const extensionSource = readFileSync(join(root, 'src', 'extension.ts'), 'utf8');

const declared = manifest.contributes.commands.map((c) => c.command);
const registered = [...extensionSource.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1]);

test('every registered command is declared, so all of them reach the palette', () => {
  const undeclared = registered.filter((c) => !declared.includes(c as string));
  assert.deepEqual(
    undeclared,
    [],
    `registered in activate() but absent from contributes.commands: ${undeclared.join(', ')}`,
  );
});

test('every declared command is registered, so none of them fails when invoked', () => {
  const unregistered = declared.filter((c) => !registered.includes(c));
  assert.deepEqual(
    unregistered,
    [],
    `declared in the manifest but never registered: ${unregistered.join(', ')}`,
  );
});

test('a command is declared exactly once', () => {
  const seen = new Set<string>();
  for (const command of declared) {
    assert.ok(!seen.has(command), `${command} is declared twice`);
    seen.add(command);
  }
});

test('every menu entry names a command that exists', () => {
  for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
    for (const entry of entries) {
      assert.ok(
        declared.includes(entry.command),
        `menus.${menu} refers to undeclared command ${entry.command}`,
      );
    }
  }
});

test('every welcome-view link points at a real command', () => {
  for (const welcome of manifest.contributes.viewsWelcome) {
    for (const [, command] of welcome.contents.matchAll(/command:([A-Za-z0-9_.]+)/g)) {
      // `vscode.*` are built into the workbench and are deliberately not ours.
      if (command !== undefined && !command.startsWith('vscode.')) {
        assert.ok(
          declared.includes(command),
          `viewsWelcome for ${welcome.view} links to undeclared command ${command}`,
        );
      }
    }
  }
});

test('a welcome view is only declared for a tree view', () => {
  // `viewsWelcome` is ignored for a webview view, so pointing one at the task
  // panel would silently produce no empty state at all. The task view renders its
  // own, which is why `present.ts` carries `BlockedReason`.
  const webviews = new Set(
    Object.values(manifest.contributes.views)
      .flat()
      .filter((v) => v.type === 'webview')
      .map((v) => v.id),
  );
  for (const welcome of manifest.contributes.viewsWelcome) {
    assert.ok(
      !webviews.has(welcome.view),
      `${welcome.view} is a webview, so its viewsWelcome entry would never render`,
    );
  }
});

test('every command a user can invoke is grouped under one category', () => {
  // Without it the palette shows a bare verb like "Add Model" with no hint of
  // which extension owns it.
  for (const command of manifest.contributes.commands) {
    assert.equal(
      command.category,
      'CodeRelay',
      `${command.command} would appear uncategorised in the palette`,
    );
  }
});

test('the commands hidden from the palette are exactly those that need an argument', () => {
  // These take a tree node or a path. Invoked from the palette they receive
  // nothing, so they are hidden there rather than left to no-op confusingly.
  const hidden = (manifest.contributes.menus['commandPalette'] ?? [])
    .filter((entry) => entry.when === 'false')
    .map((entry) => entry.command)
    .sort();
  assert.deepEqual(hidden, [
    'coderelay.deleteTask',
    'coderelay.openChange',
    'coderelay.openTask',
    'coderelay.refreshViews',
    'coderelay.selectModel',
  ]);
});

test('onboarding is reachable from the Models view without editing JSON', () => {
  // The bug this guards: `addCredential` used to enumerate providers from the
  // *model* list, so a user with an endpoint but no model was told to configure
  // a provider they had already configured. Adding an endpoint has to be a
  // first-class action, not a settings edit.
  const titles = (manifest.contributes.menus['view/title'] ?? []).filter((entry) =>
    (entry.when ?? '').includes('coderelay.modelsView'),
  );
  const commands = titles.map((entry) => entry.command);
  assert.ok(commands.includes('coderelay.addProvider'), 'no way to add an endpoint from the view');
  assert.ok(commands.includes('coderelay.addModel'), 'no way to add a model from the view');
  assert.ok(commands.includes('coderelay.addCredential'), 'no way to add a key from the view');

  const welcome = manifest.contributes.viewsWelcome.find((w) => w.view === 'coderelay.modelsView');
  assert.ok(welcome !== undefined, 'the Models view has no empty state');
  assert.ok(
    welcome.contents.includes('command:coderelay.addProvider'),
    'the empty state does not offer the one action that unblocks a new user',
  );
});

test('every setup message the client can send is accepted by the validator', () => {
  // The panel is the only setup surface now, so a message the validator drops is
  // a dead button. Listed explicitly rather than derived, so adding one to the
  // client without teaching the parser about it fails here.
  const samples: unknown[] = [
    { kind: 'setUp' },
    { kind: 'setupChoose', presetKey: 'openai' },
    { kind: 'setupField', field: 'baseUrl', value: 'https://x/v1' },
    { kind: 'setupField', field: 'apiKey', value: 'sk-test' },
    { kind: 'setupPrimary' },
    { kind: 'setupBack' },
    { kind: 'setupCancel' },
    { kind: 'setupToggleModel', modelId: 'm' },
    { kind: 'setupAddModel', modelId: 'm' },
    { kind: 'setupDefaultModel', modelId: 'm' },
    { kind: 'setupReorder', modelId: 'm', direction: -1 },
    { kind: 'setupRefreshModels' },
  ];
  for (const sample of samples) {
    assert.notEqual(parseInbound(sample), null, JSON.stringify(sample));
  }
});

test('a malformed setup message is dropped rather than acted on', () => {
  assert.equal(parseInbound({ kind: 'setupField', field: 'nope', value: 'x' }), null);
  assert.equal(parseInbound({ kind: 'setupReorder', modelId: 'm', direction: 2 }), null);
  assert.equal(parseInbound({ kind: 'setupChoose' }), null);
  // A key longer than the cap is refused, so a compromised frame cannot make the
  // host write an unbounded value into the OS keychain.
  assert.equal(
    parseInbound({ kind: 'setupField', field: 'apiKey', value: 'x'.repeat(5000) }),
    null,
  );
});

test('clearing a setup field survives validation, because empty is meaningful', () => {
  const cleared = parseInbound({ kind: 'setupField', field: 'baseUrl', value: '' });
  assert.deepEqual(cleared, { kind: 'setupField', field: 'baseUrl', value: '' });
});
