/**
 * Turning a plan into a visible definition of "done", and checking it honestly.
 *
 * End-to-end coding-agent research keeps finding the same two failures:
 * requirements get quietly dropped, and agents self-assess as finished on work
 * that is not. This module is the answer to both — but only if it resists the
 * obvious shortcut.
 *
 * **The shortcut it refuses.** The easy implementation asks the model which
 * requirements it has met. That is worthless: it is the same assertion that was
 * already wrong, restated in a checklist. So nothing here consults a model.
 * A requirement's status is derived from *evidence* — files that actually
 * changed on disk, checks that actually ran — and a requirement with no
 * evidence stays open no matter how confidently the transcript claims otherwise.
 *
 * **What that costs, stated plainly.** Evidence-only assessment cannot prove a
 * requirement is *semantically* satisfied. CodeRelay can see that `auth.ts`
 * changed and that the tests passed; it cannot see that "login works" is true.
 * So the strongest status here is `evidenced`, never `proven`, and the wording
 * says what was observed rather than what it implies. Overstating that would
 * reintroduce exactly the false confidence the checklist exists to remove.
 */
import type { CheckStatus } from '../verify/run.js';

/** How far along one requirement is, on the evidence available. */
export type RequirementStatus =
  /** Nothing has happened that bears on it. */
  | 'open'
  /** Files it names were touched, but nothing has verified the result. */
  | 'touched'
  /** Files were touched and the project's checks passed afterwards. */
  | 'evidenced'
  /** A check that bears on it failed. */
  | 'failing';

export interface Requirement {
  readonly id: string;
  /** The requirement as written, cleaned of markup. */
  readonly text: string;
  /**
   * Path fragments mentioned in the text, used to link it to real changes.
   *
   * Extracted rather than inferred: a requirement that names no file simply has
   * no file evidence, and says so, instead of being matched to whatever changed.
   */
  readonly mentions: readonly string[];
}

/** A requirement together with what was actually observed about it. */
export interface AssessedRequirement extends Requirement {
  readonly status: RequirementStatus;
  /** Files that changed and match this requirement's mentions. */
  readonly files: readonly string[];
  /** One sentence naming the evidence, or its absence. */
  readonly evidence: string;
}

export interface RequirementReport {
  readonly requirements: readonly AssessedRequirement[];
  /** How many are `evidenced`. Never called "complete". */
  readonly evidencedCount: number;
  readonly total: number;
  /** A one-line headline, or null when there are no requirements. */
  readonly summary: string | null;
}

/**
 * Pull requirements out of a plan.
 *
 * Recognises two shapes, and only two: markdown task-list items (`- [ ] …`)
 * anywhere, and plain bullets under a heading whose text starts with
 * "requirement" or "acceptance". Free prose is deliberately not parsed —
 * guessing which sentences are requirements produces a checklist the user never
 * agreed to, and a wrong checklist is worse than none because it will be
 * trusted.
 */
export function parseRequirements(markdown: string): readonly Requirement[] {
  const lines = markdown.split(/\r?\n/);
  const found: Requirement[] = [];
  const seen = new Set<string>();
  let inRequirementSection = false;

  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      inRequirementSection = /^(requirement|acceptance)/i.test(heading[1]?.trim() ?? '');
      continue;
    }

    // A task-list item is an explicit requirement wherever it appears: the
    // author typed a checkbox, which is unambiguous intent.
    const task = /^\s*[-*+]\s*\[[ xX]\]\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);

    const raw = task?.[1] ?? (inRequirementSection ? bullet?.[1] : undefined);
    if (raw === undefined) {
      continue;
    }

    const text = clean(raw);
    if (text === '') {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    found.push({ id: `req-${found.length + 1}`, text, mentions: pathsIn(raw) });
  }

  return found;
}

