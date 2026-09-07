/**
 * Provider-Independent Context Manifest.
 *
 * Implements Feature 7: Context Reconstruction vs Transcript Replay.
 *
 * Instead of replaying conversational history or raw chat transcripts across models
 * (which causes format leaks, thinking block syntax errors, context overflow,
 * and hallucinated continuity), CodeRelay synthesizes a clean, structured
 * Context Manifest for the successor worker.
 */

import type { TaskStateGraph, ToolActionNode } from '../continuity/graph.js';
import type { RecoveryLesson } from '../recovery/package.js';
import type { FailureDiagnosis } from '../recovery/decision.js';

export interface TaskContract {
  readonly objective: string;
  readonly planTitle?: string;
  readonly planMarkdown?: string;
  readonly requirements: readonly { readonly id: string; readonly text: string; readonly status: string }[];
}

export interface CurrentWorkspaceStateSummary {
  readonly modifiedFiles: readonly string[];
  readonly checkpointRef?: string;
  readonly gitClean: boolean;
  readonly diagnosticErrors: number;
}

export interface CompletedVerifiedWork {
  readonly completedSteps: readonly string[];
  readonly completedToolActions: readonly { readonly tool: string; readonly summary: string; readonly ok: boolean }[];
  readonly testSummary?: string;
}

export interface FailureContextForSuccessor {
  readonly failureVariant?: string;
  readonly failedWorkerName?: string;
  readonly failureReason?: string;
  readonly lessonsToAvoid: readonly string[];
}

export interface NextActionDirective {
  readonly stepNumber?: number;
  readonly stepTitle: string;
  readonly directive: string;
}

export interface ActiveConstraints {
  readonly tokenBudget?: number;
  readonly allowedTools: readonly string[];
  readonly safetyBoundary: string;
}

export interface ContextManifest {
  readonly manifestId: string;
  readonly schemaVersion: number;
  readonly createdAt: number;
  readonly taskId: string;
  readonly contract: TaskContract;
  readonly currentState: CurrentWorkspaceStateSummary;
  readonly completedWork: CompletedVerifiedWork;
  readonly failureContext: FailureContextForSuccessor;
  readonly nextAction: NextActionDirective;
  readonly constraints: ActiveConstraints;
}

export interface BuildManifestOptions {
  readonly taskId: string;
  readonly graph: TaskStateGraph;
  readonly diagnosis?: FailureDiagnosis;
  readonly lessons?: readonly RecoveryLesson[];
  readonly tokenBudget?: number;
  readonly allowedTools?: readonly string[];
}

