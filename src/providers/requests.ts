/**
 * Request builders: `TurnPrompt` in, `BuiltRequest` out.
 *
 * This is the only module that knows what a provider's JSON body looks like, and
 * it lives under `src/providers/` for that reason — `src/agent/` stays free of
 * provider-specific code, as the architecture requires. A builder never sees key
 * material: it produces an *unsigned* request and the adapter applies credentials
 * afterwards.
 *
 * ## Why tool results are rendered as text rather than as native tool blocks
 *
 * The obvious implementation would map each `TranscriptItem` onto the provider's
 * native tool protocol: an assistant message carrying `tool_use` blocks, then a
 * user message carrying matching `tool_result` blocks. That cannot be done
 * faithfully here, and the reason is structural rather than an omission.
 *
 * `TranscriptItem` records the *text* a model produced and the *text* a tool
 * reported. It does not record the assistant's tool-call blocks, because a
 * tool-call id is provider-scoped: the id Anthropic minted is not an id OpenAI
 * will accept, and after a failover the ids in the transcript belong to a
 * provider that is no longer answering. Sending a `tool_result` whose matching
 * `tool_use` is missing or foreign is a 400 from every provider on the list — so
 * a transcript built for replay would be a transcript that cannot survive the one
 * event CodeRelay exists to survive.
 *
 * So tool results are rendered into the conversation as text, and tools are
 * declared through the provider's `tools` parameter so the model can still *call*
 * them natively. The consequence is deliberate and worth stating plainly: the
 * outbound conversation is a reconstruction, portable across providers by
 * construction, which is the same choice `policy/handoff.ts` makes for the same
 * reason. The cost is that a provider's own tool-result bookkeeping — and any
 * prompt cache built on it — is not used. The benefit is that a mid-task provider
 * switch needs no translation layer and cannot fail on an id mismatch.
 *
 * ## Why CodeRelay's own text is labelled
 *
 * `note` items are CodeRelay's inferences — a recovery conclusion, a discarded
 * partial turn, a compaction summary — not observed model output. They are
 * rendered with an explicit `[CodeRelay]` marker so the model is never misled
 * into treating our reconstruction as something it said. Same rule as the
 * timeline: observed and inferred must not render identically.
 */
import type { TurnPrompt } from '../agent/loop.js';
import type { ToolSpec } from '../tools/tool.js';
import type { BuiltRequest } from './adapter.js';
import { ConfigError, type ModelCatalog, type ProviderConfig } from './catalog.js';

/**
 * Truncation cap for a single tool result, in characters.
 *
 * `read_file` returns a whole file, and a large file in a small context window is
 * a guaranteed `CONTEXT` failure. Truncating with a visible marker is recoverable
 * and honest; letting the request overflow is neither. Roughly 15k tokens.
 */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 60_000;

export const DEFAULT_SYSTEM_PROMPT = [
  'You are CodeRelay, an autonomous coding agent working inside a VS Code workspace.',
  '',
  'Rules:',
  '- Use the provided tools to inspect and change files. Do not describe an edit you',
  '  could perform with a tool; perform it.',
  '- Every path must be workspace-relative and inside the workspace root. Paths that',
  '  escape the root are rejected before they run.',
  '- write_file replaces a file entirely, so read_file first when the file already',
  '  exists and you intend to keep any of it. Never invent contents you have not read.',
  '- Take one concrete step per turn and wait for the tool result before deciding the',
  '  next one.',
  '- A message marked [CodeRelay] is this extension speaking, not you. It may describe',
  '  a failure, a model switch, or a step whose outcome is uncertain. Treat it as',
  '  reported fact about the run, not as something you said.',
  '- When the objective is complete, say so in plain text and stop calling tools.',
  '- If you cannot proceed without a decision only the user can make, say exactly what',
  '  you need and stop.',
].join('\n');

export interface RequestBuilderOptions {
  readonly catalog: ModelCatalog;
  /** Specs for the tools the registry holds. Usually `builtinToolSpecs`. */
  readonly toolSpecs: readonly ToolSpec[];
  readonly systemPrompt?: string;
  readonly maxToolResultChars?: number;
}

/** One outbound conversation message, before it is shaped for a provider. */
export interface CanonicalMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  // Marked, not silent: the model is told that CodeRelay cut this, so it can ask
  // for a narrower read instead of reasoning from a body it thinks is complete.
  return (
    `${text.slice(0, limit)}\n\n` +
    `[CodeRelay] Output truncated: ${limit} of ${text.length} characters shown.`
  );
}

/**
 * Flattens a transcript into an alternating user/assistant conversation.
 *
 * Alternation is enforced for every provider, not just the ones that require it.
 * Anthropic rejects consecutive same-role messages outright; the others accept
 * them but then differ in how they join them. Coalescing here means one shape is
 * built once and every provider sees the same conversation, which is what makes a
 * failover mid-task a change of endpoint rather than a change of meaning.
 */
