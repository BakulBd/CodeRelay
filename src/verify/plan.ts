/**
 * Deciding what "verified" would even mean for this project.
 *
 * The rule that shapes every line here: **CodeRelay never invents a command.**
 * A verification step is only offered when the project itself declares it — a
 * script in `package.json`, a `tsconfig.json` that makes `tsc --noEmit`
 * meaningful. Guessing `npm test` at a project that has no test script produces
 * a red cross for a failure the user does not have, and one false failure
 * teaches people to ignore the whole panel.
 *
 * The second rule follows from the first: **"nothing to check" is not
 * "everything passed."** A project with no scripts yields an empty plan, and an
 * empty plan can never produce a `verified` verdict. This is the same
 * discipline the rest of the interface already keeps — a header does not claim
 * "0 tokens" for a measurement nobody took, and this does not claim a clean
 * bill of health for checks nobody ran.
 *
 * Pure, and deliberately so. Detection is a function of the manifest and a list
 * of file names; running anything is `run.ts`'s job. That split is what lets
 * the whole decision table be asserted from literal inputs, with no temporary
 * directory and no child process.
 */

/** The kinds of check CodeRelay understands how to interpret. */
export type CheckId = 'typecheck' | 'lint' | 'test' | 'build';

/**
 * Order is meaningful: cheapest and most localised first.
 *
 * A type error makes the test run's output almost worthless, so finding it
 * first saves the user reading a wall of failures with one cause. This is also
 * the order the panel lists them in, so what is displayed matches what happened.
 */
export const CHECK_ORDER: readonly CheckId[] = ['typecheck', 'lint', 'test', 'build'];

/** Human wording for each check. One definition, used by every surface. */
export const CHECK_LABELS: Readonly<Record<CheckId, string>> = {
  typecheck: 'Types',
  lint: 'Lint',
  test: 'Tests',
  build: 'Build',
};

/** One command CodeRelay is prepared to run, and why it believes it exists. */
export interface PlannedCheck {
  readonly id: CheckId;
  readonly label: string;
  /** The exact command line. Never constructed from model output. */
  readonly command: string;
  /**
   * What made this check available, in words the user can check for themselves.
   *
   * Shown in the panel so "why is CodeRelay running this?" always has an
   * answer, and so a wrong detection is visibly wrong rather than mysterious.
   */
  readonly because: string;
}

export interface VerificationPlan {
  readonly checks: readonly PlannedCheck[];
  /**
   * Checks CodeRelay knows about but this project does not declare.
   *
   * Carried rather than dropped so the panel can say "no lint script" instead
   * of silently showing three rows where a user expected four.
   */
  readonly unavailable: readonly { readonly id: CheckId; readonly reason: string }[];
}

/** What the workspace looks like, as far as detection needs to know. */
export interface WorkspaceFacts {
  /**
   * Parsed `package.json` scripts, or null when there is no manifest.
   *
   * Taken pre-parsed because reading and parsing a file is I/O, and this module
   * stays pure. A malformed manifest is the caller's problem to report; here it
   * is simply "no scripts".
   */
  readonly scripts: Readonly<Record<string, string>> | null;
  /** File names present at the workspace root. Lowercased comparison. */
  readonly rootFiles: readonly string[];
  /**
   * The package manager to invoke scripts with.
   *
   * Detected from a lockfile by the caller rather than assumed, because running
   * `npm run` in a pnpm workspace can silently use the wrong dependency tree.
   */
  readonly packageManager: PackageManager;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Which package manager this workspace uses.
 *
 * Lockfile presence only. A `packageManager` field in the manifest would be
 * better evidence, but it is frequently absent and frequently stale, whereas a
 * lockfile is written by the tool that actually ran.
 */
export function detectPackageManager(rootFiles: readonly string[]): PackageManager {
  const files = new Set(rootFiles.map((name) => name.toLowerCase()));
  if (files.has('bun.lockb') || files.has('bun.lock')) {
    return 'bun';
  }
  if (files.has('pnpm-lock.yaml')) {
    return 'pnpm';
  }
  if (files.has('yarn.lock')) {
    return 'yarn';
  }
  return 'npm';
}

/** How each manager runs a named script. */
function runScript(manager: PackageManager, script: string): string {
  switch (manager) {
    case 'pnpm':
      return `pnpm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    case 'npm':
      return `npm run ${script}`;
  }
}

/**
 * Script names to look for, per check, in order of preference.
 *
 * Conventional names only. Matching on substrings — anything containing
 * "test" — was tried and rejected: it selects `test:watch`, which never exits,
 * and a verification step that hangs is worse than one that is absent.
 */
const SCRIPT_CANDIDATES: Readonly<Record<CheckId, readonly string[]>> = {
  typecheck: ['typecheck', 'type-check', 'tsc', 'check-types'],
  lint: ['lint', 'eslint'],
  test: ['test', 'tests', 'test:unit'],
  build: ['build', 'compile'],
};

/**
 * Build the plan for a workspace.
 *
 * Every check either has a declared command and appears in `checks`, or has a
 * stated reason and appears in `unavailable`. Nothing is silently omitted,
 * because the panel's credibility depends on the user being able to see what
 * CodeRelay decided not to do.
 */
export function planVerification(facts: WorkspaceFacts): VerificationPlan {
  const checks: PlannedCheck[] = [];
  const unavailable: { id: CheckId; reason: string }[] = [];
  const scripts = facts.scripts ?? {};
  const rootFiles = new Set(facts.rootFiles.map((name) => name.toLowerCase()));

  for (const id of CHECK_ORDER) {
    const script = SCRIPT_CANDIDATES[id].find(
      (name) => typeof scripts[name] === 'string' && scripts[name] !== '',
    );

    if (script !== undefined) {
      checks.push({
        id,
        label: CHECK_LABELS[id],
        command: runScript(facts.packageManager, script),
        because: `package.json declares a "${script}" script`,
      });
      continue;
    }

    // One fallback, and only one: a TypeScript project without a typecheck
    // script can still be checked, because `tsc --noEmit` is defined by the
    // presence of the config rather than by convention. There is deliberately
    // no equivalent guess for lint, test or build — those have no command that
    // is implied by a file's existence.
    if (id === 'typecheck' && rootFiles.has('tsconfig.json')) {
      checks.push({
        id,
        label: CHECK_LABELS[id],
        command: 'npx tsc --noEmit',
        because: 'tsconfig.json is present, so the project can be type-checked',
      });
      continue;
    }

    unavailable.push({
      id,
      reason:
        facts.scripts === null
          ? 'no package.json in the workspace root'
          : `no ${SCRIPT_CANDIDATES[id].map((s) => `"${s}"`).join(' or ')} script`,
    });
  }

  return { checks, unavailable };
}
