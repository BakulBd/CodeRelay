/**
 * The agent loop, driven end to end with no network and no editor.
 *
 * The loop itself contains almost no policy — that lives in `route`,
 * `planRecovery` and `ToolRunner` — so what is worth testing here is the
 * *sequencing*, and in particular the invariants that the other modules assume
 * the loop upholds:
 *
 *  - `stepId` is byte-identical across every attempt at one logical turn, so a
 *    `SideEffectKey` cannot change under a retry. `attemptId` carries what
 *    varies. This is the invariant the whole `TurnStep`/`sameTurn` distinction
 *    exists to protect, and nothing else in the codebase can check it.
 *  - `maxTurns` bounds logical turns, not attempts, so burning the retry budget
 *    inside one turn does not silently shorten the task.
 *  - a truncated turn is *recorded* and then *routed as a failure*, rather than
 *    being mistaken for a finished turn.
 *  - a cancelled request is never routed, never retried, and never recorded as a
 *    failure.
 *  - the secret reaches the request only through `adapter.sign`.
 *
 * The ledger, the tool runner and the credential manager are the real classes
 * (they have private state, so a structural double would be a lie as well as
 * impossible), over a temporary directory. Only the genuinely external edges are
 * faked: fetch, the provider adapter, secret storage and the clock's sleep.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentLoop, type LoopEvent, type LoopResult, type TurnPrompt } from '../../src/agent/loop.js';
import type { LedgerEntry } from '../../src/continuity/entries.js';
import { ExecutionLedger } from '../../src/continuity/ledger.js';
import {
  CredentialManager,
  type MetadataStore,
  type SecretStore,
} from '../../src/credentials/store.js';
import type {
  AttemptId,
  ModelCapabilities,
  ModelRef,
  NormalizedEvent,
  SideEffectKey,
  StepId,
  StopReason,
  TaskId,
  ToolCallId,
} from '../../src/core/types.js';

import type { Candidate, Requirements } from '../../src/policy/route.js';
import type {
  BuiltRequest,
  ProviderAdapter,
  StreamDecoder,
} from '../../src/providers/adapter.js';
import type {
  ByteBody,
  FetchLike,
  HttpRequestInitLike,
  HttpResponseLike,
} from '../../src/providers/transport.js';
import type { SseEvent } from '../../src/providers/sse.js';
import { builtinFileTools } from '../../src/tools/file-tools.js';
import { ToolRunner } from '../../src/tools/runner.js';
import { ToolRegistry } from '../../src/tools/tool.js';
import { FileSystemProbe } from '../../src/workspace/probe.js';

const TASK = 'task-1' as TaskId;
const CALL = 'call-1' as ToolCallId;

const MODEL_A: ModelRef = { providerId: 'p1', modelId: 'model-a' };
const MODEL_B: ModelRef = { providerId: 'p2', modelId: 'model-b' };

const CAPS: ModelCapabilities = {
  streaming: true,
  toolCalling: true,
  parallelToolCalls: false,
  vision: false,
  reasoning: 'none',
  structuredOutput: true,
  contextWindow: 200_000,
  maxOutput: 8_192,
  costPerMTokIn: 1,
  costPerMTokOut: 2,
};

const REQUIREMENTS: Requirements = {
  toolCalling: true,
  vision: false,
  minContextWindow: 1_000,
};

// --- scripted transport ---

/** One scripted response, consumed in order by the fake fetch. */
type Attempt =
  /**
   * A 200 event stream carrying these events verbatim.
   *
   * A script that omits a `done` event models a stream that died mid-turn: the
   * decoder reports `incomplete`, which is what the transport turns into a
   * STREAM failure. That is deliberately expressed by omission rather than by a
   * flag, because it is the same thing the real decoders do.
   */
  | { readonly kind: 'events'; readonly events: readonly NormalizedEvent[] }
  | { readonly kind: 'status'; readonly status: number; readonly body?: string }
  | { readonly kind: 'throw'; readonly error: Error };

const events = (...list: readonly NormalizedEvent[]): Attempt => ({ kind: 'events', events: list });
const status = (code: number, body = ''): Attempt => ({ kind: 'status', status: code, body });
const text = (delta: string): NormalizedEvent => ({ t: 'text', delta });
const done = (reason: StopReason): NormalizedEvent => ({ t: 'done', reason });

