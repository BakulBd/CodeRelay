/**
 * Project memory.
 *
 * The file belongs to the user, so the assertions that matter most are about
 * *not* damaging it: unknown content survives a round trip, and a disabled note
 * is kept in the file while being withheld from the model.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_MEMORY,
  MEMORY_CATEGORIES,
  addNote,
  editNote,
  parseMemory,
  removeNote,
  renderForPrompt,
  renderMemory,
  setEnabled,
} from '../../src/memory/project.js';

const SAMPLE = [
  '# CodeRelay project memory',
  '',
  '## Conventions',
  '',
  '- Never import from `dist/`',
  '- ~~Use tabs~~',
  '',
  '## Commands',
  '',
  '- `make dev` starts the sandbox',
  '',
].join('\n');

test('notes are parsed with their category and enabled state', () => {
  const memory = parseMemory(SAMPLE);

  assert.deepEqual(
    memory.notes.map((n) => [n.category, n.text, n.enabled]),
    [
      ['conventions', 'Never import from `dist/`', true],
      ['conventions', 'Use tabs', false],
      ['commands', '`make dev` starts the sandbox', true],
    ],
  );
});

test('synonym headings still parse, so a hand-written file works', () => {
  const memory = parseMemory('## Gotchas\n- The build is flaky on Windows\n');
  assert.equal(memory.notes[0]?.category, 'issues');
});

test('bullets outside a known heading are not notes', () => {
  const memory = parseMemory('## Something Else\n- not a note\n');
  assert.deepEqual(memory.notes, []);
});

test('content the parser does not understand survives a round trip', () => {
  const original = [
    'Some prose the user wrote at the top.',
    '',
    '## Conventions',
    '- Keep modules small',
    '',
  ].join('\n');

  const rendered = renderMemory(parseMemory(original));
  assert.match(rendered, /Some prose the user wrote at the top\./);
  assert.match(rendered, /- Keep modules small/);
});

test('rendering omits empty sections', () => {
  const memory = addNote(EMPTY_MEMORY, 'commands', 'npm run dev');
  const rendered = renderMemory(memory);

  assert.match(rendered, /## Commands/);
  assert.ok(!rendered.includes('## Architecture'), 'empty headings make the file look maintained');
});

test('a disabled note stays in the file, struck through', () => {
  const memory = setEnabled(parseMemory('## Conventions\n- Use tabs\n'), 'mem-1', false);
  assert.match(renderMemory(memory), /- ~~Use tabs~~/);
});

test('parse and render round-trip a disabled note', () => {
  const once = renderMemory(parseMemory(SAMPLE));
  const twice = renderMemory(parseMemory(once));
  assert.equal(once, twice, 'a round trip must be stable, or the file churns on every save');
});

// --- what the model is given ----------------------------------------------

test('a disabled note is withheld from the model entirely', () => {
  const prompt = renderForPrompt(parseMemory(SAMPLE)) ?? '';

  assert.match(prompt, /Never import from/);
  assert.ok(
    !prompt.includes('Use tabs'),
    'a model given "this used to be true" will weigh it anyway',
  );
});

test('empty memory produces nothing rather than an empty section', () => {
  assert.equal(renderForPrompt(EMPTY_MEMORY), null);
  assert.equal(
    renderForPrompt(setEnabled(parseMemory('## Conventions\n- x\n'), 'mem-1', false)),
    null,
    'tokens spent communicating an absence are tokens wasted',
  );
});

test('the prompt groups notes under their headings', () => {
  const prompt = renderForPrompt(parseMemory(SAMPLE)) ?? '';
  assert.match(prompt, /Conventions:/);
  assert.match(prompt, /Commands:/);
});

// --- editing ---------------------------------------------------------------

test('adding, editing and removing keep ids dense', () => {
  let memory = addNote(EMPTY_MEMORY, 'testing', 'run npm test');
  memory = addNote(memory, 'testing', 'coverage is not enforced');
  assert.deepEqual(memory.notes.map((n) => n.id), ['mem-1', 'mem-2']);

  memory = removeNote(memory, 'mem-1');
  assert.deepEqual(memory.notes.map((n) => n.id), ['mem-1']);
  assert.equal(memory.notes[0]?.text, 'coverage is not enforced');
});

test('an empty note is never stored', () => {
  assert.deepEqual(addNote(EMPTY_MEMORY, 'testing', '   ').notes, []);
});

test('editing a note to nothing removes it', () => {
  const memory = editNote(addNote(EMPTY_MEMORY, 'testing', 'x'), 'mem-1', '  ');
  assert.deepEqual(memory.notes, []);
});

test('every category has a heading and a hint', async () => {
  const { CATEGORY_HEADINGS, CATEGORY_HINTS } = await import('../../src/memory/project.js');
  for (const category of MEMORY_CATEGORIES) {
    assert.ok(CATEGORY_HEADINGS[category].length > 0, category);
    assert.ok(CATEGORY_HINTS[category].length > 0, category);
  }
});

test('an empty file parses to empty memory rather than throwing', () => {
  assert.deepEqual(parseMemory(''), { notes: [], preamble: '' });
  assert.deepEqual(parseMemory('\n\n\n').notes, []);
});

test('the title is owned by the renderer and never duplicated', () => {
  // Regression: the parser kept the level-1 title in the preamble and the
  // renderer prepended its own, so the file gained a title on every save.
  let text = SAMPLE;
  for (let i = 0; i < 5; i += 1) {
    text = renderMemory(parseMemory(text));
  }
  assert.equal(
    (text.match(/^# CodeRelay project memory$/gm) ?? []).length,
    1,
    'a file that grows every time it is saved is a file that will be deleted',
  );
});
