/**
 * The single source of UI state.
 *
 * Every view — the task panel, three trees and the status bar — reads from here
 * and re-reads on one event. That is deliberate: four views each doing their own
 * disk read would disagree with each other the moment a task advanced, and four
 * independent refresh timers would be four ways to poll.
 *
 * The store owns two kinds of knowledge, and keeps them apart:
 *
 * - **What is on disk.** Task ledgers, read through `listTasks` and
 *   `ExecutionLedger.readEntries`. Authoritative for everything the agent has
 *   already done, and the only thing available for a task from a previous window.
 * - **What is happening now.** A `Runtime` per task this window is executing:
 *   the abort controller that can stop it, the model it started on, and the
 *   token usage streaming past — which is observable *only* live, because usage
 *   is deliberately never written to the ledger.
 *
 * `vscode` is imported for `EventEmitter` alone. Everything that decides what
 * the state *means* lives in `project.ts`, which has no editor dependency and is
 * therefore tested without one.
 */
import { EventEmitter, type Disposable, type Event } from 'vscode';
import { ExecutionLedger } from '../../continuity/ledger.js';
import type { LedgerEntry } from '../../continuity/entries.js';
import { listTasks, type TaskSummary } from '../../continuity/tasks.js';
import type { ModelRef, TaskId } from '../../core/types.js';
import { computeCost } from './format.js';
import { projectTask, type TaskProjection } from './project.js';

/** A task this window is executing right now. */
export interface Runtime {
  readonly taskId: TaskId;
  /** Aborts the in-flight request. The loop treats this as terminal, never as a failure. */
  readonly controller: AbortController;
  /** The model the task is currently on, updated as failover moves it. */
  model: ModelRef;
  /** Usage observed on the stream. Absent until a provider reports it. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Declared prices for the current model, so cost can be derived. */
  costPerMTokIn: number;
  costPerMTokOut: number;
  /** The newest streamed text of the turn in flight. Bounded; see `noteStreamText`. */
  streamTail: string;
  /** What the agent is doing, in a few words. Shown while nothing else has landed. */
  activity: string | null;
  startedAtMs: number;
  /**
   * Checkpoints observed being created during *this* run.
   *
   * Live-only by nature, like token usage: checkpoints are git refs rather than
   * ledger entries, so a task reopened after a reload has no runtime that
   * watched them being made. The projection then reports `null` rather than
   * `0`, because "nobody was watching" is not "none were taken".
   */
  checkpointsSeen: number;
}

/**
 * How much of the current turn's text is retained.
 *
 * The tail is what a reader needs — it is where the model is now — and keeping
 * the whole of a long turn in memory for every task would grow without bound for
 * no benefit. The ledger keeps the authoritative copy.
 */
const STREAM_TAIL_CHARS = 2_000;

export class TaskStore implements Disposable {
  private readonly changed = new EventEmitter<void>();
  /** Fired whenever anything a view displays may have changed. */
  readonly onDidChange: Event<void> = this.changed.event;

