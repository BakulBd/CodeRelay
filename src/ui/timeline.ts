/**
 * Turns a ledger into something a human can read.
 *
 * Deliberately free of any `vscode` import: the renderer is a pure function of
 * the entries, so the wording of every recovery decision can be asserted in
 * tests without an extension host. The webview only supplies the shell.
 */
import type { LedgerEntry } from '../continuity/entries.js';

export interface TimelineRow {
  readonly seq: number;
  readonly at: string;
  readonly type: LedgerEntry['type'];
  /** One-line description, safe to display verbatim. */
  readonly detail: string;
  /**
   * How the row should read to a user.
   * `inferred` marks conclusions CodeRelay drew rather than observed, which the
   * UI must distinguish so nobody mistakes an inference for a fact.
   */
  readonly tone: 'normal' | 'effect' | 'problem' | 'inferred' | 'terminal';
}

const MAX_DETAIL = 200;

/** Collapses whitespace and clips, so one huge entry cannot break the layout. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat;
}

function paths(state: readonly { path: string }[]): string {
  return state.length === 0 ? 'no files' : state.map((f) => f.path).join(', ');
}

export function describeEntry(e: LedgerEntry): { detail: string; tone: TimelineRow['tone'] } {
  switch (e.type) {
    case 'TASK_STARTED':
      return { detail: oneLine(e.objective), tone: 'normal' };
    case 'STREAMING':
      return { detail: `${e.model.providerId}/${e.model.modelId}`, tone: 'normal' };
    case 'STREAM_PROGRESS':
      return { detail: `${e.textSoFar.length} chars so far`, tone: 'normal' };
    case 'TOOL_REQUESTED':
      return { detail: `${e.toolName} (${e.safety})`, tone: 'normal' };
    case 'TOOL_EXECUTING':
      return {
        // Naming the ambiguity explicitly is the point: this is the entry that
        // makes a crash recoverable.
        detail: `about to touch ${paths(e.preState)}${
          e.expectedPostState === null ? ' — outcome not predictable' : ''
        }`,
        tone: 'effect',
      };
    case 'TOOL_COMPLETED':
      return {
        detail: oneLine(e.resultSummary),
        tone: e.ok ? 'effect' : 'problem',
      };
    case 'TOOL_RECONCILED':
      return { detail: `already done: ${oneLine(e.evidence)}`, tone: 'inferred' };
    case 'MODEL_RESPONSE_COMPLETED':
      return {
        detail: `${e.model.providerId}/${e.model.modelId} stopped (${e.reason})`,
        tone: e.reason === 'stop' ? 'normal' : 'problem',
      };
    case 'FAILED':
      return { detail: `${e.errorClass}: ${oneLine(e.message)}`, tone: 'problem' };
    case 'RECOVERING':
      return { detail: oneLine(e.decision), tone: 'inferred' };
    case 'PROVIDER_SWITCHED':
      return {
        detail: `${e.from.providerId}/${e.from.modelId} → ${e.to.providerId}/${e.to.modelId} (${oneLine(e.reason)})`,
        tone: 'inferred',
      };
    case 'ESCALATED':
      return { detail: oneLine(e.question), tone: 'problem' };
    case 'PLAN_PROPOSED':
      return { detail: oneLine(e.title), tone: 'normal' };
    case 'TASK_DONE':
      return { detail: 'task finished', tone: 'terminal' };
    case 'TASK_ABANDONED':
      return { detail: oneLine(e.reason), tone: 'terminal' };
  }
}

export function renderTimeline(entries: readonly LedgerEntry[]): TimelineRow[] {
  return entries.map((e) => {
    const { detail, tone } = describeEntry(e);
    return { seq: e.seq, at: e.at, type: e.type, detail, tone };
  });
}

/** Plain-text rendering, used by the "inspect ledger" command. */
export function renderTimelineText(entries: readonly LedgerEntry[]): string {
  if (entries.length === 0) {
    return 'This ledger is empty.';
  }
  return renderTimeline(entries)
    .map((r) => `${String(r.seq).padStart(4, '0')}  ${r.at}  ${r.type}  ${r.detail}`)
    .join('\n');
}
