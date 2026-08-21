import { computeSideEffectKey } from '../continuity/entries.js';
import type { ExecutionLedger } from '../continuity/ledger.js';
import type { AttemptId, SideEffectKey, StepId, TaskId, ToolCallId } from '../core/types.js';
import {
  planRecovery,
  type EffectLogReader,
  type RecoveryPlan,
  type WorkspaceProbe,
} from '../recovery/replay.js';
import { fingerprintAll } from '../workspace/probe.js';
import { join } from 'node:path';
import type { ToolContext, ToolRegistry } from './tool.js';

/** A request for permission to run one tool call. */
export interface ApprovalRequest {
  readonly toolName: string;
  readonly args: unknown;
  readonly sideEffectKey: SideEffectKey;
}

/**
 * What the user said about a tool call that needs permission.
 *
 * `denied` carries a reason so the model is told *why* and can choose something
 * else, rather than seeing an unexplained failure and retrying the same thing.
 */
export type ApprovalDecision =
  | { readonly t: 'allowed' }
  | { readonly t: 'denied'; readonly reason: string };

/** Everything the runner needs. Injected so the whole flow is testable. */
export interface RunnerDeps {
  readonly ledger: ExecutionLedger;
  readonly tools: ToolRegistry;
  readonly probe: WorkspaceProbe;
  readonly root: string;
  readonly taskId: TaskId;
  /**
   * Consulted before any tool that could change something runs.
   *
   * Absent means "allow everything", which is what the tests and the file-only
   * configuration want. It is called *before* `TOOL_EXECUTING` is written, so a
   * refusal never opens the ambiguous window — a denied command must be provably
   * un-run, not merely probably.
   */
  readonly approve?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Directory for `unsafe` tools' effect logs. See `command-tool.ts`. */
  readonly effectsDir?: string;
  /**
   * Reads those logs back on recovery.
   *
   * Separate from `effectsDir` because writing evidence and interpreting it are
   * different jobs: the tests inject a fake reader with no filesystem at all.
   */
  readonly effects?: EffectLogReader;
  /** Cancels a long-running tool when the task is stopped. */
  readonly signal?: AbortSignal;
  readonly commandTimeoutMs?: number;
}

/** A tool call as the model asked for it. */
export interface ToolCallRequest {
  readonly toolCallId: ToolCallId;
  readonly stepId: StepId;
  readonly attemptId: AttemptId;
  readonly toolName: string;
  readonly args: unknown;
}

export type ToolOutcome =
  /** The tool ran during this call. */
  | { readonly kind: 'EXECUTED'; readonly summary: string; readonly sideEffectKey: SideEffectKey }
  /** The effect was already present, so nothing ran. */
  | { readonly kind: 'ADOPTED'; readonly evidence: string; readonly sideEffectKey: SideEffectKey }
  /** The tool failed. The task may continue with the error as context. */
  | { readonly kind: 'FAILED'; readonly message: string; readonly sideEffectKey: SideEffectKey }
  /** Blocked pending a user decision. */
  | {
      readonly kind: 'ESCALATED';
      readonly question: string;
      readonly sideEffectKey: SideEffectKey;
    };

/**
 * Executes tool calls under the write-ahead protocol.
 *
 * The ordering below is the entire safety argument, and it is the reason every
 * `append` is awaited rather than fired off:
 *
 *   1. `TOOL_REQUESTED` — durable record of intent.
 *   2. capture the pre-state, then `TOOL_EXECUTING` — durable record that the
 *      effect is *about to* happen, together with the evidence needed to tell
 *      later whether it did.
 *   3. run the effect.
 *   4. `TOOL_COMPLETED` — durable record that it finished.
 *
 * A crash between 2 and 4 is the ambiguous window this project exists to
 * handle, and `planRecovery` resolves it from the fingerprints written in 2.
 * Reordering any of these steps, or letting a write be buffered, reintroduces
 * the duplicate-execution bug.
 */
