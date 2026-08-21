/**
 * Webview escaping.
 *
 * Ledger details contain tool arguments and model output, so this view renders
 * untrusted text. A missed escape here would turn a hostile file path into
 * script execution inside the extension host's webview.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimelineRow } from '../../src/ui/timeline.js';
import { escapeHtml, renderTimelineHtml } from '../../src/ui/webview.js';

const row = (over: Partial<TimelineRow> = {}): TimelineRow => ({
  seq: 0,
  at: '2026-01-01T00:00:00.000Z',
  type: 'TASK_STARTED',
  detail: 'ok',
  tone: 'normal',
  ...over,
});

const vm = (over: Partial<Parameters<typeof renderTimelineHtml>[0]> = {}) => ({
  title: 'CodeRelay Timeline',
  objective: null,
  rows: [row()],
  nonce: 'abc123',
  ...over,
});

test('every HTML metacharacter is escaped', () => {
  assert.equal(
    escapeHtml(`<script>alert("x" & 'y')</script>`),
    '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;',
  );
});

test('ampersands are escaped first, so escapes are not double-encoded wrongly', () => {
  // If & were escaped last, '<' would become '&amp;lt;' and render as text.
  assert.equal(escapeHtml('&<'), '&amp;&lt;');
});

test('a hostile detail cannot inject markup', () => {
  const html = renderTimelineHtml(
    vm({ rows: [row({ detail: '<img src=x onerror="alert(1)">' })] }),
  );

  assert.ok(!html.includes('<img'), 'raw tag leaked into the document');
  assert.ok(!html.includes('onerror="'), 'raw attribute leaked into the document');
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
});

test('a hostile objective cannot inject markup', () => {
  const html = renderTimelineHtml(vm({ objective: '</p><script>evil()</script>' }));
  assert.ok(!html.includes('<script>'));
});

test('a hostile title cannot break out of the title element', () => {
  const html = renderTimelineHtml(vm({ title: '</title><script>evil()</script>' }));
  assert.ok(!html.includes('<script>'));
});

test('the CSP forbids scripts outright and allows only the nonced stylesheet', () => {
  const html = renderTimelineHtml(vm());
  assert.match(html, /default-src 'none'/);
  assert.match(html, /style-src 'nonce-abc123'/);
  // A static view has no reason to permit script execution at all.
  assert.ok(!html.includes('script-src'), 'no script source should be allowed');
});

test('an inference is labelled in text, not only by colour', () => {
  const html = renderTimelineHtml(vm({ rows: [row({ tone: 'inferred', type: 'TOOL_RECONCILED' })] }));
  assert.match(html, /Inferred by recovery/);
  assert.match(html, /class="tone-inferred"/);
});

test('an empty ledger says so instead of rendering an empty table', () => {
  const html = renderTimelineHtml(vm({ rows: [] }));
  assert.ok(!html.includes('<table'));
  assert.match(html, /No entries recorded/);
});

test('the table is captioned and uses header scopes for accessibility', () => {
  const html = renderTimelineHtml(vm());
  assert.match(html, /<caption>/);
  assert.match(html, /scope="col"/);
  assert.match(html, /scope="row"/);
  assert.match(html, /<html lang="en">/);
});

test('no objective paragraph is emitted when there is no objective', () => {
  assert.ok(!renderTimelineHtml(vm({ objective: null })).includes('Objective:'));
  assert.ok(renderTimelineHtml(vm({ objective: 'add pagination' })).includes('Objective:'));
});
