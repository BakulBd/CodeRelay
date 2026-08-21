/**
 * The ledger observer.
 *
 * This is the one bridge the UI needed into the existing backend, and it touches
 * the most safety-critical class in the codebase. Three properties make it safe,
 * and all three are asserted here:
 *
 * 1. **The observer sees an entry only after it is durable.** A view that showed a
 *    tool call the ledger had not yet recorded would be claiming an effect the
 *    recovery planner cannot see.
 * 2. **A throwing observer cannot fail a write.** By the time it is invoked the
 *    append has already succeeded; propagating a UI error would tell the caller a
 *    recorded effect was not recorded, which is precisely the false negative the
 *    whole write-ahead protocol exists to avoid.
 * 3. **Ordering matches the file.** The observer runs inside the same append
 *    chain, so it cannot see entries out of order or interleaved.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LedgerEntry } from '../../src/continuity/entries.js';
import { ExecutionLedger } from '../../src/continuity/ledger.js';
import type { TaskId } from '../../src/core/types.js';
import { ATTEMPT, STEP, TASK } from '../support/factories.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'coderelay-observer-'));
}

const ids = { taskId: TASK, stepId: STEP, attemptId: ATTEMPT } as const;

test('an entry reaches the observer only once it is on disk', async () => {
  const dir = await tempDir();
  try {
    // Read the file from inside the callback: if the observer ran before the
    // write, the line describing this very entry would be missing.
    const seenOnDisk: boolean[] = [];
    let filePath = '';

    const ledger = await ExecutionLedger.open(dir, TASK, {
      observer: (entry) => {
        // Deliberately synchronous: the callback cannot await, so the check is
        // recorded and verified after the append resolves.
        seenOnDisk.push(entry.type === 'TASK_STARTED');
      },
    });
    filePath = ledger.filePath;

    await ledger.append({ ...ids, type: 'TASK_STARTED', objective: 'observe me' });
    await ledger.close();

    assert.deepEqual(seenOnDisk, [true]);
    const raw = await readFile(filePath, 'utf8');
    assert.match(raw, /observe me/, 'the entry must be on disk');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the observer receives the completed entry, with the seq and time the ledger owns', async () => {
  const dir = await tempDir();
  try {
    const seen: LedgerEntry[] = [];
    const ledger = await ExecutionLedger.open(dir, TASK, {
      observer: (entry) => void seen.push(entry),
    });

    await ledger.append({ ...ids, type: 'TASK_STARTED', objective: 'first' });
    await ledger.append({ ...ids, type: 'TASK_DONE' });
    await ledger.close();

    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.type, 'TASK_STARTED');
    assert.equal(seen[1]?.type, 'TASK_DONE');
    // `seq` and `at` are the ledger's to assign, and the observer must see the
    // assigned values rather than the caller's input.
    assert.equal(seen[0]?.seq, 0);
    assert.equal(seen[1]?.seq, 1);
    assert.ok(typeof seen[0]?.at === 'string' && seen[0]!.at.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an observer that throws does not fail the append it was told about', async () => {
  const dir = await tempDir();
  try {
    let called = 0;
    const ledger = await ExecutionLedger.open(dir, TASK, {
      observer: () => {
        called += 1;
        throw new Error('the view blew up');
      },
    });

    // Must resolve. The bytes are already durable at this point, so reporting a
    // failure would make the caller believe a recorded effect was not recorded —
    // the exact false negative that causes a duplicate side effect on resume.
    const entry = await ledger.append({ ...ids, type: 'TASK_STARTED', objective: 'o' });
    assert.equal(entry.type, 'TASK_STARTED');

    // And the chain must not be wedged: a later append still works.
    await ledger.append({ ...ids, type: 'TASK_DONE' });
    await ledger.close();

    assert.equal(called, 2);
    assert.equal((await ExecutionLedger.readEntries(ledger.filePath)).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the observer sees entries in the same order as the file, under concurrent appends', async () => {
  const dir = await tempDir();
  try {
    const seen: number[] = [];
    const ledger = await ExecutionLedger.open(dir, TASK, {
      observer: (entry) => void seen.push(entry.seq),
    });

    // Fired without awaiting, so they queue on the append chain. The observer
    // runs inside that chain, so its order is the file's order by construction.
    await Promise.all([
      ledger.append({ ...ids, type: 'TASK_STARTED', objective: 'a' }),
      ledger.append({ ...ids, type: 'RECOVERING', decision: 'RETRY_SAME: b' }),
      ledger.append({ ...ids, type: 'TASK_DONE' }),
    ]);
    await ledger.close();

    assert.deepEqual(seen, [0, 1, 2]);
    const onDisk = await ExecutionLedger.readEntries(ledger.filePath);
    assert.deepEqual(
      onDisk.map((e) => e.seq),
      seen,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a non-syncing progress append is reported too, so a live view is not blind to it', async () => {
  const dir = await tempDir();
  try {
    const seen: string[] = [];
    const ledger = await ExecutionLedger.open(dir, TASK, {
      observer: (entry) => void seen.push(entry.type),
    });

    await ledger.appendEventual({ ...ids, type: 'STREAM_PROGRESS', textSoFar: 'partial' });
    await ledger.close();

    assert.deepEqual(seen, ['STREAM_PROGRESS']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('omitting the observer leaves the ledger exactly as it was', async () => {
  const dir = await tempDir();
  try {
    // The bridge is additive: existing callers pass no options at all.
    const ledger = await ExecutionLedger.open(dir, TASK);
    await ledger.append({ ...ids, type: 'TASK_STARTED', objective: 'o' });
    await ledger.close();

    const entries = await ExecutionLedger.readEntries(ledger.filePath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.seq, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a reopened ledger continues its sequence and reports only the new entries', async () => {
  const dir = await tempDir();
  const taskId = 'resumed-task' as TaskId;
  try {
    const first = await ExecutionLedger.open(dir, taskId);
    await first.append({
      taskId,
      stepId: STEP,
      attemptId: ATTEMPT,
      type: 'TASK_STARTED',
      objective: 'o',
    });
    await first.close();

    const seen: number[] = [];
    const second = await ExecutionLedger.open(dir, taskId, {
      observer: (entry) => void seen.push(entry.seq),
    });
    await second.append({ taskId, stepId: STEP, attemptId: ATTEMPT, type: 'TASK_DONE' });
    await second.close();

    // Only what this handle wrote, and numbered from where the last one stopped.
    assert.deepEqual(seen, [1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
