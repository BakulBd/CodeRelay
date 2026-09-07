/**
 * Context selection.
 *
 * ContextBench's finding is that agents over-optimise recall and under-report
 * precision, so the assertions here are mostly about restraint: what gets left
 * out, why, and whether the user could check the decision themselves.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_FILES,
  isTestFor,
  selectContext,
  summarizeContext,
  type CandidateFile,
} from '../../src/context/select.js';
import { gatherCandidates, normalisePath } from '../../src/context/gather.js';

const file = (path: string, over: Partial<CandidateFile> = {}): CandidateFile => ({
  path,
  bytes: 1_000,
  ...over,
});

const paths = (set: ReturnType<typeof selectContext>): string[] =>
  set.included.map((f) => f.path);

// --- every file names its evidence ----------------------------------------

test('every included file carries at least one reason', () => {
  const set = selectContext({
    candidates: [
      file('src/auth.ts', { changed: true }),
      file('src/ui.ts', { open: true }),
      file('package.json'),
    ],
  });

  assert.ok(set.included.length > 0);
  for (const included of set.included) {
    assert.ok(included.signals.length > 0, `${included.path} has no signal`);
    assert.ok(included.why.length > 0, `${included.path} has no reason`);
  }
});

test('a file with no signal at all is not context', () => {
  const set = selectContext({
    candidates: [file('src/unrelated.ts'), file('src/touched.ts', { changed: true })],
  });
  assert.deepEqual(paths(set), ['src/touched.ts'], 'presence in the repo is not relevance');
});

test('the reasons are the actual signals, in strength order', () => {
  const set = selectContext({
    candidates: [file('src/a.ts', { changed: true, mentioned: true, diagnostics: 2 })],
  });

  assert.deepEqual(set.included[0]?.why, [
    'you mentioned it',
    'has reported problems',
    'changed in the working tree',
  ]);
});

// --- the user's attention outranks the tool's inference -------------------

test('a mentioned file outranks everything the tool inferred', () => {
  const set = selectContext({
    candidates: [
      file('src/inferred.ts', { changed: true, diagnostics: 9, open: true }),
      file('docs/notes.md', { mentioned: true }),
    ],
  });

  assert.equal(
    paths(set)[0],
    'docs/notes.md',
    'the inference may be good, but it is still a guess about what they meant',
  );
});

test('relevance buckets follow the signal strength', () => {
  const set = selectContext({
    candidates: [
      file('a.ts', { mentioned: true }),
      file('b.ts', { changed: true }),
      file('package.json'),
    ],
  });
  const byPath = new Map(set.included.map((f) => [f.path, f.relevance]));

  assert.equal(byPath.get('a.ts'), 'high');
  assert.equal(byPath.get('b.ts'), 'medium');
  assert.equal(byPath.get('package.json'), 'low');
});

// --- exclusions are counted and explained ---------------------------------

test('generated and vendored directories are excluded with a reason and a count', () => {
  const set = selectContext({
    candidates: [
      file('src/a.ts', { changed: true }),
      file('node_modules/x/index.js', { changed: true }),
      file('node_modules/y/index.js', { changed: true }),
      file('dist/bundle.js', { changed: true }),
    ],
  });

  assert.deepEqual(paths(set), ['src/a.ts']);
  const byPattern = new Map(set.excluded.map((e) => [e.pattern, e]));
  assert.equal(byPattern.get('node_modules/')?.count, 2);
  assert.match(byPattern.get('node_modules/')?.reason ?? '', /vendored/);
  assert.equal(byPattern.get('dist/')?.count, 1);
});

test('binary files are excluded by extension', () => {
  const set = selectContext({
    candidates: [file('assets/logo.png', { mentioned: true }), file('src/a.ts', { changed: true })],
  });

  assert.deepEqual(paths(set), ['src/a.ts'], 'even a mentioned binary cannot help a model reason');
  assert.equal(set.excluded.find((e) => e.pattern === '*.png')?.reason, 'not a text file');
});

test('an oversized file is excluded and named individually', () => {
  const set = selectContext({
    candidates: [file('src/huge.ts', { changed: true, bytes: 900_000 })],
    maxFileBytes: 100_000,
  });

  assert.deepEqual(paths(set), []);
  assert.match(set.excluded[0]?.reason ?? '', /larger than 100 kB/);
  assert.equal(set.excluded[0]?.pattern, 'src/huge.ts');
});

test('user exclusions are honoured and attributed to settings', () => {
  const set = selectContext({
    candidates: [file('generated/api.ts', { changed: true }), file('src/a.ts', { changed: true })],
    extraExclusions: ['generated/'],
  });

  assert.deepEqual(paths(set), ['src/a.ts']);
  assert.match(set.excluded[0]?.reason ?? '', /your settings/);
});

// --- the cap ---------------------------------------------------------------

test('the cap keeps the strongest signals and reports what it dropped', () => {
  const candidates = [
    file('src/mentioned.ts', { mentioned: true }),
    ...Array.from({ length: 40 }, (_, i) => file(`src/changed-${i}.ts`, { changed: true })),
  ];
  const set = selectContext({ candidates, maxFiles: 5 });

  assert.equal(set.included.length, 5);
  assert.equal(paths(set)[0], 'src/mentioned.ts');
  assert.equal(set.truncated, true);
  assert.match(set.excluded.find((e) => /more files/.test(e.pattern))?.reason ?? '', /5-file limit/);
});

test('a set within the cap is not marked truncated', () => {
  const set = selectContext({ candidates: [file('a.ts', { changed: true })] });
  assert.equal(set.truncated, false);
  assert.ok(DEFAULT_MAX_FILES > 1);
});

// --- relationships ---------------------------------------------------------

test('a test whose subject is included comes along', () => {
  const set = selectContext({
    candidates: [file('src/auth.ts', { changed: true }), file('test/auth.test.ts')],
  });

  assert.ok(paths(set).includes('test/auth.test.ts'));
  assert.deepEqual(
    set.included.find((f) => f.path === 'test/auth.test.ts')?.why,
    ['tests an included file'],
  );
});

test('a test whose subject is not included stays out', () => {
  const set = selectContext({
    candidates: [file('src/auth.ts', { changed: true }), file('test/billing.test.ts')],
  });
  assert.deepEqual(paths(set), ['src/auth.ts']);
});

test('a near-miss name is not treated as a test of the subject', () => {
  // `auth.test.helper.test.ts` merely begins with the same word as `auth.ts`.
  const set = selectContext({
    candidates: [
      file('src/auth.ts', { changed: true }),
      file('test/auth.test.ts'),
      file('test/auth.test.helper.test.ts'),
    ],
  });
  assert.equal(paths(set).includes('test/auth.test.helper.test.ts'), false);
});

test('isTestFor matches conventional layouts and nothing else', () => {
  assert.equal(isTestFor('test/auth.test.ts', 'src/auth.ts'), true);
  assert.equal(isTestFor('src/auth.spec.ts', 'src/auth.ts'), true);
  assert.equal(isTestFor('test/other.test.ts', 'src/auth.ts'), false);
  assert.equal(isTestFor('src/authenticator.ts', 'src/auth.ts'), false, 'a prefix is not a subject');
});

// --- determinism and reporting --------------------------------------------

test('the same candidates always give the same set, in the same order', () => {
  const candidates = [
    file('b.ts', { changed: true }),
    file('a.ts', { changed: true }),
    file('c.ts', { changed: true }),
  ];
  assert.deepEqual(
    paths(selectContext({ candidates })),
    paths(selectContext({ candidates })),
  );
  assert.deepEqual(paths(selectContext({ candidates })), ['a.ts', 'b.ts', 'c.ts'], 'ties break by path');
});

test('the summary reports both halves of the trade, not just what was picked', () => {
  const set = selectContext({
    candidates: [
      file('src/a.ts', { changed: true, bytes: 4_000 }),
      ...Array.from({ length: 30 }, (_, i) => file(`node_modules/x${i}.js`)),
    ],
  });

  assert.equal(
    summarizeContext(set),
    '1 of 31 files · 4 kB',
    'recall on its own is the number agents over-optimise',
  );
});

test('an unknown total size is not reported as zero', () => {
  const set = selectContext({ candidates: [file('a.ts', { changed: true, bytes: null })] });
  assert.equal(set.totalBytes, null);
  assert.equal(summarizeContext(set), '1 of 1 file');
});

test('no relevant files is distinguished from no files at all', () => {
  assert.equal(summarizeContext(selectContext({ candidates: [] })), 'No files available');
  assert.equal(
    summarizeContext(selectContext({ candidates: [file('a.ts'), file('b.ts')] })),
    'No relevant files among 2',
  );
});

// --- gathering -------------------------------------------------------------

test('signals for one file are merged rather than duplicated', () => {
  const candidates = gatherCandidates({
    workspaceFiles: ['src/a.ts'],
    openPaths: ['src/a.ts'],
    diagnostics: new Map([['src/a.ts', 3]]),
    changedPaths: ['src/a.ts'],
    mentionedPaths: ['src/a.ts'],
  });

  assert.equal(candidates.length, 1, 'one file listed twice reads as a bug in the panel');
  assert.deepEqual(candidates[0], {
    path: 'src/a.ts',
    bytes: null,
    mentioned: true,
    open: true,
    diagnostics: 3,
    changed: true,
  });
});

test('paths spelled differently are the same file', () => {
  const candidates = gatherCandidates({
    workspaceFiles: ['src/a.ts'],
    openPaths: ['./src/a.ts'],
    diagnostics: new Map(),
    changedPaths: ['src\\a.ts'],
    mentionedPaths: [],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.open, true);
  assert.equal(candidates[0]?.changed, true);
});

test('a mentioned file outside the workspace listing is still considered', () => {
  const candidates = gatherCandidates({
    workspaceFiles: [],
    openPaths: [],
    diagnostics: new Map(),
    changedPaths: [],
    mentionedPaths: ['docs/spec.md'],
  });

  assert.deepEqual(candidates.map((c) => c.path), ['docs/spec.md']);
});

test('sizes are attached where known and null where not', () => {
  const candidates = gatherCandidates({
    workspaceFiles: ['a.ts', 'b.ts'],
    openPaths: [],
    diagnostics: new Map(),
    changedPaths: [],
    mentionedPaths: [],
    sizes: new Map([['a.ts', 4_096]]),
  });

  assert.equal(candidates.find((c) => c.path === 'a.ts')?.bytes, 4_096);
  assert.equal(candidates.find((c) => c.path === 'b.ts')?.bytes, null);
});

test('gathering is deterministic', () => {
  const inputs = {
    workspaceFiles: ['c.ts', 'a.ts', 'b.ts'],
    openPaths: [],
    diagnostics: new Map(),
    changedPaths: [],
    mentionedPaths: [],
  };
  assert.deepEqual(
    gatherCandidates(inputs).map((c) => c.path),
    ['a.ts', 'b.ts', 'c.ts'],
  );
});

test('gathering feeds ranking end to end', () => {
  const set = selectContext({
    candidates: gatherCandidates({
      workspaceFiles: ['src/auth.ts', 'src/unrelated.ts', 'node_modules/x.js'],
      openPaths: ['src/auth.ts'],
      diagnostics: new Map([['src/auth.ts', 2]]),
      changedPaths: [],
      mentionedPaths: [],
    }),
  });

  assert.deepEqual(paths(set), ['src/auth.ts']);
  assert.deepEqual(set.included[0]?.why, ['open in the editor', 'has reported problems']);
});

test('normalisePath is the one definition of how paths compare', () => {
  assert.equal(normalisePath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalisePath('src\\a.ts'), 'src/a.ts');
  assert.equal(normalisePath('src/a.ts'), 'src/a.ts');
});

// --- secrets never become context ------------------------------------------

test('a .env file is never included, even when the user mentions it', () => {
  const set = selectContext({
    candidates: [
      file('.env', { mentioned: true, changed: true }),
      file('src/a.ts', { changed: true }),
    ],
  });

  assert.deepEqual(
    paths(set),
    ['src/a.ts'],
    'a mention is far more likely a mistake than an intent to upload a secret',
  );
  assert.match(
    set.excluded.find((e) => e.pattern === 'secrets')?.reason ?? '',
    /credentials/i,
  );
});

test('private keys and credential files are excluded by shape', () => {
  const set = selectContext({
    candidates: [
      file('deploy/id_rsa', { mentioned: true }),
      file('certs/server.pem', { changed: true }),
      file('config/private.key', { changed: true }),
      file('credentials.json', { changed: true }),
      file('config/secrets.yaml', { changed: true }),
      file('src/ok.ts', { changed: true }),
    ],
  });

  assert.deepEqual(paths(set), ['src/ok.ts']);
  assert.equal(set.excluded.find((e) => e.pattern === 'secrets')?.count, 5);
});

test('a file merely named like code is not mistaken for a secret', () => {
  const set = selectContext({
    candidates: [
      file('src/keyboard.ts', { changed: true }),
      file('src/environment.ts', { changed: true }),
    ],
  });
  assert.equal(paths(set).length, 2, 'the patterns must not over-match ordinary source');
});
