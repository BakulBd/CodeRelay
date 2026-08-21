/**
 * The real filesystem probe.
 *
 * `planRecovery` trusts this class completely, so its contract has to hold
 * exactly: identical bytes give identical hashes, a missing file is reported as
 * absent, and anything it cannot read is an error rather than a quiet "absent".
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FileSystemProbe,
  fingerprintAll,
  predictedFingerprint,
  sha256Hex,
} from '../../src/workspace/probe.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'coderelay-probe-'));
}

test('a file is fingerprinted by content and size', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, 'a.ts'), 'hello', 'utf8');
    const got = await new FileSystemProbe(dir).fingerprint('a.ts');

    assert.equal(got.path, 'a.ts', 'the ledger path is echoed back unchanged');
    assert.equal(got.sha256, sha256Hex('hello'));
    assert.equal(got.sizeBytes, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing file is absent, which is a fact recovery can use', async () => {
  const dir = await tempDir();
  try {
    const got = await new FileSystemProbe(dir).fingerprint('nope.ts');
    assert.equal(got.sha256, null);
    assert.equal(got.sizeBytes, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a directory in place of a file counts as absent', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir, 'somedir'));
    const got = await new FileSystemProbe(dir).fingerprint('somedir');
    assert.equal(got.sha256, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('identical content in different files hashes identically', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, 'a.ts'), 'same', 'utf8');
    await writeFile(join(dir, 'b.ts'), 'same', 'utf8');
    const probe = new FileSystemProbe(dir);
    const [a, b] = await Promise.all([probe.fingerprint('a.ts'), probe.fingerprint('b.ts')]);
    assert.equal(a.sha256, b.sha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a one-byte difference changes the hash', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, 'a.ts'), 'x', 'utf8');
    const probe = new FileSystemProbe(dir);
    const before = await probe.fingerprint('a.ts');
    await writeFile(join(dir, 'a.ts'), 'y', 'utf8');
    const after = await probe.fingerprint('a.ts');
    assert.notEqual(before.sha256, after.sha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an absolute path is honoured rather than re-rooted', async () => {
  const dir = await tempDir();
  try {
    const absolute = join(dir, 'a.ts');
    await writeFile(absolute, 'hello', 'utf8');
    // Probe rooted elsewhere: the absolute path must still resolve.
    const got = await new FileSystemProbe(tmpdir()).fingerprint(absolute);
    assert.equal(got.sha256, sha256Hex('hello'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The prediction is what makes ADOPT_COMPLETED_EFFECT sound: it must agree with
// what the probe will later observe, or recovery would re-run completed writes.
test('a predicted fingerprint matches what the probe observes after the write', async () => {
  const dir = await tempDir();
  try {
    const content = 'export const x = 1;\n';
    const predicted = predictedFingerprint('a.ts', content);
    await writeFile(join(dir, 'a.ts'), content, 'utf8');

    const observed = await new FileSystemProbe(dir).fingerprint('a.ts');
    assert.deepEqual(observed, predicted);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fingerprintAll preserves the requested order', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, 'a.ts'), 'a', 'utf8');
    await writeFile(join(dir, 'b.ts'), 'b', 'utf8');

    const got = await fingerprintAll(new FileSystemProbe(dir), ['b.ts', 'a.ts', 'missing.ts']);
    assert.deepEqual(
      got.map((f) => f.path),
      ['b.ts', 'a.ts', 'missing.ts'],
    );
    assert.equal(got[2]?.sha256, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
