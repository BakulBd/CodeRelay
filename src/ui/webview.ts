/**
 * HTML for the timeline webview.
 *
 * Pure string building, kept out of `extension.ts` so the escaping can be
 * tested. Everything interpolated here originates from tool arguments and
 * provider output, i.e. untrusted text, so it is escaped without exception.
 */
import type { TimelineRow } from './timeline.js';

/** Escapes text for use in HTML element content or a quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Not cast to a wider type: keeping the `Record` exact means adding a tone
 * without labelling it is a compile error rather than a blank cell.
 */
const TONE_LABEL: Record<TimelineRow['tone'], string> = {
  normal: 'Step',
  effect: 'Side effect',
  problem: 'Problem',
  // Named in the UI, not just colour-coded, so the distinction survives for
  // screen-reader and colour-blind users.
  inferred: 'Inferred by recovery',
  terminal: 'Task ended',
};

function row(r: TimelineRow): string {
  const label = TONE_LABEL[r.tone];
  return `<tr class="tone-${escapeHtml(r.tone)}">
  <th scope="row">${r.seq}</th>
  <td><time datetime="${escapeHtml(r.at)}">${escapeHtml(r.at)}</time></td>
  <td><span class="tone-label">${escapeHtml(label)}</span> ${escapeHtml(r.type)}</td>
  <td>${escapeHtml(r.detail)}</td>
</tr>`;
}

export interface TimelineViewModel {
  readonly title: string;
  readonly objective: string | null;
  readonly rows: readonly TimelineRow[];
  /** Nonce supplied by the host so the inline stylesheet passes the CSP. */
  readonly nonce: string;
}

export function renderTimelineHtml(vm: TimelineViewModel): string {
  const body =
    vm.rows.length === 0
      ? '<p>No entries recorded for this task yet.</p>'
      : `<table>
  <caption>Execution ledger, oldest first</caption>
  <thead>
    <tr><th scope="col">#</th><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Detail</th></tr>
  </thead>
  <tbody>
${vm.rows.map(row).join('\n')}
  </tbody>
</table>`;

  // No script-src at all: this view is static, so the safest policy is to
  // forbid scripts outright rather than allow a nonce we do not need.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${escapeHtml(vm.nonce)}';">
<title>${escapeHtml(vm.title)}</title>
<style nonce="${escapeHtml(vm.nonce)}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
  table { border-collapse: collapse; width: 100%; }
  caption { text-align: left; padding-bottom: 0.5rem; }
  th, td { text-align: left; padding: 0.25rem 0.5rem; vertical-align: top;
           border-bottom: 1px solid var(--vscode-panel-border); }
  .tone-label { font-weight: 600; }
  .tone-problem .tone-label { color: var(--vscode-errorForeground); }
  .tone-inferred .tone-label { color: var(--vscode-charts-purple, var(--vscode-foreground)); }
  .tone-terminal .tone-label { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h1>${escapeHtml(vm.title)}</h1>
${vm.objective === null ? '' : `<p><strong>Objective:</strong> ${escapeHtml(vm.objective)}</p>`}
${body}
</body>
</html>`;
}
