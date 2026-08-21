/**
 * The webview boundary tests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_OBJECTIVE_CHARS,
  MAX_PATH_CHARS,
  parseInbound,
} from '../../src/ui/webview/protocol.js';
import { escapeHtml, renderShell } from '../../src/ui/webview/shell.js';

const shell = (over: Partial<Parameters<typeof renderShell>[0]> = {}) =>
  renderShell({
    cspSource: 'vscode-resource://authority',
    styleUri: 'vscode-resource://authority/media/task.css',
    scriptUri: 'vscode-resource://authority/media/task.js',
    nonce: 'abc123',
    ...over,
  });

// --- inbound validation ---

test('a message that is not an object is rejected', () => {
  for (const value of [null, undefined, 'start', 42, [], true]) {
    assert.equal(parseInbound(value), null, `accepted ${JSON.stringify(value)}`);
  }
});

test('an unknown kind is rejected rather than passed through', () => {
  assert.equal(parseInbound({ kind: 'deleteEverything' }), null);
  assert.equal(parseInbound({ kind: '' }), null);
  assert.equal(parseInbound({ kind: 42 }), null);
});

test('payload-free commands are accepted and carry nothing else', () => {
  for (const kind of [
    'ready',
    'stop',
    'resume',
    'retry',
    'switchModel',
    'pickModel',
    'openTimeline',
    'openSettings',
    'setUp',
    'setupOpenManage',
    'setupOpenAdd',
    'setupTestConnection',
    'setupPrimary',
    'setupBack',
    'setupCancel',
    'setupRefreshModels',
    'addCredential',
    'resolve',
    'attachFile',
    'openInEditor',
    'newSession',
    'exportMarkdown',
    'compactContext',
    'revertAllChanges',
    'approvePlan',
    'rejectPlan',
  ]) {
    assert.deepEqual(parseInbound({ kind }), { kind }, `rejected ${kind}`);
  }
});

test('setup commands with payloads are validated and parsed', () => {
  assert.deepEqual(parseInbound({ kind: 'setupChoose', presetKey: 'anthropic' }), {
    kind: 'setupChoose',
    presetKey: 'anthropic',
  });

  assert.deepEqual(parseInbound({ kind: 'setupEditProvider', providerId: 'my-openai' }), {
    kind: 'setupEditProvider',
    providerId: 'my-openai',
  });

  assert.deepEqual(parseInbound({ kind: 'setupDeleteProvider', providerId: 'old-gemini' }), {
    kind: 'setupDeleteProvider',
    providerId: 'old-gemini',
  });

  assert.deepEqual(parseInbound({ kind: 'setupFilterModels', query: 'claude' }), {
    kind: 'setupFilterModels',
    query: 'claude',
  });

  assert.deepEqual(parseInbound({ kind: 'setupField', field: 'baseUrl', value: 'https://api.openai.com/v1' }), {
    kind: 'setupField',
    field: 'baseUrl',
    value: 'https://api.openai.com/v1',
  });

  assert.deepEqual(parseInbound({ kind: 'setupToggleModel', modelId: 'gpt-4o' }), {
    kind: 'setupToggleModel',
    modelId: 'gpt-4o',
  });

  assert.deepEqual(parseInbound({ kind: 'setupDefaultModel', modelId: 'claude-3-7-sonnet' }), {
    kind: 'setupDefaultModel',
    modelId: 'claude-3-7-sonnet',
  });

  assert.deepEqual(parseInbound({ kind: 'setupReorder', modelId: 'gpt-4o', direction: -1 }), {
    kind: 'setupReorder',
    modelId: 'gpt-4o',
    direction: -1,
  });

  assert.deepEqual(parseInbound({ kind: 'setMode', mode: 'architect' }), {
    kind: 'setMode',
    mode: 'architect',
  });
  assert.equal(parseInbound({ kind: 'setMode', mode: 'invalid_mode' }), null);

  assert.deepEqual(parseInbound({ kind: 'toggleSound', enabled: true }), {
    kind: 'toggleSound',
    enabled: true,
  });

  assert.deepEqual(parseInbound({ kind: 'switchSession', taskId: 'task-123' }), {
    kind: 'switchSession',
    taskId: 'task-123',
  });

  assert.deepEqual(parseInbound({ kind: 'deleteSession', taskId: 'task-456' }), {
    kind: 'deleteSession',
    taskId: 'task-456',
  });

  assert.deepEqual(parseInbound({ kind: 'enhancePrompt', text: 'refactor auth flow' }), {
    kind: 'enhancePrompt',
    text: 'refactor auth flow',
  });

  assert.deepEqual(parseInbound({ kind: 'rewindToCheckpoint', commitOrTurnId: 'c1a2b3' }), {
    kind: 'rewindToCheckpoint',
    commitOrTurnId: 'c1a2b3',
  });
});

test('extra fields on a payload-free command are discarded, not forwarded', () => {
  assert.deepEqual(parseInbound({ kind: 'stop', taskId: '../../etc/passwd' }), { kind: 'stop' });
});

test('an objective is trimmed, and an empty one is not a task', () => {
  assert.deepEqual(parseInbound({ kind: 'start', objective: '  add tests  ' }), {
    kind: 'start',
    objective: 'add tests',
    model: null,
  });
  assert.equal(parseInbound({ kind: 'start', objective: '   ' }), null);
  assert.equal(parseInbound({ kind: 'start', objective: '' }), null);
  assert.equal(parseInbound({ kind: 'start' }), null);
  assert.equal(parseInbound({ kind: 'start', objective: 123 }), null);
});

test('an oversized objective is dropped rather than silently truncated', () => {
  const tooLong = 'x'.repeat(MAX_OBJECTIVE_CHARS + 1);
  assert.equal(parseInbound({ kind: 'start', objective: tooLong }), null);

  const atLimit = 'x'.repeat(MAX_OBJECTIVE_CHARS);
  const parsed = parseInbound({ kind: 'start', objective: atLimit });
  assert.ok(parsed !== null && parsed.kind === 'start');
  assert.equal(parsed.objective.length, MAX_OBJECTIVE_CHARS);
});

test('a well-formed model reference survives, and a malformed one becomes null', () => {
  const ok = parseInbound({
    kind: 'start',
    objective: 'o',
    model: { providerId: 'anthropic', modelId: 'claude-x' },
  });
  assert.ok(ok !== null && ok.kind === 'start');
  assert.deepEqual(ok.model, { providerId: 'anthropic', modelId: 'claude-x' });

  for (const model of [
    { providerId: 'anthropic' },
    { modelId: 'claude-x' },
    { providerId: '', modelId: 'x' },
    { providerId: 1, modelId: 2 },
    'anthropic/claude',
    [],
  ]) {
    const parsed = parseInbound({ kind: 'start', objective: 'o', model });
    assert.ok(parsed !== null && parsed.kind === 'start');
    assert.equal(parsed.model, null, `accepted ${JSON.stringify(model)}`);
  }
});

test('a file path is required, bounded, and otherwise passed through untouched', () => {
  assert.deepEqual(parseInbound({ kind: 'openFile', path: 'src/auth.ts' }), {
    kind: 'openFile',
    path: 'src/auth.ts',
  });
  assert.deepEqual(parseInbound({ kind: 'openChange', path: 'src/a.ts' }), {
    kind: 'openChange',
    path: 'src/a.ts',
  });
  assert.equal(parseInbound({ kind: 'openFile' }), null);
  assert.equal(parseInbound({ kind: 'openFile', path: '' }), null);
  assert.equal(parseInbound({ kind: 'openFile', path: 'x'.repeat(MAX_PATH_CHARS + 1) }), null);
});

test('a traversal path is not rejected here, because containment is the host\u2019s job', () => {
  assert.deepEqual(parseInbound({ kind: 'openFile', path: '../../etc/passwd' }), {
    kind: 'openFile',
    path: '../../etc/passwd',
  });
});

// --- the shell ---

test('the CSP forbids everything by default and admits exactly one nonced script', () => {
  const html = shell();
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-abc123'/);
  assert.ok(!/script-src [^;']*vscode-resource/.test(html), 'script-src must not allow an origin');
});

test('the shell requests no network, no images and no fonts', () => {
  const html = shell();
  assert.ok(!html.includes('connect-src'));
  assert.ok(!html.includes('img-src'));
  assert.ok(!html.includes('font-src'));
});

test('the injected nonce is applied to the script tag as well as the policy', () => {
  const html = shell({ nonce: 'n0nce-value' });
  assert.match(html, /script-src 'nonce-n0nce-value'/);
  assert.match(html, /<script nonce="n0nce-value"/);
});

test('a hostile nonce or uri cannot break out of its attribute', () => {
  const html = shell({
    nonce: '"><script>evil()</script>',
    scriptUri: '"><script>evil()</script>',
    styleUri: '"><script>evil()</script>',
    cspSource: '"><script>evil()</script>',
  });
  assert.ok(!html.includes('<script>evil()'), 'raw script tag leaked into the document');
  assert.ok(html.includes('&lt;script&gt;evil()'));
});

test('the shell contains no task content, so nothing untrusted is ever interpolated', () => {
  const html = shell();
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('[object'));
  assert.match(html, /id="timeline"[^>]*><\/main>/);
});

test('the document declares its landmarks and language for a screen reader', () => {
  const html = shell();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /role="banner"/);
  assert.match(html, /role="log"/);
  assert.match(html, /role="toolbar"/);
  assert.match(html, /aria-label="Execution timeline"/);
  assert.match(html, /aria-live="polite"/);
  assert.ok(!html.includes('aria-live="assertive"'));
});

test('the composer input has a label and its keyboard contract is stated in text', () => {
  const html = shell();
  assert.match(html, /<label class="sr-only" for="prompt">/);
  assert.match(html, /id="composer-hint"/);
  assert.match(html, /Enter to send/);
  assert.match(html, /Shift\+Enter/);
});

test('every interactive control has an accessible name', () => {
  const html = shell();
  for (const id of ['btn-stop', 'btn-resume', 'btn-retry', 'btn-switch', 'btn-send']) {
    const pattern = new RegExp(`id="${id}"[^>]*>[^<]*\\S`);
    assert.match(html, pattern, `${id} has no visible text`);
  }
  assert.match(html, /id="btn-model"[^>]*aria-label="Choose model"/);
  assert.match(html, /id="btn-attach"[^>]*aria-label="Reference a workspace file"/);
});

test('escaping covers every HTML metacharacter', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('1')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;',
  );
  assert.equal(escapeHtml('&<'), '&amp;&lt;');
});
