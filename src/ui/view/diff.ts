/**
 * Reviewing a change in VS Code's own diff editor.
 *
 * The design rule this file exists to honour: never build a diff viewer when the
 * editor already has one. So CodeRelay contributes no diff rendering at all. It
 * supplies the *left-hand side* — the file as it was at a checkpoint — through a
 * read-only virtual document, and then calls `vscode.diff` with the real file on
 * the right. The user gets syntax highlighting, inline navigation, folding,
 * accessibility and every keybinding they already know, for free.
 *
 * Two properties worth stating, because both are safety-relevant:
 *
 * - **Nothing here writes.** `CheckpointStore.restore` returns bytes and touches
 *   no file, and this provider only turns those bytes into a document. Rolling
 *   back is a separate, explicit action; opening a diff must never change the
 *   workspace.
 * - **A missing file is a real answer.** `restore` returns null when the path did
 *   not exist in that snapshot, which is exactly what a diff of a *created* file
 *   needs: an empty left side. Presenting that as an error would make reviewing a
 *   new file impossible.
 */
import {
  EventEmitter,
  Uri,
  commands,
  type Event,
  type TextDocumentContentProvider,
} from 'vscode';
import type { Checkpoint, CheckpointStore } from '../../checkpoint/git.js';
import type { TaskId } from '../../core/types.js';
import { baseName } from '../state/format.js';

/**
 * Scheme for "this file, as it was at a checkpoint".
 *
 * Registered rather than using an untitled document so the editor knows the
 * content is immutable and offers no save action for it.
 */
export const CHECKPOINT_SCHEME = 'coderelay-checkpoint';

/**
 * Builds the URI naming one file inside one checkpoint.
 *
 * The commit goes in the query and the workspace-relative path in the URI path,
 * so the language for syntax highlighting is inferred from the extension exactly
 * as it would be for the real file. The path is what VS Code shows in the tab, so
 * it stays readable rather than being encoded whole.
 */
export function checkpointUri(commit: string, path: string): Uri {
  return Uri.from({
    scheme: CHECKPOINT_SCHEME,
    // Empty authority: the commit belongs in the query, where it cannot be
    // mistaken for a host by anything that parses this URI.
    path: `/${path}`,
    query: `commit=${encodeURIComponent(commit)}`,
  });
}

/** Reads back what `checkpointUri` encoded. */
export function parseCheckpointUri(uri: Uri): { commit: string; path: string } | null {
  const commit = new URLSearchParams(uri.query).get('commit');
  if (commit === null || commit === '') {
    return null;
  }
  const path = uri.path.replace(/^\/+/, '');
  if (path === '') {
    return null;
  }
  return { commit, path };
}

/**
 * Serves file contents out of a git checkpoint.
 *
 * `onDidChange` is implemented but never fired: a checkpoint is an immutable git
 * object, so its content cannot change. The emitter exists because the interface
 * asks for one, and firing it would be a lie about the underlying data.
 */
export class CheckpointContentProvider implements TextDocumentContentProvider {
  private readonly changed = new EventEmitter<Uri>();
  readonly onDidChange: Event<Uri> = this.changed.event;

  constructor(private readonly resolve: () => CheckpointStore | null) {}

  dispose(): void {
    this.changed.dispose();
  }

  async provideTextDocumentContent(uri: Uri): Promise<string> {
    const parsed = parseCheckpointUri(uri);
    if (parsed === null) {
      return '';
    }
    const store = this.resolve();
    if (store === null) {
      // Checkpoints need a git repository. Said in the document itself rather
      // than thrown, because a thrown error opens an empty tab with no
      // explanation of why the comparison is unavailable.
      return checkpointsUnavailableNotice();
    }

    // `restore` needs only the commit, so a minimal Checkpoint is sufficient and
    // avoids listing every ref to find one we already have the hash for.
    const checkpoint = {
      taskId: '' as TaskId,
      index: 0,
      ref: '',
      commit: parsed.commit,
      tree: '',
      label: '',
    } satisfies Checkpoint;

    // Null means the file did not exist in that snapshot. An empty left side is
    // the correct diff for a file this task created.
    return (await store.restore(checkpoint, parsed.path)) ?? '';
  }
}

function checkpointsUnavailableNotice(): string {
  return [
    'CodeRelay could not read this checkpoint.',
    '',
    'Checkpoints are stored as git objects, so they need a git repository with at',
    'least one commit. Without one the agent still records what it did — the',
    'execution timeline and the list of changed files are unaffected — but there is',
    'no snapshot to compare against.',
  ].join('\n');
}

/**
 * Opens the native diff between a checkpoint and the file on disk.
 *
 * The title names the file and says which side is which, because a diff tab
 * labelled only with a path leaves the reader guessing which half is the past.
 */
export async function openCheckpointDiff(
  commit: string,
  relativePath: string,
  current: Uri,
): Promise<void> {
  await commands.executeCommand(
    'vscode.diff',
    checkpointUri(commit, relativePath),
    current,
    `${baseName(relativePath)} — before CodeRelay ↔ now`,
    // Preview, so reviewing several files in a row does not fill the tab bar.
    { preview: true },
  );
}
