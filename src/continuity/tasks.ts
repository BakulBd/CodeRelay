/**
 * Discovery and summarisation of persisted tasks.
 *
 * Kept separate from the extension host so it can be tested against a plain
 * directory. The extension only supplies the storage path.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskId } from '../core/types.js';
import type { LedgerEntry, LedgerEntryType } from './entries.js';
import { ExecutionLedger } from './ledger.js';

export interface TaskSummary {
  readonly taskId: TaskId;
  readonly filePath: string;
  /** The objective from TASK_STARTED, or null if the ledger never recorded one. */
  readonly objective: string | null;
  readonly lastEntryType: LedgerEntryType | null;
  readonly entryCount: number;
  /** ISO timestamp of the newest entry, or null for an empty ledger. */
  readonly updatedAt: string | null;
  /**
   * True when the newest meaningful entry leaves work in flight, i.e. the task
   * would need recovery rather than simply being finished or abandoned.
   */
  readonly needsAttention: boolean;
}

const TERMINAL: ReadonlySet<LedgerEntryType> = new Set<LedgerEntryType>([
  'TASK_DONE',
  'TASK_ABANDONED',
]);

/** Builds a summary from already-read entries. Pure. */
export function summarizeTask(
  taskId: TaskId,
  filePath: string,
  entries: readonly LedgerEntry[],
): TaskSummary {
  const started = entries.find((e) => e.type === 'TASK_STARTED');
  const last = entries[entries.length - 1];

  return {
    taskId,
    filePath,
    objective: started?.type === 'TASK_STARTED' ? started.objective : null,
    lastEntryType: last?.type ?? null,
    entryCount: entries.length,
    updatedAt: last?.at ?? null,
    // An empty ledger has nothing to recover, so it is not flagged.
    needsAttention: last !== undefined && !TERMINAL.has(last.type),
  };
}

/**
 * Lists every task ledger under a storage directory, newest first.
 *
 * A missing directory is not an error: it just means no task has run yet.
 * A single corrupt ledger is skipped rather than failing the whole listing,
 * because one bad file must not make every other task unreachable.
 */
export async function listTasks(storageDir: string): Promise<TaskSummary[]> {
  const dir = join(storageDir, 'tasks');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const summaries: TaskSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const filePath = join(dir, name);
    const taskId = name.slice(0, -'.jsonl'.length) as TaskId;
    try {
      summaries.push(summarizeTask(taskId, filePath, await ExecutionLedger.readEntries(filePath)));
    } catch {
      continue;
    }
  }

  // Newest first. Ledgers with no entries sort last, since they say nothing.
  return summaries.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/**
 * Finds the most recent task that needs attention (i.e. was interrupted).
 */
export async function findInterruptedTask(storageDir: string): Promise<TaskSummary | null> {
  const tasks = await listTasks(storageDir);
  return tasks.find((t) => t.needsAttention) ?? null;
}
