/**
 * Running several endpoints at once for a single turn, and keeping exactly one.
 *
 * This is the executor for `planHedge`. The policy says *which* endpoints and
 * *when*; this runs them, picks the first usable answer, and makes sure every
 * other attempt is stopped before it can matter.
 *
 * ## What is being raced
 *
 * Proposals, never effects. A leg produces text plus a list of tool calls the
 * model *would like* executed; it does not execute them. The winner's proposal
 * is handed back to the loop, which commits it through the one `ToolRunner` as
 * it always has. Losers are aborted and discarded. See `policy/hedge.ts` for
 * why that keeps every exactly-once guarantee intact — this file is the half
 * that has to actually deliver on it, which is why aborting losers happens in a
 * `finally` and not on the happy path.
 *
 * ## The rule that makes it useful
 *
 * "One failure collects another." A leg that fails does **not** end the race.
 * It does two things instead: it releases its slot, and it pulls the next
 * unstarted leg forward to *now* rather than leaving it to wait out a hedge
 * delay that was calculated on the assumption the primary was merely slow. A
 * primary that dies at 300ms should not leave the task idle until the 8s hedge
 * timer fires.
 *
 * The race ends when a leg succeeds, when every leg has failed, or when the
 * caller cancels — and in the all-failed case it returns *every* failure, not
 * just the last. The router needs the whole set to decide what to do next, and
 * a user looking at the timeline needs to see that three providers were tried,
 * not one.
 *
 * ## Determinism
 *
 * Timers and abort controllers are injected. A concurrency feature tested with
 * real `setTimeout` is a concurrency feature tested with a stopwatch, and the
 * resulting flakiness would eventually be "fixed" by deleting the test.
 */

/** Identifies a leg to the caller. Opaque here; the loop puts a model in it. */
export interface RaceLeg<T> {
  readonly id: string;
  readonly startAfterMs: number;
  readonly payload: T;
}

/** What running one leg produced. */
export type LegOutcome<R, F> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly failure: F };

/** A failure paired with the leg that produced it. */
export interface LegFailure<T, F> {
  readonly leg: RaceLeg<T>;
  readonly failure: F;
}

export type RaceOutcome<T, R, F> =
  /** One leg produced a usable proposal. Every other leg has been aborted. */
  | {
      readonly kind: 'won';
      readonly leg: RaceLeg<T>;
      readonly value: R;
      /** Legs that had already failed when the winner landed. Possibly empty. */
      readonly alsoFailed: readonly LegFailure<T, F>[];
      /** Legs that were aborted mid-flight because the winner landed first. */
      readonly aborted: readonly RaceLeg<T>[];
    }
  /** Every leg failed. The router decides what happens next. */
  | {
      readonly kind: 'exhausted';
      readonly failures: readonly LegFailure<T, F>[];
    }
  /** The caller's signal fired. Not a failure; nobody is at fault. */
  | {
      readonly kind: 'cancelled';
      readonly failures: readonly LegFailure<T, F>[];
    }
  /** The plan had no legs at all — every candidate was refused upstream. */
  | { readonly kind: 'empty' };

/** A cancellable delay. Returns a function that cancels the pending callback. */
export type Timer = (ms: number, fn: () => void) => () => void;

export interface RaceDeps<T, R, F> {
  /**
   * Runs one leg to completion.
   *
   * Must settle when `signal` aborts — a runner that ignores its signal turns
   * every losing leg into a leaked request that keeps streaming tokens after
   * the turn is over. The transport already honours this.
   *
   * Rejections are not caught here on purpose: a thrown exception from a runner
   * is a bug in the runner, not a provider failure, and swallowing it into
   * `exhausted` would present a programming error as an outage. The caller
   * wraps its own errors into `{ ok: false, failure }`.
   */
  readonly run: (leg: RaceLeg<T>, signal: AbortSignal) => Promise<LegOutcome<R, F>>;
  /** Injected so scheduling is deterministic under test. */
  readonly timer: Timer;
  /**
   * Called when a leg is aborted without producing an outcome.
   *
   * This is how the breaker's half-open probe slot gets released: an aborted
   * probe is not evidence the endpoint is unwell, but leaving `probeInFlight`
   * set would eject a healthy endpoint permanently.
   */
  readonly onAbandoned?: (leg: RaceLeg<T>) => void;
  /** Notified as legs start, so the timeline can show a hedge being engaged. */
  readonly onLegStarted?: (leg: RaceLeg<T>) => void;
}

/**
 * Run legs concurrently and keep the first usable result.
 *
 * The implementation is a small state machine rather than `Promise.race`,
 * because `Promise.race` settles on the first *settled* promise — including a
 * rejection — which would end the race on the first failure. What is wanted is
 * the first *success*, with failures accumulating.
 */
