/**
 * The status bar item.
 *
 * One item, on the right, showing at most a word and a number. The design brief's
 * constraint — do not permanently consume excessive status-bar space — is the
 * whole design here: the label is the product name plus a state, and the detail
 * that would make it wider goes in the tooltip instead.
 *
 * Two behaviours are deliberate:
 *
 * - **It is hidden when there is nothing to say.** A task-less workspace gets no
 *   item at all rather than a permanent "CodeRelay: idle" occupying space to
 *   convey nothing. It reappears the moment a task exists.
 * - **A problem is coloured, everything else is not.** `statusBarItem.*Background`
 *   are the only two colours VS Code offers here and they are loud by design, so
 *   they are reserved for a task that needs the user. A running task is announced
 *   by a spinning icon, which is enough.
 */
import {
  MarkdownString,
  StatusBarAlignment,
  ThemeColor,
  window,
  type Disposable,
  type StatusBarItem,
} from 'vscode';
import { formatDuration, formatTokens, oneLine } from './state/format.js';
import type { TaskProjection, TaskStatus } from './state/project.js';
import type { TaskStore } from './state/store.js';

/**
 * Icon and words per state.
 *
 * `warning` marks the two states that are waiting on a person. Nothing else gets
 * a background colour, because a status bar where everything is highlighted
 * highlights nothing.
 */
const PRESENTATION: Record<
  TaskStatus,
  { icon: string; label: string; warn: boolean; error: boolean }
> = {
  running: { icon: 'sync~spin', label: 'Running', warn: false, error: false },
  awaiting: { icon: 'question', label: 'Needs you', warn: true, error: false },
  interrupted: { icon: 'debug-pause', label: 'Interrupted', warn: true, error: false },
  completed: { icon: 'check', label: 'Complete', warn: false, error: false },
  stopped: { icon: 'circle-slash', label: 'Stopped', warn: false, error: false },
  failed: { icon: 'error', label: 'Failed', warn: false, error: true },
  empty: { icon: 'circle-outline', label: '', warn: false, error: false },
};

export class StatusBar implements Disposable {
  private readonly item: StatusBarItem;

  constructor(private readonly store: TaskStore) {
    // Priority 100 keeps it left of the language and encoding indicators, which
    // is where a workspace-scoped tool belongs.
    this.item = window.createStatusBarItem('coderelay.status', StatusBarAlignment.Right, 100);
    this.item.name = 'CodeRelay';
    this.item.command = 'coderelay.focusTask';
  }

  dispose(): void {
    this.item.dispose();
  }

  /** Recomputes the item from current state. Cheap enough to call on every change. */
  update(): void {
    const taskId = this.store.selected;
    if (this.store.unavailable || taskId === null) {
      // Nothing to report: no folder, or no task ever recorded.
      this.item.hide();
      return;
    }

    const projection = this.store.project(taskId);
    const status = projection.header.status;
    if (status === 'empty') {
      this.item.hide();
      return;
    }

    const presentation = PRESENTATION[status];
    const active = this.store.activeCount;

    this.item.text = `$(${presentation.icon}) CodeRelay${
      // Only a running task earns a count, and only when more than one is running.
      active > 1 ? ` ${active}` : ''
    }${presentation.label === '' ? '' : ` · ${presentation.label}`}`;

    this.item.backgroundColor = presentation.error
      ? new ThemeColor('statusBarItem.errorBackground')
      : presentation.warn
        ? new ThemeColor('statusBarItem.warningBackground')
        : undefined;

    // The label is short; the tooltip is where the numbers go.
    this.item.tooltip = tooltipFor(projection, presentation.label);
    // Announced in words, so the state does not depend on seeing an icon.
    this.item.accessibilityInformation = {
      label: `CodeRelay: ${presentation.label}. ${oneLine(projection.header.title, 60)}`,
    };
    this.item.show();
  }
}

function tooltipFor(projection: TaskProjection, statusLabel: string): MarkdownString {
  const { header } = projection;
  const tooltip = new MarkdownString();

  // The objective is model- and user-supplied text, so it is escaped rather than
  // interpolated into markdown that could format or link.
  tooltip.appendMarkdown(`**${escapeMarkdown(oneLine(header.title, 80))}**\n\n`);
  tooltip.appendMarkdown(`${statusLabel}`);

  if (header.model !== null) {
    tooltip.appendMarkdown(
      ` on \`${escapeMarkdown(header.model.providerId)}/${escapeMarkdown(header.model.modelId)}\``,
    );
  }
  tooltip.appendMarkdown('\n\n');

  const facts: string[] = [];
  const elapsed = formatDuration(header.elapsedMs);
  if (elapsed !== null) {
    facts.push(`Elapsed: ${elapsed}`);
  }
  facts.push(`Steps: ${header.turns}`);
  if (header.filesChanged > 0) {
    facts.push(`Files changed: ${header.filesChanged}`);
  }
  // Absent rather than zero: usage is only observable on a live stream, so a
  // finished task genuinely has no count and must not claim one.
  const input = formatTokens(header.inputTokens);
  const output = formatTokens(header.outputTokens);
  if (input !== null || output !== null) {
    facts.push(`Tokens: ${input ?? '—'} in · ${output ?? '—'} out`);
  }
  tooltip.appendMarkdown(facts.map((f) => `- ${f}`).join('\n'));

  if (projection.pendingQuestion !== null) {
    tooltip.appendMarkdown(
      `\n\n**Waiting for a decision:** ${escapeMarkdown(oneLine(projection.pendingQuestion, 120))}`,
    );
  }

  tooltip.appendMarkdown('\n\nClick to open the CodeRelay task view.');
  return tooltip;
}

/** Escapes markdown control characters in untrusted text. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (match) => `\\${match}`);
}