  private summaries: readonly TaskSummary[] = [];
  private readonly runtimes = new Map<TaskId, Runtime>();
  /** Entries cached per task, so four views reading at once cause one disk read. */
  private readonly entries = new Map<TaskId, readonly LedgerEntry[]>();
  private selectedId: TaskId | null = null;
  /** Coalesces bursts of ledger appends into one repaint. */
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly storageDir: string | null) {}

  dispose(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    this.changed.dispose();
  }

  /** True when there is nowhere to keep ledgers, i.e. no folder is open. */
  get unavailable(): boolean {
    return this.storageDir === null;
  }

  get tasks(): readonly TaskSummary[] {
    return this.summaries;
  }

  get activeCount(): number {
    return this.runtimes.size;
  }

  runtime(taskId: TaskId): Runtime | null {
    return this.runtimes.get(taskId) ?? null;
  }

  isLive(taskId: TaskId): boolean {
    return this.runtimes.has(taskId);
  }

  /**
   * The task the panel is showing.
   *
   * Falls back to a running task, then to the newest, so opening the view never
   * lands on nothing when there is something worth showing. A selection that no
   * longer exists is dropped rather than kept as a dangling id.
   */
  get selected(): TaskId | null {
    if (this.selectedId !== null && this.summaries.some((t) => t.taskId === this.selectedId)) {
      return this.selectedId;
    }
    const running = [...this.runtimes.keys()][0];
    if (running !== undefined) {
      return running;
    }
    return this.summaries[0]?.taskId ?? null;
  }

  select(taskId: TaskId | null): void {
    if (this.selectedId === taskId) {
      return;
    }
    this.selectedId = taskId;
    this.changed.fire();
  }

  summary(taskId: TaskId): TaskSummary | null {
    return this.summaries.find((t) => t.taskId === taskId) ?? null;
  }

  entriesOf(taskId: TaskId): readonly LedgerEntry[] {
    return this.entries.get(taskId) ?? [];
  }

  /**
   * Re-reads the ledgers from disk.
   *
   * Called on activation, after a task ends, and from the explicit refresh
   * action. Not on a timer: a running task pushes its own entries in through
   * `noteEntry`, so polling would only add latency-shaped noise.
   */
  async refresh(): Promise<void> {
    if (this.storageDir === null) {
      this.summaries = [];
      this.entries.clear();
      this.changed.fire();
      return;
    }

    this.summaries = await listTasks(this.storageDir);

    // Ledgers no longer on disk must not keep their cached entries alive: the
    // cache is the largest thing this store retains, and a deleted task holding
    // its entries for the rest of the session is a leak with a friendly name.
    const known = new Set(this.summaries.map((t) => t.taskId));
    for (const taskId of [...this.entries.keys()]) {
      if (!known.has(taskId)) {
        this.entries.delete(taskId);
      }
    }

    this.changed.fire();
  }

  /** Loads one ledger, if it has not been read yet. */
  async load(taskId: TaskId): Promise<readonly LedgerEntry[]> {
    const cached = this.entries.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    const summary = this.summary(taskId);
    if (summary === null) {
      return [];
    }
    const read = await ExecutionLedger.readEntries(summary.filePath);
    this.entries.set(taskId, read);
    return read;
  }

  /** Discards a cached ledger so the next read comes from disk. */
  invalidate(taskId: TaskId): void {
    this.entries.delete(taskId);
  }

  // --- live task lifecycle ---

  begin(runtime: Runtime): void {
    this.runtimes.set(runtime.taskId, runtime);
    this.selectedId = runtime.taskId;
    // A task that has just started has no entries worth caching from a previous
    // run, and reusing them would show the old attempt's timeline.
    this.entries.delete(runtime.taskId);
    this.changed.fire();
  }

  end(taskId: TaskId): void {
    this.runtimes.delete(taskId);
    this.changed.fire();
  }

  /**
   * Records a durable entry as it is written.
   *
   * This is the live path: the ledger notifies the store the moment an entry is
   * on disk, so the view is driven by exactly the same facts recovery would use.
   * Appending to the cached array rather than re-reading the file keeps a long
   * task from re-parsing its whole history on every step.
   */
  noteEntry(taskId: TaskId, entry: LedgerEntry): void {
    const existing = this.entries.get(taskId) ?? [];
    this.entries.set(taskId, [...existing, entry]);
    this.scheduleChange();
  }

  /** Records usage reported by a provider mid-stream. */
  noteUsage(taskId: TaskId, inputTokens: number, outputTokens: number): void {
    const runtime = this.runtimes.get(taskId);
    if (runtime === undefined) {
      return;
    }
    runtime.inputTokens = inputTokens;
    runtime.outputTokens = outputTokens;
    this.scheduleChange();
  }

  noteModel(taskId: TaskId, model: ModelRef, costIn: number, costOut: number): void {
    const runtime = this.runtimes.get(taskId);
    if (runtime === undefined) {
      return;
    }
    runtime.model = model;
    runtime.costPerMTokIn = costIn;
    runtime.costPerMTokOut = costOut;
    this.scheduleChange();
  }

  /**
   * Counts a checkpoint that was actually created.
   *
   * Only `created` outcomes reach here. A checkpoint skipped because nothing
   * had changed is not a snapshot, and counting it would inflate the one number
   * the recovery panel uses to claim work was preserved.
   */
  noteCheckpoint(taskId: TaskId): void {
    const runtime = this.runtimes.get(taskId);
    if (runtime === undefined) {
      return;
    }
    runtime.checkpointsSeen += 1;
    this.scheduleChange();
  }

  noteActivity(taskId: TaskId, activity: string | null): void {
    const runtime = this.runtimes.get(taskId);
    if (runtime === undefined) {
      return;
    }
    runtime.activity = activity;
    this.scheduleChange();
  }

  /** Accumulates streamed text, keeping only the tail. */
  noteStreamText(taskId: TaskId, delta: string): void {
    const runtime = this.runtimes.get(taskId);
    if (runtime === undefined) {
      return;
    }
    const joined = runtime.streamTail + delta;
    runtime.streamTail =
      joined.length > STREAM_TAIL_CHARS ? joined.slice(joined.length - STREAM_TAIL_CHARS) : joined;
    this.scheduleChange();
  }

  /** Clears the streamed tail at a turn boundary. */
  resetStreamText(taskId: TaskId): void {
    const runtime = this.runtimes.get(taskId);
    if (runtime !== undefined) {
      runtime.streamTail = '';
    }
  }

  // --- projection ---

  /**
   * The view model for a task, ledger and live state combined.
   *
   * The one place the two sources meet. Usage and cost come from the runtime
   * because they are not persisted; everything else comes from the ledger
   * because the ledger is what survives.
   */
  project(taskId: TaskId, now = Date.now()): TaskProjection {
    const runtime = this.runtimes.get(taskId);
    const entries = this.entriesOf(taskId);
    const cost =
      runtime === undefined || runtime.inputTokens === null
        ? null
        : computeCost(
            runtime.inputTokens,
            runtime.outputTokens ?? 0,
            runtime.costPerMTokIn,
            runtime.costPerMTokOut,
          );

    return projectTask(entries, {
      live: runtime !== undefined,
      now,
      inputTokens: runtime?.inputTokens ?? null,
      outputTokens: runtime?.outputTokens ?? null,
      costUsd: cost,
      // Live-only, so a reopened task reports null rather than a count nobody
      // was present to take.
      checkpointCount: runtime === undefined ? null : runtime.checkpointsSeen,
    });
  }

  /**
   * Fires `onDidChange` at most once per tick.
   *
   * A streaming turn produces events far faster than a person can read, and a
   * repaint per token would spend the extension host's time re-rendering frames
   * nobody sees. One frame per burst is the whole optimisation, and it is here
   * rather than in each view so no view can forget it.
   */
  private scheduleChange(): void {
    if (this.pending !== null) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = null;
      this.changed.fire();
    }, 80);
  }
}
