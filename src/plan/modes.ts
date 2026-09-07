/**
 * What each composer mode actually does.
 *
 * This module exists because of a bug rather than a feature request: the mode
 * picker offered six modes, and only two of them changed anything. `debug`,
 * `review`, `test` and `build` were decorative — they set a label and nothing
 * else, which is precisely the fake control the brief forbids. A mode that does
 * not alter behaviour is worse than an absent one, because the user reasonably
 * assumes it did something and interprets the results accordingly.
 *
 * Every mode now maps to two real consequences:
 *
 *  - a **role**, which decides what the model selector optimises for; and
 *  - a **directive**, prepended to the objective, which states the workflow the
 *    mode implies.
 *
 * The directives are deliberately short and procedural. They say what order to
 * work in and what must be true before finishing — not how to think, and never
 * anything about tone. A long persona preamble is tokens spent on every turn to
 * shape prose nobody reads.
 */
import type { TaskRole } from '../policy/select.js';

/** The modes the composer offers. Mirrors `TaskMode` in the webview protocol. */
export type Mode = 'code' | 'architect' | 'ask' | 'build' | 'plan' | 'debug' | 'review' | 'test';

export interface ModeBehaviour {
  /** What the model selector should optimise for in this mode. */
  readonly role: TaskRole;
  /** Prepended to the objective, or null when the mode adds nothing. */
  readonly directive: string | null;
  /**
   * Whether the mode is allowed to change files.
   *
   * Advisory here — the real boundary is the tool registry and the approval
   * gate — but stated so the directive and the enforcement cannot drift apart
   * silently.
   */
  readonly writes: boolean;
}

/**
 * The debug workflow, which is the one mode whose value is entirely in its
 * order.
 *
 * Reproduce before hypothesising, and verify the fix against the same
 * reproduction. The failure this prevents is the one every debugging agent
 * makes: reading a stack trace, guessing a cause, editing the file it points
 * at, and declaring success without ever having seen the bug happen — so the
 * "fix" is unfalsifiable and often unrelated.
 */
const DEBUG_DIRECTIVE = [
  '[DEBUG MODE]',
  'Work in this order and do not skip a step:',
  '1. Reproduce the problem first. Run the failing command or test and quote its',
  '   actual output. If you cannot reproduce it, say so and stop — do not guess.',
  '2. Gather evidence: the failing output, the relevant file, the surrounding code.',
  '3. State one hypothesis about the cause, and what would disprove it.',
  '4. Make the smallest change that tests that hypothesis.',
  '5. Re-run the same reproduction. A fix is not a fix until the thing that',
  '   failed now passes.',
  'If step 5 still fails, return to step 3 with what you learned rather than',
  'making a second change on top of the first.',
].join('\n');

const REVIEW_DIRECTIVE = [
  '[REVIEW MODE]',
  'Read and report. Do not modify application code.',
  'For each finding give the file and line, what is wrong, and why it matters.',
  'Rank by severity. Say plainly when you find nothing worth reporting rather',
  'than padding the list — a review that always finds something is one nobody',
  'can act on.',
].join('\n');

const TEST_DIRECTIVE = [
  '[TEST MODE]',
  'Focus on tests: write missing ones, or fix failing ones.',
  'Run the suite before and after your changes and quote both results.',
  'Never change application code to make a test pass unless the test is',
  'demonstrating a real defect — say which it is.',
  'A test that cannot fail is not a test; assert on behaviour, not on the',
  'implementation you just wrote.',
].join('\n');

const PLAN_DIRECTIVE = [
  '[PLAN MODE]',
  'Produce a plan; do not implement it.',
  'Cover, in this order: the goal, the requirements as a checklist, the files',
  'you expect to touch, the approach, the risks, and how the result will be',
  'verified. Keep it short enough to read in full.',
  'Use the propose_plan tool to submit it for approval.',
].join('\n');

const ARCHITECT_DIRECTIVE = [
  '[ARCHITECT MODE]',
  'Explore the codebase and produce an architectural implementation plan.',
  'Do NOT write or modify application code.',
  'Use the propose_plan tool to submit your plan for approval once your',
  'research is complete.',
].join('\n');

const ASK_DIRECTIVE = [
  '[ASK MODE]',
  'Answer questions about this codebase. Read freely; change nothing.',
  'Cite the files you relied on so the answer can be checked.',
].join('\n');

const BEHAVIOURS: Readonly<Record<Mode, ModeBehaviour>> = {
  // The default. No directive at all: an unqualified instruction should reach
  // the model unqualified, and wrapping every ordinary task in a preamble is
  // how prompts quietly become bloated.
  code: { role: 'code', directive: null, writes: true },
  build: { role: 'code', directive: null, writes: true },
  architect: { role: 'plan', directive: ARCHITECT_DIRECTIVE, writes: false },
  plan: { role: 'plan', directive: PLAN_DIRECTIVE, writes: false },
  ask: { role: 'review', directive: ASK_DIRECTIVE, writes: false },
  debug: { role: 'debug', directive: DEBUG_DIRECTIVE, writes: true },
  review: { role: 'review', directive: REVIEW_DIRECTIVE, writes: false },
  test: { role: 'test', directive: TEST_DIRECTIVE, writes: true },
};

export function behaviourFor(mode: Mode): ModeBehaviour {
  return BEHAVIOURS[mode];
}

/**
 * Apply a mode to an objective.
 *
 * Returns the objective unchanged when the mode adds nothing, so the caller
 * never has to special-case the default.
 */
export function applyMode(mode: Mode, objective: string): string {
  const directive = BEHAVIOURS[mode].directive;
  return directive === null ? objective : `${directive}\n\n${objective}`;
}
