/**
 * The Changes tree: what this task did to the workspace.
 *
 * The list is derived from the SHA-256 fingerprints the ledger recorded before
 * and after every tool call, not from a filesystem scan. That is what makes it
 * meaningful after a crash: it reports what *this task* changed, rather than
 * everything that happens to differ from git HEAD — which would include the
 * user's own uncommitted work and turn a review list into noise.
 *
 * Clicking a row opens VS Code's own diff editor against the checkpoint taken
 * before the change. When there is no checkpoint to compare against — no git
 * repository, or a repository with no commits — the row says so and opens the
 * file instead of a diff with a misleading empty half.
 */
import {
  EventEmitter,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  type Event,
  type TreeDataProvider,
} from 'vscode';
import { shortPath } from '../state/format.js';
import type { ChangeKind, FileChange } from '../state/project.js';

import type { TaskStore } from '../state/store.js';

export interface ChangeNode {
  readonly change: FileChange;
  /** Absolute URI of the file as it is now, for the right-hand side of the diff. */
  readonly current: Uri | null;
}

/**
 * Letter, icon and word per change kind.
 *
 * The single letter matches what every source-control UI uses, so it needs no
 * learning; the word is what a screen reader says, because a lone "M" announces
 * nothing useful.
 */
const KIND: Record<ChangeKind, { letter: string; icon: string; colour: string; word: string }> = {
  added: {
    letter: 'A',
    icon: 'diff-added',
    colour: 'gitDecoration.addedResourceForeground',
    word: 'Added',
  },
  modified: {
    letter: 'M',
    icon: 'diff-modified',
    colour: 'gitDecoration.modifiedResourceForeground',
    word: 'Modified',
  },
  deleted: {
    letter: 'D',
    icon: 'diff-removed',
    colour: 'gitDecoration.deletedResourceForeground',
    word: 'Deleted',
  },
};

export class ChangesTreeProvider implements TreeDataProvider<ChangeNode> {
  private readonly changed = new EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData: Event<ChangeNode | undefined> = this.changed.event;

  constructor(
    private readonly store: TaskStore,
    private readonly workspaceRoot: () => string | null,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: ChangeNode): TreeItem {
    const { change } = node;
    const presentation = KIND[change.kind];

    const item = new TreeItem(shortPath(change.path), TreeItemCollapsibleState.None);
    item.id = `change:${change.path}`;
    item.iconPath = new ThemeIcon(presentation.icon, new ThemeColor(presentation.colour));
    item.resourceUri = node.current ?? undefined;

    // The letter is conventional shorthand; `accessibilityInformation` carries
    // the word, so nothing here depends on the reader seeing a colour or
    // recognising an abbreviation.
    const inferred = change.provenance === 'inferred';
    item.description = inferred ? `${presentation.letter} · inferred` : presentation.letter;
    item.accessibilityInformation = {
      label: inferred
        ? `${presentation.word}, inferred by recovery: ${change.path}`
        : `${presentation.word}: ${change.path}`,
    };

    item.tooltip = [
      change.path,
      `${presentation.word}${byteDelta(change)}`,
      inferred
        ? 'CodeRelay inferred this change from the workspace after an interruption; the ' +
          'tool itself never reported it.'
        : 'Recorded by the tool that made the change.',
      node.current === null ? '' : 'Click to compare with the checkpoint taken before it.',
    ]
      .filter((line) => line !== '')
      .join('\n');

    item.contextValue = 'coderelay.change';
    if (node.current !== null) {
      item.command = {
        command: 'coderelay.openChange',
        title: 'Review Change',
        arguments: [change.path],
      };
    }
    return item;
  }

  getChildren(node?: ChangeNode): ChangeNode[] {
    if (node !== undefined) {
      return [];
    }
    const taskId = this.store.selected;
    if (taskId === null) {
      return [];
    }
    const root = this.workspaceRoot();
    return this.store.project(taskId).changes.map((change) => ({
      change,
      // A deleted file has no current side to open, and a workspace-relative
      // path cannot be resolved without a root.
      current:
        root === null || change.kind === 'deleted'
          ? null
          : Uri.file(`${root}/${change.path}`),
    }));
  }
}

/** `+n bytes` / `−n bytes`, or nothing when the sizes are unknown. */
function byteDelta(change: FileChange): string {
  const before = change.bytesBefore;
  const after = change.bytesAfter;
  if (before === null && after === null) {
    return '';
  }
  if (before === null) {
    return ` · ${after} bytes`;
  }
  if (after === null) {
    return ` · was ${before} bytes`;
  }
  const delta = after - before;
  if (delta === 0) {
    return ` · ${after} bytes`;
  }
  return ` · ${after} bytes (${delta > 0 ? '+' : '\u2212'}${Math.abs(delta)})`;
}

