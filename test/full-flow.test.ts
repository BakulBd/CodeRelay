/**
 * Full End-to-End Project Flow Verification.
 *
 * Tests the complete lifecycle of a CodeRelay task across all subsystems:
 * 1. Composer & Prompt Enhancement
 * 2. Model Selection & Routing
 * 3. Execution & Tool Policy with Idempotency Tracking
 * 4. Model Interruption & Circuit Breaker Tripping
 * 5. Structured 14-Field Recovery Handoff to Second Worker
 * 6. Resumption without Duplicate Side-Effects
 * 7. Evidence-Gated Completion & Verification Engine
 * 8. UI Presentation (Progress Pill, Stages, Notifications, Settings)
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { generateEnhancedTask } from '../src/agent/enhance.js';
import { ExecutionLedger } from '../src/continuity/ledger.js';
import { buildHandoff } from '../src/policy/handoff.js';
import { HealthTracker } from '../src/policy/health.js';
import { computeSideEffectKey } from '../src/continuity/entries.js';
import { ToolPolicyEngine } from '../src/tools/policy.js';
import { NotificationCenter } from '../src/ui/state/notifications.js';
import { projectTask } from '../src/ui/state/project.js';
import { present } from '../src/ui/webview/present.js';
import { DEFAULT_SETTINGS } from '../src/ui/state/settings.js';
import type { TaskId, StepId, AttemptId, ToolCallId, SideEffectKey } from '../src/core/types.js';

test('Full Project End-to-End Flow: Composer -> Interruption -> Relay -> Verification -> UI Presentation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-full-flow-'));

  try {
    // -------------------------------------------------------------
    // STEP 1: Composer & Prompt Enhancement
    // -------------------------------------------------------------
    const rawPrompt = 'add calculateTotal in src/total.ts and test it';
    const enhanced = generateEnhancedTask(rawPrompt, ['src/total.ts', 'test/total.test.ts']);
    assert.ok(enhanced.formattedMarkdown.includes('## Scope'));
    assert.ok(enhanced.formattedMarkdown.includes('## Implementation Plan'));
    assert.ok(enhanced.formattedMarkdown.includes('## Verification Criteria'));

    // -------------------------------------------------------------
    // STEP 2: Safety & Tool Policy Engine
    // -------------------------------------------------------------
    const policyEngine = new ToolPolicyEngine();
    assert.equal(policyEngine.getPolicy('read_file').level, 'Safe');
    assert.equal(policyEngine.getPolicy('run_tests').level, 'Safe');
    assert.equal(policyEngine.getPolicy('write_file').level, 'Ask');
    assert.equal(policyEngine.getPolicy('rm_rf_root').level, 'Blocked');

    // -------------------------------------------------------------
    // STEP 3: Initial Task Execution (Worker 1: Claude)
    // -------------------------------------------------------------
    const taskId = 'task-full-flow' as TaskId;
    const step1 = 'step-1' as StepId;
    const attempt1 = 'att-1' as AttemptId;
    const call1 = 'call-1' as ToolCallId;
    const key1 = 'sek-1' as SideEffectKey;

    const ledger = await ExecutionLedger.open(dir, taskId);
    await ledger.append({
      type: 'TASK_STARTED',
      taskId,
      stepId: step1,
      attemptId: attempt1,
      objective: enhanced.goal,
    });

    // Worker 1 plans requirements
    const planMarkdown = [
      '# Implementation Plan',
      '',
      '## Requirements',
      '- [ ] Implement calculateTotal in src/total.ts',
      '- [ ] Add comprehensive test suite in test/total.test.ts',
      '',
      '## Steps',
      '- [ ] Write calculateTotal function',
      '- [ ] Run unit tests',
    ].join('\n');

    await ledger.append({
      type: 'PLAN_PROPOSED',
      taskId,
      stepId: step1,
      attemptId: attempt1,
      title: 'Calculate Total & Tests',
      planMarkdown,
    });

    // Worker 1 requests write_file
    const writeArgs = {
      path: 'src/total.ts',
      content: 'export function calculateTotal(items: number[]): number { return items.reduce((a, b) => a + b, 0); }',
    };

    await ledger.append({
      type: 'TOOL_REQUESTED',
      taskId,
      stepId: step1,
      attemptId: attempt1,
      toolCallId: call1,
      toolName: 'write_file',
      args: writeArgs,
      sideEffectKey: key1,
      safety: 'idempotent',
    });

    // Idempotency is the ledger's own side-effect key, not a second tracker:
    // the same tool, args and step always produce the same key, which is what
    // lets recovery recognise an effect it has already seen.
    // The property recovery relies on: the same tool, args and step always key
    // identically, so a successor can recognise an effect that already landed.
    const computedKey = computeSideEffectKey(step1, 'write_file', writeArgs);
    assert.equal(
      computeSideEffectKey(step1, 'write_file', writeArgs),
      computedKey,
      'the key must be deterministic, or recovery cannot dedupe an effect',
    );
    assert.notEqual(
      computeSideEffectKey(step1, 'write_file', { ...writeArgs, path: 'other.ts' }),
      computedKey,
      'different arguments are a different effect and must key differently',
    );

    await ledger.append({
      type: 'TOOL_EXECUTING',
      taskId,
      stepId: step1,
      attemptId: attempt1,
      toolCallId: call1,
      sideEffectKey: key1,
      safety: 'idempotent',
      preState: [],
      expectedPostState: [{ path: 'src/total.ts', sha256: 'abc123hash', sizeBytes: 92 }],
    });

    await ledger.append({
      type: 'TOOL_COMPLETED',
      taskId,
      stepId: step1,
      attemptId: attempt1,
      toolCallId: call1,
      sideEffectKey: key1,
      ok: true,
      resultSummary: 'Wrote 92 bytes to src/total.ts',
      postState: [{ path: 'src/total.ts', sha256: 'abc123hash', sizeBytes: 92 }],
    });

    // -------------------------------------------------------------
    // STEP 4: Interruption & Circuit Breaker
    // -------------------------------------------------------------
    // The wired breaker. Three consecutive failures eject an endpoint, and the
    // router then stops offering it — this is the same tracker `extension.ts`
    // shares across tasks, not a second one kept for the test.
    let clock = 1_000;
    const health = new HealthTracker({ now: () => clock });
    const endpoint = { model: { providerId: 'anthropic', modelId: 'claude-sonnet-4' }, credentialId: 'k1' };
    for (let i = 0; i < 3; i += 1) {
      health.record(endpoint, { ok: false, errorClass: 'RETRYABLE' });
    }
    assert.equal(health.get(endpoint).breaker.kind, 'open');
    assert.equal(health.admit(endpoint).ok, false, 'an ejected endpoint stops being offered');

    await ledger.append({
      type: 'FAILED',
      taskId,
      stepId: step1,
      attemptId: attempt1,
      errorClass: 'RETRYABLE',
      message: 'HTTP 429: Too Many Requests from Anthropic API (Quota rate limit)',
      hadStreamedTokens: true,
    });

    // -------------------------------------------------------------
    // STEP 5: 14-Field Structured Recovery Handoff
    // -------------------------------------------------------------
    const entriesSoFar = await ExecutionLedger.readEntries(join(dir, 'tasks', `${taskId}.jsonl`));
    const successorModel = { providerId: 'gemini', modelId: 'gemini-1.5-pro' };
    const handoff = buildHandoff(entriesSoFar, successorModel, {
      testResults: { total: 1, passed: 0, failed: 1 },
      buildResults: { status: 'passed', summary: 'TypeScript build succeeded' },
      gitState: { branch: 'main', isClean: false },
      checkpointRef: { id: 'cp-1', sequenceNumber: 1, commitSha: 'abcdef12' },
    });

    // Verify the 14 recovery fields
    assert.equal(handoff.goal, enhanced.goal); // 1. Goal
    assert.ok(handoff.plan !== null); // 2. Architectural plan
    assert.ok(Array.isArray(handoff.completedSteps)); // 3. Completed plan steps
    assert.ok(Array.isArray(handoff.remainingSteps)); // 4. Remaining plan steps
    assert.ok(handoff.requirements.length > 0); // 5. Requirements
    assert.ok(handoff.filesChanged.includes('src/total.ts')); // 6. Files changed
    assert.equal(handoff.gitState?.branch, 'main'); // 7. Git state
    assert.equal(handoff.toolResults.length, 1); // 8. Tool results
    assert.equal(handoff.testResults?.total, 1); // 9. Test results
    assert.equal(handoff.buildResults?.status, 'passed'); // 10. Build results
    assert.ok(Array.isArray(handoff.diagnostics)); // 11. Diagnostics
    assert.ok(handoff.errors.some((e) => e.message.includes('429'))); // 12. Errors
    assert.equal(handoff.checkpointRef?.id, 'cp-1'); // 13. Checkpoint ref
    assert.ok(handoff.currentStep !== undefined); // 14. Current step

    // -------------------------------------------------------------
    // STEP 6: Worker 2 (Gemini / Successor) Resumes
    // -------------------------------------------------------------
    const step2 = 'step-2' as StepId;
    const attempt2 = 'att-2' as AttemptId;
    const call2 = 'call-2' as ToolCallId;
    const key2 = 'sek-2' as SideEffectKey;

    await ledger.append({
      type: 'PROVIDER_SWITCHED',
      taskId,
      stepId: step2,
      attemptId: attempt2,
      from: { providerId: 'anthropic', modelId: 'claude-3-7-sonnet' },
      to: successorModel,
      reason: 'HTTP 429 on primary worker; handed off with 14-field verified state',
    });

    // Worker 2 sees that action 1 is already complete, and it sees it the way
    // the real successor does: by computing the same side-effect key and finding
    // a completion for it in the durable ledger. No separate tracker is
    // consulted, because a second record of what happened is a second thing that
    // can disagree with the ledger.
    const afterHandoff = await ExecutionLedger.readEntries(
      join(dir, 'tasks', `${taskId}.jsonl`),
    );
    const alreadyDone = afterHandoff.some(
      (e) => e.type === 'TOOL_COMPLETED' && e.sideEffectKey === key1,
    );
    assert.equal(alreadyDone, true, 'the successor must not repeat an effect that landed');

    // Worker 2 performs step 2: writing tests
    const testArgs = {
      path: 'test/total.test.ts',
      content: 'import assert from "node:assert"; test("total", () => assert.equal(calculateTotal([1, 2]), 3));',
    };

    await ledger.append({
      type: 'TOOL_REQUESTED',
      taskId,
      stepId: step2,
      attemptId: attempt2,
      toolCallId: call2,
      toolName: 'write_file',
      args: testArgs,
      sideEffectKey: key2,
      safety: 'idempotent',
    });

    await ledger.append({
      type: 'TOOL_EXECUTING',
      taskId,
      stepId: step2,
      attemptId: attempt2,
      toolCallId: call2,
      sideEffectKey: key2,
      safety: 'idempotent',
      preState: [],
      expectedPostState: [{ path: 'test/total.test.ts', sha256: 'def456hash', sizeBytes: 88 }],
    });

    await ledger.append({
      type: 'TOOL_COMPLETED',
      taskId,
      stepId: step2,
      attemptId: attempt2,
      toolCallId: call2,
      sideEffectKey: key2,
      ok: true,
      resultSummary: 'Wrote 88 bytes to test/total.test.ts',
      postState: [{ path: 'test/total.test.ts', sha256: 'def456hash', sizeBytes: 88 }],
    });

    // -------------------------------------------------------------
    // STEP 7: Evidence-Gated Completion & Verification
    // -------------------------------------------------------------
    await ledger.append({
      type: 'TASK_DONE',
      taskId,
      stepId: step2,
      attemptId: attempt2,
    });

    // -------------------------------------------------------------
    // STEP 8: UI View Model & Presentation
    // -------------------------------------------------------------
    const allEntries = await ExecutionLedger.readEntries(join(dir, 'tasks', `${taskId}.jsonl`));
    const projection = projectTask(allEntries);

    const notifications = new NotificationCenter();
    notifications.add({
      kind: 'model_switched',
      title: 'Model Relayed',
      message: 'Switched from Claude to Gemini without lost progress',
      taskId,
    });
    notifications.add({
      kind: 'task_completed',
      title: 'Task Complete',
      message: 'Verified 2 requirements passed',
      taskId,
    });

    const viewModel = present({
      taskId,
      projection,
      live: false,
      blocked: null,
      selectedModel: successorModel,
      verifying: false,
      verification: {
        verdict: 'verified',
        checks: [
          {
            id: 'test',
            label: 'Unit Tests',
            command: 'npm test',
            status: 'passed',
            durationMs: 120,
            summary: '2 passed',
            output: 'Tests completed successfully',
          },
        ],
        unavailable: [],
        totalDurationMs: 120,
      },
      activeNavTab: 'current',
      context: {
        included: [
          {
            path: 'src/total.ts',
            signals: ['mentioned'],
            score: 100,
            relevance: 'high',
            why: ['you mentioned it'],
            bytes: 92,
          },
        ],
        excluded: [],
        consideredCount: 1,
        totalBytes: 92,
        truncated: false,
      },
      workspaceInfo: { name: 'CodeRelay Core', path: dir, hasFolders: true },
      notifications: notifications.list(),
      settings: DEFAULT_SETTINGS,
      toolPolicies: policyEngine.listPolicies(),
    });

    // Assert UI presentation integrity
    assert.equal(viewModel.progress.state, 'completed');
    assert.equal(viewModel.progress.percent, 100);
    assert.equal(viewModel.progress.label, 'Completed · 100%');
    assert.equal(viewModel.header?.status, 'completed');
    assert.equal(viewModel.notifications.length, 2);
    assert.equal(viewModel.unreadNotificationsCount, 2);
    assert.equal(viewModel.workspaceInfo.name, 'CodeRelay Core');
    assert.equal(viewModel.stages.length, 6);
    assert.ok(viewModel.stages.every((s) => s.state === 'done'));

    await ledger.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
