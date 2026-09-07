/**
 * 16-Variant Failure Classification Engine & Recovery Decision Engine.
 *
 * Implements Feature 4 & 5:
 * "Models can fail. Your coding task should not."
 *
 * Provides granular diagnosis and operational explainability for every failure,
 * determining whether to retry with backoff, rotate credentials, compact context,
 * or execute a safe cross-provider relay.
 */

import type { ErrorClass, ModelCapabilities, ModelRef } from '../core/types.js';

export type DetailedFailureVariant =
  | 'PROVIDER_5XX'
  | 'RATE_LIMIT_429'
  | 'QUOTA_EXHAUSTED'
  | 'CONTEXT_OVERFLOW'
  | 'OUTPUT_TOKEN_TRUNCATION'
  | 'STREAM_INTERRUPTION'
  | 'TOOL_CALL_FORMAT_ERROR'
  | 'TOOL_EXECUTION_FAILURE'
  | 'REASONING_COLLAPSE'
  | 'CAPABILITY_MISMATCH'
  | 'AUTH_CREDENTIAL_FAILURE'
  | 'NETWORK_TIMEOUT'
  | 'CONTENT_FILTER_REJECTION'
  | 'MODEL_DEPRECATED_404'
  | 'COLD_START_TIMEOUT'
  | 'UNRECOVERABLE_INTERNAL_ERROR';

export type RecoveryActionType =
  | 'RETRY_SAME_WORKER_EXPONENTIAL_BACKOFF'
  | 'ROTATE_CREDENTIAL'
  | 'CROSS_PROVIDER_RELAY'
  | 'COMPACT_CONTEXT_AND_CONTINUE'
  | 'CONTINUE_WITH_PROMPT_RECOVERY'
  | 'REPAIR_TOOL_ARGUMENTS'
  | 'REVERT_AND_RETRY_ACTION'
  | 'STOP_AND_REPORT';

export interface FailureDiagnosis {
  readonly variant: DetailedFailureVariant;
  readonly baseErrorClass: ErrorClass;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly rawMessage: string;
  readonly operationalExplanation: string;
  readonly recoveryAction: RecoveryActionType;
  readonly requiresRelay: boolean;
  readonly freezeExecution: boolean;
  readonly requiredCapabilities?: Partial<ModelCapabilities>;
}

export interface DecisionInput {
  readonly error: unknown;
  readonly httpStatus?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly currentWorker: ModelRef;
  readonly currentWorkerCaps?: ModelCapabilities;
  readonly attemptCount: number;
  readonly inFlightTool?: string;
  readonly streamReceivedTokens?: number;
}

export class RecoveryDecisionEngine {
  /**
   * Classifies any error into one of the 16 detailed failure variants.
   */
  public static diagnose(input: DecisionInput): FailureDiagnosis {
    const rawMessage = input.error instanceof Error ? input.error.message : String(input.error ?? '');
    const msg = rawMessage.toLowerCase();
    const status = input.httpStatus ?? extractHttpStatus(rawMessage);

    // Extract Retry-After if present in headers or message
    let retryAfterMs: number | undefined;
    if (input.headers) {
      const headerVal = input.headers['retry-after'] || input.headers['Retry-After'];
      if (headerVal) {
        const parsed = Number.parseInt(headerVal, 10);
        if (!Number.isNaN(parsed)) {
          retryAfterMs = parsed * 1000;
        }
      }
    }

    // 1. Provider 5xx / outage (500, 502, 503, 504, 529)
    if (status === 529 || (status !== undefined && status >= 500 && status <= 599) || msg.includes('overloaded') || msg.includes('bad gateway') || msg.includes('service unavailable')) {
      const isTemporary = input.attemptCount < 2 && (status === 503 || status === 529);
      return {
        variant: 'PROVIDER_5XX',
        baseErrorClass: 'RETRYABLE',
        httpStatus: status ?? 500,
        retryAfterMs: retryAfterMs ?? 2000,
        rawMessage,
        operationalExplanation: `Provider ${input.currentWorker.providerId} returned HTTP ${status ?? 500} server overload. ${isTemporary ? 'Attempting quick retry before relay.' : 'Switching to alternative provider worker.'}`,
        recoveryAction: isTemporary ? 'RETRY_SAME_WORKER_EXPONENTIAL_BACKOFF' : 'CROSS_PROVIDER_RELAY',
        requiresRelay: !isTemporary,
        freezeExecution: true
      };
    }

    // 2. Rate limit (429) with retry-after
    if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('tpm limit') || msg.includes('rpm limit')) {
      const longDelay = retryAfterMs && retryAfterMs > 15_000;
      return {
        variant: 'RATE_LIMIT_429',
        baseErrorClass: 'RETRYABLE',
        httpStatus: 429,
        retryAfterMs,
        rawMessage,
        operationalExplanation: `Provider ${input.currentWorker.providerId} rate-limited requests${retryAfterMs ? ` (${Math.round(retryAfterMs / 1000)}s backoff)` : ''}. ${longDelay || input.attemptCount >= 2 ? 'Relaying to alternative provider worker to prevent user idle delay.' : 'Retrying with backoff.'}`,
        recoveryAction: longDelay || input.attemptCount >= 2 ? 'CROSS_PROVIDER_RELAY' : 'RETRY_SAME_WORKER_EXPONENTIAL_BACKOFF',
        requiresRelay: longDelay || input.attemptCount >= 2,
        freezeExecution: true
      };
    }

