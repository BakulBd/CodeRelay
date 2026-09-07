/**
 * CodeRelay recovery benchmark: the shapes, and the aggregation over runs.
 *
 * This module used to *generate* its results. `evaluateScenario` returned a
 * hand-written model — 2,400 tokens per step, 4,200ms for a naive fallback,
 * 850ms for CodeRelay, a 1.8x replay multiplier — and every field that decided
 * the outcome was a constant chosen in advance. CodeRelay was hardcoded to
 * `completed: true` while the comparison was allowed to fail. A benchmark that
 * can only produce one answer is not evidence, it is a claim wearing a table's
 * clothing, and publishing token counts and dollar costs from it was the
 * fabrication the product is supposed to be against.
 *
 * So this module no longer produces numbers at all. It defines the shape of a
 * *measured* run and aggregates real ones. Every metric is either something a
 * run actually observed or `null`, and `null` renders as "not measured" rather
 * than as a zero.
 *
 * The three paradigms are all really executed — see `runBenchmarkSuite` in
 * `extension.ts`:
 *
 *  1. **Normal execution** — the same task with no faults injected. The
 *     baseline, and the control for how long the work takes at all.
 *  2. **Without recovery** — the same faults, with failover switched off, so
 *     the task has only retry to fall back on. This is the honest stand-in for
 *     "what a tool without cross-provider recovery would do", because it is
 *     literally CodeRelay with that capability removed.
 *  3. **CodeRelay recovery** — the same faults with everything enabled.
 *
 * All three hit the real provider over the real transport; only the failures
 * are synthetic. That is what makes the comparison mean anything.
 */
import type { FaultKind } from './faults.js';

export type BenchmarkParadigm = 'normal_execution' | 'simple_fallback' | 'coderelay_recovery';

export interface BenchmarkScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly faultKind: FaultKind;
  readonly plannedSteps: number;
  readonly sideEffectActions: number;
}

/**
 * What one real run of one paradigm actually did.
 *
 * Nullable fields are the ones a run may not be able to observe. `null` means
 * "not measured" and must never be rendered as `0` — a provider that does not
 * report usage has not reported zero tokens.
 */
export interface ParadigmMetrics {
  readonly paradigm: BenchmarkParadigm;
  readonly label: string;
  /** Whether the run reached a completed task. Observed from the loop result. */
  readonly completed: boolean;
  /**
   * Whether recovery was both needed and successful.
   *
   * `false` when no fault ever fired, because nothing was recovered from — that
   * is a different thing from recovery having failed, and the report says so.
   */
  readonly recoverySucceeded: boolean;
  /** Wall-clock duration of the run. Always measurable. */
  readonly elapsedMs: number;
  /** Tokens the provider reported. `null` when it reported none. */
  readonly tokensUsed: number | null;
  /** Cost derived from reported usage and declared prices. `null` if either is absent. */
  readonly costUsd: number | null;
  /** Routing decisions the loop actually took. */
  readonly retries: number;
  readonly providerSwitches: number;
  /**
   * Side effects the ledger reconciled rather than re-ran.
   *
   * This is the idempotency claim, and it is counted from `TOOL_RECONCILED`
   * entries — the ledger's own record that an effect was adopted instead of
   * repeated.
   */
  readonly duplicateActionsPrevented: number;
  /** Faults that actually fired during this run. Zero means nothing was tested. */
  readonly faultsFired: number;
  /** Escalations the loop raised, i.e. points where it needed a human. */
  readonly humanInterventions: number;
  /** Why the run ended, in the loop's own words. */
  readonly outcome: string;
}

export interface ScenarioBenchmarkResult {
  readonly scenario: BenchmarkScenario;
  readonly results: Record<BenchmarkParadigm, ParadigmMetrics>;
}

export const BENCHMARK_SCENARIOS: readonly BenchmarkScenario[] = [
  {
    id: 'rate_limit_429',
    name: 'HTTP 429 Rate Limit Burst',
    description: 'Model hits provider rate limit mid-task during step 3 of 5.',
    faultKind: 'rate-limit',
    plannedSteps: 5,
    sideEffectActions: 4,
  },
  {
    id: 'stream_truncation',
    name: 'Partial Stream Disconnect',
    description: 'SSE stream drops abruptly midway through a tool execution turn.',
    faultKind: 'partial-stream',
    plannedSteps: 4,
    sideEffectActions: 3,
  },
  {
    id: 'connection_timeout',
    name: 'Socket Connection Timeout',
    description: 'Provider stalls for >30s without returning chunks.',
    faultKind: 'timeout',
    plannedSteps: 6,
    sideEffectActions: 5,
  },
  {
    id: 'provider_outage',
    name: 'Full Provider 503 Outage',
    description: 'Primary provider returns 503; requires cross-provider relay to Gemini.',
    faultKind: 'provider-outage',
    plannedSteps: 5,
    sideEffectActions: 4,
  },
  {
    id: 'context_overflow',
    name: 'Context Window Limit Exceeded',
    description: 'Prompt exceeds 128k context cap; requires structured handoff compaction.',
    faultKind: 'context-overflow',
    plannedSteps: 8,
    sideEffectActions: 6,
  },
];