export class ToolRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /**
   * The execution context for one call.
   *
   * `effectLogPath` is derived from the `SideEffectKey` rather than the tool
   * call id, because the key is what identifies the *same intended operation*
   * across attempts. A retry of the same command therefore reuses the same log,
   * which is precisely what makes the file usable as evidence.
   */
  private contextFor(sideEffectKey: SideEffectKey): ToolContext {
    const { root, probe, effectsDir, signal, commandTimeoutMs } = this.deps;
    return {
      root,
      probe,
      ...(effectsDir === undefined ? {} : { effectLogPath: join(effectsDir, `${sideEffectKey}.log`) }),
      ...(signal === undefined ? {} : { signal }),
      ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
    };
  }

  async run(req: ToolCallRequest): Promise<ToolOutcome> {
    const { ledger, tools, probe, taskId } = this.deps;
    const tool = tools.get(req.toolName);
    const sideEffectKey = computeSideEffectKey(req.stepId, req.toolName, req.args);
    const base = {
      taskId,
      stepId: req.stepId,
      attemptId: req.attemptId,
    } as const;

    await ledger.append({
      ...base,
      type: 'TOOL_REQUESTED',
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      args: req.args,
      sideEffectKey,
      safety: tool.safety,
    });

    // Parsing happens before TOOL_EXECUTING so a malformed call fails without
    // ever creating an ambiguous window.
    let planned: ReturnType<typeof tool.plan>;
    try {
      planned = tool.plan(req.args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ledger.append({
        ...base,
        type: 'TOOL_COMPLETED',
        toolCallId: req.toolCallId,
        sideEffectKey,
        ok: false,
        resultSummary: `invalid arguments: ${message}`,
        postState: [],
      });
      return { kind: 'FAILED', message, sideEffectKey };
    }

    // Permission is asked *here*: after parsing, so the prompt can describe a
    // validated call, and before TOOL_EXECUTING, so a refusal leaves no trace
    // that recovery could later read as "this may have run".
    if (this.deps.approve !== undefined && tool.safety !== 'pure') {
      const decision = await this.deps.approve({
        toolName: req.toolName,
        args: req.args,
        sideEffectKey,
      });
      if (decision.t === 'denied') {
        await ledger.append({
          ...base,
          type: 'TOOL_COMPLETED',
          toolCallId: req.toolCallId,
          sideEffectKey,
          ok: false,
          resultSummary: decision.reason,
          postState: [],
        });
        return { kind: 'FAILED', message: decision.reason, sideEffectKey };
      }
    }

    const preState = await fingerprintAll(probe, planned.paths);

    await ledger.append({
      ...base,
      type: 'TOOL_EXECUTING',
      toolCallId: req.toolCallId,
      sideEffectKey,
      safety: tool.safety,
      preState,
      expectedPostState: planned.expectedPostState,
    });

    // --- the ambiguous window opens here ---
    try {
      const summary = await tool.execute(req.args, this.contextFor(sideEffectKey));
      const postState = await fingerprintAll(probe, planned.paths);

      await ledger.append({
        ...base,
        type: 'TOOL_COMPLETED',
        toolCallId: req.toolCallId,
        sideEffectKey,
        ok: true,
        resultSummary: summary,
        postState,
      });
      return { kind: 'EXECUTED', summary, sideEffectKey };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const postState = await fingerprintAll(probe, planned.paths);

      // Recorded as a settled failure rather than left open: we observed the
      // outcome, so a later restart must not treat it as "may have run".
      await ledger.append({
        ...base,
        type: 'TOOL_COMPLETED',
        toolCallId: req.toolCallId,
        sideEffectKey,
        ok: false,
        resultSummary: `failed: ${message}`,
        postState,
      });
      return { kind: 'FAILED', message, sideEffectKey };
    }
  }

  /**
   * Resumes a task after an interruption.
   *
   * Only `ADOPT_COMPLETED_EFFECT` is acted on here, by recording the
   * reconciliation so the effect is never reconsidered. The other outcomes are
   * returned for the agent loop to act on, because executing a tool requires
   * the model's arguments and asking the user requires the UI. Recovery decides;
   * it does not act on the user's behalf.
   */
  async resume(): Promise<RecoveryPlan> {
    const { ledger, probe, effects } = this.deps;
    const entries = await ledger.read();
    const plan = await planRecovery(entries, probe, effects);

    if (plan.kind === 'ADOPT_COMPLETED_EFFECT') {
      // Inherit the ids of the entry being reconciled so the timeline links the
      // two, and so a second restart sees the effect as settled.
      const executing = entries.find(
        (e) => e.type === 'TOOL_EXECUTING' && e.toolCallId === plan.toolCallId,
      );

      await ledger.append({
        taskId: this.deps.taskId,
        stepId: executing?.stepId ?? ('unknown' as StepId),
        attemptId: executing?.attemptId ?? ('unknown' as AttemptId),
        type: 'TOOL_RECONCILED',
        toolCallId: plan.toolCallId,
        sideEffectKey: plan.sideEffectKey,
        evidence: plan.evidence,
      });
    }

    return plan;
  }
}
