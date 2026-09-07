/**
 * User-written routing rules: "when the task is X, prefer Y, fall back to Z."
 *
 * `select.ts` decides which model suits a role using declared capabilities and
 * measured health. That is a good default and a bad dictator: it cannot know
 * that this team's Gemini key has a much larger quota, or that debugging in
 * this repository goes better on one model than another. Rules are where the
 * user overrules it, and they are deliberately the *last* word on preference
 * and the *first* thing to be ignored when a preferred model cannot run.
 *
 * Three properties, each of which is a way rules could otherwise do harm:
 *
 *  1. **A rule expresses a preference, never a requirement.** A rule pointing at
 *     a model that is missing, uncredentialed or ejected is skipped, and the
 *     task continues on the automatic choice. The alternative — refusing to run
 *     because a rule cannot be honoured — turns a convenience into an outage.
 *
 *  2. **The first matching rule wins, and rules do not merge.** Combining two
 *     partially-matching rules produces a preference neither rule expresses and
 *     nobody can predict. Order is explicit and editable.
 *
 *  3. **A rule always says why it applied.** The reason reaches "Why this
 *     model?" verbatim, so a surprising choice is traceable to the line the
 *     user wrote rather than to an opaque score.
 */
import type { ModelRef } from '../core/types.js';
import type { TaskRole } from './select.js';

/** What a rule matches on. An absent field matches anything. */
export interface RuleCondition {
  /** The task role, from the composer's mode. */
  readonly role?: TaskRole;
  /**
   * Minimum context the task needs, in tokens.
   *
   * Matches when the task's estimated context is at or above this, which is how
   * "long-context task → Gemini" is expressed.
   */
  readonly minContextTokens?: number;
}

/** Where a matching rule points. */
export interface RuleTarget {
  /** Prefer this exact model. */
  readonly modelId?: string;
  /** Or prefer any model from this provider. */
  readonly providerId?: string;
}

export interface RoutingRule {
  readonly id: string;
  /** Shown in the list. Free text the user wrote. */
  readonly label: string;
  readonly enabled: boolean;
  readonly when: RuleCondition;
  readonly prefer: RuleTarget;
  /** Tried when `prefer` cannot run. Optional. */
  readonly fallback?: RuleTarget;
}

/** What the task looks like when rules are evaluated. */
export interface RuleContext {
  readonly role: TaskRole;
  /**
   * Estimated context the task will need, in tokens, or null when unknown.
   *
   * Null does not match a `minContextTokens` condition. A rule that fires on an
   * unknown quantity is a rule that fires arbitrarily, and "we did not measure"
   * must not be read as "small enough" or "large enough".
   */
  readonly contextTokens: number | null;
}

/** A resolved preference, ready to hand to `selectModel`. */
export interface RuleOutcome {
  /** Ordered targets to prefer, strongest first. Empty when no rule matched. */
  readonly targets: readonly RuleTarget[];
  /** The rule that matched, for the explanation. Null when none did. */
  readonly rule: RoutingRule | null;
  /** A sentence for "Why this model?", or null when no rule applied. */
  readonly reason: string | null;
}

/**
 * Whether a rule's condition holds.
 *
 * Every absent field matches, so a rule with an empty `when` matches every
 * task — which is a legitimate way to express a global default and is treated
 * as such rather than being rejected as malformed.
 */
export function matches(rule: RoutingRule, context: RuleContext): boolean {
  if (!rule.enabled) {
    return false;
  }
  if (rule.when.role !== undefined && rule.when.role !== context.role) {
    return false;
  }
  if (rule.when.minContextTokens !== undefined) {
    if (context.contextTokens === null) {
      return false;
    }
    if (context.contextTokens < rule.when.minContextTokens) {
      return false;
    }
  }
  return true;
}

/**
 * Find the preference for this task.
 *
 * First match wins. Returns an empty outcome rather than throwing when nothing
 * matches, because "no rule applies" is the common case and not an error.
 */
