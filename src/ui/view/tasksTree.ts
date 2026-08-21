/**
 * The Tasks tree: every task this project has, grouped by what it needs.
 *
 * Grouped by *state* rather than listed by date, because the question a user
 * brings to this view is "is anything waiting on me?" rather than "what did I do
 * on Tuesday". The groups are ordered by how much attention they want: something
 * running, then something asking a question, then something that stopped part-way
 * and can be resumed, then history.
 *
 * Two presentation rules, both from the design brief and both load-bearing:
 *
 * - **Status is never carried by colour alone.** Every row has an icon *and* a
 *   description in words, so the state survives a colour-blind reader, a
 *   high-contrast theme and a screen reader.
 * - **Empty groups are not rendered.** A permanent "Interrupted (0)" heading
 *   trains the eye to skip the row that will one day matter.
 */
import {
  EventEmitter,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  type Event,
  type TreeDataProvider,
} from 'vscode';
import type { TaskSummary } from '../../continuity/tasks.js';
import type { TaskId } from '../../core/types.js';
import { formatRelative, oneLine } from '../state/format.js';
import { projectStatus, type TaskStatus } from '../state/project.js';
import type { TaskStore } from '../state/store.js';

/** A group heading, or a task. */
export type TaskNode =
  | { readonly kind: 'group'; readonly id: string; readonly label: string; readonly tasks: readonly TaskSummary[] }
  | { readonly kind: 'task'; readonly summary: TaskSummary; readonly status: TaskStatus };

/**
 * Icon and spoken label per status.
 *
 * The label is not decoration: it is what a screen reader announces and what a
 * user reads when the theme renders every icon in one colour. `ThemeColor` is
 * used for the icon so a high-contrast theme can override it, and never a hex
 * value that would survive a theme change it should not.
 */
const PRESENTATION: Record<TaskStatus, { icon: string; colour: string | null; label: string }> = {
  running: { icon: 'sync~spin', colour: 'charts.blue', label: 'Running' },
  awaiting: { icon: 'question', colour: 'notificationsWarningIcon.foreground', label: 'Waiting for you' },
  interrupted: { icon: 'debug-pause', colour: 'notificationsWarningIcon.foreground', label: 'Interrupted' },
  completed: { icon: 'pass', colour: 'testing.iconPassed', label: 'Completed' },
  stopped: { icon: 'circle-slash', colour: null, label: 'Stopped' },
  failed: { icon: 'error', colour: 'notificationsErrorIcon.foreground', label: 'Failed' },
  empty: { icon: 'circle-outline', colour: null, label: 'Nothing recorded' },
};

/**
 * Which group a status belongs to, and in what order the groups appear.
 *
 * Completed, stopped and failed share one group. Three separate history
 * headings would be three mostly-empty lists, and the row itself already says
 * which of the three it is.
 */
const GROUPS: readonly {
  readonly id: string;
  readonly label: string;
  readonly statuses: readonly TaskStatus[];
}[] = [
  { id: 'active', label: 'Active', statuses: ['running'] },
  { id: 'awaiting', label: 'Waiting for you', statuses: ['awaiting'] },
  { id: 'interrupted', label: 'Interrupted', statuses: ['interrupted'] },
  { id: 'recent', label: 'Recent', statuses: ['completed', 'stopped', 'failed', 'empty'] },
];

export class TasksTreeProvider implements TreeDataProvider<TaskNode> {
  private readonly changed = new EventEmitter<TaskNode | undefined>();
  readonly onDidChangeTreeData: Event<TaskNode | undefined> = this.changed.event;

