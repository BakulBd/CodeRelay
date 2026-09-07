/**
 * Universal Model Alias System.
 *
 * Provides stable logical names for task routing ("best-coder", "fast", "cheap", "local",
 * "long-context", "reviewer"). The system dynamically resolves an alias to the best
 * configured model based on capability requirements, pricing, latency, and health.
 */
import type { ModelRef } from '../core/types.js';
import type { Candidate } from '../policy/route.js';

export type ModelAlias =
  | 'best-coder'
  | 'fast'
  | 'cheap'
  | 'local'
  | 'long-context'
  | 'reviewer';

/**
 * Every alias, in the order a picker should offer them.
 *
 * Exported so a caller cannot enumerate a stale subset by hand — adding an
 * alias to the union above and forgetting the list is the one way these two
 * can disagree.
 */
export const MODEL_ALIASES: readonly ModelAlias[] = [
  'best-coder',
  'fast',
  'cheap',
  'long-context',
  'reviewer',
  'local',
];

export interface AliasResolution {
  readonly alias: ModelAlias;
  readonly resolvedModel: ModelRef | null;
  readonly reason: string;
}

export function resolveModelAlias(
  alias: ModelAlias,
  candidates: readonly Candidate[],
  customOverrides?: Readonly<Record<string, ModelRef>>,
): AliasResolution {
  if (customOverrides?.[alias]) {
    const override = customOverrides[alias];
    return {
      alias,
      resolvedModel: override,
      reason: `User override pinned "${alias}" to ${override.providerId}/${override.modelId}.`,
    };
  }

  const usable = candidates.filter((c) => c.readyCredentialIds.length > 0 && c.coolingRetryAfterMs === null);
  const pool = usable.length > 0 ? usable : candidates;

  if (pool.length === 0) {
    return {
      alias,
      resolvedModel: null,
      reason: 'No configured model candidates available.',
    };
  }

  const fallbackCandidate = pool[0];
  if (!fallbackCandidate) {
    return {
      alias,
      resolvedModel: null,
      reason: 'No configured model candidates available.',
    };
  }

  switch (alias) {
    case 'best-coder': {
      // Prioritize high reasoning or proven coding models with tool calling
      const coder =
        pool.find((c) => c.capabilities.reasoning !== 'none' && c.capabilities.toolCalling) ??
        pool.find((c) => /sonnet|gpt-4o|deepseek-r1|gemini-1\.5-pro/i.test(c.model.modelId)) ??
        fallbackCandidate;
      return {
        alias,
        resolvedModel: coder.model,
        reason: 'Selected for advanced architectural reasoning and tool-calling fidelity.',
      };
    }

    case 'fast': {
      // Prioritize low-latency or flash/mini models
      const fast =
        pool.find((c) => /flash|mini|haiku|groq/i.test(c.model.modelId) || /groq|cerebras/i.test(c.model.providerId)) ??
        fallbackCandidate;
      return {
        alias,
        resolvedModel: fast.model,
        reason: 'Selected for high token throughput and low time-to-first-token.',
      };
    }

    case 'cheap': {
      // Prioritize lowest combined token cost
      const sorted = [...pool].sort(
        (a, b) =>
          (a.capabilities.costPerMTokIn + a.capabilities.costPerMTokOut) -
          (b.capabilities.costPerMTokIn + b.capabilities.costPerMTokOut),
      );
      const cheap = sorted[0] ?? fallbackCandidate;
      return {
        alias,
        resolvedModel: cheap.model,
        reason: `Selected for lowest cost ($${cheap.capabilities.costPerMTokIn}/M in).`,
      };
    }

    case 'local': {
      // Prioritize on-premise endpoints (ollama, lmstudio, localhost)
      const local = pool.find((c) => /ollama|lmstudio|local/i.test(c.model.providerId));
      if (local) {
        return {
          alias,
          resolvedModel: local.model,
          reason: 'Selected local model for zero-cloud privacy.',
        };
      }
      return {
        alias,
        resolvedModel: fallbackCandidate.model,
        reason: 'No local model configured; falling back to primary available model.',
      };
    }

    case 'long-context': {
      // Prioritize highest context window capacity
      const sorted = [...pool].sort((a, b) => b.capabilities.contextWindow - a.capabilities.contextWindow);
      const wide = sorted[0] ?? fallbackCandidate;
      return {
        alias,
        resolvedModel: wide.model,
        reason: `Selected for maximum context capacity (${Math.round(wide.capabilities.contextWindow / 1000)}k tokens).`,
      };
    }

    case 'reviewer': {
      // High reasoning or deep critique capability
      const reviewer =
        pool.find((c) => c.capabilities.reasoning === 'explicit') ??
        pool.find((c) => /sonnet|gpt-4o|o1|o3/i.test(c.model.modelId)) ??
        fallbackCandidate;
      return {
        alias,
        resolvedModel: reviewer.model,
        reason: 'Selected for thorough critique and bug detection.',
      };
    }
  }
}
