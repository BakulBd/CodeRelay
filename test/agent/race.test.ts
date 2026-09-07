/**
 * Concurrent legs, exactly one winner.
 *
 * Every test here drives a fake clock and resolves legs by hand, so there is no
 * sleeping and no ordering that depends on how fast the machine is. The
 * assertions that matter most are the ones about *losers*: that they are
 * aborted, that they are never returned, and that a failure does not end the
 * race. A racing failover that silently kept two winners would corrupt a
 * workspace, and that is the property this file exists to pin.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  race,
  type LegOutcome,
  type RaceLeg,
  type Timer,
} from '../../src/agent/race.js';

/** A clock whose timers only fire when the test says so. */
function fakeTimer(): {
  timer: Timer;
  fire: (ms: number) => void;
  pendingCount: () => number;
} {
  let now = 0;
  let seq = 0;
  const scheduled = new Map<number, { at: number; fn: () => void }>();

  const timer: Timer = (ms, fn) => {
    const id = seq++;
    scheduled.set(id, { at: now + ms, fn });
    return () => {
      scheduled.delete(id);
    };
  };

  return {
    timer,
    fire(ms) {
      now += ms;
      // Snapshot first: a callback may schedule more work, and mutating the map
      // while iterating it would be the kind of bug this harness should not add.
      const due = [...scheduled.entries()]
        .filter(([, entry]) => entry.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, entry] of due) {
        scheduled.delete(id);
        entry.fn();
      }
    },
    pendingCount: () => scheduled.size,
  };
}

/** A leg whose outcome the test resolves explicitly. */
function controllable(): {
  promise: Promise<LegOutcome<string, string>>;
  succeed: (value: string) => void;
  fail: (failure: string) => void;
  aborted: () => boolean;
  bind: (signal: AbortSignal) => void;
} {
  let resolve!: (outcome: LegOutcome<string, string>) => void;
  const promise = new Promise<LegOutcome<string, string>>((r) => {
    resolve = r;
  });
  let wasAborted = false;
  return {
    promise,
    succeed: (value) => resolve({ ok: true, value }),
    fail: (failure) => resolve({ ok: false, failure }),
    aborted: () => wasAborted,
    bind: (signal) => {
      if (signal.aborted) {
        wasAborted = true;
        return;
      }
      signal.addEventListener('abort', () => {
        wasAborted = true;
        // A real runner settles when aborted; this one does too, so a leaked
        // pending promise cannot make a test pass by accident.
        resolve({ ok: false, failure: 'aborted' });
      });
    },
  };
}

const leg = (id: string, startAfterMs = 0): RaceLeg<string> => ({
  id,
  startAfterMs,
  payload: id,
});