function sseBody(list: readonly NormalizedEvent[]): ByteBody {
  const payload = list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return (async function* () {
    yield new TextEncoder().encode(payload);
  })();
}


function headersOf(record: Readonly<Record<string, string>>): HttpResponseLike['headers'] {
  return { get: (name: string) => record[name.toLowerCase()] ?? null };
}

/**
 * Decodes the fake wire format: one JSON `NormalizedEvent` per SSE event.
 *
 * `incomplete` is derived the way a real decoder derives it — from the absence
 * of the provider's terminal event — so "the stream stopped early" is a property
 * of the script rather than something the harness asserts into existence.
 */
class JsonEventDecoder implements StreamDecoder {
  private sawDone = false;

  decode(event: SseEvent): NormalizedEvent[] {
    if (event.data === '') {
      return [];
    }
    const parsed = JSON.parse(event.data) as NormalizedEvent;
    if (parsed.t === 'done') {
      this.sawDone = true;
    }
    return [parsed];
  }

  finish(): { events: NormalizedEvent[]; incomplete: boolean } {
    return { events: [], incomplete: !this.sawDone };
  }
}

class FakeAdapter implements ProviderAdapter {
  /** Every secret handed to `sign`, in order. Never a header the loop invented. */
  readonly signedWith: string[] = [];

  constructor(readonly providerId: string) {}

  createDecoder(): StreamDecoder {
    return new JsonEventDecoder();
  }

  capabilities(): ModelCapabilities | null {
    return CAPS;
  }

  models(): readonly ModelRef[] {
    return [];
  }

  sign(request: BuiltRequest, secret: string): BuiltRequest {
    this.signedWith.push(secret);
    return {
      ...request,
      headers: { ...(request.headers ?? {}), 'x-test-key': secret },
    };
  }
}

// --- credential doubles ---

class FakeSecrets implements SecretStore {
  readonly entries = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.entries.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

class FakeMetadata implements MetadataStore {
  readonly entries = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.entries.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.entries.set(key, JSON.parse(JSON.stringify(value)));
  }
}

// --- harness ---

interface Options {
  readonly script: readonly Attempt[];
  readonly maxTurns?: number;
  /** Models offered to the router. The first one is where the task starts. */
  readonly models?: readonly ModelRef[];
  /** Provider ids to register adapters for. Defaults to every model's provider. */
  readonly providers?: readonly string[];
  readonly keys?: readonly { readonly providerId: string; readonly secret: string }[];
  readonly progressEveryChars?: number;
}

interface Harness {
  readonly workspace: string;
  readonly ledger: ExecutionLedger;
  readonly credentials: CredentialManager;
  readonly loop: AgentLoop;
  readonly prompts: TurnPrompt[];
  readonly requests: { url: string; init: HttpRequestInitLike }[];
  readonly observed: LoopEvent[];
  readonly delays: number[];
  adapter(providerId: string): FakeAdapter;
  entries(): Promise<LedgerEntry[]>;
  dispose(): Promise<void>;
}

