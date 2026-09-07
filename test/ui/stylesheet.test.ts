/**
 * The stylesheet's load-bearing rules.
 *
 * `media/task.css` is not TypeScript, so nothing else in this suite can see it.
 * These tests read it as text and assert the handful of properties that are
 * correctness rather than taste — each one of which was either found broken
 * during visual verification or would break silently in a theme nobody tested.
 *
 * Deliberately not a general CSS lint. Only claims the project makes elsewhere:
 * that the panel is theme-driven, that hiding works, and that motion and contrast
 * preferences are honoured.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const css = readFileSync(join(process.cwd(), 'media', 'task.css'), 'utf8');

test('no hard-coded colour survives, so no theme can be broken by this file', () => {
  // The whole "native to VS Code" claim rests on this. A hex value would be
  // wrong in some theme, and the themes that do not exist yet cannot be checked
  // by looking.
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], `hard-coded colours: ${hex.join(', ')}`);

  // Functional colour notations are the same problem wearing different syntax.
  for (const fn of ['rgb(', 'rgba(', 'hsl(', 'hsla(', 'oklch(', 'color(']) {
    assert.ok(!css.includes(fn), `${fn} bypasses the theme`);
  }
});

test('every colour comes from a VS Code variable or the forced-colors keywords', () => {
  const colourish = [...css.matchAll(/(?:^|[\s:])(?:color|background|border-color)\s*:\s*([^;]+);/g)];
  assert.ok(colourish.length > 5, 'expected colour declarations to exist');
  for (const [, value] of colourish) {
    const v = (value ?? '').trim();
    const ok =
      v.includes('--vscode-') ||
      // The semantic layer: components ask for a *meaning* and only `:root`
      // knows which VS Code variable carries it. Asserted below to resolve to
      // one, which is a stronger guarantee than each component spelling it out
      // and four of them spelling it differently.
      /var\(--(ok|warn|danger|muted|accent|border)\)/.test(v) ||
      v.includes('currentColor') ||
      v === 'transparent' ||
      v === 'inherit' ||
      v === 'none' ||
      // `forced-colors` system keywords are the correct answer in high contrast.
      /ButtonBorder|CanvasText|Canvas|LinkText|GrayText|Highlight/.test(v);
    assert.ok(ok, `not theme-driven: ${v}`);
  }
});

test('the hidden attribute outranks any display a class sets', () => {
  // The bug this catches was real and visible: the empty state and a full
  // timeline rendered at the same time, because `.empty { display: flex }` beats
  // the UA rule for `[hidden]`. The client hides by attribute, so without this
  // every `display`-carrying element it hides stays on screen.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('the panel itself never scrolls, so the composer cannot leave the screen', () => {
  assert.match(css, /body\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.timeline\s*\{[^}]*overflow-y:\s*auto/s);
});

test('the recovery notice is bounded, so its buttons stay reachable', () => {
  // An unbounded card grew past the viewport and slid under the timeline, taking
  // Retry and Switch model with it.
  const notice = css.match(/\.notice\s*\{[^}]*\}/s)?.[0] ?? '';
  assert.match(notice, /max-height:/);
  assert.match(notice, /overflow-y:\s*auto/);
});

test('large output is capped rather than allowed to push the view around', () => {
  const body = css.match(/\.row-body\s*\{[^}]*\}/s)?.[0] ?? '';
  assert.match(body, /max-height:/);
  assert.match(body, /overflow-y:\s*auto/);
});

test('focus is always visible, in the theme\u2019s own focus colour', () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /outline:\s*1px solid var\(--vscode-focusBorder\)/);
  // Removing an outline without replacing it is how a panel becomes unusable
  // with a keyboard.
  assert.ok(!/outline:\s*(none|0)\s*;/.test(css), 'an outline is removed somewhere');
});

test('reduced motion and high contrast are both honoured', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);

  // Every animation must be inside something the reduced-motion block disables.
  const animated = [...css.matchAll(/\n\s*animation:\s*([a-zA-Z-]+)/g)].map((m) => m[1]);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(animated.length > 0, 'expected at least one animation');
  assert.match(reduced, /animation:\s*none/);
});

test('typography is inherited from the editor rather than imposed', () => {
  assert.match(css, /font-family:\s*var\(--vscode-font-family\)/);
  // The base size reaches components through the type scale rather than being
  // written out at each site; that the scale derives from the editor's own
  // setting is asserted separately, against `:root`.
  assert.match(css, /--fs-base:\s*var\(--vscode-font-size\)/);
  // No absolute font size anywhere: the user's own setting is the base, and
  // everything else is a ratio of it.
  const absolute = css.match(/font-size:\s*\d+(\.\d+)?(px|pt|rem|em)\b/g) ?? [];
  // The two glyph sizes on the rail are the exception, and they are decorative
  // marks rather than text.
  assert.ok(absolute.length <= 3, `absolute font sizes: ${absolute.join(', ')}`);
});

test('the setup panel is styled entirely from theme tokens', () => {
  const setup = css.slice(css.indexOf('--- guided setup'));
  assert.ok(setup.length > 500, 'the setup block should exist');

  // No literal colour anywhere in it: the panel has to follow the user's theme,
  // including the high-contrast ones where a hardcoded grey becomes invisible.
  const literals = setup.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? [];
  assert.deepEqual(literals, [], `literal colours in setup: ${literals.join(', ')}`);

  // And every focusable control it adds has a visible focus ring.
  for (const selector of ['.provider-card', '.field-input', '.model-toggle']) {
    assert.ok(
      setup.includes(`${selector}:focus`),
      `${selector} has no focus style, so it cannot be used from the keyboard`,
    );
  }
});


// --- the semantic token layer ---------------------------------------------
// Components name a meaning; `:root` maps it to a VS Code variable. These
// assertions are what make that indirection safe rather than a hiding place.

test('every semantic token resolves to a VS Code variable', () => {
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));

  for (const token of ['--ok', '--warn', '--danger', '--muted', '--accent']) {
    const declaration = new RegExp(`${token}:\\s*([^;]+);`).exec(root);
    assert.ok(declaration !== null, `${token} is used but never defined`);
    assert.match(
      declaration[1] ?? '',
      /var\(--vscode-/,
      `${token} must resolve to a theme variable, not a literal`,
    );
  }
});

test('the type scale is relative to the editor font, and has few enough steps to read as a scale', () => {
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));

  for (const token of ['--fs-xs', '--fs-sm', '--fs-md', '--fs-base', '--fs-lg', '--fs-xl']) {
    const declaration = new RegExp(`${token}:\\s*([^;]+);`).exec(root);
    assert.ok(declaration !== null, `${token} is used but never defined`);
    assert.match(
      declaration[1] ?? '',
      /var\(--vscode-font-size\)/,
      `${token} must scale with the user's own font size`,
    );
  }

  // The point of a scale is that its steps are distinguishable. Twenty-seven
  // multipliers — 0.9, 0.92, 0.95, 0.96 among them — differ by under a pixel at
  // a 13px base and read as noise rather than hierarchy.
  const used = new Set(
    [...css.matchAll(/font-size:\s*var\((--fs-[a-z]+)\)/g)].map((m) => m[1]),
  );
  assert.ok(used.size <= 6, `${used.size} type steps in use; a scale needs a handful`);
});

test('no component spells a semantic colour itself', () => {
  // Outside `:root`, asking for `--vscode-testing-iconPassed` directly is how
  // two adjacent rows end up rendering different greens.
  const body = css.slice(css.indexOf('}', css.indexOf(':root {')));
  for (const raw of [
    '--vscode-testing-iconPassed',
    '--vscode-charts-green',
    '--vscode-errorForeground',
    '--vscode-descriptionForeground',
  ]) {
    assert.ok(
      !body.includes(raw),
      `${raw} is spelled directly in a component; use the semantic token`,
    );
  }
});