export function applyRules(
  rules: readonly RoutingRule[],
  context: RuleContext,
): RuleOutcome {
  const rule = rules.find((candidate) => matches(candidate, context));
  if (rule === undefined) {
    return { targets: [], rule: null, reason: null };
  }

  const targets = [rule.prefer, ...(rule.fallback === undefined ? [] : [rule.fallback])];
  return {
    targets,
    rule,
    reason: `your routing rule “${rule.label}” prefers ${describeTarget(rule.prefer)}`,
  };
}

/** A target in words, for the rule list and the explanation. */
export function describeTarget(target: RuleTarget): string {
  if (target.modelId !== undefined && target.modelId !== '') {
    return target.modelId;
  }
  if (target.providerId !== undefined && target.providerId !== '') {
    return `any ${target.providerId} model`;
  }
  return 'no model';
}

/** A whole rule in one line, for the list and the editor. */
export function describeRule(rule: RoutingRule): string {
  const conditions: string[] = [];
  if (rule.when.role !== undefined) {
    conditions.push(`task is ${rule.when.role}`);
  }
  if (rule.when.minContextTokens !== undefined) {
    conditions.push(`context ≥ ${rule.when.minContextTokens.toLocaleString('en-US')}`);
  }
  const when = conditions.length === 0 ? 'always' : conditions.join(' and ');
  const fallback =
    rule.fallback === undefined ? '' : `, else ${describeTarget(rule.fallback)}`;
  return `When ${when} → prefer ${describeTarget(rule.prefer)}${fallback}`;
}

/**
 * Whether a model satisfies a target.
 *
 * Exact model id, or any model from a named provider. Comparison is
 * case-sensitive because provider and model ids are, and a rule that matched
 * `GPT-5` against `gpt-5` would work until the day two models differ only in
 * case.
 */
export function targetMatches(target: RuleTarget, model: ModelRef): boolean {
  if (target.modelId !== undefined && target.modelId !== '') {
    return model.modelId === target.modelId;
  }
  if (target.providerId !== undefined && target.providerId !== '') {
    return model.providerId === target.providerId;
  }
  return false;
}

/**
 * Read rules from settings, discarding anything malformed.
 *
 * Tolerant rather than strict: settings are hand-edited, and one mistyped rule
 * must not stop the other four from working — nor stop the task from running at
 * all. A discarded rule is silently absent from the list, which is visible in
 * the rules UI, rather than being an error the user meets at task start.
 */
export function parseRules(raw: unknown): readonly RoutingRule[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rules: RoutingRule[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const prefer = parseTarget(record['prefer']);
    if (prefer === null) {
      // A rule that points nowhere cannot express a preference.
      continue;
    }
    const when = typeof record['when'] === 'object' && record['when'] !== null
      ? (record['when'] as Record<string, unknown>)
      : {};

    const role = typeof when['role'] === 'string' ? (when['role'] as TaskRole) : undefined;
    const minContext =
      typeof when['minContextTokens'] === 'number' && Number.isFinite(when['minContextTokens'])
        ? (when['minContextTokens'] as number)
        : undefined;
    const fallback = parseTarget(record['fallback']);

    rules.push({
      id: typeof record['id'] === 'string' ? record['id'] : `rule-${index + 1}`,
      label:
        typeof record['label'] === 'string' && record['label'].trim() !== ''
          ? record['label'].trim()
          : describeTarget(prefer),
      // Absent means on. A rule someone wrote is one they meant to use, and
      // requiring an explicit `enabled: true` would silently disable every rule
      // written by hand.
      enabled: record['enabled'] !== false,
      when: {
        ...(role === undefined ? {} : { role }),
        ...(minContext === undefined ? {} : { minContextTokens: minContext }),
      },
      prefer,
      ...(fallback === null ? {} : { fallback }),
    });
  }
  return rules;
}

function parseTarget(raw: unknown): RuleTarget | null {
  if (typeof raw === 'string') {
    // A bare string is a model id, which is the shorthand most people reach for.
    return raw.trim() === '' ? null : { modelId: raw.trim() };
  }
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const modelId = typeof record['modelId'] === 'string' ? record['modelId'].trim() : '';
  const providerId = typeof record['providerId'] === 'string' ? record['providerId'].trim() : '';
  if (modelId !== '') {
    return { modelId };
  }
  if (providerId !== '') {
    return { providerId };
  }
  return null;
}