/** Strips markdown emphasis, code ticks and trailing punctuation. */
function clean(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * File-ish fragments mentioned in a requirement.
 *
 * Matches things containing a slash or a known-looking extension. Bare words
 * are excluded: "login" is not a path, and treating it as one would match it
 * against any file whose name happens to contain it.
 */
export function pathsIn(text: string): readonly string[] {
  const out = new Set<string>();
  const pattern = /[`'"]?([\w./@-]*[\w-]+\.[a-z]{1,5}|[\w./@-]*\/[\w./@-]+)[`'"]?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[1];
    if (candidate === undefined) {
      continue;
    }
    // A decimal number is not a path.
    if (/^\d+\.\d+$/.test(candidate)) {
      continue;
    }
    if (candidate.length < 3) {
      continue;
    }
    out.add(candidate);
  }
  return [...out];
}

/** Everything observed that could bear on a requirement. */
export interface Evidence {
  /** Paths changed in this task, from recorded fingerprints. */
  readonly changedFiles: readonly string[];
  /**
   * The verification outcome, when a run has happened.
   *
   * `null` means nothing has been verified — which is why no requirement can
   * reach `evidenced` without one.
   */
  readonly verification?: {
    readonly verdict: 'verified' | 'failed' | 'unverifiable' | 'cancelled';
    readonly failedChecks: readonly { readonly id: string; readonly status: CheckStatus }[];
  } | null;
}

/**
 * Match a requirement's mentions against files that actually changed.
 *
 * Suffix matching, because a plan says `auth.ts` while the ledger records
 * `src/auth/auth.ts`. Anchored at a path boundary so `auth.ts` cannot match
 * `oauth.ts`.
 */
function matchingFiles(
  requirement: Requirement,
  changed: readonly string[],
): readonly string[] {
  const out: string[] = [];
  for (const file of changed) {
    const normalised = file.replace(/\\/g, '/').toLowerCase();
    for (const mention of requirement.mentions) {
      const needle = mention.replace(/\\/g, '/').toLowerCase();
      if (normalised === needle || normalised.endsWith(`/${needle}`)) {
        out.push(file);
        break;
      }
    }
  }
  return out;
}

/**
 * Assess every requirement against the evidence.
 *
 * The only way to reach `evidenced` is: files this requirement names actually
 * changed, **and** the project's own checks ran and passed. Either alone is not
 * enough — a change nobody verified is just a change, and a passing suite says
 * nothing about a requirement whose files were never touched.
 */
export function assessRequirements(
  requirements: readonly Requirement[],
  evidence: Evidence,
): RequirementReport {
  const verification = evidence.verification ?? null;
  const verified = verification?.verdict === 'verified';
  const checksFailed = verification?.verdict === 'failed';

  const assessed = requirements.map((requirement): AssessedRequirement => {
    const files = matchingFiles(requirement, evidence.changedFiles);

    if (files.length === 0) {
      // A requirement naming no files can never be linked to a change, so it
      // stays open and says why rather than being silently marked done by a
      // passing suite it has no connection to.
      return {
        ...requirement,
        status: 'open',
        files,
        evidence:
          requirement.mentions.length === 0
            ? 'No file was named, so no change can be linked to this.'
            : 'None of the files this names have changed.',
      };
    }

    if (checksFailed) {
      return {
        ...requirement,
        status: 'failing',
        files,
        evidence: `${describeFiles(files)} changed, but the project's checks are failing.`,
      };
    }

    if (verified) {
      return {
        ...requirement,
        status: 'evidenced',
        files,
        // "changed and the checks passed" — never "this requirement is met".
        // The checks cannot see whether the requirement is semantically true.
        evidence: `${describeFiles(files)} changed, and the project's checks passed afterwards.`,
      };
    }

    return {
      ...requirement,
      status: 'touched',
      files,
      evidence:
        verification === null
          ? `${describeFiles(files)} changed. Nothing has verified the result yet.`
          : `${describeFiles(files)} changed, but verification did not complete.`,
    };
  });

  const evidencedCount = assessed.filter((r) => r.status === 'evidenced').length;

  return {
    requirements: assessed,
    evidencedCount,
    total: assessed.length,
    summary:
      assessed.length === 0
        ? null
        : `${evidencedCount} of ${assessed.length} backed by evidence`,
  };
}

function describeFiles(files: readonly string[]): string {
  if (files.length === 1) {
    return files[0] ?? '';
  }
  return `${files.length} files`;
}
