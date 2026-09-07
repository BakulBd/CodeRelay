/**
 * Choosing what the agent should look at, and being able to justify every file.
 *
 * ContextBench (arXiv:2602.05892) measured context retrieval across 1,136
 * issue-resolution tasks and found three things that shape this module:
 *
 *  1. Agents consistently favour **recall over precision** — they pull in far
 *     more than they use.
 *  2. There is a large gap between context *explored* and context *used*.
 *  3. Balanced retrieval reaches higher accuracy at **lower** cost, and
 *     elaborate scaffolding buys surprisingly little over simple signals.
 *
 * So this deliberately does not attempt clever retrieval. It ranks on a handful
 * of signals a user can verify by eye, caps the result, and — most importantly
 * — records *why* each file is in and what was left out. A context set the user
 * cannot inspect is one they cannot correct, and the third finding says the
 * sophistication would not have paid for itself anyway.
 *
 * The design rule throughout: **every included file names its evidence.** Not a
 * relevance number on its own, which is unfalsifiable, but the actual reason —
 * "you mentioned it", "it has errors", "it changed in git". A wrong reason is
 * visibly wrong, in a way that a wrong score is not.
 *
 * Pure. Gathering the signals touches git, the editor and the diagnostics API;
 * none of that happens here, so the whole ranking is testable from literals.
 */

import { isSensitivePath } from '../policy/privacy.js';

/** Why a file earned its place. Ordered strongest first. */
export type Signal =
  /** The user named it with @, or it is the file they have open. */
  | 'mentioned'
  | 'open'
  /** The editor reports errors or warnings in it. */
  | 'diagnostic'
  /** Modified, added or renamed in the working tree. */
  | 'changed'
  /** A test file whose subject is already included. */
  | 'test-of-included'
  /** Imported by an already-included file. */
  | 'imported-by-included'
  /** A project manifest or config the task is likely to need. */
  | 'manifest';

/**
 * Weight per signal.
 *
 * Ordered by how directly the signal reflects *the user's own attention*. A
 * file they pointed at outranks one the tool inferred, always — the inference
 * may be good, but it is still a guess about what they meant.
 */
const WEIGHTS: Readonly<Record<Signal, number>> = {
  mentioned: 100,
  open: 60,
  diagnostic: 45,
  changed: 40,
  'test-of-included': 25,
  'imported-by-included': 20,
  manifest: 10,
};

/** Plain wording for each signal, shown per file in the panel. */
const SIGNAL_WORDS: Readonly<Record<Signal, string>> = {
  mentioned: 'you mentioned it',
  open: 'open in the editor',
  diagnostic: 'has reported problems',
  changed: 'changed in the working tree',
  'test-of-included': 'tests an included file',
  'imported-by-included': 'imported by an included file',
  manifest: 'project manifest',
};

/** One file the agent will be shown. */
export interface ContextFile {
  readonly path: string;
  /** Every signal that fired, strongest first. Never empty. */
  readonly signals: readonly Signal[];
  /**
   * Sum of signal weights. Ordering only; never displayed as a percentage.
   *
   * Used as a *tiebreak*, not as the primary order — see `selectContext`.
   */
  readonly score: number;
  /** Bucketed for display. */
  readonly relevance: 'high' | 'medium' | 'low';
  /** The reasons, already a sentence fragment each. */
  readonly why: readonly string[];
  /** Size in bytes when known, so the panel can show the real cost. */
  readonly bytes: number | null;
}

/** Something deliberately left out, and why. */
export interface Exclusion {
  /** A path or a glob-ish prefix, exactly as it will be displayed. */
  readonly pattern: string;
  readonly reason: string;
  /** How many candidate files this removed. */
  readonly count: number;
}

export interface ContextSet {
  readonly included: readonly ContextFile[];
  readonly excluded: readonly Exclusion[];
  /** Candidates considered before capping. The recall side of the trade. */
  readonly consideredCount: number;
  /** Total bytes of included files, when sizes were known. */
  readonly totalBytes: number | null;
  /** True when the cap removed files that would otherwise have qualified. */
  readonly truncated: boolean;
}

/** One candidate, as the caller has observed it. */
export interface CandidateFile {
  readonly path: string;
  readonly bytes?: number | null;
  readonly mentioned?: boolean;
  readonly open?: boolean;
  readonly diagnostics?: number;
  readonly changed?: boolean;
}

export interface SelectContextOptions {
  readonly candidates: readonly CandidateFile[];
  /**
   * Most files to include.
   *
   * A cap rather than a token budget: token counts differ per model and per
   * tokenizer, and a limit that changes when the model changes would make the
   * panel's numbers unreproducible. The byte total is reported alongside so the
   * real cost is still visible.
   */
  readonly maxFiles?: number;
  /** Largest single file to include, in bytes. */
  readonly maxFileBytes?: number;
  /** Extra directory prefixes to exclude, beyond the built-in list. */
  readonly extraExclusions?: readonly string[];
}

