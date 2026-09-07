/**
 * CodeRelay Continuity Score Calculator.
 *
 * Engineering metric (0-100) reflecting task health, verification depth,
 * worker diversity, and safe-relay readiness.
 *
 * "Models can fail. Your coding task should not."
 */

import type { ModelRef } from '../core/types.js';
import type { TaskStateGraph, ToolActionNode } from './graph.js';

export type ContinuityHealth = 'HEALTHY' | 'AT_RISK' | 'CRITICAL';

export interface ScoreCategory {
  readonly score: number;
  readonly max: number;
  readonly details: string;
}

export interface ContinuityScoreBreakdown {
  readonly checkpointIntegrity: ScoreCategory;
  readonly requirementCoverage: ScoreCategory;
  readonly verificationRecency: ScoreCategory;
  readonly workerDiversity: ScoreCategory;
  readonly actionIdempotency: ScoreCategory;
}

export interface ContinuityScoreResult {
  readonly score: number; // 0 - 100
  readonly health: ContinuityHealth;
  readonly breakdown: ContinuityScoreBreakdown;
  readonly summary: string;
  readonly recommendations: readonly string[];
}

export interface ContinuityContext {
  readonly graph: TaskStateGraph;
  readonly availableWorkers?: readonly ModelRef[];
  readonly workspaceClean?: boolean;
  readonly pendingFileModifications?: boolean;
}