export function canonicalMessages(
  prompt: TurnPrompt,
  maxToolResultChars: number,
): readonly CanonicalMessage[] {
  const parts: CanonicalMessage[] = [{ role: 'user', text: prompt.objective }];

  for (const item of prompt.transcript) {
    switch (item.role) {
      case 'assistant':
        parts.push({ role: 'assistant', text: item.text });
        break;
      case 'tool_result': {
        const label =
          item.toolCallId === undefined ? 'Tool result' : `Tool result ${item.toolCallId}`;
        parts.push({
          role: 'user',
          text: `[${label}]\n${truncate(item.text, maxToolResultChars)}`,
        });
        break;
      }
      case 'note':
        parts.push({ role: 'user', text: `[CodeRelay] ${item.text}` });
        break;
    }
  }

  const merged: CanonicalMessage[] = [];
  for (const part of parts) {
    if (part.text.trim() === '') {
      continue;
    }
    const last = merged[merged.length - 1];
    if (last !== undefined && last.role === part.role) {
      merged[merged.length - 1] = { role: last.role, text: `${last.text}\n\n${part.text}` };
      continue;
    }
    merged.push(part);
  }

  // An objective is always present, so the conversation always starts with the
  // user. A *trailing* assistant message is the case worth handling: Anthropic
  // reads it as a prefill to continue rather than as history, which would make
  // the model resume a sentence when we wanted a fresh turn.
  const last = merged[merged.length - 1];
  if (last !== undefined && last.role === 'assistant') {
    merged.push({ role: 'user', text: 'Continue with the next step.' });
  }

  return merged;
}

/**
 * The system text for one attempt.
 *
 * A handoff packet is appended here rather than injected as a message because it
 * is standing context for this attempt only, and because a system block is the
 * one place every provider treats as instruction rather than as dialogue.
 */
export function systemText(prompt: TurnPrompt, base: string): string {
  if (prompt.handoff === null) {
    return base;
  }
  return [
    base,
    '',
    '--- Handoff from a previous model ---',
    'The task was already in progress on a different model. What follows is',
    "CodeRelay's reconstruction of the state, not a transcript of your own output.",
    '',
    prompt.handoff,
  ].join('\n');
}

/**
 * Selects the specs for the tools this turn may use.
 *
 * A registered tool with no declared spec still gets declared, with an open
 * schema. Dropping it would make the tool silently unavailable — a whole task
 * wasted on a model that never learns it could have written the file — whereas an
 * open schema still passes through the tool's own `parse`, which rejects bad
 * arguments and feeds the error back as an ordinary tool failure.
 */
export function selectToolSpecs(
  toolNames: readonly string[],
  specs: readonly ToolSpec[],
): readonly ToolSpec[] {
  const byName = new Map(specs.map((s) => [s.name, s]));
  return toolNames.map(
    (name) =>
      byName.get(name) ?? {
        name,
        description: `${name} (no argument schema was declared for this tool).`,
        schema: { type: 'object' as const, properties: {} },
      },
  );
}

function maxOutputFor(options: RequestBuilderOptions, prompt: TurnPrompt): number {
  const entry = options.catalog.entry(prompt.model);
  if (entry === null) {
    throw new ConfigError(
      `Model "${prompt.model.providerId}/${prompt.model.modelId}" is not configured, so ` +
        'CodeRelay does not know its output limit. Add it to coderelay.models.',
    );
  }
  return entry.maxOutput;
}

function providerFor(options: RequestBuilderOptions, prompt: TurnPrompt): ProviderConfig {
  const provider = options.catalog.provider(prompt.model.providerId);
  if (provider === null) {
    throw new ConfigError(`Provider "${prompt.model.providerId}" is not configured.`);
  }
  return provider;
}

const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  accept: 'text/event-stream',
};

function headersFor(provider: ProviderConfig): Record<string, string> {
  return { ...JSON_HEADERS, ...(provider.headers ?? {}) };
}

/**
 * Removes a version segment the builder is about to add itself.
 *
 * Anthropic's documented base is `https://api.anthropic.com` and Gemini's is the
 * bare host, but both are also widely written *with* the version attached, and
 * every OpenAI-compatible base URL in existence ends in `/v1`. A user who copies
 * the version in would otherwise get `/v1/v1/messages` — a 404 on every attempt,
 * which failover cannot route around and which reads as "my key is broken".
 * Accepting both spellings costs one regex and removes the most likely
 * configuration mistake in the whole file.
 */
function withoutVersion(baseUrl: string, version: string): string {
  return baseUrl.endsWith(`/${version}`) ? baseUrl.slice(0, -(version.length + 1)) : baseUrl;
}

function messagesFor(
  options: RequestBuilderOptions,
  prompt: TurnPrompt,
): readonly CanonicalMessage[] {
  return canonicalMessages(
    prompt,
    options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS,
  );
}

