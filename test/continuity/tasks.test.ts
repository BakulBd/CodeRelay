/**
 * Task discovery. The listing is what the user sees after a crash, so the two
 * behaviours that matter are "an interrupted task is flagged" and "one broken
 * ledger does not hide the others".
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listTasks, summarizeTask } from '../../src/continuity/tasks.js';
import type { TaskId } from '../../src/core/types.js';
import { KEY, callId, history } from '../support/factories.js';

async function storage(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-tasks-'));
  await mkdir(join(dir, 'tasks'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, 'tasks', name), content, 'utf8');
  }
  return dir;
}

const jsonl = (entries: readonly unknown[]) =>
  entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

test('a missing storage directory lists nothing rather than throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-empty-'));
  try {
    assert.deepEqual(await listTasks(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interrupted task is flagged for attention and keeps its objective', async () => {
  const entries = history(
    { type: 'TASK_STARTED', objective: 'add pagination' },
    {
      type: 'TOOL_EXECUTING',
      toolCallId: callId('c1'),
      sideEffectKey: KEY,
      safety: 'idempotent',
      preState: [],
      expectedPostState: null,
    },
  );

  const dir = await storage({ 'task-1.jsonl': jsonl(entries) });
  try {
    const [task] = await listTasks(dir);
    assert.ok(task);
    assert.equal(task.taskId, 'task-1');
    assert.equal(task.objective, 'add pagination');
    assert.equal(task.lastEntryType, 'TOOL_EXECUTING');
    assert.equal(task.entryCount, 2);
    assert.equal(task.needsAttention, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a finished task is not flagged', async () => {
  const dir = await storage({
    'done.jsonl': jsonl(history({ type: 'TASK_STARTED', objective: 'x' }, { type: 'TASK_DONE' })),
  });
  try {
    const [task] = await listTasks(dir);
    assert.equal(task?.needsAttention, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an abandoned task is not flagged either', async () => {
  const dir = await storage({
    'gone.jsonl': jsonl(history({ type: 'TASK_ABANDONED', reason: 'user cancelled' })),
  });
  try {
    const [task] = await listTasks(dir);
    assert.equal(task?.needsAttention, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tasks are listed newest first', async () => {
  const dir = await storage({
    'old.jsonl': jsonl([
      { taskId: 'old', seq: 0, at: '2026-01-01T00:00:00.000Z', type: 'TASK_DONE' },
    ]),
    'new.jsonl': jsonl([
      { taskId: 'new', seq: 0, at: '2026-06-01T00:00:00.000Z', type: 'TASK_DONE' },
    ]),
  });
  try {
    assert.deepEqual(
      (await listTasks(dir)).map((t) => t.taskId),
      ['new', 'old'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('one corrupt ledger does not hide the healthy ones', async () => {
  const dir = await storage({
    // Unparseable mid-file, which readEntries treats as real corruption.
    'broken.jsonl': 'not json\n{"seq":1,"at":"2026-01-01T00:00:00.000Z","type":"TASK_DONE"}\n',
    'fine.jsonl': jsonl(history({ type: 'TASK_DONE' })),
  });
  try {
    assert.deepEqual(
      (await listTasks(dir)).map((t) => t.taskId),
      ['fine'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-ledger files in the directory are ignored', async () => {
  const dir = await storage({
    'notes.txt': 'hello',
    'task-1.jsonl': jsonl(history({ type: 'TASK_DONE' })),
  });
  try {
    assert.equal((await listTasks(dir)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty ledger reports nulls and is not flagged', () => {
  const summary = summarizeTask('t' as TaskId, '/tmp/t.jsonl', []);
  assert.equal(summary.objective, null);
  assert.equal(summary.lastEntryType, null);
  assert.equal(summary.updatedAt, null);
  assert.equal(summary.entryCount, 0);
  // Nothing was ever in flight, so there is nothing to recover.
  assert.equal(summary.needsAttention, false);
});
