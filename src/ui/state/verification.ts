/**
 * Wording for a verification run.
 *
 * Pure, so the one sentence that matters most in the whole interface — whether
 * the work is actually done — can be asserted by `node --test` rather than read
 * off a screen.
 *
 * The distinction this module exists to keep is between four things that a less
 * careful panel would render as two:
 *
 *   verified      every check the project declares ran, and passed
 *   failed        something ran and reported a problem
 *   unverifiable  the project declares nothing to check
 *   cancelled     checks were left unrun, so nothing is claimed either way
 *
 * Only the first is a green tick. `unverifiable` in particular must never read
 * as success: a project with no test script has not passed its tests, and a
 * panel that implies otherwise is worse than no panel, because it would be
 * believed exactly when it is least earned.
 */
import type { CheckStatus, VerificationRun, Verdict } from '../../verify/run.js';

export type VerdictTone = 'ok' | 'problem' | 'muted';

export interface VerdictModel {
  readonly verdict: Verdict;
  /** Two or three words for the header. */
  readonly label: string;
  /** One sentence explaining what that means. */
  readonly detail: string;
  readonly tone: VerdictTone;
  /** A single character. */
  readonly glyph: string;
  /** The whole verdict as one sentence, for a screen reader. */
  readonly spoken: string;
}

/** Per-check display, matching the tones the timeline already uses. */
export function checkTone(status: CheckStatus): VerdictTone {
  switch (status) {
    case 'passed':
      return 'ok';
    case 'failed':
    case 'errored':
      return 'problem';
    case 'skipped':
      return 'muted';
  }
}

export function checkGlyph(status: CheckStatus): string {
  switch (status) {
    case 'passed':
      return '✓';
    case 'failed':
      return '✗';
    case 'errored':
      return '!';
    case 'skipped':
      return '○';
  }
}

/**
 * Describe a finished run.
 *
 * Counts come from the results rather than from the verdict, so the sentence
 * and the rows below it cannot disagree.
 */
export function describeVerdict(run: VerificationRun): VerdictModel {
  const passed = run.checks.filter((c) => c.status === 'passed').length;
  const failed = run.checks.filter((c) => c.status === 'failed' || c.status === 'errored');
  const skipped = run.checks.filter((c) => c.status === 'skipped').length;

  switch (run.verdict) {
    case 'verified':
      return {
        verdict: run.verdict,
        label: 'Verified',
        detail:
          passed === 1
            ? 'The one check this project declares passed.'
            : `All ${passed} checks this project declares passed.`,
        tone: 'ok',
        glyph: '✓',
        spoken: `Verified. ${passed} of ${passed} checks passed.`,
      };

    case 'failed': {
      const names = failed.map((c) => c.label.toLowerCase());
      const which =
        names.length === 1
          ? `The ${names[0]} check failed.`
          : `${names.length} checks failed: ${names.join(', ')}.`;
      return {
        verdict: run.verdict,
        label: 'Not verified',
        detail:
          skipped > 0
            ? `${which} ${skipped === 1 ? 'One later check was' : `${skipped} later checks were`} not run.`
            : which,
        tone: 'problem',
        glyph: '✗',
        spoken: `Not verified. ${which}`,
      };
    }

    case 'unverifiable':
      return {
        verdict: run.verdict,
        label: 'Nothing to verify',
        // Named as an absence, never as a pass. This is the sentence the whole
        // module exists to get right.
        detail:
          'This project declares no test, lint, typecheck or build script, so ' +
          'CodeRelay has nothing it can run to check the work.',
        tone: 'muted',
        glyph: '–',
        spoken:
          'Nothing to verify: this project declares no checks, so the work has not been verified.',
      };

    case 'cancelled':
      return {
        verdict: run.verdict,
        label: 'Incomplete',
        detail:
          passed === 0
            ? 'Verification was stopped before anything finished.'
            : `${passed} ${passed === 1 ? 'check' : 'checks'} passed, but ${
                skipped === 1 ? 'one was' : `${skipped} were`
              } never run.`,
        tone: 'muted',
        glyph: '□',
        spoken: 'Verification did not finish, so the work has not been verified.',
      };
  }
}

/**
 * What the panel says about checks the project does not declare.
 *
 * Returns null when everything is declared — a line reading "nothing missing"
 * is noise. Kept separate from the verdict so a project that simply has no
 * linter is not made to look deficient in the headline.
 */
export function describeUnavailable(run: VerificationRun): string | null {
  if (run.unavailable.length === 0) {
    return null;
  }
  const names = run.unavailable.map((u) => u.id).join(', ');
  return `Not declared by this project: ${names}`;
}
