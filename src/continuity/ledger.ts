import { open, mkdir, readFile, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LedgerEntry } from './entries.js';
import type { TaskId } from '../core/types.js';

/**
 * `Omit` applied directly to a union keeps only the keys every member shares,
 * which would silently discard every variant-specific field. Distributing over
 * the union preserves each variant.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A ledger entry as supplied by callers: everything except the fields the
 * ledger itself owns.
 */
export type LedgerEntryInput = DistributiveOmit<LedgerEntry, 'seq' | 'at'>;

/**
 * The entries that may be appended without waiting for `fsync`.
 *
 * Exactly one type qualifies, and it is named here rather than left to the
 * caller's judgement: `STREAM_PROGRESS` is the only entry no side effect is ever
 * ordered against. See `appendEventual`.
 */
export type EventualEntryInput = Extract<LedgerEntryInput, { type: 'STREAM_PROGRESS' }>;

/**
 * Append-only, crash-safe execution ledger.
 *
 * ## Why JSONL rather than SQLite
 *
 * The only write pattern we need is "append one record and know it is on
 * disk". JSONL gives that with a single `write` + `fsync`, survives partial
 * tail writes (a torn last line is simply dropped on read), and adds no native
 * dependency to the extension bundle. Anthropic's Agent SDK stores session
 * transcripts the same way (JSONL under `~/.claude/projects/`), which is some
 * evidence the shape fits the problem.
 *
 * ## The durability contract
 *
 * `append` does not resolve until the bytes are durable. Callers rely on this:
 * the agent loop must never begin a side effect before its `TOOL_EXECUTING`
 * entry has returned. Weakening this to a buffered write would silently break
 * duplicate prevention, because a crash could lose the record of an effect
 * that did happen.
 *
 * Writes are serialized through a promise chain so that concurrent `append`
 * calls cannot interleave partial lines, and so `seq` values stay ordered.
 */

/**
 * Notified after an entry is durable.
 *
 * Exists so a UI can follow a task without polling the file. The ledger is
 * already the ordered, complete, tested record of everything that happens, so
 * tailing it is strictly better than maintaining a second event stream that could
 * disagree with it.
 *
 * Called *after* the write — and, for `append`, after the `fsync` — so an observer
 * can never see an entry that is not yet on disk. It is invoked inside the append
 * chain but its result is not awaited and its failures are swallowed: a view that
 * throws must not be able to fail the durable write it was told about.
 */
export type LedgerObserver = (entry: LedgerEntry) => void;

export class ExecutionLedger {
  private handle: FileHandle | null = null;
  /** Serializes appends. Each append chains onto the previous one. */
  private tail: Promise<unknown> = Promise.resolve();
  private nextSeq = 0;
  private observer: LedgerObserver | null = null;

  private constructor(
    readonly taskId: TaskId,
    readonly filePath: string,
  ) {}

  /**
   * Opens (or creates) the ledger for a task.
   *
   * If the file already exists its entries are read first so `seq` continues
   * from where the previous process stopped.
   */
  static async open(
    storageDir: string,
    taskId: TaskId,
    options: { readonly observer?: LedgerObserver } = {},
  ): Promise<ExecutionLedger> {
    const filePath = join(storageDir, 'tasks', `${taskId}.jsonl`);
    await mkdir(dirname(filePath), { recursive: true });

    const ledger = new ExecutionLedger(taskId, filePath);
    const existing = await ExecutionLedger.readEntries(filePath);
    ledger.nextSeq = existing.length > 0 ? (existing[existing.length - 1]!.seq ?? 0) + 1 : 0;
    ledger.observer = options.observer ?? null;

    // 'a' guarantees each write lands at the current end of file, which keeps
    // appends correct even if another process holds the same file open.
    ledger.handle = await open(filePath, 'a');
    return ledger;
  }

  /**
   * Appends an entry and returns only once it is durable on disk.
   *
   * The caller supplies everything except `seq` and `at`, which the ledger
   * owns so that ordering cannot be forged by a buggy caller.
   */
  async append(entry: LedgerEntryInput): Promise<LedgerEntry> {
    return this.write(entry, true);
  }

  /**
   * Appends an entry without waiting for `fsync`.
   *
   * Restricted by its parameter type to `STREAM_PROGRESS`, which is the one
   * class of entry that nothing depends on: progress exists solely to give
   * `REGENERATE_TURN` a hint about what a lost turn was saying, and no side
   * effect is ever ordered against it. Losing the last few of them to a power
   * cut costs a hint; syncing them costs one `fsync` per few hundred characters
   * of model output, on the hot path, for a durability guarantee no reader wants.
   *
   * Ordering is unaffected — it still goes through the same append chain, so it
   * cannot overtake or interleave with a durable entry. Only the *waiting* is
   * dropped. Every entry whose absence could cause a side effect to be repeated
   * still goes through `append`, and the type signature is what keeps that
   * distinction from eroding into "whichever one the caller felt like".
   */
  async appendEventual(entry: EventualEntryInput): Promise<LedgerEntry> {
    return this.write(entry, false);
  }

  private write(entry: LedgerEntryInput, sync: boolean): Promise<LedgerEntry> {
    const handle = this.handle;
    if (!handle) {
      throw new Error('ExecutionLedger is closed');
    }

    const run = this.tail.then(async () => {
      const complete = {
        ...entry,
        seq: this.nextSeq++,
        at: new Date().toISOString(),
      } as LedgerEntry;

      await handle.write(`${JSON.stringify(complete)}\n`, null, 'utf8');
      if (sync) {
        // The whole point of this class. Without the sync, a power loss or host
        // crash can lose an entry describing an effect that already happened,
        // which is precisely the duplicate-execution bug we exist to prevent.
        await handle.sync();
      }

      // After the write, so an observer can never be told about an entry that is
      // not on disk. Guarded because a UI is not allowed to fail a durable write:
      // the append has already succeeded by this point, and reporting it as
      // failed would make the caller believe a recorded effect was not recorded.
      if (this.observer !== null) {
        try {
          this.observer(complete);
        } catch {
          // Deliberately silent. There is no channel to report this on that the
          // observer itself is not part of.
        }
      }
      return complete;
    });

    // Keep the chain alive even if this append rejects, otherwise one failure
    // would permanently wedge every later append.
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Reads all durable entries for this task. */
  async read(): Promise<LedgerEntry[]> {
    await this.tail.catch(() => undefined);
    return ExecutionLedger.readEntries(this.filePath);
  }

  async close(): Promise<void> {
    await this.tail.catch(() => undefined);
    await this.handle?.close();
    this.handle = null;
  }

  /**
   * Parses a ledger file, tolerating a torn final line.
   *
   * A crash mid-write can leave an incomplete last record. That line is
   * discarded rather than throwing: an unparseable tail means the action it
   * described never completed, so treating it as absent is the safe reading.
   * A malformed line anywhere *other* than the tail indicates real corruption
   * and is surfaced.
   */
  static async readEntries(filePath: string): Promise<LedgerEntry[]> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const entries: LedgerEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      try {
        entries.push(JSON.parse(line) as LedgerEntry);
      } catch {
        const isLast = i === lines.length - 1;
        if (isLast) {
          break; // torn tail: the described action did not complete
        }
        throw new Error(
          `Ledger ${filePath} is corrupt at line ${i + 1}: unparseable entry before end of file`,
        );
      }
    }

    return entries;
  }
}
