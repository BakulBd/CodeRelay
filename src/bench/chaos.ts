/**
 * CodeRelay Chaos & Failure Injection Harness.
 *
 * Implements Feature 16: Controlled Chaos Engineering for Task Continuity.
 *
 * Proves the core guarantee under synthetic adversity:
 * "Models can fail. Your coding task should not."
 *
 * Simulates real failure modes (429 rate limits, partial stream disconnects,
 * malformed tool payloads, context overflows, credential revocations,
 * and checkpoint conflicts) at targeted task execution stages to verify that
 * CodeRelay's freeze, recovery packaging, and safe relay mechanisms work without flaw.
 */

import type { DetailedFailureVariant } from '../recovery/decision.js';
import type { TaskStateGraph } from '../continuity/graph.js';
import { RecoveryPackageBuilder } from '../recovery/package.js';
import { HandoffPacket } from '../policy/handoff.js';
import type { ModelRef } from '../core/types.js';

export type ChaosFailureType =
  | 'RATE_LIMIT_429'
  | 'STREAM_CUTOFF'
  | 'MALFORMED_TOOL_ARGS'
  | 'CONTEXT_OVERFLOW'
  | 'CREDENTIAL_REVOCATION'
  | 'GIT_CHECKPOINT_CONFLICT'
  | 'PROVIDER_503_OUTAGE';

export interface ChaosConfig {
  readonly failureType: ChaosFailureType;
  readonly triggerOnStep: number;
  readonly triggerOnAction?: string;
  readonly enabled: boolean;
}

export interface ChaosExperimentReport {
  readonly experimentId: string;
  readonly failureType: ChaosFailureType;
  readonly triggerOnStep: number;
  readonly detected: boolean;
  readonly executionFrozen: boolean;
  readonly recoveryPackageCreated: boolean;
  readonly duplicatesPrevented: number;
  readonly successorResumed: boolean;
  /**
   * Whether verification passed after the relay, or `null` when none ran.
   *
   * Nullable because a dry run verifies nothing, and reporting `true` there
   * claimed a compiler and a test suite had passed when neither had been
   * invoked. `null` must render as "not run", never as a tick.
   */
  readonly finalVerificationPassed: boolean | null;
  readonly timeToRecoverMs: number;
  readonly details: string;
}

export class ChaosInjectionHarness {
  private activeConfig: ChaosConfig | null = null;
  private triggered = false;

  constructor(config?: ChaosConfig) {
    this.activeConfig = config ?? null;
  }

  public setConfig(config: ChaosConfig): void {
    this.activeConfig = config;
    this.triggered = false;
  }

  public getActiveConfig(): ChaosConfig | null {
    return this.activeConfig;
  }

  public shouldTrigger(currentStep: number, actionName?: string): boolean {
    if (!this.activeConfig || !this.activeConfig.enabled || this.triggered) {
      return false;
    }
    if (this.activeConfig.triggerOnStep === currentStep) {
      if (!this.activeConfig.triggerOnAction || this.activeConfig.triggerOnAction === actionName) {
        this.triggered = true;
        return true;
      }
    }
    return false;
  }

  /**
   * Generates synthetic error matching the configured chaos failure type.
   */
  public generateChaosError(): { error: Error; httpStatus?: number; headers?: Record<string, string> } {
    const type = this.activeConfig?.failureType ?? 'PROVIDER_503_OUTAGE';

    switch (type) {
      case 'RATE_LIMIT_429':
        return {
          error: new Error('Rate limit exceeded: 429 Too Many Requests. Capacity exhausted.'),
          httpStatus: 429,
          headers: { 'retry-after': '30' }
        };
      case 'STREAM_CUTOFF':
        return {
          error: new Error('Premature close: SSE connection dropped mid-event while streaming tool arguments.'),
          httpStatus: 200
        };
      case 'MALFORMED_TOOL_ARGS':
        return {
          error: new Error('Tool call schema error: unexpected token or invalid JSON payload for tool call.'),
          httpStatus: 200
        };
      case 'CONTEXT_OVERFLOW':
        return {
          error: new Error('context_length_exceeded: This model maximum context length is 32768 tokens, but your request resulted in 34120 tokens.'),
          httpStatus: 400
        };
      case 'CREDENTIAL_REVOCATION':
        return {
          error: new Error('401 Unauthorized: Invalid API key or token revoked by provider security scan.'),
          httpStatus: 401
        };
      case 'GIT_CHECKPOINT_CONFLICT':
        return {
          error: new Error('Git lock conflict: index.lock exists in workspace or unable to write tree.'),
          httpStatus: 500
        };
      case 'PROVIDER_503_OUTAGE':
      default:
        return {
          error: new Error('503 Service Unavailable: Provider API is currently experiencing a major incident.'),
          httpStatus: 503
        };
    }
  }

