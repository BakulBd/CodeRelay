/**
 * The chaos harness must not invent outcomes.
 *
 * `runSimulation` used to report `detected: true`, `successorResumed: true` and
 * a verification of "12 of 12 checks passed" — none of which any code in it
 * observed. It wrote a pre-decided success story into the task graph and
 * returned it as an experiment result, and the panel displayed it as one. A
 * chaos test that cannot fail is not a test.
 *
 * These assertions are deliberately about *absence of claims*. The harness is a
 * dry run of the relay bookkeeping; making a provider genuinely fail is the
 * Benchmark Lab's job, and the two must never be confusable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ChaosInjectionHarness } from '../../src/bench/chaos.js';
import { TaskStateGraph } from '../../src/continuity/graph.js';
import type { ModelRef } from '../../src/core/types.js';

const PRIMARY: ModelRef = { providerId: 'anthropic', modelId: 'claude-sonnet-4' };
const FALLBACK: ModelRef = { providerId: 'openai', modelId: 'gpt-5' };

function run() {
  const graph = new TaskStateGraph('task-1');
  const harness = new ChaosInjectionHarness({
    failureType: 'PROVIDER_503_OUTAGE',
    triggerOnStep: 3,
    enabled: true,
  });
  return {
    graph,
    report: harness.runSimulation({
      graph,
      primaryWorker: PRIMARY,
      fallbackWorker: FALLBACK,
      failureType: 'PROVIDER_503_OUTAGE',
    }),
  };
}

test('a dry run does not claim anything was detected', () => {
  assert.equal(
    run().report.detected,
    false,
    'no request was made, so nothing detected a failure',
  );
});

test('a dry run does not claim a successor resumed', () => {
  assert.equal(run().report.successorResumed, false, 'no successor ran');
});

test('a dry run reports no verification rather than a passing one', () => {
  assert.equal(
    run().report.finalVerificationPassed,
    null,
    'claiming a compiler and a suite passed when neither was invoked was the worst of it',
  );
});

test('a dry run does not leave the graph claiming the task completed', () => {
  const { graph } = run();
  assert.notEqual(
    graph.getTaskStatus(),
    'completed',
    'nothing ran, so the task did not finish',
  );
});

test('the details say plainly that nothing was called', () => {
  const details = run().report.details;
  assert.match(details, /Dry run only/);
  assert.match(details, /no provider was called/i);
  assert.match(details, /Benchmark Lab/, 'it must point at the thing that does run for real');
});

test('what it does report is real: the graph really recorded the relay', () => {
  const { report } = run();
  assert.equal(report.executionFrozen, true, 'the status change is checked, not asserted');
  assert.equal(report.recoveryPackageCreated, true);
  assert.equal(
    typeof report.duplicatesPrevented,
    'number',
    'counted from the actions the graph actually holds',
  );
});
