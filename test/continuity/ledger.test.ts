/**
 * Ledger durability and parsing.
 *
 * Recovery is only as trustworthy as the file it reads, so these tests focus on
 * the properties recovery depends on: entries survive a reopen, `seq` keeps
 * ascending across processes, concurrent appends do not interleave, and a
 * crash-truncated tail is read as "that action never happened" while genuine
 * mid-file corruption is refused rather than silently skipped.
 */
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExecutionLedger, type LedgerEntryInput } from '../../src/continuity/ledger.js';
import type { TaskId } from '../../src/core/types.js';

import { ATTEMPT, STEP, TASK } from '../support/factories.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'coderelay-ledger-'));
}

/** The minimum a caller must supply; `seq` and `at` belong to the ledger. */
function draft(objective: string): LedgerEntryInput {
  return {
    taskId: TASK,
    stepId: STEP,
    attemptId: ATTEMPT,
    type: 'TASK_STARTED',
    objective,
  };
}


test('an appended entry is readable immediately and carries ledger-owned fields', async () => {
  const dir = await tempDir();
  try {
    const ledger = await ExecutionLedger.open(dir, TASK);
    const written = await ledger.append(draft('first'));

    assert.equal(written.seq, 0);
    assert.ok(Date.parse(written.at) > 0, 'at must be a parseable timestamp');

    const read = await ledger.read();
    assert.equal(read.length, 1);
    assert.equal(read[0]?.seq, 0);
    await ledger.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing ledger reads as empty rather than throwing', async () => {
  const dir = await tempDir();
  try {
    const entries = await ExecutionLedger.readEntries(join(dir, 'tasks', 'absent.jsonl'));
    assert.deepEqual(entries, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('seq continues across a reopen, so a restart cannot reuse numbers', async () => {
  const dir = await tempDir();
  try {
    const first = await ExecutionLedger.open(dir, TASK);
    await first.append(draft('a'));
    await first.append(draft('b'));
    await first.close();

    // Simulates the extension host restarting mid-task.
    const second = await ExecutionLedger.open(dir, TASK);
    const third = await second.append(draft('c'));
    assert.equal(third.seq, 2);

    const all = await second.read();
    assert.deepEqual(
      all.map((e) => e.seq),
      [0, 1, 2],
    );
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent appends serialize into whole lines with ordered seq', async () => {
  const dir = await tempDir();
  try {
    const ledger = await ExecutionLedger.open(dir, TASK);

    // Fired without awaiting: the agent loop and UI can both append.
    const written = await Promise.all(
      Array.from({ length: 50 }, (_, i) => ledger.append(draft(`entry-${i}`))),
    );

    assert.deepEqual(
      written.map((e) => e.seq),
      Array.from({ length: 50 }, (_, i) => i),
    );

    const raw = await readFile(ledger.filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 50);
    for (const line of lines) {
      // A torn or interleaved write would fail to parse here.
      JSON.parse(line);
    }

    const objectives = (await ledger.read()).map((e) =>
      e.type === 'TASK_STARTED' ? e.objective : null,
    );
    assert.equal(new Set(objectives).size, 50, 'no entry may be lost or duplicated');
    await ledger.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a torn final line is dropped, because the action it described never finished', async () => {
  const dir = await tempDir();
  try {
    const ledger = await ExecutionLedger.open(dir, TASK);
    await ledger.append(draft('complete'));
    await ledger.close();

    // A power loss during the second write leaves a half-written record.
    await appendFile(ledger.filePath, '{"type":"TOOL_EXECU', 'utf8');

    const entries = await ExecutionLedger.readEntries(ledger.filePath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.type, 'TASK_STARTED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a reopened ledger appends after a torn tail without inheriting its seq', async () => {
  const dir = await tempDir();
  try {
    const ledger = await ExecutionLedger.open(dir, TASK);
    await ledger.append(draft('complete'));
    await ledger.close();
    await appendFile(ledger.filePath, '{"seq":1,"type":"BROK', 'utf8');

    const reopened = await ExecutionLedger.open(dir, TASK);
    const next = await reopened.append(draft('after crash'));
    // The torn record is not a durable fact, so seq 1 is still free.
    assert.equal(next.seq, 1);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corruption before the end of file is reported, never silently skipped', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'corrupt.jsonl');
    await writeFile(
      file,
      ['{"seq":0,"type":"TASK_STARTED"}', 'not json at all', '{"seq":2,"type":"TASK_DONE"}'].join(
        '\n',
      ),
      'utf8',
    );

    // Skipping a middle entry could hide a TOOL_EXECUTING record, which would
    // turn a "may have run" into "never ran" and re-run the side effect.
    await assert.rejects(() => ExecutionLedger.readEntries(file), /corrupt at line 2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appending to a closed ledger fails loudly', async () => {
  const dir = await tempDir();
  try {
    const ledger = await ExecutionLedger.open(dir, TASK);
    await ledger.close();
    await assert.rejects(() => ledger.append(draft('after close')), /closed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two tasks keep separate files', async () => {
  const dir = await tempDir();
  try {
    const a = await ExecutionLedger.open(dir, 'task-a' as TaskId);
    const b = await ExecutionLedger.open(dir, 'task-b' as TaskId);
    await a.append(draft('a'));
    await b.append(draft('b'));

    assert.notEqual(a.filePath, b.filePath);
    assert.equal((await a.read()).length, 1);
    assert.equal((await b.read()).length, 1);
    await a.close();
    await b.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