  constructor(private readonly store: TaskStore) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: TaskNode): TreeItem {
    if (node.kind === 'group') {
      const item = new TreeItem(node.label, TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.id}`;
      // The count belongs in the description rather than the label so the group
      // name stays stable while the number moves.
      item.description = String(node.tasks.length);
      item.contextValue = 'coderelay.group';
      return item;
    }

    const { summary, status } = node;
    const presentation = PRESENTATION[status];
    const title = summary.objective === null ? 'Untitled task' : oneLine(summary.objective, 80);

    const item = new TreeItem(title, TreeItemCollapsibleState.None);
    item.id = `task:${summary.taskId}`;
    item.iconPath = new ThemeIcon(
      presentation.icon,
      presentation.colour === null ? undefined : new ThemeColor(presentation.colour),
    );

    // Status in words, always. Never colour alone.
    const when = formatRelative(summary.updatedAt, Date.now());
    item.description = when === null ? presentation.label : `${presentation.label} · ${when}`;

    item.tooltip = [
      title,
      `Status: ${presentation.label}`,
      `Entries: ${summary.entryCount}`,
      summary.updatedAt === null ? 'Never written' : `Last activity: ${summary.updatedAt}`,
    ].join('\n');

    // Drives `view/item/context` in the manifest, which is why the resumable and
    // awaiting cases are encoded here rather than recomputed in a `when` clause.
    const resumable = status === 'interrupted' || status === 'stopped' || status === 'failed';
    item.contextValue = `coderelay.task${resumable ? '.resumable' : ''}${
      status === 'awaiting' ? '.awaiting' : ''
    }`;

    item.command = {
      command: 'coderelay.openTask',
      title: 'Open Task',
      arguments: [summary.taskId],
    };
    return item;
  }

  getChildren(node?: TaskNode): TaskNode[] {
    if (node === undefined) {
      return this.groups();
    }
    if (node.kind === 'group') {
      return node.tasks.map((summary) => ({
        kind: 'task' as const,
        summary,
        status: this.statusOf(summary),
      }));
    }
    return [];
  }

  /** The task id a tree selection refers to, for the commands that take one. */
  static taskIdOf(node: unknown): TaskId | null {
    if (typeof node === 'string') {
      return node as TaskId;
    }
    if (typeof node === 'object' && node !== null && 'kind' in node) {
      const typed = node as TaskNode;
      return typed.kind === 'task' ? typed.summary.taskId : null;
    }
    return null;
  }

  private statusOf(summary: TaskSummary): TaskStatus {
    // The live view wins for a task this window is running: the ledger trails
    // the loop by design, so a running task's file always looks unfinished.
    if (this.store.isLive(summary.taskId)) {
      return 'running';
    }
    const cached = this.store.entriesOf(summary.taskId);
    if (cached.length > 0) {
      return projectStatus(cached, false);
    }
    // Without the entries loaded, the summary still carries enough: `listTasks`
    // computed `needsAttention` from the same terminal-entry rule.
    if (summary.lastEntryType === null) {
      return 'empty';
    }
    if (summary.lastEntryType === 'TASK_DONE') {
      return 'completed';
    }
    if (summary.lastEntryType === 'TASK_ABANDONED') {
      // Stopped and failed are indistinguishable without the entry's reason, and
      // the reason needs a read. `failed` is the conservative reading: it
      // over-reports a problem rather than hiding one, and resolves to the truth
      // as soon as the ledger is loaded.
      return 'failed';
    }
    if (summary.lastEntryType === 'ESCALATED') {
      return 'awaiting';
    }
    return summary.needsAttention ? 'interrupted' : 'completed';
  }

  private groups(): TaskNode[] {
    const byStatus = new Map<TaskStatus, TaskSummary[]>();
    for (const summary of this.store.tasks) {
      const status = this.statusOf(summary);
      const bucket = byStatus.get(status);
      if (bucket === undefined) {
        byStatus.set(status, [summary]);
      } else {
        bucket.push(summary);
      }
    }

    const out: TaskNode[] = [];
    for (const group of GROUPS) {
      const tasks = group.statuses.flatMap((status) => byStatus.get(status) ?? []);
      if (tasks.length === 0) {
        // An empty heading is a row that teaches the eye to skip the place where
        // something important will eventually appear.
        continue;
      }
      out.push({ kind: 'group', id: group.id, label: group.label, tasks });
    }
    return out;
  }
}
