/**
 * Workspace Safety Checker.
 *
 * Implements Feature 2 & 13: Technical Guarantee Boundary.
 *
 * Before any cross-provider relay, rollback, or destructive recovery action,
 * CodeRelay verifies:
 * 1. Current workspace state vs. recorded checkpoint hashes
 * 2. Uncommitted / dirty mutations
 * 3. File hash integrity
 * 4. Safety boundary gates (ensuring no partial writes or silent data loss)
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { CheckpointNode } from '../continuity/graph.js';
import type { GitRunner } from '../checkpoint/git.js';

export interface FileSafetyStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly currentHash?: string;
  readonly expectedHash?: string;
  readonly isModified: boolean;
  readonly isMissing: boolean;
}

export interface WorkspaceSafetyReport {
  readonly clean: boolean;
  readonly timestamp: number;
  readonly filesChecked: number;
  readonly modifiedFiles: readonly string[];
  readonly missingFiles: readonly string[];
  readonly corruptedFiles: readonly string[];
  readonly fileStatuses: readonly FileSafetyStatus[];
  readonly gitStatusSummary?: string;
}

export interface RelaySafetyDecision {
  readonly safeToRelay: boolean;
  readonly recommendation: 'PROCEED' | 'CHECKPOINT_FIRST' | 'ROLLBACK_FIRST' | 'BLOCK_USER_INPUT';
  readonly reason: string;
}

export class WorkspaceSafetyChecker {
  /**
   * Computes SHA-256 hash of a file's contents.
   */
  public static async computeFileHash(filePath: string): Promise<string | null> {
    try {
      const content = await readFile(filePath);
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Audits a set of files against expected hashes to detect untracked/corrupted edits.
   */
  public static async auditFiles(
    workspaceRoot: string,
    expectedHashes: Readonly<Record<string, string>>
  ): Promise<WorkspaceSafetyReport> {
    const fileStatuses: FileSafetyStatus[] = [];
    const modifiedFiles: string[] = [];
    const missingFiles: string[] = [];
    const corruptedFiles: string[] = [];

    for (const [relPath, expHash] of Object.entries(expectedHashes)) {
      const fullPath = isAbsolute(relPath) ? relPath : resolve(workspaceRoot, relPath);
      let exists = false;
      let currentHash: string | null = null;

      try {
        const s = await stat(fullPath);
        if (s.isFile()) {
          exists = true;
          currentHash = await WorkspaceSafetyChecker.computeFileHash(fullPath);
        }
      } catch {
        exists = false;
      }

      if (!exists) {
        missingFiles.push(relPath);
        fileStatuses.push({
          path: relPath,
          exists: false,
          expectedHash: expHash,
          isModified: false,
          isMissing: true
        });
      } else if (currentHash !== expHash) {
        modifiedFiles.push(relPath);
        fileStatuses.push({
          path: relPath,
          exists: true,
          currentHash: currentHash ?? undefined,
          expectedHash: expHash,
          isModified: true,
          isMissing: false
        });
      } else {
        fileStatuses.push({
          path: relPath,
          exists: true,
          currentHash: currentHash ?? undefined,
          expectedHash: expHash,
          isModified: false,
          isMissing: false
        });
      }
    }

    const clean = modifiedFiles.length === 0 && missingFiles.length === 0 && corruptedFiles.length === 0;

    return {
      clean,
      timestamp: Date.now(),
      filesChecked: Object.keys(expectedHashes).length,
      modifiedFiles,
      missingFiles,
      corruptedFiles,
      fileStatuses
    };
  }

  /**
   * Verifies git status using an injected GitRunner.
   */
  public static async checkGitStatus(git: GitRunner): Promise<{ isClean: boolean; statusOutput: string }> {
    try {
      const res = await git.run(['status', '--porcelain']);
      if (res.exitCode === 0) {
        const out = res.stdout.trim();
        return { isClean: out === '', statusOutput: out };
      }
      return { isClean: false, statusOutput: `Git error: ${res.stderr}` };
    } catch (err) {
      return { isClean: false, statusOutput: String(err) };
    }
  }

  /**
   * Evaluates whether a cross-provider relay is safe to initiate based on safety audit and continuity.
   */
  public static evaluateRelaySafety(
    report: WorkspaceSafetyReport,
    latestCheckpoint: CheckpointNode | null,
    continuityScore: number
  ): RelaySafetyDecision {
    if (report.missingFiles.length > 0) {
      return {
        safeToRelay: false,
        recommendation: 'BLOCK_USER_INPUT',
        reason: `${report.missingFiles.length} tracked files are missing from workspace (${report.missingFiles.slice(0, 3).join(', ')}). Possible deletion conflict.`
      };
    }

    if (report.modifiedFiles.length > 0) {
      if (!latestCheckpoint) {
        return {
          safeToRelay: false,
          recommendation: 'CHECKPOINT_FIRST',
          reason: `${report.modifiedFiles.length} files have uncheckpointed changes. Create a verified checkpoint before relaying.`
        };
      }

      // Check if checkpoint covered these files
      const uncheckpointed = report.modifiedFiles.filter((f) => !latestCheckpoint.filesChanged.includes(f));
      if (uncheckpointed.length > 0) {
        return {
          safeToRelay: false,
          recommendation: 'CHECKPOINT_FIRST',
          reason: `${uncheckpointed.length} files modified after latest checkpoint ${latestCheckpoint.checkpointId}. Checkpoint state first to prevent lost progress.`
        };
      }
    }

    if (continuityScore < 40) {
      return {
        safeToRelay: true,
        recommendation: 'PROCEED',
        reason: `Continuity score is low (${continuityScore}/100). Successor worker will execute with active side-effect deduplication.`
      };
    }

    return {
      safeToRelay: true,
      recommendation: 'PROCEED',
      reason: 'Workspace is verified clean and synchronized with checkpoint state.'
    };
  }
}
