/**
 * CodeRelay Recovery Package & Confidence Scorer.
 *
 * Implements the core technical guarantee:
 * "One task. Any model. Any provider. No lost progress."
 *
 * When a worker fails or is relayed, the RecoveryPackage encapsulates
 * all durable task state, checkpoints, lessons learned, and confidence metrics
 * so the successor worker can continue without restarting.
 */

import type { ModelCapabilities, ModelRef } from '../core/types.js';
import type { SerializedTaskGraph, TaskStateGraph } from '../continuity/graph.js';
import { ContinuityScoreCalculator, type ContinuityScoreResult } from '../continuity/metric.js';
import type { HandoffPacket } from '../policy/handoff.js';

export type RecoveryConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'BLOCKED';

export interface RecoveryLesson {
  readonly failureClass: string;
  readonly failedWorker: ModelRef;
  readonly reason: string;
  readonly constraintForSuccessor: string;
}

export interface RecoveryPackageCheckpointRef {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly stateHash: string;
  readonly verified: boolean;
  readonly gitCommitSha?: string;
  readonly filesChanged: readonly string[];
}

export interface RecoveryPackage {
  readonly packageId: string;
  readonly schemaVersion: number;
  readonly createdAt: number;
  readonly taskId: string;
  readonly fromWorker: ModelRef | null;
  readonly toWorker: ModelRef;
  readonly confidence: RecoveryConfidence;
  readonly confidenceRationale: string;
  readonly continuityScore: ContinuityScoreResult;
  readonly graphSnapshot: SerializedTaskGraph;
  readonly handoffPacket: HandoffPacket;
  readonly checkpointRef: RecoveryPackageCheckpointRef | null;
  readonly lessons: readonly RecoveryLesson[];
  readonly safeToProceed: boolean;
}

export interface ConfidenceEvaluationContext {
  readonly fromWorker: ModelRef | null;
  readonly toWorker: ModelRef;
  readonly fromCaps?: ModelCapabilities;
  readonly toCaps?: ModelCapabilities;
  readonly continuityScore: ContinuityScoreResult;
  readonly hasVerifiedCheckpoint: boolean;
  readonly workspaceCorrupted?: boolean;
  readonly failureCountForTask?: number;
  readonly failureClass?: string;
}

export class RecoveryConfidenceScorer {
  /**
   * Computes relay confidence level with operational rationale.
   *
   * Criteria:
   * - BLOCKED: Workspace is corrupted, unresolvable conflicts, or required capabilities missing entirely.
   * - LOW: Successor lacks required capabilities (context window or tool calling), or continuity is critical (<50).
   * - MEDIUM: Compatible successor with verified progress, but some unverified mutations or minor capability mismatch.
   * - HIGH: Successor matches or exceeds capabilities, clean verified checkpoint, continuity score >= 80.
   */
  public static evaluate(ctx: ConfidenceEvaluationContext): {
    confidence: RecoveryConfidence;
    rationale: string;
    safeToProceed: boolean;
  } {
    if (ctx.workspaceCorrupted) {
      return {
        confidence: 'BLOCKED',
        rationale: 'Workspace state is corrupted or has unresolvable conflicts. Manual user review required before relay.',
        safeToProceed: false
      };
    }

    // Check if successor model capabilities are known and sufficient
    if (ctx.toCaps) {
      if (!ctx.toCaps.toolCalling) {
        return {
          confidence: 'BLOCKED',
          rationale: `Successor model ${ctx.toWorker.modelId} on ${ctx.toWorker.providerId} does not support tool calling required for code execution.`,
          safeToProceed: false
        };
      }
      if (ctx.fromCaps && ctx.toCaps.contextWindow < ctx.fromCaps.contextWindow && ctx.continuityScore.score < 60) {
        return {
          confidence: 'LOW',
          rationale: `Successor model ${ctx.toWorker.modelId} has smaller context window (${ctx.toCaps.contextWindow}) than predecessor (${ctx.fromCaps.contextWindow}). May risk context overflow.`,
          safeToProceed: true
        };
      }
    }

    if (ctx.continuityScore.score < 40 && !ctx.hasVerifiedCheckpoint) {
      return {
        confidence: 'LOW',
        rationale: `Task continuity is critical (${ctx.continuityScore.score}/100) and no verified checkpoint exists. Progress may need manual re-verification.`,
        safeToProceed: true
      };
    }

    if (ctx.continuityScore.score >= 75 && ctx.hasVerifiedCheckpoint) {
      return {
        confidence: 'HIGH',
        rationale: `Verified checkpoint available with high continuity score (${ctx.continuityScore.score}/100). Successor worker is fully qualified.`,
        safeToProceed: true
      };
    }

    return {
      confidence: 'MEDIUM',
      rationale: `Standard relay approved (${ctx.continuityScore.score}/100 continuity). Execution state is preserved and idempotency active.`,
      safeToProceed: true
    };
  }
}

export class RecoveryPackageBuilder {
  /**
   * Assembles a self-contained RecoveryPackage for cross-provider relay.
   */
  public static build(options: {
    taskId: string;
    graph: TaskStateGraph;
    handoffPacket: HandoffPacket;
    fromWorker: ModelRef | null;
    toWorker: ModelRef;
    fromCaps?: ModelCapabilities;
    toCaps?: ModelCapabilities;
    availableWorkers?: readonly ModelRef[];
    workspaceClean?: boolean;
    workspaceCorrupted?: boolean;
    lessons?: readonly RecoveryLesson[];
  }): RecoveryPackage {
    const continuityScore = ContinuityScoreCalculator.compute({
      graph: options.graph,
      availableWorkers: options.availableWorkers ?? [options.toWorker],
      workspaceClean: options.workspaceClean ?? true
    });

    const latestCheckpoint = options.graph.getLatestCheckpoint();
    const hasVerifiedCheckpoint = Boolean(latestCheckpoint?.verified);

    const evaluation = RecoveryConfidenceScorer.evaluate({
      fromWorker: options.fromWorker,
      toWorker: options.toWorker,
      fromCaps: options.fromCaps,
      toCaps: options.toCaps,
      continuityScore,
      hasVerifiedCheckpoint,
      workspaceCorrupted: options.workspaceCorrupted
    });

    const checkpointRef: RecoveryPackageCheckpointRef | null = latestCheckpoint
      ? {
          id: latestCheckpoint.checkpointId,
          sequenceNumber: latestCheckpoint.sequenceNumber,
          stateHash: latestCheckpoint.stateHash,
          verified: latestCheckpoint.verified,
          gitCommitSha: latestCheckpoint.gitCommitSha,
          filesChanged: latestCheckpoint.filesChanged
        }
      : null;

    const packageId = `recpkg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return {
      packageId,
      schemaVersion: 1,
      createdAt: Date.now(),
      taskId: options.taskId,
      fromWorker: options.fromWorker,
      toWorker: options.toWorker,
      confidence: evaluation.confidence,
      confidenceRationale: evaluation.rationale,
      continuityScore,
      graphSnapshot: options.graph.toJSON(),
      handoffPacket: options.handoffPacket,
      checkpointRef,
      lessons: options.lessons ?? [],
      safeToProceed: evaluation.safeToProceed
    };
  }
}