export class ContinuityScoreCalculator {
  /**
   * Computes the 0-100 Continuity Score with audit breakdown.
   */
  public static compute(context: ContinuityContext): ContinuityScoreResult {
    const { graph, availableWorkers = [], workspaceClean = true, pendingFileModifications = false } = context;

    // 1. Checkpoint Integrity (Max: 20)
    // Evaluates whether a valid, verified checkpoint exists and matches workspace state.
    const latestCheckpoint = graph.getLatestCheckpoint();
    let checkpointScore = 0;
    let checkpointDetails = 'No checkpoint recorded yet.';

    if (latestCheckpoint) {
      if (latestCheckpoint.verified && !pendingFileModifications && workspaceClean) {
        checkpointScore = 20;
        checkpointDetails = `Bound to verified checkpoint ${latestCheckpoint.checkpointId} (${latestCheckpoint.reason})`;
      } else if (latestCheckpoint.verified) {
        checkpointScore = 14;
        checkpointDetails = `Verified checkpoint ${latestCheckpoint.checkpointId} exists, but uncommitted edits are pending.`;
      } else {
        checkpointScore = 8;
        checkpointDetails = `Unverified checkpoint ${latestCheckpoint.checkpointId} recorded.`;
      }
    }

    // 2. Requirement Coverage (Max: 25)
    // Ratio of evidenced requirements over total requirements.
    const requirements = graph.getRequirements();
    let reqScore = 25;
    let reqDetails = 'No requirements registered.';

    if (requirements.length > 0) {
      const evidenced = requirements.filter((r) => r.status === 'evidenced').length;
      const touched = requirements.filter((r) => r.status === 'touched').length;
      const failing = requirements.filter((r) => r.status === 'failing').length;

      const ratio = (evidenced * 1.0 + touched * 0.4) / requirements.length;
      reqScore = Math.min(25, Math.round(ratio * 25));
      reqDetails = `${evidenced}/${requirements.length} evidenced, ${touched} touched, ${failing} failing`;
    }

    // 3. Verification Recency (Max: 20)
    // Have verifications (tests/build/diagnostics) passed since the last mutating action?
    const latestVerification = graph.getLatestVerification();
    const actions = graph.getCompletedActions();
    let verifyScore = 0;
    let verifyDetails = 'No verification executed yet.';

    if (latestVerification) {
      const verificationTime = latestVerification.createdAt;
      const recentMutatingAction = actions.find((a) => a.createdAt > verificationTime);

      if (latestVerification.passed) {
        if (!recentMutatingAction && !pendingFileModifications) {
          verifyScore = 20;
          verifyDetails = `Latest verification PASSED (${latestVerification.passedCount}/${latestVerification.checksCount} checks) with 0 trailing mutations.`;
        } else {
          verifyScore = 12;
          verifyDetails = `Verification passed, but ${recentMutatingAction ? 'tool actions' : 'file edits'} occurred after verification.`;
        }
      } else {
        verifyScore = 4;
        verifyDetails = `Latest verification FAILED (${latestVerification.failureCount} errors, ${latestVerification.diagnosticsCount} diagnostics).`;
      }
    } else if (actions.length === 0) {
      // Clean slate before mutations: partial baseline
      verifyScore = 10;
      verifyDetails = 'Initial state: no mutations made yet.';
    }

    // 4. Worker Diversity (Max: 15)
    // Are there multiple capable, distinct workers/providers available to take over if current fails?
    const distinctProviders = new Set(availableWorkers.map((w) => w.providerId));
    let diversityScore = 0;
    let diversityDetails = 'No alternative workers registered.';

    if (distinctProviders.size >= 3) {
      diversityScore = 15;
      diversityDetails = `${distinctProviders.size} distinct providers ready for failover relay.`;
    } else if (distinctProviders.size === 2) {
      diversityScore = 11;
      diversityDetails = '2 providers configured (primary + fallback).';
    } else if (distinctProviders.size === 1) {
      diversityScore = 6;
      diversityDetails = 'Single provider configured. No cross-provider redundancy.';
    }

    // 5. Action Idempotency & Progress Stability (Max: 20)
    // Are all tool actions hashed and stable? Any duplicate attempts?
    let idempotencyScore = 20;
    let idempotencyDetails = 'All actions deduplicated and hashed.';

    if (actions.length > 0) {
      const skippedDuplicates = actions.filter((a) => a.status === 'skipped_duplicate').length;
      const failedActions = actions.filter((a) => a.status === 'failed').length;

      if (failedActions > 0) {
        idempotencyScore = Math.max(8, 20 - failedActions * 4);
        idempotencyDetails = `${actions.length} actions (${failedActions} failed, ${skippedDuplicates} safely skipped duplicates).`;
      } else {
        idempotencyDetails = `${actions.length} actions executed with side-effect hashing (${skippedDuplicates} duplicates prevented).`;
      }
    }

    // Total Score
    const totalScore = Math.max(0, Math.min(100, checkpointScore + reqScore + verifyScore + diversityScore + idempotencyScore));

    const health: ContinuityHealth =
      totalScore >= 80 ? 'HEALTHY' : totalScore >= 50 ? 'AT_RISK' : 'CRITICAL';

    const recommendations: string[] = [];
    if (checkpointScore < 15) {
      recommendations.push('Create a verified git/state checkpoint to anchor task progress.');
    }
    if (verifyScore < 15) {
      recommendations.push('Run verification (test/build/lint) to certify recent workspace edits.');
    }
    if (diversityScore < 10) {
      recommendations.push('Configure a secondary fallback provider in CodeRelay setup to enable cross-provider relay.');
    }
    if (reqScore < 15 && requirements.length > 0) {
      recommendations.push('Tie concrete verification evidence to open requirements.');
    }

    const summary = `Continuity: ${totalScore}/100 [${health}] - ${recommendations[0] ?? 'Task state is fully resilient and relay-ready.'}`;

    return {
      score: totalScore,
      health,
      breakdown: {
        checkpointIntegrity: { score: checkpointScore, max: 20, details: checkpointDetails },
        requirementCoverage: { score: reqScore, max: 25, details: reqDetails },
        verificationRecency: { score: verifyScore, max: 20, details: verifyDetails },
        workerDiversity: { score: diversityScore, max: 15, details: diversityDetails },
        actionIdempotency: { score: idempotencyScore, max: 20, details: idempotencyDetails }
      },
      summary,
      recommendations
    };
  }
}
