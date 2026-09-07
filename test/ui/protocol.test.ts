/**
 * The webview boundary tests.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    'exportTaskGraph',
    'runMultiModelReview',
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

  assert.deepEqual(parseInbound({ kind: 'relayTask', targetModel: { providerId: 'anthropic', modelId: 'claude-3-5-sonnet' } }), {
    kind: 'relayTask',
    targetModel: { providerId: 'anthropic', modelId: 'claude-3-5-sonnet' },
  });

  assert.deepEqual(parseInbound({ kind: 'rollbackCheckpoint', checkpointId: 'cp_1' }), {
    kind: 'rollbackCheckpoint',
    checkpointId: 'cp_1',
  });

  assert.deepEqual(parseInbound({ kind: 'runRecoveryBenchmark', scenarioId: 'rate_limit_429' }), {
    kind: 'runRecoveryBenchmark',
    scenarioId: 'rate_limit_429',
  });

  assert.deepEqual(parseInbound({ kind: 'injectChaos', failureType: 'STREAM_CUTOFF', targetStep: 2 }), {
    kind: 'injectChaos',
    failureType: 'STREAM_CUTOFF',
    targetStep: 2,
  });

  assert.deepEqual(parseInbound({ kind: 'importTaskGraph', graphJson: '{"schemaVersion":3}' }), {
    kind: 'importTaskGraph',
    graphJson: '{"schemaVersion":3}',
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

// --- recovery panel --------------------------------------------------------
// The panel is split across three files that cannot see each other: the shell
// declares the DOM, `media/task.js` paints it, and `media/task.css` styles it.
// Nothing but these assertions stops one of them being renamed without the
// others.

test('the shell declares the recovery panel, hidden until there is something to show', () => {
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });

  assert.match(html, /id="recovery-panel"/);
  assert.match(
    html,
    /<section class="recovery-panel" id="recovery-panel"[^>]*hidden>/,
    'a task that ran cleanly must not show a recovery section at all',
  );
  assert.match(html, /id="recovery-list"[^>]*hidden/, 'the detail starts collapsed');
});

test('the recovery toggle is wired for keyboard and screen readers', () => {
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });

  // A <button> rather than a clickable div, so Enter and Space work with no
  // key handling of our own.
  assert.match(html, /<button type="button" class="recovery-toggle"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="recovery-list"/);
  assert.match(html, /<section class="recovery-panel"[^>]*aria-label="Recovery history"/);
});

test('the client and the shell agree on every recovery element id', () => {
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');

  for (const id of [
    'recovery-panel',
    'recovery-toggle',
    'recovery-summary',
    'recovery-checkpoints',
    'recovery-list',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `shell is missing #${id}`);
    assert.ok(
      client.includes(`getElementById('${id}')`),
      `task.js never looks up #${id}, so the shell declares an element nothing paints`,
    );
  }
});

test('the recovery renderer never turns provider text into markup', () => {
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');
  const start = client.indexOf('function renderRecovery(');
  assert.ok(start > 0, 'renderRecovery must exist');
  const body = client.slice(start, client.indexOf('function renderTimeline(', start));

  assert.ok(!body.includes('innerHTML'), 'a failure message comes from a provider');
  assert.ok(!body.includes('insertAdjacentHTML'));
  assert.ok(body.includes('textContent'), 'text must be assigned as text');
});

// --- verification panel ----------------------------------------------------

test('the shell declares the verification panel with both controls', () => {
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });

  assert.match(html, /id="verify-panel"/);
  assert.match(html, /id="btn-verify"/);
  assert.match(html, /id="btn-verify-stop"[^>]*hidden/, 'Stop only appears while a run is in flight');
  assert.match(html, /<section class="verify-panel" id="verify-panel"[^>]*hidden>/);
});

test('the client and the shell agree on every verification element id', () => {
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');

  for (const id of [
    'verify-panel',
    'verify-glyph',
    'verify-label',
    'verify-total',
    'verify-detail',
    'verify-list',
    'verify-unavailable',
    'btn-verify',
    'btn-verify-stop',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `shell is missing #${id}`);
    assert.ok(client.includes(`getElementById('${id}')`), `task.js never looks up #${id}`);
  }
});

test('verify and stopVerify are accepted inbound messages', () => {
  assert.deepEqual(parseInbound({ kind: 'verify' }), { kind: 'verify' });
  assert.deepEqual(parseInbound({ kind: 'stopVerify' }), { kind: 'stopVerify' });
});

test('the verification renderer never shows a tick for a run that has not happened', () => {
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');
  const start = client.indexOf('function renderVerify(');
  assert.ok(start > 0, 'renderVerify must exist');
  const body = client.slice(start, client.indexOf('function renderRecovery(', start));

  // The "not verified yet" branch is the one that must never be a tick.
  const branch = body.slice(body.indexOf('} else if (!v) {'), body.indexOf('} else {', body.indexOf('} else if (!v) {')));
  assert.ok(branch.length > 0, 'the no-run branch must exist');
  assert.ok(!branch.includes("'✓'"), 'nothing has been run, so nothing may be ticked');
  assert.match(branch, /Not verified yet/);

  assert.ok(!body.includes('innerHTML'), 'command output is untrusted text');
  assert.ok(body.includes('textContent'));
});

// --- brand mark ------------------------------------------------------------

test('the mark is monochrome and survives tinting in the Activity Bar', () => {
  const svg = readFileSync(join(process.cwd(), 'media', 'coderelay.svg'), 'utf8');

  // VS Code tints Activity Bar icons, so any literal colour would be lost or
  // wrong in some theme.
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(svg), 'no literal colour may appear in the mark');
  assert.ok(!/\b(rgb|hsl|url)\(/.test(svg), 'no gradients or external references');
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /viewBox="0 0 24 24"/);
});

test('the sidebar and the Activity Bar draw the same mark', () => {
  const svg = readFileSync(join(process.cwd(), 'media', 'coderelay.svg'), 'utf8');
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });

  // Two files drawing different logos is the kind of drift nobody notices until
  // a screenshot shows both at once.
  for (const path of svg.match(/d="[^"]+"/g) ?? []) {
    assert.ok(html.includes(path), `the shell is missing the mark's ${path}`);
  }
  assert.equal((svg.match(/<path/g) ?? []).length, 2, 'two brackets');
  assert.equal((svg.match(/<circle/g) ?? []).length, 1, 'one payload between them');
});

// --- context, requirements and why-this-model panels ----------------------
// Each panel is split across three files that cannot see each other: the shell
// declares the DOM, `media/task.js` paints it, `media/task.css` styles it.
// These assertions are the only thing stopping one being renamed without the
// others.

test('every panel element the shell declares is looked up by the client', () => {
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');

  const ids = [
    'ctx-panel', 'ctx-toggle', 'ctx-summary', 'ctx-body', 'ctx-list',
    'ctx-excluded', 'ctx-excluded-list', 'btn-ctx-rebuild', 'btn-ctx-clear',
    'req-panel', 'req-summary', 'req-list',
    'why-panel', 'why-toggle', 'why-line', 'why-body', 'why-list',
    'why-rejected', 'why-rejected-list',
  ];
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `shell is missing #${id}`);
    assert.ok(client.includes(`getElementById('${id}')`), `task.js never looks up #${id}`);
  }
});

test('panels that can be empty start hidden', () => {
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });

  for (const id of ['ctx-panel', 'req-panel', 'why-panel']) {
    const section = new RegExp(`<section[^>]*id="${id}"[^>]*hidden>`);
    assert.match(html, section, `#${id} must not reserve space before it has content`);
  }
});

test('collapsible panels are buttons with the aria wiring', () => {
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });

  for (const [toggle, body] of [
    ['ctx-toggle', 'ctx-body'],
    ['why-toggle', 'why-body'],
    ['recovery-toggle', 'recovery-list'],
  ]) {
    const pattern = new RegExp(
      `<button type="button"[^>]*id="${toggle}"[^>]*aria-expanded="false"[^>]*aria-controls="${body}"`,
    );
    assert.match(html, pattern, `${toggle} needs keyboard and screen-reader wiring`);
  }
});

test('the new renderers never turn model or provider text into markup', () => {
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');

  for (const [fn, next] of [
    ['renderContext', 'renderRequirements'],
    ['renderRequirements', 'renderVerify'],
    ['renderWhyModel', 'renderContext'],
  ]) {
    const start = client.indexOf(`function ${fn}(`);
    assert.ok(start > 0, `${fn} must exist`);
    const body = client.slice(start, client.indexOf(`function ${next}(`, start));
    assert.ok(body.length > 0, `${fn} body not found`);
    assert.ok(!body.includes('innerHTML'), `${fn} must not build markup`);
    assert.ok(body.includes('textContent'), `${fn} must assign text as text`);
  }
});

test('context actions are accepted inbound messages', () => {
  assert.deepEqual(parseInbound({ kind: 'rebuildContext' }), { kind: 'rebuildContext' });
  assert.deepEqual(parseInbound({ kind: 'clearContext' }), { kind: 'clearContext' });
});

// --- repaint guards --------------------------------------------------------

test('every repaint guard covers everything painted after it', () => {
  // A guard that returns early on a signature missing a field it then paints
  // would leave that field permanently stale. This checks the two panels whose
  // guards sit above more than just the list they key on.
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');

  const ctxStart = client.indexOf('const ctxSignature');
  assert.ok(ctxStart > 0, 'the context guard must use an explicit signature');
  const ctxSignature = client.slice(ctxStart, client.indexOf('].join', ctxStart));
  assert.match(ctxSignature, /ctx\.excluded/, 'exclusions are painted below the guard');
  assert.match(ctxSignature, /ctx\.files/);

  const verifyStart = client.indexOf('const verifySignature');
  assert.ok(verifyStart > 0, 'the verification guard must use an explicit signature');
  const verifySignature = client.slice(verifyStart, client.indexOf('].join', verifyStart));
  assert.match(verifySignature, /unavailable/, 'the not-declared line is painted below the guard');
  assert.match(verifySignature, /verdict/);
});

// --- the webview cannot be killed by a missing element ---------------------
// This exists because of a shipped bug: `media/task.js` looked up `btn-export`
// and `btn-sound`, neither of which was in the shell, then called
// `addEventListener` on the resulting `null` during initialisation. That threw,
// so *every* line after it never ran — no composer handler, no message
// listener, no `ready` post. The whole panel was inert and the extension never
// received a single message from it. It looked like "the UI does nothing".

test('every element the client looks up exists in the shell', () => {
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');

  const looked = [
    ...new Set([...client.matchAll(/getElementById\(['"]([A-Za-z0-9_-]+)['"]\)/g)].map((m) => m[1])),
  ];
  const missing = looked.filter((id) => !html.includes(`id="${id}"`));

  assert.equal(looked.length > 40, true, 'the scan must actually be finding lookups');
  assert.deepEqual(
    missing,
    [],
    'a null element throws on first use and takes the rest of the client with it',
  );
});

test('the composer is a form, so submitting it reaches the client', () => {
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');

  // The client listens for `submit` on #composer. A <section> never fires one.
  assert.match(html, /<form class="workspace-composer" id="composer"/);
  assert.match(client, /el\.composer\.addEventListener\('submit'/);
});

test('the client posts ready, which only happens if initialisation completed', () => {
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');
  const ready = client.lastIndexOf("post({ kind: 'ready' })");
  assert.ok(ready > 0, 'the client must announce itself to the host');

  // Every unguarded `addEventListener` on a looked-up element sits above this
  // line, so a throw anywhere in that region means the host never hears from
  // the panel at all. Nothing here can prove the whole file is safe, but the
  // element test above proves no lookup is null.
  assert.ok(
    client.slice(ready).trim().length < 200,
    'ready must be the last thing initialisation does',
  );
});

// --- credential pool panel -------------------------------------------------

test('the key pool panel exists and starts hidden', () => {
  const html = renderShell({ nonce: 'n0nce', cspSource: 'vscode-webview:', scriptUri: 's', styleUri: 'c' });

  assert.match(html, /<section class="keypool" id="keypool"[^>]*hidden>/);
  for (const id of ['keypool-summary', 'keypool-blocked', 'keypool-list', 'btn-key-add']) {
    assert.ok(html.includes(`id="${id}"`), `shell is missing #${id}`);
  }
});

test('key actions are validated, and a forged id is rejected', () => {
  assert.deepEqual(parseInbound({ kind: 'keyPromote', credentialId: 'cred-1' }), {
    kind: 'keyPromote',
    credentialId: 'cred-1',
  });
  assert.deepEqual(parseInbound({ kind: 'keyToggle', credentialId: 'cred-1', enabled: true }), {
    kind: 'keyToggle',
    credentialId: 'cred-1',
    enabled: true,
  });

  // Ids are minted by the host; anything else is a frame inventing one.
  assert.equal(parseInbound({ kind: 'keyRemove', credentialId: '../../etc/passwd' }), null);
  assert.equal(parseInbound({ kind: 'keyRemove', credentialId: '' }), null);
  assert.equal(parseInbound({ kind: 'keyRemove', credentialId: 'a'.repeat(500) }), null);
  assert.equal(parseInbound({ kind: 'keyRemove' }), null);
});

test('an absent enabled flag is treated as off, never as on', () => {
  const parsed = parseInbound({ kind: 'keyToggle', credentialId: 'cred-1' });
  assert.deepEqual(parsed, { kind: 'keyToggle', credentialId: 'cred-1', enabled: false });
});

test('the key pool renderer never puts key material into markup', () => {
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');
  const start = client.indexOf('function renderKeyPool(');
  assert.ok(start > 0, 'renderKeyPool must exist');
  const body = client.slice(start, client.indexOf('function renderSetup(', start));

  assert.ok(!body.includes('innerHTML'), 'a label is user text');
  assert.ok(body.includes('textContent'));
  // The view model carries no secret, and the renderer must not go looking for
  // one either.
  for (const field of ['secret', 'apiKey', 'token']) {
    assert.ok(!body.includes(`row.${field}`), `the renderer must not read row.${field}`);
  }
});