async function harness(opts: Options): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'coderelay-loop-'));
  const workspace = join(dir, 'workspace');
  const probe = new FileSystemProbe(workspace);
  const ledger = await ExecutionLedger.open(join(dir, 'storage'), TASK);
  const tools = new ToolRegistry(builtinFileTools);
  const runner = new ToolRunner({ ledger, tools, probe, root: workspace, taskId: TASK });

  const secrets = new FakeSecrets();
  const metadata = new FakeMetadata();
  let issued = 0;
  const credentials = new CredentialManager({
    secrets,
    metadata,
    newId: () => `cred-${++issued}`,
  });

  for (const key of opts.keys ?? [{ providerId: MODEL_A.providerId, secret: 'k1' }]) {
    await credentials.add(key.providerId, `${key.providerId} key`, key.secret);
  }

  const models = opts.models ?? [MODEL_A];
  const adapters = new Map<string, FakeAdapter>();
  for (const providerId of opts.providers ?? models.map((m) => m.providerId)) {
    adapters.set(providerId, new FakeAdapter(providerId));
  }

  const queue = [...opts.script];
  const requests: { url: string; init: HttpRequestInitLike }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, init });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('The loop made more requests than the script supplies.');
    }
    if (next.kind === 'throw') {
      throw next.error;
    }
    if (next.kind === 'status') {
      return {
        status: next.status,
        headers: headersOf({ 'content-type': 'application/json' }),
        body: null,
        text: async () => next.body ?? '',
      };
    }
    return {
      status: 200,
      headers: headersOf({ 'content-type': 'text/event-stream' }),
      body: sseBody(next.events),
      text: async () => '',
    };
  };

  const prompts: TurnPrompt[] = [];
  const observed: LoopEvent[] = [];
  const delays: number[] = [];

  const candidates = async (): Promise<readonly Candidate[]> =>
    models.map((model) => ({
      model,
      capabilities: CAPS,
      readyCredentialIds: credentials
        .records()
        .filter((r) => r.providerId === model.providerId && r.disabledReason === null)
        .map((r) => r.credentialId),
      coolingRetryAfterMs: null,
    }));

  const loop = new AgentLoop({
    taskId: TASK,
    ledger,
    runner,
    tools,
    credentials,
    adapters,
    fetchImpl,
    buildRequest: (prompt) => {
      prompts.push(prompt);
      return {
        url: `https://example.test/${prompt.model.providerId}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: prompt.model.modelId, objective: prompt.objective }),
      };
    },
    candidates,
    requirements: REQUIREMENTS,
    initialModel: models[0]!,
    checkpoints: null,
    ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
    ...(opts.progressEveryChars === undefined
      ? {}
      : { progressEveryChars: opts.progressEveryChars }),
    // Delays are recorded rather than waited on: the policy decides how long to
    // wait, and re-testing its arithmetic in real time would only make the suite
    // slow.
    sleep: async (ms) => {
      delays.push(ms);
    },
    observer: (event) => observed.push(event),
  });

  return {
    workspace,
    ledger,
    credentials,
    loop,
    prompts,
    requests,
    observed,
    delays,
    adapter(providerId) {
      const found = adapters.get(providerId);
      if (found === undefined) {
        throw new Error(`The harness registered no adapter for "${providerId}".`);
      }
      return found;
    },

    entries: () => ledger.read(),
    async dispose() {
      await ledger.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function of<T extends LedgerEntry['type']>(
  entries: readonly LedgerEntry[],
  type: T,
): Extract<LedgerEntry, { type: T }>[] {
  return entries.filter((e): e is Extract<LedgerEntry, { type: T }> => e.type === type);
}

const stepOf = (turn: number): StepId => `${TASK}#turn-${turn}` as StepId;

// --- turn and attempt accounting ---

test('a retry is another attempt at the same step, not a new step', async () => {
  const h = await harness({ script: [status(500, 'upstream exploded'), events(text('ok'), done('stop'))] });
  try {
    const result = await h.loop.run('do the thing');
    assert.deepEqual(result, { kind: 'DONE', turns: 1 });

    const streaming = of(await h.entries(), 'STREAMING');
    assert.equal(streaming.length, 2);
    // The load-bearing assertion: the same logical turn keeps one stepId, so a
    // side-effect key derived from it cannot move under a retry.
    assert.equal(streaming[0]!.stepId, stepOf(1));
    assert.equal(streaming[1]!.stepId, stepOf(1));
    assert.notEqual(streaming[0]!.attemptId, streaming[1]!.attemptId);
  } finally {
    await h.dispose();
  }
});

test('maxTurns bounds logical turns, so retries do not shorten the task', async () => {
  // One turn of budget, and the first attempt at it fails. Counting attempts
  // would abandon the task here.
  const h = await harness({
    maxTurns: 1,
    script: [status(503), events(text('finished'), done('stop'))],
  });
  try {
    const result = await h.loop.run('do the thing');
    assert.deepEqual(result, { kind: 'DONE', turns: 1 });
  } finally {
    await h.dispose();
  }
});

test('a task that never concludes is abandoned once the turn budget is spent', async () => {
  // Each turn completes cleanly and dispatches a tool, so each one is a genuine
  // step rather than a retry.
  const turn = () =>
    events(
      { t: 'tool_call', id: CALL, name: 'read_file', args: { path: 'a.txt' } },
      done('tool_use'),
    );
  const h = await harness({ maxTurns: 2, script: [turn(), turn()] });
  try {
    const result = await h.loop.run('loop forever');
    assert.equal(result.kind, 'ABANDONED');
    assert.match((result as { reason: string }).reason, /after 2 model turns/);

    const entries = await h.entries();
    assert.deepEqual(
      of(entries, 'STREAMING').map((e) => e.stepId),
      [stepOf(1), stepOf(2)],
    );
    assert.equal(of(entries, 'TASK_ABANDONED').length, 1);
  } finally {
    await h.dispose();
  }
});

test('attempt ids are unique across a task without a global counter', async () => {
  const h = await harness({
    script: [
      status(500),
      events({ t: 'tool_call', id: CALL, name: 'read_file', args: { path: 'a.txt' } }, done('tool_use')),
      events(text('done'), done('stop')),
    ],
  });
  try {
    await h.loop.run('do the thing');
    const ids = of(await h.entries(), 'STREAMING').map((e) => e.attemptId as string);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    await h.dispose();
  }
});

// --- truncation ---

test('a truncated turn is recorded and then routed as a failure', async () => {
  const h = await harness({
    script: [
      events(text('I will now '), done('truncated')),
      events(text('all done'), done('stop')),
    ],
  });
  try {
    const result = await h.loop.run('do the thing');
    assert.deepEqual(result, { kind: 'DONE', turns: 1 });

    const entries = await h.entries();
    const completed = of(entries, 'MODEL_RESPONSE_COMPLETED');
    // Recorded honestly, so the timeline shows what arrived...
    assert.equal(completed[0]!.reason, 'truncated');
    assert.equal(completed[0]!.text, 'I will now ');
    // ...and then routed, so no half-expressed intent is acted on.
    const failed = of(entries, 'FAILED');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.errorClass, 'STREAM');
    assert.equal(failed[0]!.hadStreamedTokens, true);

    // Same turn, so the retry keeps the step.
    assert.deepEqual(
      of(entries, 'STREAMING').map((e) => e.stepId),
      [stepOf(1), stepOf(1)],
    );
    // The partial text is not promoted into the transcript as if the model had
    // said it.
    assert.deepEqual(h.prompts[1]!.transcript, []);
  } finally {
    await h.dispose();
  }
});

test('a stream that stops without a terminal event is a failure, not a finished turn', async () => {
  const h = await harness({
    // No `done` event: the decoder reports the turn never completed.
    script: [events(text('half a thought')), events(text('done'), done('stop'))],
  });
  try {
    const result = await h.loop.run('do the thing');
    assert.deepEqual(result, { kind: 'DONE', turns: 1 });

    const entries = await h.entries();
    assert.equal(of(entries, 'MODEL_RESPONSE_COMPLETED').length, 1);
    assert.equal(of(entries, 'FAILED')[0]!.errorClass, 'STREAM');
  } finally {
    await h.dispose();
  }
});

// --- cancellation ---

test('cancellation ends the task without a failure and without a retry', async () => {
  const abort = new Error('The operation was aborted');
  abort.name = 'AbortError';
  const h = await harness({ script: [{ kind: 'throw', error: abort }] });
  try {
    const result = await h.loop.run('do the thing');
    assert.deepEqual(result, { kind: 'CANCELLED' });

    const entries = await h.entries();
    assert.deepEqual(of(entries, 'FAILED'), []);
    assert.deepEqual(of(entries, 'RECOVERING'), []);
    assert.equal(of(entries, 'TASK_ABANDONED')[0]!.reason, 'Cancelled by the user.');
    // Exactly one request: a cancelled attempt is never tried again.
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.delays, []);
  } finally {
    await h.dispose();
  }
});

// --- configuration faults ---

test('a model with no registered adapter is a configuration fault, not a retry', async () => {
  const h = await harness({ script: [], providers: [] });
  try {
    const result = await h.loop.run('do the thing');
    assert.equal(result.kind, 'ABANDONED');
    assert.match((result as { reason: string }).reason, /No adapter is registered for provider "p1"/);
    // Nothing was sent, and no credential was even acquired.
    assert.deepEqual(h.requests, []);
    assert.deepEqual(of(await h.entries(), 'STREAMING'), []);
  } finally {
    await h.dispose();
  }
});

test('having no usable credential parks the task instead of failing it', async () => {
  const h = await harness({ script: [], keys: [] });
  try {
    const result = await h.loop.run('do the thing');
    assert.equal(result.kind, 'ESCALATED');
    assert.match((result as { question: string }).question, /no usable credential for "p1"/);
    assert.equal(of(await h.entries(), 'ESCALATED').length, 1);
    assert.deepEqual(h.requests, []);
  } finally {
    await h.dispose();
  }
});

test('a cooldown longer than the wait budget is the user\u2019s decision, not a stall', async () => {
  const h = await harness({ script: [] });
  try {
    const credentialId = h.credentials.records()[0]!.credentialId;
    await h.credentials.reportFailure(credentialId, {
      errorClass: 'RETRYABLE',
      requestRetryable: true,
      // Far beyond DEFAULT_LIMITS.maxWaitMs.
      retryAfterMs: 600_000,
      rotateCredential: true,
      reason: 'throttled',
    });

    const result = await h.loop.run('do the thing');
    assert.equal(result.kind, 'ESCALATED');
    assert.match((result as { question: string }).question, /rate limited or cooling down/);
    assert.deepEqual(h.requests, []);
  } finally {
    await h.dispose();
  }
});

// --- credentials reach the request only through the adapter ---

test('the secret reaches the request only through adapter.sign', async () => {
  const h = await harness({ script: [events(text('ok'), done('stop'))] });
  try {
    await h.loop.run('do the thing');

    assert.deepEqual(h.adapter('p1').signedWith, ['k1']);
    const sent = h.requests[0]!.init.headers;
    assert.equal(sent['x-test-key'], 'k1');
    // The builder's own headers survive, and the loop added no auth of its own.
    assert.equal(sent['content-type'], 'application/json');
    assert.equal(sent['authorization'], undefined);
    assert.deepEqual(Object.keys(sent).sort(), ['content-type', 'x-test-key']);
  } finally {
    await h.dispose();
  }
});

test('a successful turn clears the credential\u2019s failure count', async () => {
  const h = await harness({ script: [status(500), events(text('ok'), done('stop'))] });
  try {
    await h.loop.run('do the thing');
    const record = h.credentials.records()[0]!;
    assert.equal(record.consecutiveFailures, 0);
    assert.equal(record.disabledReason, null);
  } finally {
    await h.dispose();
  }
});

// --- model switching ---

test('an invalid request moves to another model and hands off through the ledger', async () => {
  const h = await harness({
    models: [MODEL_A, MODEL_B],
    keys: [
      { providerId: 'p1', secret: 'k1' },
      { providerId: 'p2', secret: 'k2' },
    ],
    script: [status(400, 'unknown model'), events(text('ok'), done('stop'))],
  });
  try {
    const result = await h.loop.run('do the thing');
    assert.deepEqual(result, { kind: 'DONE', turns: 1 });

    const entries = await h.entries();
    const switched = of(entries, 'PROVIDER_SWITCHED');
    assert.equal(switched.length, 1);
    assert.deepEqual(switched[0]!.from, MODEL_A);
    assert.deepEqual(switched[0]!.to, MODEL_B);

    // A switch is another attempt at the same turn.
    assert.deepEqual(
      of(entries, 'STREAMING').map((e) => e.stepId),
      [stepOf(1), stepOf(1)],
    );

    // The successor is briefed, and briefed exactly once.
    assert.equal(h.prompts[0]!.handoff, null);
    assert.deepEqual(h.prompts[1]!.model, MODEL_B);
    assert.notEqual(h.prompts[1]!.handoff, null);
    assert.match(h.prompts[1]!.handoff!, /do the thing/);

    // Each provider signed with its own key, and only its own key.
    assert.deepEqual(h.adapter('p1').signedWith, ['k1']);
    assert.deepEqual(h.adapter('p2').signedWith, ['k2']);
    assert.equal(h.requests[1]!.url, 'https://example.test/p2');
  } finally {
    await h.dispose();
  }
});

// --- tools ---

test('a tool call is executed under the write-ahead protocol and fed back', async () => {
  const h = await harness({
    script: [
      events(
        { t: 'tool_call', id: CALL, name: 'write_file', args: { path: 'a.txt', content: 'hello' } },
        done('tool_use'),
      ),
      events(text('written'), done('stop')),
    ],
  });
  try {
    const result = await h.loop.run('write a file');
    assert.deepEqual(result, { kind: 'DONE', turns: 2 });

    assert.equal(await readFile(join(h.workspace, 'a.txt'), 'utf8'), 'hello');

    const entries = await h.entries();
    assert.deepEqual(
      entries
        .filter((e) => e.type.startsWith('TOOL_'))
        .map((e) => e.type),
      ['TOOL_REQUESTED', 'TOOL_EXECUTING', 'TOOL_COMPLETED'],
    );
    // The tool belongs to the turn that requested it.
    assert.equal(of(entries, 'TOOL_REQUESTED')[0]!.stepId, stepOf(1));
    // Dispatching a tool finishes the turn, so the next one is a new step.
    assert.deepEqual(
      of(entries, 'STREAMING').map((e) => e.stepId),
      [stepOf(1), stepOf(2)],
    );

    // The result is context for the next turn, and it is labelled as a result
    // rather than as something the model said.
    const item = h.prompts[1]!.transcript.at(-1)!;
    assert.equal(item.role, 'tool_result');
    assert.equal(item.toolCallId, CALL);

    assert.equal(h.observed.filter((e) => e.t === 'tool').length, 1);
  } finally {
    await h.dispose();
  }
});

test('a hallucinated tool name is information for the model, not a dead task', async () => {
  const h = await harness({
    script: [
      events({ t: 'tool_call', id: CALL, name: 'nope', args: {} }, done('tool_use')),
      events(text('understood'), done('stop')),
    ],
  });
  try {
    const result = await h.loop.run('do the thing');
    assert.deepEqual(result, { kind: 'DONE', turns: 2 });

    const entries = await h.entries();
    const failed = of(entries, 'FAILED');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.errorClass, 'TOOL');
    // Never entered the runner: an unknown name is not a side effect.
    assert.deepEqual(of(entries, 'TOOL_REQUESTED'), []);

    const item = h.prompts[1]!.transcript.at(-1)!;
    assert.equal(item.role, 'tool_result');
    assert.match(item.text, /Unknown tool "nope"/);
    assert.match(item.text, /write_file/);
  } finally {
    await h.dispose();
  }
});

test('a tool that fails is reported to the model and the task continues', async () => {
  const h = await harness({
    script: [
      // Escapes the workspace root, so the tool rejects it.
      events(
        { t: 'tool_call', id: CALL, name: 'read_file', args: { path: '../outside.txt' } },
        done('tool_use'),
      ),
      events(text('understood'), done('stop')),
    ],
  });
  try {
    const result = await h.loop.run('read something');
    assert.deepEqual(result, { kind: 'DONE', turns: 2 });

    const completed = of(await h.entries(), 'TOOL_COMPLETED');
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.ok, false);
    assert.match(h.prompts[1]!.transcript.at(-1)!.text, /Failed:/);
  } finally {
    await h.dispose();
  }
});

