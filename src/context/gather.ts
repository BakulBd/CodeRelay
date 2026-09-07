/**
 * Collecting the signals `selectContext` ranks.
 *
 * Split out from `select.ts` for the same reason `verify/exec.ts` is split from
 * `verify/run.ts`: the ranking is a pure function that must be exhaustively
 * testable, and exactly one small module is allowed to know about the editor.
 *
 * Everything here is an *observation*, never an inference. A file is reported
 * as open because a tab holds it, as diagnosed because the language server said
 * so, as changed because a fingerprint differs. Nothing in this file decides
 * what any of that means — that is `selectContext`'s job, and keeping the two
 * apart is what lets the panel say "open in the editor" and be exactly right.
 */
import type { CandidateFile } from './select.js';

/** The editor facts this module needs, in a shape with no `vscode` import. */
export interface GatherInputs {
  /** Workspace-relative paths of every file worth considering. */
  readonly workspaceFiles: readonly string[];
  /** Paths currently open in a tab. */
  readonly openPaths: readonly string[];
  /** Path → number of errors and warnings reported against it. */
  readonly diagnostics: ReadonlyMap<string, number>;
  /** Paths this task has already changed, from recorded fingerprints. */
  readonly changedPaths: readonly string[];
  /** Paths the user named with `@` in the composer. */
  readonly mentionedPaths: readonly string[];
  /** Path → size in bytes, where known. */
  readonly sizes?: ReadonlyMap<string, number>;
}

/**
 * Normalise a path for comparison.
 *
 * Separators unified and any leading `./` removed, because the same file
 * arrives spelled three ways: `src/a.ts` from a glob, `./src/a.ts` from a
 * mention, and `src\a.ts` on Windows. Comparing them unnormalised produced a
 * file listed twice with different reasons, which reads as a bug in the panel
 * even though the ranking was right.
 */
export function normalisePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Merge the signals into one candidate list.
 *
 * A file mentioned, open *and* changed appears once carrying all three, because
 * the union is what the ranking is meant to see. The candidate set is the union
 * of every signal source rather than just the workspace listing, so a mentioned
 * file outside the glob is still considered.
 */
export function gatherCandidates(inputs: GatherInputs): readonly CandidateFile[] {
  const open = new Set(inputs.openPaths.map(normalisePath));
  const changed = new Set(inputs.changedPaths.map(normalisePath));
  const mentioned = new Set(inputs.mentionedPaths.map(normalisePath));

  const diagnostics = new Map<string, number>();
  for (const [path, count] of inputs.diagnostics) {
    diagnostics.set(normalisePath(path), count);
  }
  const sizes = new Map<string, number>();
  for (const [path, bytes] of inputs.sizes ?? []) {
    sizes.set(normalisePath(path), bytes);
  }

  // The union, not just the workspace listing: a mentioned file that the glob
  // missed is still a file the user asked for.
  const all = new Set<string>([
    ...inputs.workspaceFiles.map(normalisePath),
    ...open,
    ...changed,
    ...mentioned,
  ]);

  const candidates: CandidateFile[] = [];
  for (const path of all) {
    if (path === '') {
      continue;
    }
    const size = sizes.get(path);
    candidates.push({
      path,
      bytes: size ?? null,
      mentioned: mentioned.has(path),
      open: open.has(path),
      diagnostics: diagnostics.get(path) ?? 0,
      changed: changed.has(path),
    });
  }

  // Sorted so the candidate list itself is deterministic; the ranking sorts
  // again, but a stable input makes a stable output easier to reason about.
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}