    // 3. Quota exhausted (billing / tier limit)
    if (msg.includes('quota') || msg.includes('credit') || msg.includes('billing') || msg.includes('insufficient_quota') || msg.includes('balance')) {
      return {
        variant: 'QUOTA_EXHAUSTED',
        baseErrorClass: 'AUTH',
        httpStatus: status ?? 402,
        rawMessage,
        operationalExplanation: `Billing quota or credit exhausted on ${input.currentWorker.providerId}. Retrying will not succeed without account change; immediate cross-provider relay required.`,
        recoveryAction: 'CROSS_PROVIDER_RELAY',
        requiresRelay: true,
        freezeExecution: true
      };
    }

    // 4. Context window overflow
    if (msg.includes('context_length_exceeded') || msg.includes('maximum context length') || msg.includes('too many tokens') || msg.includes('context window') || msg.includes('prompt is too long')) {
      return {
        variant: 'CONTEXT_OVERFLOW',
        baseErrorClass: 'CONTEXT',
        rawMessage,
        operationalExplanation: `Prompt tokens exceeded context window of ${input.currentWorker.modelId}. Context reconstruction & compaction required.`,
        recoveryAction: 'COMPACT_CONTEXT_AND_CONTINUE',
        requiresRelay: false,
        freezeExecution: true,
        requiredCapabilities: { contextWindow: 64_000 }
      };
    }

    // 5. Output token truncation
    if (msg.includes('max_tokens') || msg.includes('length') || (msg.includes('truncated') && (input.streamReceivedTokens ?? 0) > 2000)) {
      return {
        variant: 'OUTPUT_TOKEN_TRUNCATION',
        baseErrorClass: 'CONTEXT',
        rawMessage,
        operationalExplanation: `Model ${input.currentWorker.modelId} hit maximum output token cap mid-generation. Resuming task from structured recovery state without replaying prior tokens.`,
        recoveryAction: 'CONTINUE_WITH_PROMPT_RECOVERY',
        requiresRelay: false,
        freezeExecution: false
      };
    }

    // 6. Stream interruption
    if (msg.includes('premature close') || msg.includes('stream closed') || msg.includes('socket hang up') || msg.includes('econnreset') || msg.includes('incomplete chunked encoding')) {
      return {
        variant: 'STREAM_INTERRUPTION',
        baseErrorClass: 'STREAM',
        rawMessage,
        operationalExplanation: `Streaming HTTP response abruptly dropped mid-turn from ${input.currentWorker.providerId}. Recovering last recorded tool effect and continuing.`,
        recoveryAction: input.attemptCount < 2 ? 'RETRY_SAME_WORKER_EXPONENTIAL_BACKOFF' : 'CROSS_PROVIDER_RELAY',
        requiresRelay: input.attemptCount >= 2,
        freezeExecution: true
      };
    }

    // 7. Tool call format error (malformed JSON, invalid arguments)
    if (msg.includes('json') || msg.includes('invalid arguments') || msg.includes('schema violation') || msg.includes('malformed tool')) {
      return {
        variant: 'TOOL_CALL_FORMAT_ERROR',
        baseErrorClass: 'TOOL',
        rawMessage,
        operationalExplanation: `Worker ${input.currentWorker.modelId} generated invalid arguments or malformed JSON for tool '${input.inFlightTool ?? 'unknown'}'. Repairing schema instruction.`,
        recoveryAction: input.attemptCount < 2 ? 'REPAIR_TOOL_ARGUMENTS' : 'CROSS_PROVIDER_RELAY',
        requiresRelay: input.attemptCount >= 2,
        freezeExecution: true,
        requiredCapabilities: { structuredOutput: true }
      };
    }

    // 8. Tool execution failure (command failed, file locked)
    if (msg.includes('enoent') || msg.includes('eacces') || msg.includes('ebusy') || msg.includes('command failed') || msg.includes('exit code')) {
      return {
        variant: 'TOOL_EXECUTION_FAILURE',
        baseErrorClass: 'TOOL',
        rawMessage,
        operationalExplanation: `Tool execution error in '${input.inFlightTool ?? 'action'}'. Recording failure event in task state graph; worker should adapt strategy.`,
        recoveryAction: 'REVERT_AND_RETRY_ACTION',
        requiresRelay: false,
        freezeExecution: false
      };
    }

