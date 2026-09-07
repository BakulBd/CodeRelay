/**
 * The requirement tracker.
 *
 * The point of this module is to refuse the obvious shortcut — asking the model
 * whether it is done — so most of these tests assert that a requirement does
 * *not* advance without evidence. A checklist that ticks itself is the failure
 * mode, not a missing feature.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessRequirements,
  parseRequirements,
  pathsIn,
  type Evidence,
} from '../../src/plan/requirements.js';

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  changedFiles: [],
  ...over,
});

const PASSED = { verdict: 'verified', failedChecks: [] } as const;
const FAILED = { verdict: 'failed', failedChecks: [{ id: 'test', status: 'failed' }] } as const;

// --- parsing ---------------------------------------------------------------

test('task-list items are requirements wherever they appear', () => {
  const reqs = parseRequirements([
    '# Plan',
    'Some prose that is not a requirement.',
    '- [ ] Login works',
    '- [x] Session persists',
  ].join('\n'));

  assert.deepEqual(reqs.map((r) => r.text), ['Login works', 'Session persists']);
});

test('plain bullets count only under a requirements heading', () => {
  const reqs = parseRequirements([
    '## Approach',
    '- Refactor the router',
    '## Requirements',
    '- Logout implemented',
    '- Protected routes',
    '## Risks',
    '- Might break sessions',
  ].join('\n'));

  assert.deepEqual(reqs.map((r) => r.text), ['Logout implemented', 'Protected routes']);
});

test('acceptance criteria headings count too', () => {
  const reqs = parseRequirements('## Acceptance criteria\n- It compiles\n');
  assert.deepEqual(reqs.map((r) => r.text), ['It compiles']);
});

test('free prose is never guessed at', () => {
  const reqs = parseRequirements(
    'The system must support logout. Sessions should persist across reloads.',
  );
  assert.deepEqual(reqs, [], 'a checklist the user never agreed to would still be trusted');
});

test('markdown emphasis and code ticks are stripped', () => {
  const reqs = parseRequirements('- [ ] Add **validation** to `src/auth.ts`');
  assert.equal(reqs[0]?.text, 'Add validation to src/auth.ts');
});

test('duplicates are collapsed', () => {
  const reqs = parseRequirements('- [ ] Login works\n- [ ] login works\n');
  assert.equal(reqs.length, 1);
});

test('requirements get stable ids in order', () => {
  const reqs = parseRequirements('- [ ] One\n- [ ] Two\n');
  assert.deepEqual(reqs.map((r) => r.id), ['req-1', 'req-2']);
});

// --- path extraction -------------------------------------------------------

test('paths are recognised; bare words are not', () => {
  assert.deepEqual(pathsIn('Add validation to src/auth.ts'), ['src/auth.ts']);
  assert.deepEqual(pathsIn('Login works'), [], '"login" is not a path');
  assert.deepEqual(pathsIn('Bump to version 1.2'), [], 'a decimal is not a path');
});

test('several paths in one requirement are all found', () => {
  const found = pathsIn('Wire `src/a.ts` into tests/b.test.ts');
  assert.ok(found.includes('src/a.ts'));
  assert.ok(found.includes('tests/b.test.ts'));
});

// --- assessment: the part that must not lie -------------------------------

test('with no evidence at all, everything stays open', () => {
  const reqs = parseRequirements('- [ ] Add validation to src/auth.ts');
  const report = assessRequirements(reqs, evidence());

  assert.equal(report.requirements[0]?.status, 'open');
  assert.equal(report.evidencedCount, 0);
  assert.match(report.requirements[0]?.evidence ?? '', /have changed/);
});

test('a requirement naming no file can never be linked to a change', () => {
  const reqs = parseRequirements('- [ ] Login works');
  const report = assessRequirements(
    reqs,
    evidence({ changedFiles: ['src/auth.ts'], verification: PASSED }),
  );

  assert.equal(
    report.requirements[0]?.status,
    'open',
    'a passing suite says nothing about a requirement it has no connection to',
  );
  assert.match(report.requirements[0]?.evidence ?? '', /No file was named/);
});

test('a changed file with no verification is touched, never evidenced', () => {
  const reqs = parseRequirements('- [ ] Add validation to src/auth.ts');
  const report = assessRequirements(reqs, evidence({ changedFiles: ['src/auth.ts'] }));

  assert.equal(report.requirements[0]?.status, 'touched');
  assert.equal(report.evidencedCount, 0, 'a change nobody verified is just a change');
  assert.match(report.requirements[0]?.evidence ?? '', /Nothing has verified/);
});

test('a change plus passing checks is the strongest status available', () => {
  const reqs = parseRequirements('- [ ] Add validation to src/auth.ts');
  const report = assessRequirements(
    reqs,
    evidence({ changedFiles: ['src/auth.ts'], verification: PASSED }),
  );

  assert.equal(report.requirements[0]?.status, 'evidenced');
  assert.match(
    report.requirements[0]?.evidence ?? '',
    /changed, and the project's checks passed afterwards/,
    'the wording states what was observed, not that the requirement is true',
  );
  assert.equal(report.summary, '1 of 1 backed by evidence');
});

test('failing checks mark touched requirements as failing', () => {
  const reqs = parseRequirements('- [ ] Add validation to src/auth.ts');
  const report = assessRequirements(
    reqs,
    evidence({ changedFiles: ['src/auth.ts'], verification: FAILED }),
  );

  assert.equal(report.requirements[0]?.status, 'failing');
  assert.equal(report.evidencedCount, 0);
});

test('a cancelled verification does not evidence anything', () => {
  const reqs = parseRequirements('- [ ] Add validation to src/auth.ts');
  const report = assessRequirements(
    reqs,
    evidence({
      changedFiles: ['src/auth.ts'],
      verification: { verdict: 'cancelled', failedChecks: [] },
    }),
  );

  assert.equal(report.requirements[0]?.status, 'touched');
  assert.match(report.requirements[0]?.evidence ?? '', /did not complete/);
});

test('an unverifiable project cannot evidence a requirement either', () => {
  const reqs = parseRequirements('- [ ] Add validation to src/auth.ts');
  const report = assessRequirements(
    reqs,
    evidence({
      changedFiles: ['src/auth.ts'],
      verification: { verdict: 'unverifiable', failedChecks: [] },
    }),
  );
  assert.equal(
    report.requirements[0]?.status,
    'touched',
    'a project with no checks has not had its work checked',
  );
});

// --- matching --------------------------------------------------------------

test('a plan naming a bare filename matches the real path it lives at', () => {
  const reqs = parseRequirements('- [ ] Fix auth.ts');
  const report = assessRequirements(
    reqs,
    evidence({ changedFiles: ['src/services/auth.ts'], verification: PASSED }),
  );
  assert.deepEqual(report.requirements[0]?.files, ['src/services/auth.ts']);
});

test('matching is anchored at a path boundary', () => {
  const reqs = parseRequirements('- [ ] Fix auth.ts');
  const report = assessRequirements(
    reqs,
    evidence({ changedFiles: ['src/oauth.ts'], verification: PASSED }),
  );
  assert.equal(report.requirements[0]?.status, 'open', 'auth.ts must not match oauth.ts');
});

test('several matching files are summarised rather than listed in full', () => {
  const reqs = parseRequirements('- [ ] Update src/a.ts and src/b.ts');
  const report = assessRequirements(
    reqs,
    evidence({ changedFiles: ['src/a.ts', 'src/b.ts'], verification: PASSED }),
  );
  assert.match(report.requirements[0]?.evidence ?? '', /^2 files changed/);
});

test('no requirements yields no summary rather than an empty one', () => {
  const report = assessRequirements([], evidence());
  assert.equal(report.summary, null);
  assert.equal(report.total, 0);
});

test('a similarly-named file at a different path is not a match', () => {
  const reqs = parseRequirements('- [ ] Add validation to src/auth.ts');
  const report = assessRequirements(
    reqs,
    evidence({ changedFiles: ['src/auth/auth.ts'], verification: PASSED }),
  );

  assert.equal(
    report.requirements[0]?.status,
    'open',
    'src/auth.ts and src/auth/auth.ts are different files; matching them would be a guess',
  );
});
