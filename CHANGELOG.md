# Changelog

All notable changes to CodeRelay are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

Initial release.

### Providers
- Anthropic Messages API, including in-stream `error` events that arrive after an HTTP 200.
- OpenAI Chat Completions, and every OpenAI-compatible endpoint (OpenRouter, NVIDIA NIM,
  Azure OpenAI, vLLM, Ollama, LM Studio) as configuration rather than code.
- Google Gemini `generateContent` over SSE.
- Bearer, `api-key` header and unauthenticated local endpoints.

### Recovery
- Failure classification across retryable, network, TLS-trust, auth, forbidden,
  config, context, stream and unknown classes — each with its own policy.
- Capability-gated failover: retry, credential switch, model switch, provider switch,
  context compaction, or escalation to the user.
- Append-only execution ledger, flushed to disk before every side effect, tolerant of a
  torn tail and able to report lost writes.
- Interrupted-operation resolution from SHA-256 workspace fingerprints: run it, adopt it,
  or ask — never guess.
- Cross-provider handoff by reconstruction rather than transcript replay, with every
  claim labelled as observed or inferred.
- Truncated streams distinguished from clean stops; incomplete tool calls discarded
  rather than executed.
- Resume after VS Code reload, extension restart or crash.

### Workspace safety
- `read_file`, `write_file` and `delete_file`, confined to the workspace folder.
- `run_command`, off by default, so the agent can build, test, type-check and lint
  its own work. Recognises irreversible commands — force pushes, `rm -rf`,
  `git reset --hard`, `sudo`, database drops — and always asks before running one,
  in every permission mode.
- Three permission modes: `safe` (read-only), `balanced` (default) and `autonomous`.
- Commands write an effect log before they start, so an interrupted command is
  resolved from evidence: never started, finished with a recorded exit code, or
  genuinely unknown and escalated to the user.
- Git checkpoints as unreachable objects under `refs/coderelay/`, written through a
  private index. Never touches `HEAD`, a branch, the staging area or the working tree.

### Credentials
- Keys stored in VS Code SecretStorage, never in settings, logs or the timeline.
- Multiple keys per provider, with per-key failure tracking and cooldown.
- 401 takes a key out of rotation; 403 bans only the (key, model) pairing.

### Setup
- **Guided provider setup.** `CodeRelay: Add AI Provider` asks for the endpoint, one
  model and a key, then writes ordinary rows into `coderelay.providers` and
  `coderelay.models` — settings that remain readable and editable afterwards. Presets
  for Anthropic, OpenAI, Gemini, NVIDIA, OpenRouter, Azure OpenAI, Ollama, LM Studio
  and a custom endpoint fill in the facts nobody can be expected to guess: the wire
  protocol, the auth scheme, and which field carries the output cap.
- A preset carries endpoint facts only. It ships no model ids and no capabilities,
  because a model table baked into an extension goes stale and becomes a confident lie
  about a context window.
- **Adding a key no longer dead-ends.** `Add API Key` enumerates configured *endpoints*
  rather than configured models, so a user who has added an endpoint but not yet
  declared a model against it is no longer told to "configure a provider in
  coderelay.providers" — advice they had already followed, and could not have followed
  in the other order, since declaring a model is pointless without a key. With nothing
  configured at all, the prompt now offers to add an endpoint instead of refusing.
- Provider and model can be added from the Models view title bar or from a right-click
  on a provider row, with each endpoint showing how many keys it has and how many are
  usable.
- **Starting a task with nothing configured now offers to configure it.** The first-run
  path used to name `coderelay.providers` and `coderelay.models` and offer "Open
  Settings" — accurate and useless in the same breath, since it left the user to
  hand-write JSON for a schema they had never seen. It now distinguishes three states,
  because each has a different next action: no endpoint at all (start setup), an
  endpoint but no model (ask only the model question, against the endpoint they already
  added), and models that exist but have no usable key (a key problem, not a
  configuration one).
- **`CodeRelay: Test Connection`** sends one real request through the same request
  builder, signer and transport a task uses, so a pass means the configuration works
  rather than meaning a health endpoint answered. It reports the six distinguishable
  outcomes separately — rejected key, forbidden model, malformed request, unreachable
  endpoint, untrusted certificate, rate limit — because three of them mean the
  configuration is fine and the other three need different fixes. A rate limit states
  the wait; a 400 names the output-token field, which is the usual cause. Cancellable,
  and it never reports a key's health as a side effect: asking a question must not take
  a credential out of rotation.


### Interface
- **Activity Bar container** with four views: Task, Tasks, Changes and Models.

- **Task view** — a webview showing the task header (status, model, elapsed, steps,
  files, tokens and cost when the catalog declares prices), a streaming execution
  timeline, and a composer. Enter sends, Shift+Enter is a newline, Escape clears a
  draft or stops a running task.
- **Execution timeline** driven by the ledger itself, so the view shows exactly what a
  resumed task would act on. One card per operation rather than one row per ledger
  entry, expandable for large output, with each file openable in the editor.
- **Observed and inferred are never rendered alike.** An effect CodeRelay concluded
  had already landed is labelled `inferred` in the row, in the tooltip and in the
  sentence a screen reader hears.
- **Recovery, not "Error."** A failure states what happened in plain words, what the
  ledger proves already succeeded, and offers Retry, Switch model and the timeline.
- **Tasks view** grouped by what needs attention: Active, Waiting for you, Interrupted,
  Recent. Every row carries its status as a word as well as an icon.
- **Changes view** derived from the recorded SHA-256 fingerprints, so it lists what
  *this task* changed rather than everything that differs from HEAD. Clicking a file
  opens VS Code's own diff editor against the checkpoint taken before the change.
- **Models view** built from the same candidate set the router uses, showing declared
  capabilities and whether each model is usable right now — keys ready, cooling, or
  no credential.
- **Status bar** item that appears only when there is something to report, coloured
  only when a task needs the user.
- Commands to start, resume, stop and resolve tasks, switch model, manage keys, review a
  change, and inspect the ledger. `Ctrl/Cmd+Alt+N` starts a task; `Ctrl/Cmd+Alt+C`
  focuses the view.
- Interrupted tasks reported on activation — reported, never resumed automatically.
- Themed entirely through VS Code variables, so dark, light and high-contrast themes
  are all correct. Reduced-motion is honoured, and no status depends on colour alone.