/** Lets pending microtasks drain, so `.then` handlers have run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

test('an empty plan is reported as empty rather than as a failure', async () => {
  const clock = fakeTimer();
  const outcome = await race<string, string, string>([], {
    run: async () => ({ ok: true, value: 'never' }),
    timer: clock.timer,
  });
  assert.equal(outcome.kind, 'empty');
});

test('a single leg that succeeds wins with no hedging', async () => {
  const clock = fakeTimer();
  const a = controllable();

  const promise = race<string, string, string>([leg('a')], {
    run: (_l, signal) => {
      a.bind(signal);
      return a.promise;
    },
    timer: clock.timer,
  });

  a.succeed('proposal-a');
  const outcome = await promise;

  assert.ok(outcome.kind === 'won');
  assert.equal(outcome.value, 'proposal-a');
  assert.equal(outcome.leg.id, 'a');
  assert.deepEqual(outcome.alsoFailed, []);
});

test('the hedge is not started while the primary is still within its delay', async () => {
  const clock = fakeTimer();
  const started: string[] = [];
  const a = controllable();
  const b = controllable();
  const legs = { a, b } as const;

  const promise = race<string, string, string>([leg('a'), leg('b', 5_000)], {
    run: (l, signal) => {
      started.push(l.id);
      const entry = legs[l.id as 'a' | 'b'];
      entry.bind(signal);
      return entry.promise;
    },
    timer: clock.timer,
  });

  await settle();
  assert.deepEqual(started, ['a'], 'the hedge must cost nothing when the primary is prompt');

  a.succeed('fast');
  const outcome = await promise;

  assert.ok(outcome.kind === 'won');
  assert.equal(outcome.leg.id, 'a');
  assert.equal(clock.pendingCount(), 0, 'the armed hedge timer must be cancelled');
  assert.equal(b.aborted(), false, 'a leg that never started cannot have been aborted');
});

test('a slow primary lets the hedge fire, and the hedge can win', async () => {
  const clock = fakeTimer();
  const a = controllable();
  const b = controllable();
  const legs = { a, b } as const;

  const promise = race<string, string, string>([leg('a'), leg('b', 5_000)], {
    run: (l, signal) => {
      const entry = legs[l.id as 'a' | 'b'];
      entry.bind(signal);
      return entry.promise;
    },
    timer: clock.timer,
  });

  await settle();
  clock.fire(5_000);
  await settle();

  b.succeed('hedge-won');
  const outcome = await promise;

  assert.ok(outcome.kind === 'won');
  assert.equal(outcome.leg.id, 'b');
  assert.equal(a.aborted(), true, 'the loser must be stopped, not left streaming');
  assert.deepEqual(
    outcome.aborted.map((l) => l.id),
    ['a'],
  );
});

// --- the rule the feature exists for --------------------------------------

test('a failing primary pulls the hedge forward instead of waiting out its delay', async () => {
  const clock = fakeTimer();
  const started: string[] = [];
  const a = controllable();
  const b = controllable();
  const legs = { a, b } as const;

  const promise = race<string, string, string>([leg('a'), leg('b', 30_000)], {
    run: (l, signal) => {
      started.push(l.id);
      const entry = legs[l.id as 'a' | 'b'];
      entry.bind(signal);
      return entry.promise;
    },
    timer: clock.timer,
  });

  await settle();
  assert.deepEqual(started, ['a']);

  // The primary dies immediately. Nothing advances the clock afterwards, so if
  // the hedge only ran on its timer this test would hang.
  a.fail('rate-limited');
  await settle();

  assert.deepEqual(started, ['a', 'b'], 'a dead primary must not leave the task idle');

  b.succeed('took-over');
  const outcome = await promise;

  assert.ok(outcome.kind === 'won');
  assert.equal(outcome.leg.id, 'b');
  assert.deepEqual(
    outcome.alsoFailed.map((f) => f.failure),
    ['rate-limited'],
    'the winner still reports what failed on the way, so the timeline can show it',
  );
});

test('one failure does not end the race', async () => {
  const clock = fakeTimer();
  const a = controllable();
  const b = controllable();
  const legs = { a, b } as const;

  const promise = race<string, string, string>([leg('a'), leg('b')], {
    run: (l, signal) => {
      const entry = legs[l.id as 'a' | 'b'];
      entry.bind(signal);
      return entry.promise;
    },
    timer: clock.timer,
  });

  await settle();
  a.fail('boom');
  await settle();

  b.succeed('still-fine');
  const outcome = await promise;

  assert.ok(outcome.kind === 'won', 'Promise.race semantics would have failed here');
  assert.equal(outcome.value, 'still-fine');
});

test('every leg failing reports every failure, not just the last', async () => {
  const clock = fakeTimer();
  const a = controllable();
  const b = controllable();
  const c = controllable();
  const legs = { a, b, c } as const;

  const promise = race<string, string, string>([leg('a'), leg('b'), leg('c')], {
    run: (l, signal) => {
      const entry = legs[l.id as 'a' | 'b' | 'c'];
      entry.bind(signal);
      return entry.promise;
    },
    timer: clock.timer,
  });

  await settle();
  a.fail('429');
  b.fail('500');
  c.fail('ECONNRESET');
  const outcome = await promise;

  assert.ok(outcome.kind === 'exhausted');
  assert.deepEqual(
    outcome.failures.map((f) => f.failure).sort(),
    ['429', '500', 'ECONNRESET'],
    'the router needs the whole set to decide what to do next',
  );
});

test('a staggered plan exhausts only after the last leg has run', async () => {
  const clock = fakeTimer();
  const a = controllable();
  const b = controllable();
  const legs = { a, b } as const;
  let settledEarly = false;

  const promise = race<string, string, string>([leg('a'), leg('b', 1_000)], {
    run: (l, signal) => {
      const entry = legs[l.id as 'a' | 'b'];
      entry.bind(signal);
      return entry.promise;
    },
    timer: clock.timer,
  });
  void promise.then(() => {
    settledEarly = true;
  });

  await settle();
  a.fail('down');
  await settle();

  assert.equal(settledEarly, false, 'a promoted leg is still a leg that must be awaited');

  b.fail('also-down');
  const outcome = await promise;
  assert.ok(outcome.kind === 'exhausted');
  assert.equal(outcome.failures.length, 2);
});

// --- cancellation ----------------------------------------------------------

test('an already-aborted signal produces a cancellation without starting anything', async () => {
  const clock = fakeTimer();
  const controller = new AbortController();
  controller.abort();
  let started = false;

  const outcome = await race<string, string, string>(
    [leg('a')],
    {
      run: async () => {
        started = true;
        return { ok: true, value: 'nope' };
      },
      timer: clock.timer,
    },
    controller.signal,
  );

  assert.equal(outcome.kind, 'cancelled');
  assert.equal(started, false);
});

test('cancelling mid-race stops every leg and is not reported as a failure', async () => {
  const clock = fakeTimer();
  const controller = new AbortController();
  const a = controllable();
  const b = controllable();
  const legs = { a, b } as const;

  const promise = race<string, string, string>(
    [leg('a'), leg('b')],
    {
      run: (l, signal) => {
        const entry = legs[l.id as 'a' | 'b'];
        entry.bind(signal);
        return entry.promise;
      },
      timer: clock.timer,
    },
    controller.signal,
  );

  await settle();
  controller.abort();
  const outcome = await promise;

  assert.equal(outcome.kind, 'cancelled', 'the user pressing stop is not an outage');
  assert.equal(a.aborted(), true);
  assert.equal(b.aborted(), true);
});

// --- bookkeeping the breaker depends on -----------------------------------

test('abandoned legs are reported so a probe slot can be released', async () => {
  const clock = fakeTimer();
  const abandoned: string[] = [];
  const a = controllable();
  const b = controllable();
  const legs = { a, b } as const;

  const promise = race<string, string, string>([leg('a'), leg('b')], {
    run: (l, signal) => {
      const entry = legs[l.id as 'a' | 'b'];
      entry.bind(signal);
      return entry.promise;
    },
    timer: clock.timer,
    onAbandoned: (l) => abandoned.push(l.id),
  });

  await settle();
  a.succeed('winner');
  await promise;

  assert.deepEqual(abandoned, ['b'], 'an aborted probe must not stay marked in flight forever');
});

test('a winner is final: a later success from another leg cannot replace it', async () => {
  const clock = fakeTimer();
  const a = controllable();
  const b = controllable();
  const legs = { a, b } as const;

  const promise = race<string, string, string>([leg('a'), leg('b')], {
    run: (l, signal) => {
      const entry = legs[l.id as 'a' | 'b'];
      // Deliberately not bound to the signal, so this leg ignores its abort —
      // the race must still discard it rather than committing two proposals.
      void signal;
      return entry.promise;
    },
    timer: clock.timer,
  });

  await settle();
  a.succeed('first');
  b.succeed('second');
  const outcome = await promise;

  assert.ok(outcome.kind === 'won');
  assert.equal(outcome.value, 'first', 'exactly one proposal may ever be committed');
});

test('a runner that throws rejects rather than being reported as an outage', async () => {
  const clock = fakeTimer();
  await assert.rejects(
    race<string, string, string>([leg('a')], {
      run: async () => {
        throw new Error('bug in the runner');
      },
      timer: clock.timer,
    }),
    /bug in the runner/,
  );
});
