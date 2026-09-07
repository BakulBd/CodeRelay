/**
 * Automatic Capability Detection & Negotiation.
 *
 * Probes endpoints, validates model feature support, and builds honest capability matrices.
 * When a model lacks native support (e.g. native JSON schema), selects the optimal
 * fallback strategy.
 */
import type { ModelCapabilities } from '../core/types.js';

export type CapabilityStatus = 'supported' | 'partial' | 'unknown' | 'unsupported';

export interface ModelCapabilityMatrix {
  readonly modelId: string;
  readonly providerId: string;
  readonly streaming: CapabilityStatus;
  readonly toolCalling: CapabilityStatus;
  readonly parallelToolCalls: CapabilityStatus;
  readonly structuredOutput: CapabilityStatus;
  readonly vision: CapabilityStatus;
  readonly reasoning: CapabilityStatus;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly promptCaching: CapabilityStatus;
}

export type StructuredOutputStrategy =
  | 'native_json_schema'
  | 'tool_schema_enforcement'
  | 'constrained_json_prompt'
  | 'heuristic_parse';

export function determineStructuredOutputStrategy(
  capabilities: ModelCapabilities | null,
): StructuredOutputStrategy {
  if (capabilities?.structuredOutput) {
    return 'native_json_schema';
  }
  if (capabilities?.toolCalling) {
    return 'tool_schema_enforcement';
  }
  return 'constrained_json_prompt';
}

export function assessCapabilityStatus(supported: boolean | undefined | null): CapabilityStatus {
  if (supported === true) {
    return 'supported';
  }
  if (supported === false) {
    return 'unsupported';
  }
  return 'unknown';
}

export function buildCapabilityMatrix(
  providerId: string,
  modelId: string,
  caps: ModelCapabilities,
): ModelCapabilityMatrix {
  return {
    providerId,
    modelId,
    streaming: assessCapabilityStatus(caps.streaming),
    toolCalling: assessCapabilityStatus(caps.toolCalling),
    parallelToolCalls: assessCapabilityStatus(caps.parallelToolCalls),
    structuredOutput: assessCapabilityStatus(caps.structuredOutput),
    vision: assessCapabilityStatus(caps.vision),
    reasoning: caps.reasoning !== 'none' ? 'supported' : 'unsupported',
    contextWindow: caps.contextWindow,
    maxOutput: caps.maxOutput,
    promptCaching: 'unknown',
  };
}
