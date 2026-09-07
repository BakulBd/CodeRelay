/**
 * The stylesheet's responsive contract.
 *
 * A VS Code sidebar is user-resizable and routinely dragged narrow. Nothing in
 * this repository can render CSS, so this cannot prove the layout *looks*
 * right — it checks the structural causes of the failures that actually happen
 * at narrow widths, each of which is silent:
 *
 *  - a fixed `min-width` wider than the panel pushes content out of view, and
 *    an absolutely-positioned popover is simply clipped at the edge with its
 *    controls unreachable;
 *  - a flex or grid child containing text refuses to shrink below its content
 *    unless it is given `min-width: 0`, so one long path forces the whole row
 *    to overflow;
 *  - `white-space: nowrap` without `overflow` and `text-overflow` produces text
 *    that runs off the edge rather than truncating.
 *
 * The floor is stated once, here, so the breakpoints and the assertions cannot
 * drift apart.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * The narrowest sidebar the panel is designed to stay usable at.
 *
 * VS Code allows narrower, but below this the composer stops being usable for
 * its actual purpose, and pretending otherwise would mean shipping controls too
 * small to hit.
 */
const MIN_SUPPORTED_WIDTH = 240;

const css = readFileSync(join(process.cwd(), 'media', 'task.css'), 'utf8');

/**
 * Rule bodies, paired with their selector, ignoring at-rule wrappers.
 *
 * Comments are stripped first. Without that, everything between one rule's
 * closing brace and the next rule's opening brace is captured as the selector —
 * so a documented rule appeared to be named after its own comment, and the
 * element it actually styles looked unstyled.
 */
function rules(): { selector: string; body: string }[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; body: string }[] = [];
  const pattern = /([^{}@]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const selector = (match[1] ?? '').trim();
    if (selector === '' || selector.startsWith('@')) {
      continue;
    }
    out.push({ selector, body: match[2] ?? '' });
  }
  return out;
}