/** Human wording per paradigm. One definition, shared by every surface. */
export const PARADIGM_LABELS: Readonly<Record<BenchmarkParadigm, string>> = {
  normal_execution: 'No faults (baseline)',
  simple_fallback: 'Faults, recovery off',
  coderelay_recovery: 'Faults, CodeRelay recovery',
};

/**
 * Aggregate measured runs into a suite summary.
 *
 * Every number here is derived from runs that happened. Where a rate cannot be
 * computed — no runs, or no run that measured the input — the field is `null`
 * rather than `0`, because "we could not measure it" and "it was zero" are
 * different answers and only one of them is a result.
 */
export function summarizeSuite(results: readonly ScenarioBenchmarkResult[]): {
  readonly scenarios: number;
  readonly coderelayCompletionRate: number | null;
  readonly withoutRecoveryCompletionRate: number | null;
  readonly duplicateActionsPreventedTotal: number;
  readonly averageRecoveryLatencyMs: number | null;
  readonly scenariosWhereNoFaultFired: number;
} {
  if (results.length === 0) {
    return {
      scenarios: 0,
      coderelayCompletionRate: null,
      withoutRecoveryCompletionRate: null,
      duplicateActionsPreventedTotal: 0,
      averageRecoveryLatencyMs: null,
      scenariosWhereNoFaultFired: 0,
    };
  }

  // A scenario whose faults never fired tested nothing, so it is excluded from
  // the rates and counted separately. Including it would let a run that
  // finished too quickly to be faulted inflate the completion rate.
  const tested = results.filter((r) => r.results.coderelay_recovery.faultsFired > 0);
  const untested = results.length - tested.length;

  const rate = (pick: (r: ScenarioBenchmarkResult) => boolean): number | null =>
    tested.length === 0
      ? null
      : Math.round((tested.filter(pick).length / tested.length) * 100);

  const latencies = tested.map((r) => r.results.coderelay_recovery.elapsedMs);

  return {
    scenarios: results.length,
    coderelayCompletionRate: rate((r) => r.results.coderelay_recovery.completed),
    withoutRecoveryCompletionRate: rate((r) => r.results.simple_fallback.completed),
    duplicateActionsPreventedTotal: results.reduce(
      (sum, r) => sum + r.results.coderelay_recovery.duplicateActionsPrevented,
      0,
    ),
    averageRecoveryLatencyMs:
      latencies.length === 0
        ? null
        : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    scenariosWhereNoFaultFired: untested,
  };
}



/**
 * Format measured runs as a markdown report.
 *
 * Reports what was observed and nothing else. The previous version asserted its
 * conclusions inside the table — "100% Safe Continuation", "Zero False
 * Positives", a hardcoded `0` for CodeRelay's duplicate actions, an
 * "Improvement" column computed from invented constants. A report that states
 * its verdict in the header has not reported anything.
 *
 * `null` renders as an em dash, never as `0`: a provider that reported no usage
 * has not reported zero tokens.
 */
export function formatBenchmarkReport(
  results: readonly ScenarioBenchmarkResult[],
): string {
  const summary = summarizeSuite(results);
  const n = (value: number | null, suffix = ''): string =>
    value === null ? '—' : `${value}${suffix}`;

  const lines: string[] = [];
  lines.push('# CodeRelay recovery benchmark');
  lines.push('');
  lines.push(
    'Each paradigm below was really executed against the configured provider. ' +
      'Only the failures were injected; every unfaulted request was a real one.',
  );
  lines.push('');

  if (summary.scenariosWhereNoFaultFired > 0) {
    lines.push(
      `> **${summary.scenariosWhereNoFaultFired} of ${summary.scenarios} scenarios are excluded ` +
        'from the rates below**: the task finished before the injected fault could fire, so ' +
        'nothing was tested.',
    );
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| :--- | :--- |');
  lines.push(`| Scenarios run | ${summary.scenarios} |`);
  lines.push(`| Completed with CodeRelay recovery | ${n(summary.coderelayCompletionRate, '%')} |`);
  lines.push(`| Completed with recovery off | ${n(summary.withoutRecoveryCompletionRate, '%')} |`);
  lines.push(
    `| Side effects adopted rather than repeated | ${summary.duplicateActionsPreventedTotal} |`,
  );
  lines.push(`| Mean elapsed, CodeRelay recovery | ${n(summary.averageRecoveryLatencyMs, 'ms')} |`);
  lines.push('');
  lines.push('## Scenarios');
  lines.push('');

  for (const result of results) {
    lines.push(`### ${result.scenario.name}`);
    lines.push(result.scenario.description);
    lines.push('');
    if (result.results.coderelay_recovery.faultsFired === 0) {
      lines.push('_No injected fault fired — this scenario tested nothing._');
      lines.push('');
      continue;
    }
    lines.push('| Paradigm | Completed | Elapsed | Switches | Adopted | Tokens | Outcome |');
    lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
    for (const paradigm of [
      'normal_execution',
      'simple_fallback',
      'coderelay_recovery',
    ] as const) {
      const m = result.results[paradigm];
      lines.push(
        `| ${m.label} | ${m.completed ? 'yes' : 'no'} | ${m.elapsedMs}ms | ` +
          `${m.providerSwitches} | ${m.duplicateActionsPrevented} | ${n(m.tokensUsed)} | ${m.outcome} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