    // 9. Reasoning collapse (model in infinite loop, repetitive tokens)
    if (msg.includes('loop detected') || msg.includes('repetitive') || msg.includes('reasoning collapse')) {
      return {
        variant: 'REASONING_COLLAPSE',
        baseErrorClass: 'CONTEXT',
        rawMessage,
        operationalExplanation: `Reasoning collapse or repetition cycle detected on worker ${input.currentWorker.modelId}. Freezing turn and relaying to higher-tier reasoning worker.`,
        recoveryAction: 'CROSS_PROVIDER_RELAY',
        requiresRelay: true,
        freezeExecution: true,
        requiredCapabilities: { reasoning: 'explicit' }
      };
    }

    // 10. Capability mismatch (model lacks required tool/vision/context support)
    if (msg.includes('not supported') || msg.includes('capability') || msg.includes('does not support tools')) {
      return {
        variant: 'CAPABILITY_MISMATCH',
        baseErrorClass: 'CONFIG',
        rawMessage,
        operationalExplanation: `Model ${input.currentWorker.modelId} lacks necessary capabilities for this task. Relaying to qualified worker.`,
        recoveryAction: 'CROSS_PROVIDER_RELAY',
        requiresRelay: true,
        freezeExecution: true,
        requiredCapabilities: { toolCalling: true }
      };
    }

    // 11. Authentication/credential failure (401, invalid key)
    if (status === 401 || msg.includes('unauthorized') || msg.includes('invalid api key') || msg.includes('incorrect api key') || msg.includes('bearer token')) {
      return {
        variant: 'AUTH_CREDENTIAL_FAILURE',
        baseErrorClass: 'AUTH',
        httpStatus: 401,
        rawMessage,
        operationalExplanation: `API key or credential for ${input.currentWorker.providerId} was rejected by upstream provider. Rotating credential or relaying to another provider.`,
        recoveryAction: 'ROTATE_CREDENTIAL',
        requiresRelay: true,
        freezeExecution: true
      };
    }

    // 12. Network timeout (DNS failure, gateway timeout)
    if (status === 408 || msg.includes('etimedout') || msg.includes('enotfound') || msg.includes('dns') || msg.includes('network timeout')) {
      return {
        variant: 'NETWORK_TIMEOUT',
        baseErrorClass: 'NETWORK',
        httpStatus: status ?? 408,
        rawMessage,
        operationalExplanation: `Network connection timeout contacting ${input.currentWorker.providerId}.`,
        recoveryAction: input.attemptCount < 2 ? 'RETRY_SAME_WORKER_EXPONENTIAL_BACKOFF' : 'CROSS_PROVIDER_RELAY',
        requiresRelay: input.attemptCount >= 2,
        freezeExecution: true
      };
    }

    // 13. Content filter / safety rejection
    if (msg.includes('safety') || msg.includes('content filter') || msg.includes('moderation') || msg.includes('policy')) {
      return {
        variant: 'CONTENT_FILTER_REJECTION',
        baseErrorClass: 'CONFIG',
        rawMessage,
        operationalExplanation: `Provider ${input.currentWorker.providerId} content policy rejection triggered. Relaying to alternative provider with broader code policy.`,
        recoveryAction: 'CROSS_PROVIDER_RELAY',
        requiresRelay: true,
        freezeExecution: true
      };
    }

    // 14. Model deprecation / endpoint 404
    if (status === 404 || msg.includes('model not found') || msg.includes('deprecated') || msg.includes('not found')) {
      return {
        variant: 'MODEL_DEPRECATED_404',
        baseErrorClass: 'CONFIG',
        httpStatus: 404,
        rawMessage,
        operationalExplanation: `Model ${input.currentWorker.modelId} endpoint returned 404 Not Found or is deprecated. Re-routing task to current active model.`,
        recoveryAction: 'CROSS_PROVIDER_RELAY',
        requiresRelay: true,
        freezeExecution: true
      };
    }

    // 15. Cold start timeout (>30s initial response)
    if (msg.includes('cold start') || (msg.includes('timeout') && (input.streamReceivedTokens ?? 0) === 0)) {
      return {
        variant: 'COLD_START_TIMEOUT',
        baseErrorClass: 'NETWORK',
        rawMessage,
        operationalExplanation: `Worker ${input.currentWorker.modelId} cold-start exceeded response SLA. Switching to warm low-latency worker.`,
        recoveryAction: 'CROSS_PROVIDER_RELAY',
        requiresRelay: true,
        freezeExecution: true
      };
    }

    // 16. Unrecoverable internal error (default catch-all)
    return {
      variant: 'UNRECOVERABLE_INTERNAL_ERROR',
      baseErrorClass: 'UNKNOWN',
      rawMessage,
      operationalExplanation: `Unclassified worker error: ${rawMessage}. Freezing execution and halting for user guidance.`,
      recoveryAction: 'STOP_AND_REPORT',
      requiresRelay: false,
      freezeExecution: true
    };
  }
}

function extractHttpStatus(message: string): number | undefined {
  const match = message.match(/\b(4\d\d|5\d\d)\b/);
  if (match && match[1]) {
    const num = Number.parseInt(match[1], 10);
    return Number.isNaN(num) ? undefined : num;
  }
  return undefined;
}