/** Anthropic Messages, streaming. */
export function buildAnthropicRequest(
  options: RequestBuilderOptions,
  prompt: TurnPrompt,
): BuiltRequest {
  const provider = providerFor(options, prompt);
  const specs = selectToolSpecs(prompt.toolNames, options.toolSpecs);
  const body: Record<string, unknown> = {
    model: prompt.model.modelId,
    max_tokens: maxOutputFor(options, prompt),
    stream: true,
    system: systemText(prompt, options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT),
    messages: messagesFor(options, prompt).map((m) => ({ role: m.role, content: m.text })),
  };
  if (specs.length > 0) {
    body['tools'] = specs.map((s) => ({
      name: s.name,
      description: s.description,
      input_schema: s.schema,
    }));
  }
  return {
    url: `${withoutVersion(provider.baseUrl, 'v1')}/v1/messages`,
    method: 'POST',
    headers: headersFor(provider),
    body: JSON.stringify(body),
  };
}

/**
 * OpenAI-compatible Chat Completions, streaming.
 *
 * Two shapes differ by endpoint rather than by protocol, so both are
 * configuration rather than code:
 *
 *  - Azure OpenAI addresses a *deployment* and needs `api-version` in the query
 *    string. Setting `apiVersion` on the provider selects that URL form.
 *  - The field naming the output cap is not the same everywhere; newer OpenAI
 *    models moved from `max_tokens` to `max_completion_tokens`.
 *    `maxTokensField` picks it, and `'none'` omits the cap for a gateway that
 *    rejects both. Nothing here guesses which one a given endpoint wants: a wrong
 *    guess is a 400 on every attempt, and that is not a failure failover can
 *    route around, so it must be stated rather than assumed.
 */
export function buildOpenAiRequest(
  options: RequestBuilderOptions,
  prompt: TurnPrompt,
): BuiltRequest {
  const provider = providerFor(options, prompt);
  const specs = selectToolSpecs(prompt.toolNames, options.toolSpecs);

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemText(prompt, options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT) },
    ...messagesFor(options, prompt).map((m) => ({ role: m.role, content: m.text })),
  ];

  const body: Record<string, unknown> = {
    model: prompt.model.modelId,
    stream: true,
    messages,
  };

  const field = provider.maxTokensField ?? 'max_tokens';
  if (field !== 'none') {
    body[field] = maxOutputFor(options, prompt);
  }

  if (specs.length > 0) {
    body['tools'] = specs.map((s) => ({
      type: 'function',
      function: { name: s.name, description: s.description, parameters: s.schema },
    }));
  }

  const url =
    provider.apiVersion === undefined
      ? `${provider.baseUrl}/chat/completions`
      : `${provider.baseUrl}/openai/deployments/${encodeURIComponent(prompt.model.modelId)}` +
        `/chat/completions?api-version=${encodeURIComponent(provider.apiVersion)}`;

  return { url, method: 'POST', headers: headersFor(provider), body: JSON.stringify(body) };
}

/**
 * Gemini `streamGenerateContent` with SSE framing.
 *
 * `alt=sse` is not optional for us: without it the endpoint streams a JSON array
 * rather than server-sent events, and `SseParser` would find no frames at all.
 * The API version is a path segment here, and `apiVersion` supplies it so a new
 * version needs no release.
 */
export function buildGeminiRequest(
  options: RequestBuilderOptions,
  prompt: TurnPrompt,
): BuiltRequest {
  const provider = providerFor(options, prompt);
  const specs = selectToolSpecs(prompt.toolNames, options.toolSpecs);
  const version = provider.apiVersion ?? 'v1beta';

  const body: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: systemText(prompt, options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT) }],
    },
    contents: messagesFor(options, prompt).map((m) => ({
      // Gemini calls the assistant "model".
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    })),
    generationConfig: { maxOutputTokens: maxOutputFor(options, prompt) },
  };

  if (specs.length > 0) {
    body['tools'] = [
      {
        functionDeclarations: specs.map((s) => ({
          name: s.name,
          description: s.description,
          parameters: s.schema,
        })),
      },
    ];
  }

  const url =
    `${withoutVersion(provider.baseUrl, version)}/${version}` +
    `/models/${encodeURIComponent(prompt.model.modelId)}:streamGenerateContent?alt=sse`;

  return { url, method: 'POST', headers: headersFor(provider), body: JSON.stringify(body) };
}

/**
 * The `RequestBuilder` the agent loop is given.
 *
 * Dispatch is on the configured `kind`, so an endpoint is a row in settings and
 * not a code path. An unconfigured provider throws rather than falling back to a
 * guess: sending an Anthropic body to a Gemini URL would fail on every attempt,
 * and a failure no failover can route around should surface as configuration
 * being wrong.
 */
export function createRequestBuilder(
  options: RequestBuilderOptions,
): (prompt: TurnPrompt) => BuiltRequest {
  return (prompt: TurnPrompt): BuiltRequest => {
    const provider = providerFor(options, prompt);
    switch (provider.kind) {
      case 'anthropic':
        return buildAnthropicRequest(options, prompt);
      case 'gemini':
        return buildGeminiRequest(options, prompt);
      case 'openai':
        return buildOpenAiRequest(options, prompt);
    }
  };
}
