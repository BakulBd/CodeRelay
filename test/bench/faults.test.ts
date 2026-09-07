/**
 * Fault injection.
 *
 * The value of a benchmark rests entirely on whether the failures it claims to
 * have caused actually happened, and whether the requests it did not fault went
 * to the real provider. Both are checked here, along with the property that
 * makes runs comparable at all: the same script always produces the same
 * failures.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAULT_LABELS,
  SCENARIOS,
  injectFaults,
  type FaultKind,
} from '../../src/bench/faults.js';
import type { FetchLike, HttpResponseLike } from '../../src/providers/transport.js';

/** A fetch that records calls and always succeeds. */
function realish(): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    return {
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: null,
      text: async () => 'ok',
    } satisfies HttpResponseLike;
  };
  return { fetchImpl, calls };
}

const init = { method: 'POST', headers: {}, body: '{}' };

test('unfaulted requests reach the real fetch untouched', async () => {
  const inner = realish();
  const { fetchImpl } = injectFaults(inner.fetchImpl, {
    faults: [{ onRequest: 2, kind: 'server-error' }],
  });

  const first = await fetchImpl('https://a.test', init);
  assert.equal(first.status, 200);
  assert.deepEqual(inner.calls, ['https://a.test'], 'the first request was genuinely made');

  const second = await fetchImpl('https://b.test', init);
  assert.equal(second.status, 500);
  assert.equal(inner.calls.length, 1, 'the faulted request must not also hit the provider');
});

test('a rate limit carries the header the classifier reads', async () => {
  const { fetchImpl } = injectFaults(realish().fetchImpl, {
    faults: [{ onRequest: 1, kind: 'rate-limit' }],
  });

  const response = await fetchImpl('https://a.test', init);
  assert.equal(response.status, 429);
  assert.equal(
    response.headers.get('retry-after'),
    '1',
    'a 429 without retry-after exercises a different branch than a real one',
  );
});

test('a network fault throws rather than returning a synthetic 5xx', async () => {
  const { fetchImpl } = injectFaults(realish().fetchImpl, {
    faults: [{ onRequest: 1, kind: 'network' }],
  });

  await assert.rejects(fetchImpl('https://a.test', init), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ECONNRESET');
    return true;
  });
});

test('an auth fault returns 401 so the key rotates rather than the model switching', async () => {
  const { fetchImpl } = injectFaults(realish().fetchImpl, {
    faults: [{ onRequest: 1, kind: 'auth' }],
  });
  assert.equal((await fetchImpl('https://a.test', init)).status, 401);
});

test('a partial stream emits valid framing and then stops', async () => {
  const { fetchImpl } = injectFaults(realish().fetchImpl, {
    faults: [{ onRequest: 1, kind: 'partial-stream' }],
  });

  const response = await fetchImpl('https://a.test', init);
  assert.equal(response.status, 200);

  // `ByteBody` is a union of an async iterable and a reader-style stream; the
  // injector produces the reader form, which is what the real `fetch` adapter
  // hands the transport.
  const body = response.body;
  assert.ok(body !== null && 'getReader' in body, 'the injected body must be a byte stream');
  const reader = body.getReader();

  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /content_block_delta/);

  const second = await reader.read();
  assert.equal(second.done, true, 'done with no terminal event is what a dropped stream looks like');
});

test('a timeout fault never settles until the caller aborts', async () => {
  const { fetchImpl } = injectFaults(realish().fetchImpl, {
    faults: [{ onRequest: 1, kind: 'timeout' }],
  });

  const controller = new AbortController();
  const pending = fetchImpl('https://a.test', { ...init, signal: controller.signal });

  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'the transport deadline is what must end this, not the fault');

  controller.abort();
  await assert.rejects(pending);
});

// --- the property that makes runs comparable ------------------------------

test('the same script produces the same failures every run', async () => {
  const script = {
    faults: [
      { onRequest: 2, kind: 'server-error' as FaultKind },
      { onRequest: 4, kind: 'network' as FaultKind },
    ],
  };

  const observe = async (): Promise<string[]> => {
    const { fetchImpl } = injectFaults(realish().fetchImpl, script);
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      try {
        seen.push(String((await fetchImpl('https://a.test', init)).status));
      } catch {
        seen.push('throw');
      }
    }
    return seen;
  };

  assert.deepEqual(await observe(), await observe());
  assert.deepEqual(await observe(), ['200', '500', '200', 'throw', '200']);
});

// --- honest reporting ------------------------------------------------------

test('the log reports faults that never fired', async () => {
  const { fetchImpl, log } = injectFaults(realish().fetchImpl, {
    faults: [
      { onRequest: 1, kind: 'rate-limit' },
      { onRequest: 9, kind: 'server-error' },
    ],
  });

  await fetchImpl('https://a.test', init);
  const result = log();

  assert.equal(result.requests, 1);
  assert.deepEqual(result.fired.map((f) => f.kind), ['rate-limit']);
  assert.deepEqual(
    result.unfired.map((f) => f.kind),
    ['server-error'],
    'a scenario whose faults never fired has not tested what it claims',
  );
});

test('a run that faults nothing reports every fault as unfired', () => {
  const { log } = injectFaults(realish().fetchImpl, {
    faults: [{ onRequest: 1, kind: 'network' }],
  });
  assert.equal(log().requests, 0);
  assert.equal(log().unfired.length, 1);
});

// --- scenarios -------------------------------------------------------------

test('every fault kind has a label and every scenario a non-empty script', () => {
  const kinds: FaultKind[] = [
    'rate-limit',
    'server-error',
    'auth',
    'network',
    'timeout',
    'partial-stream',
  ];
  for (const kind of kinds) {
    assert.ok(FAULT_LABELS[kind].length > 0, kind);
  }

  const ids = new Set<string>();
  for (const scenario of SCENARIOS) {
    assert.ok(scenario.script.faults.length > 0, `${scenario.id} faults nothing`);
    assert.ok(scenario.description.length > 0, `${scenario.id} needs a description`);
    assert.equal(ids.has(scenario.id), false, 'scenario ids must be unique');
    ids.add(scenario.id);
    for (const fault of scenario.script.faults) {
      assert.ok(fault.onRequest >= 1, 'request ordinals are 1-based');
    }
  }
});

test('the sustained outage scenario faults enough to force a provider move', () => {
  const sustained = SCENARIOS.find((s) => s.id === 'sustained-outage');
  assert.ok(sustained !== undefined);
  assert.ok(
    sustained.script.faults.length >= 3,
    'the per-model attempt budget is 3, so fewer would only test retry',
  );
});
