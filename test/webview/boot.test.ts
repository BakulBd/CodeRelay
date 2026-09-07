/**
 * The webview client must actually boot.
 *
 * This exists because of a shipped bug that no other test could see: the client
 * looked up an element the shell did not declare, then called
 * `addEventListener` on the resulting `null` during initialisation. That threw,
 * and *everything after it* never ran — no composer handler, no message
 * listener, no `ready` post. The panel rendered and then did nothing at all,
 * and the extension never received a single message from it.
 *
 * Type checking cannot catch this: the shell is a template string and the
 * client is plain JavaScript, and neither one can see the other. So this runs
 * the real `media/task.js` against the real shell HTML in a minimal DOM, and
 * asserts the one thing that proves the panel is alive — that it posts `ready`.
 *
 * The DOM here is deliberately shallow. It is not trying to be a browser; it
 * only needs to answer `getElementById` exactly as a browser would, returning
 * `null` for anything the shell does not declare. That single behaviour is what
 * makes the test able to fail for the right reason.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { renderShell } from '../../src/ui/webview/shell.js';

interface BootResult {
  readonly posted: readonly { readonly kind?: string }[];
  readonly listeners: readonly string[];
}

function boot(): BootResult {
  const html = renderShell({
    nonce: 'n0nce',
    cspSource: 'vscode-webview:',
    scriptUri: 'task.js',
    styleUri: 'task.css',
  });

  // Only ids the shell actually declares resolve, so a lookup the shell does
  // not satisfy returns null exactly as it would in the panel.
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const listeners: string[] = [];
  const posted: { kind?: string }[] = [];
  const cache = new Map<string, unknown>();

  const makeEl = (id: string): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      id,
      hidden: false,
      value: '',
      textContent: '',
      className: '',
      title: '',
      type: '',
      placeholder: '',
      disabled: false,
      checked: false,
      spellcheck: false,
      autocomplete: '',
      rows: 1,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      childElementCount: 0,
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener: (t: string) => listeners.push(`${id}:${t}`),
      removeEventListener() {},
      setAttribute() {},
      getAttribute: () => null,
      removeAttribute() {},
      appendChild(child: unknown) {
        (el['childElementCount'] as number)++;
        return child;
      },
      append() {},
      remove() {},
      focus() {},
      blur() {},
      click() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      contains: () => false,
      scrollIntoView() {},
      insertBefore() {},
      replaceChildren() {},
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    };
    return el;
  };

  const document = {
    getElementById: (id: string) => {
      if (!declared.has(id)) {
        return null;
      }
      if (!cache.has(id)) {
        cache.set(id, makeEl(id));
      }
      return cache.get(id);
    },
    createElement: (tag: string) => makeEl(`created-${tag}`),
    createTextNode: (t: string) => ({ textContent: t }),
    createDocumentFragment: () => makeEl('fragment'),
    addEventListener: (t: string) => listeners.push(`document:${t}`),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: makeEl('body'),
    documentElement: makeEl('html'),
    activeElement: null,
  };

  const sandbox: Record<string, unknown> = {
    document,
    window: {
      document,
      addEventListener: (t: string) => listeners.push(`window:${t}`),
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
    },
    navigator: { clipboard: { writeText: async () => {} } },
    acquireVsCodeApi: () => ({
      postMessage: (m: { kind?: string }) => posted.push(m),
      getState: () => undefined,
      setState: () => {},
    }),
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    TextEncoder,
    TextDecoder,
  };
  sandbox['globalThis'] = sandbox;

  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');
  vm.runInNewContext(client, sandbox, { filename: 'media/task.js' });

  return { posted, listeners };
}

test('the client initialises without throwing', () => {
  // If this throws, the panel is inert in the real extension too: everything
  // below the throw never registers.
  assert.doesNotThrow(boot, 'media/task.js must run to completion against the shell');
});

test('the client posts ready, so the host hears from the panel', () => {
  const { posted } = boot();

  assert.ok(
    posted.some((m) => m.kind === 'ready'),
    'without `ready` the host never sends state and the panel stays empty forever',
  );
});

test('the client registers handlers for the controls the user actually uses', () => {
  const { listeners } = boot();

  // A sample of the controls that matter most. Each is a path a user takes on
  // their first minute with the extension, and each would silently do nothing
  // if initialisation had stopped early.
  for (const required of [
    'btn-send:click',
    'composer:submit',
    'prompt:keydown',
    'window:message',
  ]) {
    assert.ok(
      listeners.includes(required),
      `no handler for ${required} — initialisation stopped before reaching it`,
    );
  }

  assert.ok(listeners.length > 30, `only ${listeners.length} handlers registered`);
});