export const DEFAULT_MAX_FILES = 24;
export const DEFAULT_MAX_FILE_BYTES = 256_000;

/**
 * Directories that are never useful context.
 *
 * Generated output and vendored dependencies. Excluded by prefix rather than by
 * a `.gitignore` parse: the ignore file is about what to *commit*, which is a
 * different question, and plenty of projects commit a `dist/` they would still
 * never want an agent reading.
 */
const NEVER: readonly { prefix: string; reason: string }[] = [
  { prefix: 'node_modules/', reason: 'vendored dependencies' },
  { prefix: 'dist/', reason: 'build output' },
  { prefix: 'build/', reason: 'build output' },
  { prefix: 'out/', reason: 'build output' },
  { prefix: '.git/', reason: 'repository metadata' },
  { prefix: 'coverage/', reason: 'generated coverage report' },
  { prefix: '.next/', reason: 'build output' },
  { prefix: 'vendor/', reason: 'vendored dependencies' },
  { prefix: '__pycache__/', reason: 'generated bytecode' },
  { prefix: '.venv/', reason: 'virtual environment' },
];

/** Files worth including as manifests when little else is available. */
const MANIFESTS: ReadonlySet<string> = new Set([
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'requirements.txt',
  'gemfile',
]);

/** Extensions that are not text and cannot help a model reason about code. */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'gz', 'tar',
  'mp4', 'mp3', 'wav', 'woff', 'woff2', 'ttf', 'eot', 'so', 'dylib', 'dll',
  'exe', 'bin', 'lock', 'wasm',
]);

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}

/** Whether a path looks like a test for `subject`. */
export function isTestFor(candidate: string, subject: string): boolean {
  const stem = baseName(subject).replace(/\.[^.]+$/, '');
  if (stem === '' || candidate === subject) {
    return false;
  }
  const base = baseName(candidate);

  // Exact conventional forms only: `<stem>.test.<ext>` and `<stem>.spec.<ext>`.
  // A looser `startsWith(stem + '.')` was tried and matched
  // `auth.test.helper.test.ts` against `auth.ts`, which is a different file
  // that merely begins with the same word. One wrong inclusion costs the user
  // more attention than one missed test costs the agent.
  const conventional = new RegExp(`^${escapeRegExp(stem)}\\.(test|spec)\\.[^.]+$`);
  if (conventional.test(base)) {
    return true;
  }

  // Or the same file name living under a test directory: `test/auth.ts`.
  const inTestDir = /(^|\/)(tests?|__tests__)\//.test(candidate);
  return inTestDir && base.replace(/\.[^.]+$/, '') === stem;
}

/** Escapes a file stem for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The weight of a file's single strongest signal. */
function strongest(file: ContextFile): number {
  return file.signals.reduce((best, s) => Math.max(best, WEIGHTS[s]), 0);
}

function relevanceOf(score: number): 'high' | 'medium' | 'low' {
  if (score >= WEIGHTS.open) {
    return 'high';
  }
  return score >= WEIGHTS['test-of-included'] ? 'medium' : 'low';
}

/**
 * Build the context set.
 *
 * Two passes: direct signals first, then signals that depend on what the first
 * pass already included (a test is only relevant because its subject is). That
 * ordering is why `test-of-included` and `imported-by-included` are named the
 * way they are — they are relationships to the set, not properties of the file.
 */