export async function race<T, R, F>(
  legs: readonly RaceLeg<T>[],
  deps: RaceDeps<T, R, F>,
  signal?: AbortSignal,
): Promise<RaceOutcome<T, R, F>> {
  if (legs.length === 0) {
    return { kind: 'empty' };
  }

  const ordered = [...legs].sort((a, b) => a.startAfterMs - b.startAfterMs);
  const failures: LegFailure<T, F>[] = [];
  const aborted: RaceLeg<T>[] = [];

  // Controllers for legs that are currently in flight, so a winner can stop
  // them. Keyed by leg id, removed as each settles.
  const inFlight = new Map<string, AbortController>();
  // Cancel functions for legs that are scheduled but not yet started.
  const pending = new Map<string, () => void>();

  let settled = false;
  let resolveOuter!: (outcome: RaceOutcome<T, R, F>) => void;
  let rejectOuter!: (error: unknown) => void;
  const outcome = new Promise<RaceOutcome<T, R, F>>((resolve, reject) => {
    resolveOuter = resolve;
    rejectOuter = reject;
  });

  // How many legs have neither started nor been cancelled, plus how many are
  // still running. The race is exhausted when both reach zero.
  let notYetStarted = ordered.length;
  let running = 0;

  const stopEverything = (): void => {
    for (const cancel of pending.values()) {
      cancel();
    }
    pending.clear();
    for (const [id, controller] of inFlight) {
      const leg = ordered.find((candidate) => candidate.id === id);
      if (leg !== undefined) {
        aborted.push(leg);
        deps.onAbandoned?.(leg);
      }
      controller.abort();
    }
    inFlight.clear();
  };

  /**
   * Settle the race.
   *
   * Takes a builder rather than a value because `stopEverything` is what
   * discovers which legs were aborted, and a winner's outcome has to report
   * them — building the result first would always report an empty list.
   */
  const finish = (build: () => RaceOutcome<T, R, F>): void => {
    if (settled) {
      return;
    }
    settled = true;
    stopEverything();
    resolveOuter(build());
  };

  const onCancelled = (): void => {
    finish(() => ({ kind: 'cancelled', failures: [...failures] }));
  };

  if (signal !== undefined) {
    if (signal.aborted) {
      return { kind: 'cancelled', failures: [] };
    }
    signal.addEventListener('abort', onCancelled, { once: true });
  }

  const startLeg = (leg: RaceLeg<T>): void => {
    if (settled) {
      return;
    }
    pending.delete(leg.id);
    notYetStarted -= 1;
    running += 1;

    const controller = new AbortController();
    inFlight.set(leg.id, controller);
    deps.onLegStarted?.(leg);

    void deps.run(leg, controller.signal).then(
      (result) => {
        inFlight.delete(leg.id);
        running -= 1;
        if (settled) {
          return;
        }
        if (result.ok) {
          // The winner. `finish` aborts everything still running, which is what
          // stops a losing provider from continuing to stream. The aborted list
          // is read inside the builder, after that has happened.
          finish(() => ({
            kind: 'won',
            leg,
            value: result.value,
            alsoFailed: [...failures],
            aborted: [...aborted],
          }));
          return;
        }
        failures.push({ leg, failure: result.failure });
        // "One failure collects another": rather than waiting out the next
        // leg's hedge delay, promote it now. The delay was an estimate of how
        // long to give a *slow* primary, and the primary is not slow, it is gone.
        promoteNext();
        if (running === 0 && notYetStarted === 0) {
          finish(() => ({ kind: 'exhausted', failures: [...failures] }));
        }
      },
      (error: unknown) => {
        // A runner that throws is a bug in the runner, not a provider outage.
        // Rejecting rather than folding it into `exhausted` keeps the two
        // apart: an outage is something the router should react to, a bug is
        // something that should reach the error handler unchanged.
        inFlight.delete(leg.id);
        running -= 1;
        if (!settled) {
          settled = true;
          stopEverything();
          rejectOuter(error);
        }
      },
    );
  };

  /** Pull the earliest still-scheduled leg forward to now. */
  const promoteNext = (): void => {
    const next = ordered.find((leg) => pending.has(leg.id));
    if (next === undefined) {
      return;
    }
    const cancel = pending.get(next.id);
    cancel?.();
    pending.delete(next.id);
    startLeg(next);
  };

  for (const leg of ordered) {
    if (leg.startAfterMs <= 0) {
      startLeg(leg);
      continue;
    }
    // Registered before the timer is armed so `promoteNext` and `stopEverything`
    // can both see it, even if the timer fires synchronously in a test.
    let cancelTimer: (() => void) | null = null;
    pending.set(leg.id, () => {
      cancelTimer?.();
    });
    cancelTimer = deps.timer(leg.startAfterMs, () => {
      if (pending.has(leg.id)) {
        startLeg(leg);
      }
    });
  }

  // Every leg failed before any timer could fire — possible when all legs are
  // immediate. Checked after the loop so `running` reflects the real state.
  if (!settled && running === 0 && notYetStarted === 0) {
    finish(() => ({ kind: 'exhausted', failures: [...failures] }));
  }

  try {
    return await outcome;
  } finally {
    signal?.removeEventListener('abort', onCancelled);
  }
}

/**
 * A `Timer` over the platform clock.
 *
 * `unref` where available so a pending hedge cannot hold the extension host
 * open during shutdown. Guarded because the DOM typing of `setTimeout` does not
 * declare it and the value is a number there.
 */
export const realTimer: Timer = (ms, fn) => {
  const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
  handle.unref?.();
  return () => {
    clearTimeout(handle as unknown as Parameters<typeof clearTimeout>[0]);
  };
};