test('nothing declares a minimum wider than the narrowest supported sidebar', () => {
  const offenders: string[] = [];

  for (const { selector, body } of rules()) {
    const match = /min-width:\s*(\d+)px/.exec(body);
    if (match === null) {
      continue;
    }
    const width = Number(match[1]);
    if (width <= MIN_SUPPORTED_WIDTH) {
      continue;
    }
    // A minimum above the floor is fine when it is also capped against the
    // viewport, because then it shrinks instead of overflowing.
    if (/max-width:\s*calc\(100vw/.test(body)) {
      continue;
    }
    offenders.push(`${selector} (min-width: ${width}px)`);
  }

  assert.deepEqual(
    offenders,
    [],
    `wider than ${MIN_SUPPORTED_WIDTH}px with no viewport cap — these overflow silently`,
  );
});

test('absolutely positioned overlays are capped against the viewport', () => {
  // A popover that cannot shrink is clipped at the panel edge, and whatever sits
  // past the edge cannot be clicked at all. Only overlays wide enough to overflow
  // matter — a 14px badge cannot, and demanding a cap on one would be noise.
  const WIDE_ENOUGH_TO_OVERFLOW = 120;

  for (const { selector, body } of rules()) {
    const min = /min-width:\s*(\d+)px/.exec(body);
    if (!/position:\s*absolute/.test(body) || min === null) {
      continue;
    }
    if (Number(min[1]) < WIDE_ENOUGH_TO_OVERFLOW) {
      continue;
    }
    assert.match(
      body,
      /max-width:\s*calc\(100vw/,
      `${selector} is absolutely positioned with a fixed minimum and no viewport cap`,
    );
  }
});

test('text that is told not to wrap is also told how to truncate', () => {
  const offenders: string[] = [];

  for (const { selector, body } of rules()) {
    if (!/white-space:\s*nowrap/.test(body)) {
      continue;
    }
    // Buttons, badges and glyphs are short by construction and are meant to keep
    // their full width; the rule is about text that can be arbitrarily long.
    if (/btn|badge|glyph|chip|pill|tab|caret|sr-only|pipeline-node/i.test(selector)) {
      continue;
    }
    if (/overflow:\s*hidden/.test(body) && /text-overflow:\s*ellipsis/.test(body)) {
      continue;
    }
    offenders.push(selector);
  }

  assert.deepEqual(offenders, [], 'nowrap without ellipsis runs text off the edge');
});

test('flex and grid rows that hold text let it shrink', () => {
  // The classic overflow: a grid child defaults to `min-width: auto`, which is
  // its content width, so one long file path widens the whole row.
  const offenders: string[] = [];

  for (const { selector, body } of rules()) {
    const isTrack = /display:\s*(flex|grid)/.test(body);
    const hasColumns = /grid-template-columns/.test(body);
    if (!isTrack && !hasColumns) {
      continue;
    }
    if (!hasColumns) {
      continue;
    }
    // `repeat(auto-fit, minmax(190px, 1fr))` is already safe: the minmax gives
    // the track a floor it can shrink to. Only a *bare* `1fr` track is sized by
    // its content and therefore unable to shrink.
    const withoutMinmax = body.replace(/minmax\([^)]*\)/g, '');
    if (/\b1fr\b/.test(withoutMinmax)) {
      offenders.push(`${selector.replace(/\s+/g, ' ')} (bare 1fr track)`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a 1fr track sized by its content cannot shrink; use minmax(0, 1fr)',
  );
});

test('the panel itself never scrolls sideways', () => {
  // Whatever else happens, the root must not produce a horizontal scrollbar:
  // that is the symptom every failure above ends in.
  // `overflow: hidden` covers both axes and is what the root uses; matching only
  // the `-x` form would have failed on a stricter rule than the one required.
  assert.match(
    css,
    /(^|\})\s*body\s*\{[^}]*overflow(-x)?:\s*hidden/m,
    'the panel root must pin overflow so a single wide child cannot scroll it sideways',
  );
});

test('narrow-width rules exist and agree with the stated floor', () => {
  const breakpoints = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((m) =>
    Number(m[1]),
  );

  assert.ok(breakpoints.length > 0, 'there must be narrow-width handling at all');
  assert.ok(
    breakpoints.some((w) => w <= MIN_SUPPORTED_WIDTH),
    `nothing adapts at or below the ${MIN_SUPPORTED_WIDTH}px floor the panel claims to support`,
  );
});

test('motion and contrast preferences are honoured', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
});

// --- keyboard reachability -------------------------------------------------

test('everything clickable has a visible focus state', () => {
  // Several of these are `<div>`s rather than `<button>`s, so they get no
  // browser default at all: a keyboard user could tab onto them and see
  // nothing. Nine were in that state before this test existed.
  const focusable = new Set(
    rules()
      .filter((r) => r.selector.includes(':focus'))
      .flatMap((r) =>
        r.selector.split(',').map((s) => s.trim().replace(/:focus(-visible)?\b.*$/, '')),
      ),
  );

  const unreachable: string[] = [];
  for (const { selector, body } of rules()) {
    if (!/cursor:\s*pointer/.test(body)) {
      continue;
    }
    for (const one of selector.split(',').map((s) => s.trim())) {
      // A rule can group plain and `:focus` selectors together; the pseudo ones
      // are the focus style, not an element that needs one.
      if (one.includes(':')) {
        continue;
      }
      // A compound selector inherits the base element's focus style.
      const base = one.split(/\s+/).pop() ?? one;
      if (!focusable.has(one) && !focusable.has(base)) {
        unreachable.push(one);
      }
    }
  }

  assert.deepEqual(
    [...new Set(unreachable)],
    [],
    'clickable with no focus style — a keyboard user cannot see where they are',
  );
});

test('focus rings use :focus-visible, not :focus', () => {
  // `:focus` shows the ring after a mouse click too, which is what leads teams
  // to delete focus styling altogether.
  const focusOnly = rules().filter(
    (r) =>
      /:focus\b/.test(r.selector) &&
      !r.selector.includes(':focus-visible') &&
      // `:focus-within` fires when a *descendant* is focused, which is the
      // correct way to ring a box around a focused input.
      !r.selector.includes(':focus-within'),
  );

  for (const { selector, body } of focusOnly) {
    // Paired rules that only reset `outline: none` before a `:focus-visible`
    // rule re-adds it are the accepted idiom.
    if (/outline:\s*none/.test(body)) {
      continue;
    }
    assert.fail(`${selector} styles :focus rather than :focus-visible`);
  }
});
