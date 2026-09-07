/**
 * Routing rules.
 *
 * A rule is a preference, never a requirement — so most of these tests check
 * that a rule which cannot be honoured gets out of the way rather than stopping
 * the task. The other half check that a rule always explains itself, because a
 * surprising model choice must be traceable to the line the user wrote.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRules,
  describeRule,
  describeTarget,
  matches,
  parseRules,
  targetMatches,
  type RoutingRule,
  type RuleContext,
} from '../../src/policy/rules.js';

const rule = (over: Partial<RoutingRule> = {}): RoutingRule => ({
  id: 'r1',
  label: 'Debug on Gemini',
  enabled: true,
  when: { role: 'debug' },
  prefer: { modelId: 'gemini-pro' },
  ...over,
});

const context = (over: Partial<RuleContext> = {}): RuleContext => ({
  role: 'debug',
  contextTokens: null,
  ...over,
});

// --- matching --------------------------------------------------------------

test('a rule matches its role and nothing else', () => {
  assert.equal(matches(rule(), context({ role: 'debug' })), true);
  assert.equal(matches(rule(), context({ role: 'code' })), false);
});

test('an empty condition matches everything, which is a valid global default', () => {
  const global = rule({ when: {} });
  assert.equal(matches(global, context({ role: 'code' })), true);
  assert.equal(matches(global, context({ role: 'test' })), true);
});

test('a disabled rule never matches', () => {
  assert.equal(matches(rule({ enabled: false }), context()), false);
});

test('a context-size condition needs a measured context', () => {
  const long = rule({ when: { minContextTokens: 100_000 } });

  assert.equal(matches(long, context({ contextTokens: 200_000 })), true);
  assert.equal(matches(long, context({ contextTokens: 50_000 })), false);
  assert.equal(
    matches(long, context({ contextTokens: null })),
    false,
    '"we did not measure" must not be read as "large enough"',
  );
});

test('conditions combine with AND, not OR', () => {
  const both = rule({ when: { role: 'debug', minContextTokens: 100_000 } });
  assert.equal(matches(both, context({ role: 'debug', contextTokens: 200_000 })), true);
  assert.equal(matches(both, context({ role: 'debug', contextTokens: 10 })), false);
  assert.equal(matches(both, context({ role: 'code', contextTokens: 200_000 })), false);
});

// --- application -----------------------------------------------------------

test('no matching rule is an empty outcome, not an error', () => {
  const outcome = applyRules([rule()], context({ role: 'code' }));
  assert.deepEqual(outcome.targets, []);
  assert.equal(outcome.rule, null);
  assert.equal(outcome.reason, null);
});

test('the first matching rule wins and rules do not merge', () => {
  const first = rule({ id: 'a', label: 'A', prefer: { modelId: 'first' } });
  const second = rule({ id: 'b', label: 'B', prefer: { modelId: 'second' } });

  const outcome = applyRules([first, second], context());
  assert.equal(outcome.rule?.id, 'a');
  assert.deepEqual(
    outcome.targets.map((t) => t.modelId),
    ['first'],
    'merging two rules produces a preference neither of them expresses',
  );
});

test('a fallback target follows the preferred one', () => {
  const outcome = applyRules(
    [rule({ prefer: { modelId: 'gemini-pro' }, fallback: { providerId: 'openai' } })],
    context(),
  );
  assert.deepEqual(outcome.targets, [{ modelId: 'gemini-pro' }, { providerId: 'openai' }]);
});

test('a matching rule always explains itself by name', () => {
  const outcome = applyRules([rule({ label: 'Debug on Gemini' })], context());
  assert.match(outcome.reason ?? '', /Debug on Gemini/);
  assert.match(outcome.reason ?? '', /gemini-pro/);
});

// --- targets ---------------------------------------------------------------

test('a model target matches only that model', () => {
  const target = { modelId: 'gpt-5' };
  assert.equal(targetMatches(target, { providerId: 'openai', modelId: 'gpt-5' }), true);
  assert.equal(targetMatches(target, { providerId: 'openai', modelId: 'gpt-4' }), false);
});

test('a provider target matches any model from it', () => {
  const target = { providerId: 'anthropic' };
  assert.equal(targetMatches(target, { providerId: 'anthropic', modelId: 'anything' }), true);
  assert.equal(targetMatches(target, { providerId: 'openai', modelId: 'anything' }), false);
});

test('matching is case-sensitive, because model ids are', () => {
  assert.equal(targetMatches({ modelId: 'GPT-5' }, { providerId: 'openai', modelId: 'gpt-5' }), false);
});

test('an empty target matches nothing rather than everything', () => {
  assert.equal(targetMatches({}, { providerId: 'openai', modelId: 'gpt-5' }), false);
});

// --- parsing settings ------------------------------------------------------

test('malformed entries are discarded without taking the others with them', () => {
  const rules = parseRules([
    { label: 'good', prefer: 'gpt-5', when: { role: 'code' } },
    'not an object',
    { label: 'points nowhere', prefer: {} },
    null,
    { label: 'also good', prefer: { providerId: 'anthropic' } },
  ]);

  assert.deepEqual(rules.map((r) => r.label), ['good', 'also good']);
});

test('a bare string target is shorthand for a model id', () => {
  const rules = parseRules([{ prefer: 'claude-sonnet-4' }]);
  assert.deepEqual(rules[0]?.prefer, { modelId: 'claude-sonnet-4' });
});

test('a rule with no explicit enabled flag is on', () => {
  assert.equal(parseRules([{ prefer: 'x' }])[0]?.enabled, true);
  assert.equal(parseRules([{ prefer: 'x', enabled: false }])[0]?.enabled, false);
});

test('a rule with no label is named after what it prefers', () => {
  assert.equal(parseRules([{ prefer: { providerId: 'ollama' } }])[0]?.label, 'any ollama model');
});

test('non-numeric context thresholds are dropped rather than coerced', () => {
  const rules = parseRules([{ prefer: 'x', when: { minContextTokens: 'lots' } }]);
  assert.equal(rules[0]?.when.minContextTokens, undefined);
  assert.equal(matches(rules[0]!, context({ contextTokens: null })), true, 'the condition is simply absent');
});

test('anything that is not an array yields no rules', () => {
  assert.deepEqual(parseRules(null), []);
  assert.deepEqual(parseRules({}), []);
  assert.deepEqual(parseRules('rules'), []);
});

test('ids are assigned when absent so rules stay addressable', () => {
  const rules = parseRules([{ prefer: 'a' }, { prefer: 'b' }]);
  assert.deepEqual(rules.map((r) => r.id), ['rule-1', 'rule-2']);
});

// --- wording ---------------------------------------------------------------

test('a rule reads as a sentence in the list', () => {
  assert.equal(
    describeRule(rule({ when: { role: 'debug' }, prefer: { modelId: 'gemini-pro' } })),
    'When task is debug → prefer gemini-pro',
  );
  assert.equal(
    describeRule(
      rule({
        when: { role: 'code', minContextTokens: 200_000 },
        prefer: { providerId: 'google' },
        fallback: { modelId: 'gpt-5' },
      }),
    ),
    'When task is code and context ≥ 200,000 → prefer any google model, else gpt-5',
  );
  assert.equal(
    describeRule(rule({ when: {}, prefer: { modelId: 'x' } })),
    'When always → prefer x',
  );
});

test('describeTarget never returns an empty string', () => {
  assert.equal(describeTarget({ modelId: 'a' }), 'a');
  assert.equal(describeTarget({ providerId: 'b' }), 'any b model');
  assert.equal(describeTarget({}), 'no model');
});
