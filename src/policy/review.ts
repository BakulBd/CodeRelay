/**
 * Multi-Model Review Orchestration.
 *
 * Implements Feature 14: Multi-Model Review (Worker A implements, Worker B reviews, Worker C verifies).
 *
 * Provides cross-worker verification: the model that wrote the code does not have
 * the final word on whether it meets requirements. A secondary, independent worker
 * reviews diffs for edge cases, security flaws, and requirement adherence.
 */

import type { ModelRef } from '../core/types.js';

export type ReviewFindingSeverity = 'critical' | 'warning' | 'suggestion';
export type ReviewFindingCategory = 'correctness' | 'security' | 'edge_case' | 'performance' | 'style';

export interface ReviewFinding {
  readonly id: string;
  readonly severity: ReviewFindingSeverity;
  readonly category: ReviewFindingCategory;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
  readonly suggestion?: string;
}

export interface MultiModelReviewVerdict {
  readonly approved: boolean;
  readonly reviewerModel: ModelRef;
  readonly implementerModel: ModelRef;
  readonly timestamp: number;
  readonly findings: readonly ReviewFinding[];
  readonly criticalCount: number;
  readonly warningCount: number;
  readonly summary: string;
}

export interface BuildReviewPromptOptions {
  readonly taskObjective: string;
  readonly requirements: readonly { readonly id: string; readonly text: string }[];
  readonly filesModified: readonly string[];
  readonly diffSummary: string;
  readonly testResults?: string;
}

export class MultiModelReviewOrchestrator {
  /**
   * Constructs the prompt for an independent reviewer worker.
   */
  public static buildReviewPrompt(options: BuildReviewPromptOptions): string {
    const lines: string[] = [
      '# CODERELAY INDEPENDENT MULTI-MODEL CODE REVIEW',
      '',
      '> You are an independent code reviewer worker in the CodeRelay continuity pipeline.',
      '> Another worker has implemented code for the task described below.',
      '> Your job is to thoroughly audit the diff for correctness, security, edge cases, and requirement adherence.',
      '',
      `## Task Objective: ${options.taskObjective}`,
      ''
    ];

    if (options.requirements.length > 0) {
      lines.push('## Requirements to Verify:');
      for (const r of options.requirements) {
        lines.push(`- (${r.id}) ${r.text}`);
      }
      lines.push('');
    }

    if (options.filesModified.length > 0) {
      lines.push(`## Files Modified: ${options.filesModified.join(', ')}`);
      lines.push('');
    }

    if (options.testResults) {
      lines.push(`## Automated Test Status:\n${options.testResults}\n`);
    }

    lines.push('## Diff to Review:');
    lines.push('```diff');
    lines.push(options.diffSummary.slice(0, 12_000));
    lines.push('```');
    lines.push('');

    lines.push('## Instructions:');
    lines.push('Provide your review in structured markdown with:');
    lines.push('1. VERDICT: APPROVED or CHANGES_REQUESTED');
    lines.push('2. SUMMARY: 1-2 sentence overview of implementation quality.');
    lines.push('3. FINDINGS: List each finding with:');
    lines.push('   - [CRITICAL | WARNING | SUGGESTION]');
    lines.push('   - Category: [correctness | security | edge_case | performance | style]');
    lines.push('   - File: path/to/file');
    lines.push('   - Details and recommended fix');

    return lines.join('\n');
  }

  /**
   * Parses raw reviewer output into a structured verdict and findings list.
   */
  public static parseReviewVerdict(
    rawOutput: string,
    implementer: ModelRef,
    reviewer: ModelRef
  ): MultiModelReviewVerdict {
    const isApproved =
      rawOutput.toUpperCase().includes('VERDICT: APPROVED') ||
      (rawOutput.toUpperCase().includes('APPROVED') && !rawOutput.toUpperCase().includes('CHANGES_REQUESTED'));

    const findings: ReviewFinding[] = [];
    const lines = rawOutput.split('\n');

    let currentSeverity: ReviewFindingSeverity = 'warning';
    let currentCategory: ReviewFindingCategory = 'correctness';
    let currentFile = 'workspace';
    let findingCounter = 1;

    for (const line of lines) {
      const trimmed = line.trim();
      const upper = trimmed.toUpperCase();

      if (upper.includes('[CRITICAL]') || upper.includes('CRITICAL:')) {
        currentSeverity = 'critical';
      } else if (upper.includes('[WARNING]') || upper.includes('WARNING:')) {
        currentSeverity = 'warning';
      } else if (upper.includes('[SUGGESTION]') || upper.includes('SUGGESTION:')) {
        currentSeverity = 'suggestion';
      }

      if (upper.includes('SECURITY')) {
        currentCategory = 'security';
      } else if (upper.includes('EDGE_CASE') || upper.includes('EDGE CASE')) {
        currentCategory = 'edge_case';
      } else if (upper.includes('PERFORMANCE')) {
        currentCategory = 'performance';
      }

      const fileMatch = trimmed.match(/(?:file|path):\s*([^\s,]+)/i);
      if (fileMatch && fileMatch[1]) {
        currentFile = fileMatch[1];
      }

      if (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed)) {
        const message = trimmed.replace(/^[-*\d.]+\s*/, '').trim();
        if (message.length > 15 && !upper.startsWith('VERDICT') && !upper.startsWith('SUMMARY')) {
          findings.push({
            id: `find_${findingCounter++}`,
            severity: currentSeverity,
            category: currentCategory,
            file: currentFile,
            message
          });
        }
      }
    }

    const criticalCount = findings.filter((f) => f.severity === 'critical').length;
    const warningCount = findings.filter((f) => f.severity === 'warning').length;

    const approved = isApproved && criticalCount === 0;

    return {
      approved,
      reviewerModel: reviewer,
      implementerModel: implementer,
      timestamp: Date.now(),
      findings,
      criticalCount,
      warningCount,
      summary: approved
        ? `Reviewer ${reviewer.modelId} APPROVED changes (${findings.length} findings, 0 critical).`
        : `Reviewer ${reviewer.modelId} REQUESTED CHANGES (${criticalCount} critical, ${warningCount} warnings).`
    };
  }
}