export function selectContext(options: SelectContextOptions): ContextSet {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const exclusionCounts = new Map<string, { reason: string; count: number }>();
  const note = (pattern: string, reason: string): void => {
    const found = exclusionCounts.get(pattern);
    if (found === undefined) {
      exclusionCounts.set(pattern, { reason, count: 1 });
    } else {
      found.count += 1;
    }
  };

  const excludeRules = [
    ...NEVER,
    ...(options.extraExclusions ?? []).map((prefix) => ({
      prefix,
      reason: 'excluded by your settings',
    })),
  ];

  const surviving: CandidateFile[] = [];
  for (const candidate of options.candidates) {
    const rule = excludeRules.find((r) => candidate.path.startsWith(r.prefix));
    if (rule !== undefined) {
      note(rule.prefix, rule.reason);
      continue;
    }
    // Checked before anything else that could include a file: a `.env`, a
    // private key or a credentials file must never be sent to a provider, and
    // "the user mentioned it" is not a reason to make an exception — a mention
    // is far more likely to be a mistake than an intent to upload a secret.
    if (isSensitivePath(candidate.path)) {
      note('secrets', 'may contain credentials');
      continue;
    }

    const ext = extensionOf(candidate.path);
    if (BINARY_EXTENSIONS.has(ext)) {
      note(`*.${ext}`, 'not a text file');
      continue;
    }
    if (typeof candidate.bytes === 'number' && candidate.bytes > maxFileBytes) {
      note(candidate.path, `larger than ${Math.round(maxFileBytes / 1000)} kB`);
      continue;
    }
    surviving.push(candidate);
  }

  // Pass one: signals that stand on their own.
  const scored = new Map<string, { signals: Signal[]; file: CandidateFile }>();
  for (const candidate of surviving) {
    const signals: Signal[] = [];
    if (candidate.mentioned === true) {
      signals.push('mentioned');
    }
    if (candidate.open === true) {
      signals.push('open');
    }
    if ((candidate.diagnostics ?? 0) > 0) {
      signals.push('diagnostic');
    }
    if (candidate.changed === true) {
      signals.push('changed');
    }
    if (MANIFESTS.has(baseName(candidate.path))) {
      signals.push('manifest');
    }
    if (signals.length > 0) {
      scored.set(candidate.path, { signals, file: candidate });
    }
  }

  // Pass two: relationships to what pass one selected. Computed against the
  // pass-one set only, so this cannot cascade — a test of a test of a changed
  // file is not context, it is drift.
  const seeds = [...scored.keys()];
  for (const candidate of surviving) {
    if (scored.has(candidate.path)) {
      continue;
    }
    const isTest = seeds.some((seed) => isTestFor(candidate.path, seed));
    if (isTest) {
      scored.set(candidate.path, { signals: ['test-of-included'], file: candidate });
    }
  }

  const ranked = [...scored.values()]
    .map(({ signals, file }) => {
      const score = signals.reduce((sum, s) => sum + WEIGHTS[s], 0);
      const peak = signals.reduce((best, sig) => Math.max(best, WEIGHTS[sig]), 0);
      return {
        path: file.path,
        signals: [...signals].sort((a, b) => WEIGHTS[b] - WEIGHTS[a]),
        score,
        // Bucketed on the strongest signal rather than the sum, for the same
        // reason the sort is: a pile of weak evidence is not strong evidence.
        relevance: relevanceOf(peak),
        why: signals
          .slice()
          .sort((a, b) => WEIGHTS[b] - WEIGHTS[a])
          .map((s) => SIGNAL_WORDS[s]),
        bytes: file.bytes ?? null,
      } satisfies ContextFile;
    })
    // Ordered by the *strongest single signal* first, and only then by the sum.
    //
    // Summing alone was wrong, and visibly so: `open` + `diagnostic` +
    // `changed` totals more than `mentioned`, so three inferred signals would
    // outrank a file the user actually named — the exact inversion the weight
    // table exists to prevent. Accumulated guesses must never outweigh a
    // direct instruction, however many of them there are.
    //
    // Ties break by path, so the same inputs always give the same set; a panel
    // that reordered between renders would be impossible to check by eye.
    .sort(
      (a, b) =>
        strongest(b) - strongest(a) ||
        b.score - a.score ||
        a.path.localeCompare(b.path),
    );

  const included = ranked.slice(0, maxFiles);
  const truncated = ranked.length > included.length;
  if (truncated) {
    note(
      `${ranked.length - included.length} more files`,
      `over the ${maxFiles}-file limit — lowest relevance first`,
    );
  }

  const sizes = included.map((f) => f.bytes).filter((b): b is number => b !== null);
  return {
    included,
    excluded: [...exclusionCounts].map(([pattern, { reason, count }]) => ({
      pattern,
      reason,
      count,
    })),
    consideredCount: options.candidates.length,
    // Null rather than 0 when nothing reported a size: an unknown total is not
    // an empty one.
    totalBytes: sizes.length === 0 ? null : sizes.reduce((a, b) => a + b, 0),
    truncated,
  };
}

/**
 * A one-line summary for the panel header.
 *
 * Reports both halves of the trade ContextBench measured: how much was
 * considered, and how much survived. "18 files selected" alone is a recall
 * number, and recall on its own is what the paper found agents over-optimise.
 */
export function summarizeContext(set: ContextSet): string {
  const n = set.included.length;
  if (n === 0) {
    return set.consideredCount === 0
      ? 'No files available'
      : `No relevant files among ${set.consideredCount}`;
  }
  const head = `${n} of ${set.consideredCount} file${set.consideredCount === 1 ? '' : 's'}`;
  if (set.totalBytes === null) {
    return head;
  }
  return `${head} · ${Math.max(1, Math.round(set.totalBytes / 1000))} kB`;
}