// --- progress and resumption ---

test('streaming progress is checkpointed while a turn is still open', async () => {
  const h = await harness({
    progressEveryChars: 4,
    script: [events(text('abcd'), text('efgh'), done('stop'))],
  });
  try {
    await h.loop.run('do the thing');
    const progress = of(await h.entries(), 'STREAM_PROGRESS');
    assert.deepEqual(
      progress.map((e) => e.textSoFar),
      ['abcd', 'abcdefgh'],
    );
    // Progress belongs to the attempt that produced it.
    assert.equal(progress[0]!.stepId, stepOf(1));
  } finally {
    await h.dispose();
  }
});

test('resuming keeps the original objective and carries a truncated turn forward as a hint', async () => {
  const h = await harness({ script: [events(text('ok'), done('stop'))] });
  try {
    // A previous process got as far as a truncated turn.
    await h.ledger.append({
      taskId: TASK,
      stepId: stepOf(1),
      attemptId: `${TASK}#turn-1-attempt-1` as AttemptId,
      type: 'TASK_STARTED',
      objective: 'the original objective',
    });
    await h.ledger.append({
      taskId: TASK,
      stepId: stepOf(1),
      attemptId: `${TASK}#turn-1-attempt-1` as AttemptId,
      type: 'MODEL_RESPONSE_COMPLETED',
      model: MODEL_A,
      reason: 'truncated',
      text: 'I was going to',
    });

    const result = await h.loop.run('a different objective');
    assert.deepEqual(result, { kind: 'DONE', turns: 1 });

    // Resuming must not silently retarget the task.
    assert.equal(h.prompts[0]!.objective, 'the original objective');
    // Only one TASK_STARTED: the resume path does not restart the task.
    assert.equal(of(await h.entries(), 'TASK_STARTED').length, 1);

    const note = h.prompts[0]!.transcript[0]!;
    assert.equal(note.role, 'note');
    // The partial text must arrive labelled as an unfinished hint, never as
    // something the previous model actually decided. Both halves of that
    // contract are asserted: the heading that frames it, and the caveat that
    // stops the successor acting on it.
    assert.match(note.text, /Output that was cut off/);
    assert.match(note.text, /never finished/);
    assert.match(note.text, /I was going to/);
  } finally {
    await h.dispose();
  }
});

