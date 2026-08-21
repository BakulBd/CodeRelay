/**
 * Core provider-agnostic types for CodeRelay.
 *
 * Nothing in this file may reference a specific AI provider. Provider-specific
 * shapes are normalized into these types by adapters in `src/providers/`.
 */

/** Opaque identifiers. Branded to prevent accidental mixing. */
export type TaskId = string & { readonly __brand: 'TaskId' };
export type StepId = string & { readonly __brand: 'StepId' };
export type AttemptId = string & { readonly __brand: 'AttemptId' };
export type ToolCallId = string & { readonly __brand: 'ToolCallId' };

/**
 * A deterministic fingerprint of a side effect: hash(toolName + normalized args + stepId).
 *
 * Two tool calls with the same SideEffectKey are the *same* intended operation.
 * This is what lets recovery decide "was this already done?" rather than
 * blindly re-running it.
 */
export type SideEffectKey = string & { readonly __brand: 'SideEffectKey' };

/**
 * Lifecycle of a single agent step.
 *
 * The ordering matters for recovery. See `docs/architecture.md`; in short, the
 * ledger records TOOL_EXECUTING *before* the side effect runs, so a crash
 * leaves an unambiguous "we may have started this" marker on disk.
 */
export type StepState =
  | 'PENDING'
  | 'STREAMING'
  | 'TOOL_REQUESTED'
  | 'TOOL_EXECUTING'
  | 'TOOL_COMPLETED'
  | 'MODEL_RESPONSE_COMPLETED'
  | 'FAILED'
  | 'RECOVERING'
  | 'VERIFIED'
  | 'DONE';

/**
 * Whether re-running a tool is safe when we cannot tell if it already ran.
 *
 * - `pure`: no side effects at all (read_file, search). Always safe to re-run.
 * - `idempotent`: re-running converges to the same state (write_file with
 *   fixed content). Safe to re-run if we verify the target state first.
 * - `unsafe`: re-running may duplicate an effect (terminal commands, appends).
 *   Never auto-retried from an ambiguous state; escalated to the user.
 */
export type ToolSafety = 'pure' | 'idempotent' | 'unsafe';

/** Classification of a failure. Each class gets its own recovery policy. */
export type ErrorClass =
  | 'RETRYABLE'      // 408/429/500/502/503/504, provider overload (e.g. Anthropic 529)
  | 'NETWORK'        // DNS, ECONNREFUSED, ECONNRESET, socket timeout, transient TLS
  | 'TLS_UNTRUSTED'  // certificate validation failure; surfaced immediately, not retried
  | 'AUTH'           // 401; the credential itself is rejected, so rotate it and never retry it
  | 'FORBIDDEN'      // 403; the credential is valid but not permitted for this model/endpoint/region
  | 'CONFIG'         // invalid model/params; fail fast, retrying cannot help

  | 'CONTEXT'        // context or output limit exceeded; compact or re-route
  | 'STREAM'         // truncation, malformed SSE, HTTP 200 with non-JSON body
  | 'TOOL'           // tool timeout, missing result, malformed call
  | 'FILESYSTEM'     // external modification, permission denied, edit conflict
  | 'UNKNOWN';       // unclassified; treated conservatively (no auto-retry of side effects)

/** A normalized streaming event. All adapters emit only these. */
export type NormalizedEvent =
  | { readonly t: 'text'; readonly delta: string }
  | { readonly t: 'thinking'; readonly delta: string }
  | {
      readonly t: 'tool_call';
      readonly id: ToolCallId;
      readonly name: string;
      readonly args: unknown;
    }
  | { readonly t: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly t: 'done'; readonly reason: StopReason };

/**
 * Why generation stopped.
 *
 * `truncated` is distinct from `length`: `length` means the model hit its
 * configured output cap (a clean stop), while `truncated` means the transport
 * died mid-stream and we do not know what the model intended to emit next.
 */
export type StopReason = 'stop' | 'tool_use' | 'length' | 'truncated';

/** What a model can actually do. Used to gate failover targets. */
export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly toolCalling: boolean;
  readonly parallelToolCalls: boolean;
  readonly vision: boolean;
  readonly reasoning: 'none' | 'implicit' | 'explicit';
  readonly structuredOutput: boolean;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly costPerMTokIn: number;
  readonly costPerMTokOut: number;
}

/** Identifies a concrete model on a concrete provider. */
export interface ModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

/** A credential, referenced by opaque id. The secret itself never appears here. */
export interface CredentialRef {
  readonly providerId: string;
  /** Stable id used as the SecretStorage key and in health records. */
  readonly credentialId: string;
  /** Human-readable label, e.g. "personal key". Never the key material. */
  readonly label: string;
}