  /**
   * Executes a simulated chaos run against a TaskStateGraph to measure recovery behavior.
   */
  public runSimulation(options: {
    graph: TaskStateGraph;
    primaryWorker: ModelRef;
    fallbackWorker: ModelRef;
    failureType: ChaosFailureType;
  }): ChaosExperimentReport {
    const start = Date.now();
    const experimentId = `chaos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // What follows exercises the *real* task graph: the failure is recorded,
    // the recovery package is assembled, and deduplication is counted from the
    // actions the graph actually holds. What it deliberately no longer does is
    // decide the outcome in advance.
    //
    // The previous version reported `detected = true`, `successorResumed =
    // true` and a verification of "12 of 12 checks passed" — none of which any
    // code here observed. It wrote a pre-decided success story into the graph
    // and returned it as an experiment. A chaos test that cannot fail is not a
    // test, and the invented verification was the worst of it: it claimed a
    // compiler and a suite had run when nothing had.
    //
    // This is a **dry run of the relay bookkeeping**, and it is named as one.
    // Making a provider genuinely fail and measuring what survives is a
    // different and more expensive thing — that is the Benchmark Lab, which
    // injects faults into real requests.

    // Freeze: real, and checked rather than asserted.
    options.graph.setTaskStatus('relaying');
    const executionFrozen = options.graph.getTaskStatus() === 'relaying';

    const failNode = options.graph.recordFailure({
      failureClass: options.failureType,
      worker: options.primaryWorker,
      errorText: `Dry run: ${options.failureType}`,
    });

    const recNode = options.graph.recordRecovery({
      failureNodeId: failNode.id,
      actionTaken: 'cross_provider_relay',
      fromWorker: options.primaryWorker,
      toWorker: options.fallbackWorker,
      confidence: 'HIGH',
      reason:
        `Dry run of a relay from ${options.primaryWorker.providerId} to ` +
        `${options.fallbackWorker.providerId}.`,
    });
    const recoveryPackageCreated = Boolean(recNode && recNode.id);

    // Real: how many completed actions the graph holds, and would therefore
    // carry across rather than repeat.
    const duplicatesPrevented = options.graph.getCompletedActions().length;

    // Deliberately not set to `completed`: nothing ran, so the task did not
    // finish. Leaving the graph claiming completion was how the dry run ended
    // up indistinguishable from a real one.
    options.graph.setTaskStatus('relaying');

    return {
      experimentId,
      failureType: options.failureType,
      triggerOnStep: this.activeConfig?.triggerOnStep ?? 0,
      // Nothing detected anything — no request was made. Reporting `true` here
      // was the clearest fabrication in the file.
      detected: false,
      executionFrozen,
      recoveryPackageCreated,
      duplicatesPrevented,
      // No successor ran.
      successorResumed: false,
      // No verification ran. `null` is the honest value; `true` was a claim
      // that a compiler and a test suite had passed.
      finalVerificationPassed: null,
      timeToRecoverMs: Date.now() - start,
      details:
        `Dry run only — no provider was called and nothing was verified. ` +
        `The graph recorded a ${options.failureType} failure and assembled a relay package to ` +
        `${options.fallbackWorker.modelId}, carrying ${duplicatesPrevented} completed action(s) ` +
        `that a real relay would not repeat. Use the Benchmark Lab to make a provider actually fail.`,
    };
  }
}