test('a finished ledger is not resurrected by another run', async () => {
  const h = await harness({ script: [] });
  try {
    await h.ledger.append({
      taskId: TASK,
      stepId: stepOf(1),
      attemptId: `${TASK}#turn-1-attempt-1` as AttemptId,
      type: 'TASK_STARTED',
      objective: 'already finished',
    });
    await h.ledger.append({
      taskId: TASK,
      stepId: stepOf(1),
      attemptId: `${TASK}#turn-1-attempt-1` as AttemptId,
      type: 'TASK_DONE',
    });

    const result: LoopResult = await h.loop.run('anything');
    assert.deepEqual(result, { kind: 'DONE', turns: 0 });
    assert.deepEqual(h.requests, []);
  } finally {
    await h.dispose();
  }
});

test('an interrupted tool call is resumed from the ledger rather than re-requested', async () => {
  const h = await harness({ script: [events(text('all done'), done('stop'))] });
  try {
    const base = {
      taskId: TASK,
      stepId: stepOf(1),
      attemptId: `${TASK}#turn-1-attempt-1` as AttemptId,
    } as const;
    await h.ledger.append({ ...base, type: 'TASK_STARTED', objective: 'resume the write' });
    // TOOL_REQUESTED with no TOOL_EXECUTING: the effect provably never began.
    await h.ledger.append({
      ...base,
      type: 'TOOL_REQUESTED',
      toolCallId: CALL,
      toolName: 'write_file',
      args: { path: 'resumed.txt', content: 'from the ledger' },
      sideEffectKey: 'sek-1' as SideEffectKey,

      safety: 'idempotent',
    });

    const result = await h.loop.run('resume the write');
    assert.deepEqual(result, { kind: 'DONE', turns: 1 });

    // The arguments came from the ledger, not from a new model turn.
    assert.equal(await readFile(join(h.workspace, 'resumed.txt'), 'utf8'), 'from the ledger');
    const completed = of(await h.entries(), 'TOOL_COMPLETED');
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.ok, true);
    // The recovered call keeps the step it was originally requested under.
    assert.equal(completed[0]!.stepId, stepOf(1));
  } finally {
    await h.dispose();
  }
});

// --- observability ---

test('every routing decision is offered to the observer and recorded', async () => {
  const h = await harness({ script: [status(500), events(text('ok'), done('stop'))] });
  try {
    await h.loop.run('do the thing');

    const decisions = h.observed.filter((e) => e.t === 'decision');
    assert.equal(decisions.length, 1);
    assert.equal((decisions[0] as { decision: { kind: string } }).decision.kind, 'RETRY_SAME');

    const recovering = of(await h.entries(), 'RECOVERING');
    assert.equal(recovering.length, 1);
    assert.match(recovering[0]!.decision, /^RETRY_SAME: /);
    // The policy's delay was applied, not one the loop invented.
    assert.deepEqual(h.delays, [1_000]);
  } finally {
    await h.dispose();
  }
});