export class ContextManifestBuilder {
  /**
   * Constructs a structured ContextManifest from the TaskStateGraph and recovery context.
   */
  public static build(options: BuildManifestOptions): ContextManifest {
    const { graph, diagnosis, lessons = [], tokenBudget, allowedTools = ['read_file', 'write_file', 'run_command'] } = options;

    const goal = graph.getGoal();
    const requirements = graph.getRequirements();
    const completedSteps = graph.getCompletedSteps();
    const remainingSteps = graph.getRemainingSteps();
    const completedActions = graph.getCompletedActions();
    const latestCheckpoint = graph.getLatestCheckpoint();
    const latestVerification = graph.getLatestVerification();

    const contract: TaskContract = {
      objective: goal?.objective ?? 'Complete requested coding task.',
      requirements: requirements.map((r) => ({
        id: r.requirementId,
        text: r.text,
        status: r.status
      }))
    };

    const currentState: CurrentWorkspaceStateSummary = {
      modifiedFiles: graph.getRelevantFiles(),
      checkpointRef: latestCheckpoint?.checkpointId,
      gitClean: Boolean(latestCheckpoint?.verified),
      diagnosticErrors: latestVerification?.failureCount ?? 0
    };

    const completedWork: CompletedVerifiedWork = {
      completedSteps: completedSteps.map((s) => `Step ${s.stepNumber}: ${s.title}`),
      completedToolActions: completedActions.slice(-10).map((a) => ({
        tool: a.toolName,
        summary: `Action on ${a.paths.join(', ') || 'workspace'} (${a.status})`,
        ok: a.status === 'succeeded' || a.status === 'skipped_duplicate'
      })),
      testSummary: latestVerification ? latestVerification.summary : undefined
    };

    const lessonsToAvoid = lessons.map((l) => `${l.reason} -> ${l.constraintForSuccessor}`);
    if (diagnosis && !lessonsToAvoid.length) {
      lessonsToAvoid.push(`Previous attempt failed: ${diagnosis.operationalExplanation}. Do not repeat this pattern.`);
    }

    const failureContext: FailureContextForSuccessor = {
      failureVariant: diagnosis?.variant,
      failureReason: diagnosis?.operationalExplanation,
      lessonsToAvoid
    };

    const nextStep = remainingSteps[0];
    const nextAction: NextActionDirective = nextStep
      ? {
          stepNumber: nextStep.stepNumber,
          stepTitle: nextStep.title,
          directive: `Continue executing Step ${nextStep.stepNumber}: ${nextStep.title}. Do not re-execute completed steps.`
        }
      : {
          stepTitle: 'Final Verification',
          directive: 'All steps recorded as completed. Run project test suite and verify build integrity before closing task.'
        };

    const constraints: ActiveConstraints = {
      tokenBudget,
      allowedTools,
      safetyBoundary: 'Side-effect deduplication active. Mutating actions are checked against verified checkpoints.'
    };

    const manifestId = `ctxman_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    return {
      manifestId,
      schemaVersion: 1,
      createdAt: Date.now(),
      taskId: options.taskId,
      contract,
      currentState,
      completedWork,
      failureContext,
      nextAction,
      constraints
    };
  }

  /**
   * Renders the ContextManifest into a clean markdown prompt for a successor worker.
   * Eliminates all vendor-specific artifacts, raw thinking blocks, or provider-scoped IDs.
   */
  public static renderForSuccessor(manifest: ContextManifest): string {
    const lines: string[] = [
      '# CODERELAY TASK CONTINUATION DIRECTIVE',
      '',
      '> You are taking over an active coding task via CodeRelay safe cross-provider handoff.',
      '> Models are replaceable workers. The task is the durable source of truth.',
      '> Follow the verified state below. Do NOT restart work that is already completed.',
      '',
      '## 1. TASK CONTRACT',
      `**Objective:** ${manifest.contract.objective}`,
      ''
    ];

    if (manifest.contract.requirements.length > 0) {
      lines.push('**Requirements:**');
      for (const req of manifest.contract.requirements) {
        lines.push(`- [${req.status === 'evidenced' ? 'x' : ' '}] (${req.id}) ${req.text} [${req.status.toUpperCase()}]`);
      }
      lines.push('');
    }

    lines.push('## 2. CURRENT WORKSPACE STATE');
    if (manifest.currentState.modifiedFiles.length > 0) {
      lines.push(`**Tracked Modified Files:** ${manifest.currentState.modifiedFiles.join(', ')}`);
    } else {
      lines.push('**Tracked Modified Files:** None yet');
    }
    if (manifest.currentState.checkpointRef) {
      lines.push(`**Anchored Checkpoint:** ${manifest.currentState.checkpointRef} (verified: ${manifest.currentState.gitClean})`);
    }
    lines.push('');

    lines.push('## 3. COMPLETED & VERIFIED WORK (DO NOT REPEAT)');
    if (manifest.completedWork.completedSteps.length > 0) {
      for (const step of manifest.completedWork.completedSteps) {
        lines.push(`- ✓ ${step}`);
      }
    } else {
      lines.push('- No plan steps marked completed yet.');
    }
    if (manifest.completedWork.testSummary) {
      lines.push(`**Last Verification:** ${manifest.completedWork.testSummary}`);
    }
    lines.push('');

    if (manifest.failureContext.lessonsToAvoid.length > 0) {
      lines.push('## 4. PRECEDING FAILURE LESSONS (ANTI-PATTERNS)');
      for (const lesson of manifest.failureContext.lessonsToAvoid) {
        lines.push(`- ⚠️ ${lesson}`);
      }
      lines.push('');
    }

    lines.push('## 5. IMMEDIATE NEXT ACTION DIRECTIVE');
    lines.push(`**Target:** ${manifest.nextAction.stepTitle}`);
    lines.push(`**Directive:** ${manifest.nextAction.directive}`);
    lines.push('');

    lines.push('## 6. ACTIVE CONSTRAINTS');
    lines.push(`- Allowed Tools: ${manifest.constraints.allowedTools.join(', ')}`);
    lines.push(`- Safety: ${manifest.constraints.safetyBoundary}`);

    return lines.join('\n');
  }
}
