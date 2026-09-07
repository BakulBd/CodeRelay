/**
 * Benchmark aggregation.
 *
 * The previous version of this file asserted the conclusions: completion rate
 * exactly 100, token savings above 25%, and the literal string
 * "100% Safe Continuation" in the report. Those passed because the module
 * generated them from constants — the test locked in a marketing claim rather
 * than checking a measurement.
 *
 * This module no longer produces numbers, so what is worth testing is the
 * honesty of the aggregation: unmeasured stays unmeasured, and a scenario whose
 * fault never fired is excluded from the rates instead of inflating them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BENCHMARK_SCENARIOS,
  PARADIGM_LABELS,
  formatBenchmarkReport,
  summarizeSuite,
  type BenchmarkParadigm,
  type ParadigmMetrics,
  type ScenarioBenchmarkResult,
} from '../../src/bench/recovery-bench.js';

function metrics(over: Partial<ParadigmMetrics> = {}): ParadigmMetrics {
  return {
    paradigm: 'coderelay_recovery',
    label: PARADIGM_LABELS.coderelay_recovery,
    completed: true,
    recoverySucceeded: true,
    elapsedMs: 1_000,
    tokensUsed: null,
    costUsd: null,
    retries: 0,
    providerSwitches: 0,
    duplicateActionsPrevented: 0,
    faultsFired: 1,
    humanInterventions: 0,
    outcome: 'DONE',
    ...over,
  };
}

function scenarioResult(
  over: Partial<Record<BenchmarkParadigm, Partial<ParadigmMetrics>>> = {},
): ScenarioBenchmarkResult {
  return {
    scenario: BENCHMARK_SCENARIOS[0]!,
    results: {
      normal_execution: metrics({ paradigm: 'normal_execution', faultsFired: 0, ...over.normal_execution }),
      simple_fallback: metrics({ paradigm: 'simple_fallback', ...over.simple_fallback }),
      coderelay_recovery: metrics({ paradigm: 'coderelay_recovery', ...over.coderelay_recovery }),
    },
  };
}

// --- the honesty properties ------------------------------------------------

test('no runs yields null rates, never zero', () => {
  const summary = summarizeSuite([]);

  assert.equal(summary.scenarios, 0);
  assert.equal(
    summary.coderelayCompletionRate,
    null,
    '"we measured nothing" and "it completed 0% of the time" are different answers',
  );
  assert.equal(summary.withoutRecoveryCompletionRate, null);
  assert.equal(summary.averageRecoveryLatencyMs, null);
});

test('a scenario whose fault never fired is excluded from the rates', () => {
  const summary = summarizeSuite([
    scenarioResult({ coderelay_recovery: { faultsFired: 0, completed: true } }),
    scenarioResult({ coderelay_recovery: { faultsFired: 1, completed: false } }),
  ]);

  assert.equal(summary.scenariosWhereNoFaultFired, 1);
  assert.equal(
    summary.coderelayCompletionRate,
    0,
    'a run that finished before it could be faulted must not count as a success',
  );
});

test('every scenario untested yields null rather than a rate over nothing', () => {
  const summary = summarizeSuite([scenarioResult({ coderelay_recovery: { faultsFired: 0 } })]);
  assert.equal(summary.coderelayCompletionRate, null);
  assert.equal(summary.scenariosWhereNoFaultFired, 1);
});

test('rates are computed from the runs, not asserted', () => {
  const summary = summarizeSuite([
    scenarioResult({
      coderelay_recovery: { completed: true },
      simple_fallback: { completed: false },
    }),
    scenarioResult({
      coderelay_recovery: { completed: false },
      simple_fallback: { completed: false },
    }),
  ]);

  assert.equal(summary.coderelayCompletionRate, 50);
  assert.equal(summary.withoutRecoveryCompletionRate, 0);
});

test('nothing forces CodeRelay to win', () => {
  // The old module hardcoded `completed: true` for CodeRelay. The aggregation
  // must be perfectly willing to report that it lost.
  const summary = summarizeSuite([
    scenarioResult({
      coderelay_recovery: { completed: false },
      simple_fallback: { completed: true },
    }),
  ]);

  assert.equal(summary.coderelayCompletionRate, 0);
  assert.equal(summary.withoutRecoveryCompletionRate, 100);
});

test('adopted side effects are summed across scenarios', () => {
  const summary = summarizeSuite([
    scenarioResult({ coderelay_recovery: { duplicateActionsPrevented: 2 } }),
    scenarioResult({ coderelay_recovery: { duplicateActionsPrevented: 3 } }),
  ]);
  assert.equal(summary.duplicateActionsPreventedTotal, 5);
});

// --- the report ------------------------------------------------------------

test('the report states measurements and asserts no conclusions', () => {
  const report = formatBenchmarkReport([scenarioResult()]);

  assert.match(report, /# CodeRelay recovery benchmark/);
  assert.match(report, new RegExp(BENCHMARK_SCENARIOS[0]!.name));

  for (const claim of ['100% Safe Continuation', 'Zero False Positives', 'faster', 'Improvement']) {
    assert.ok(!report.includes(claim), `the report must not assert "${claim}"`);
  }
});

test('unmeasured values render as a dash, never as zero', () => {
  const report = formatBenchmarkReport([
    scenarioResult({ coderelay_recovery: { tokensUsed: null } }),
  ]);
  assert.match(report, /\| — \|/, 'a provider that reported no usage did not report zero tokens');
});

test('a scenario that tested nothing says so instead of showing a table', () => {
  const report = formatBenchmarkReport([
    scenarioResult({ coderelay_recovery: { faultsFired: 0 } }),
  ]);
  assert.match(report, /No injected fault fired — this scenario tested nothing/);
});

test('every scenario declares a fault kind and a description', () => {
  const ids = new Set<string>();
  for (const scenario of BENCHMARK_SCENARIOS) {
    assert.ok(scenario.name.length > 0);
    assert.ok(scenario.description.length > 0);
    assert.ok(scenario.faultKind.length > 0);
    assert.equal(ids.has(scenario.id), false, 'scenario ids must be unique');
    ids.add(scenario.id);
  }
});
