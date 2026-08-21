# CodeRelay

**Models can fail. Your task shouldn't.**

CodeRelay is a VS Code extension that runs a coding task across multiple AI providers and keeps the task alive when one of them fails. When a provider rate-limits, times out, drops a stream halfway, or rejects your key, CodeRelay works out what had already happened on disk, hands a reconstructed account of the work to a different model, and carries on — without re-running an edit that already landed.

It is not a chat panel. It is the reliability layer underneath one — with an interface
built to show you the difference.

---

## The interface

CodeRelay adds an icon to the Activity Bar with four views, and you can drive the whole
task lifecycle without opening the Command Palette.

**Task** — the objective, the status, the model actually doing the work, elapsed time,
steps, files changed, and tokens and cost when your catalog declares prices. Below it, a
streaming execution timeline; below that, a composer. `Enter` sends, `Shift+Enter` is a
newline, `Escape` clears a draft or stops a running task.

The timeline is a projection of the ledger rather than a separate commentary on it, so
what you read is exactly what a resumed task would act on. One card per operation, not
one row per ledger entry. Large output collapses behind a disclosure. Every file is a
link into the editor.

```
◆ Task              Add input validation to the signup handler and a test for it
○ Thought through the next step   claude-sonnet-4
✓ Read              …/auth/signup.ts                                       1.2s
✓ Edited            …/auth/signup.ts                                       0.4s
✗ Provider was busy                              partial output received
↻ Moving to another model                                       [inferred]
⇄ Switched model    claude-sonnet-4 → gpt-5                     [inferred]
↺ Edited            …/auth/signup.test.ts                       [inferred]
✓ Task complete
```

That `[inferred]` label is the point. CodeRelay concluded those effects had already
landed by comparing file fingerprints — it did not watch them happen — and the interface
says so in the row, in the tooltip and in the sentence a screen reader reads. An
inference is never dressed up as an observation.

**When something fails, you do not get the word "Error".** You get what happened, what
the ledger proves already succeeded, and one click to continue:

```
Connection lost
The connection to the provider dropped or stopped responding.

✓ 4 steps completed
✓ 1 file written
✓ 1 file deleted
✓ Progress checkpointed to the task ledger
✗ Connection lost

[Retry]  [Switch model]  Show timeline
```

**Tasks** — grouped by what needs you: Active, Waiting for you, Interrupted, Recent.
**Changes** — the files this task changed, derived from the recorded fingerprints rather
than from a diff against `HEAD`, so your own uncommitted work is not mixed in. Clicking
one opens **VS Code's own diff editor** against the checkpoint taken before the change;
CodeRelay contributes no diff viewer of its own.
**Models** — every configured model with its declared capabilities and whether it is
usable right now: keys ready, cooling for 38s, or no credential. Built from the same
candidate set the router uses, so it cannot disagree with the thing that actually routes.

A status bar item appears when there is something to report and is coloured only when a
task needs you. Everything is themed through VS Code variables, so dark, light and
high-contrast are all correct; reduced motion is honoured; and no status anywhere depends
on colour alone.

---

## The problem

Every AI coding tool has the same failure: the provider dies mid-task and you start over.

That is annoying when the model was still talking. It is dangerous when it was halfway through editing a file, because the honest question — *did that write actually happen?* — usually has no answer. Most tools guess, or ask you to click "Retry" and hope.

CodeRelay records every side effect **before** it happens, in an append-only ledger that is flushed to disk ahead of the operation it describes. After an interruption it compares the workspace against what the ledger expected, and takes one of four positions:

| Evidence | What CodeRelay does |
|---|---|
| The operation provably never started | Runs it |
| The workspace matches the expected result | Adopts it, and marks the fact as *inferred* rather than observed |
| The workspace matches the state from before | Runs it — the write did not land |
| Neither matches, or the operation is unverifiable | **Stops and asks you.** It does not guess |

---

## Recovery flow

```
Provider failure
        ↓
Detect failure          classify: retryable / auth / forbidden / context /
        ↓               stream / network / config
Preserve task context   append-only ledger, fsync'd before every side effect
        ↓
Select fallback         capability-gated: never routes to a model that
        ↓               cannot do the work
Continue task           reconstructed handoff, not a replayed transcript
        ↓
Verify result           SHA-256 fingerprints before and after every edit
```

The recovery ladder is configurable in spirit and fixed in order: retry the same model → switch to another key on the same provider → switch model → switch provider → ask you. A failure the classifier marks non-retryable never becomes a retry, and a key the provider rejected is never offered again inside the same task.

---

## Key features

- **Cross-provider task continuity.** A task that starts on Claude can finish on GPT or Gemini and still knows what was already done.
- **No duplicate side effects.** Every operation carries a fingerprint derived from its tool, its arguments and its step — so a retry after an ambiguous failure is resolved by evidence, not by assumption.
- **Reconstructed handoff, not transcript replay.** The successor model is given the objective, the effects that actually completed, and an explicit statement of where the previous model stopped. Facts are labelled *observed* or *inferred*, and the distinction is written into the prompt itself.
- **Streaming truncation is treated as truncation.** A tool call whose arguments were still arriving when the stream died is discarded, never executed. An unrecognised stop reason is reported as truncated rather than assumed complete.
- **Error classification, not blanket retry.** 401 rotates the key; 403 bans the *(key, model)* pairing but keeps the key; a certificate failure stops immediately with the actual diagnosis instead of burning the retry budget.
- **Git checkpoints that cannot damage your repository.** Snapshots are unreachable objects under `refs/coderelay/`, written through a private index. CodeRelay never touches `HEAD`, a branch, your staging area or your working tree, and never creates a commit on a branch.
- **A UI that distinguishes evidence from inference.** Four views, a live execution
  timeline, native diffs against pre-change checkpoints, and recovery that tells you what
  already succeeded.
- **Execution timeline.** Every attempt, failure, classification, routing decision and recovery step is visible and explained. Model switches are never hidden.
- **Keys in the OS keychain.** Credentials go into VS Code SecretStorage and are never written to settings, logs or the timeline.

---

## Supported providers

CodeRelay speaks three wire protocols. A provider is a settings row, not a code change, so anything that speaks one of these works without waiting for a release.

| Protocol | `kind` | Works with |
|---|---|---|
| Anthropic Messages API | `anthropic` | Claude models |
| OpenAI Chat Completions | `openai` | OpenAI, OpenRouter, NVIDIA NIM, Azure OpenAI, Together, Groq, vLLM, Ollama, LM Studio, and any other OpenAI-compatible endpoint |
| Google Gemini `generateContent` | `gemini` | Gemini models |

Authentication schemes: `bearer` (`Authorization: Bearer`), `api-key-header` (Azure OpenAI's `api-key`), and `none` for a local endpoint.

### Not supported

Stated plainly, because a reliability tool should not overclaim:

- **AWS Bedrock** — needs SigV4 request signing, which is not implemented.
- **GitHub Copilot** — needs the VS Code Language Model API, which is a different transport from HTTP+SSE and is not implemented.
- **MCP servers, subagents, browser automation** — not implemented.

---

## What the agent can do

CodeRelay gives the model three tools, and only three:

| Tool | Effect |
|---|---|
| `read_file` | Read a UTF-8 file inside the workspace |
| `write_file` | Replace a file's contents, creating parent directories |
| `delete_file` | Delete a file inside the workspace |
| `run_command` | Run a shell command in the workspace root — **off by default** |

The file tools are confined to the workspace folder.

`run_command` lets the agent build, test, type-check and lint its own work, which is what makes a verify-and-repair cycle possible. It is **disabled until you turn it on** (`coderelay.commands`), because a command is the one tool whose effect CodeRelay cannot verify from the workspace afterwards.

### Permission modes

When commands are enabled, `coderelay.permissionMode` decides what runs without asking:

| Mode | Behaviour |
|---|---|
| `safe` | Read-only. Anything that could change something is refused. |
| `balanced` *(default)* | Ordinary development commands run. Irreversible ones ask first. |
| `autonomous` | Everything runs — except the irreversible shapes, which still ask. |

**A destructive command asks in every mode, including `autonomous`.** Force-pushes, `rm -rf`, `git reset --hard`, `sudo`, database drops and similar are recognised and always require an explicit yes, because a git checkpoint cannot undo them.

Commands run without a terminal and cannot accept interactive input. Each one is killed after `coderelay.commandTimeoutMs` (default two minutes).

---

## Installation

Install **CodeRelay** from the Visual Studio Marketplace, or:

```
code --install-extension bakullabs.coderelay
```

Requires VS Code 1.96 or later. CodeRelay needs a trusted workspace, because it writes files and runs `git` to take rollback snapshots.

---

## Quick start

**1. Add a key.** Run `CodeRelay: Add API Key` from the Command Palette. The key goes straight into SecretStorage.

**2. Describe your endpoint** in settings:

```jsonc
"coderelay.providers": [
  { "id": "anthropic", "kind": "anthropic", "baseUrl": "https://api.anthropic.com" },
  { "id": "openai",    "kind": "openai",    "baseUrl": "https://api.openai.com/v1",
    "maxTokensField": "max_completion_tokens" }
]
```

**3. Declare the models** you want CodeRelay to route between:

```jsonc
"coderelay.models": [
  { "provider": "anthropic", "model": "<model-id>",
    "contextWindow": 200000, "maxOutput": 8192, "toolCalling": true },
  { "provider": "openai", "model": "<model-id>",
    "contextWindow": 128000, "maxOutput": 16384, "toolCalling": true }
]
```

**4. Open the CodeRelay view** from the Activity Bar and describe what you want done in
the composer. `CodeRelay: Start Task` in the Command Palette does the same thing.

> **Why you declare capabilities yourself.** Model line-ups change monthly. A capability table baked into an extension goes stale and becomes a confident lie about a context window — and CodeRelay gates failover on those numbers. It records what you told it and never claims a model can do something you did not say it could.

---

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `coderelay.providers` | `[]` | Endpoints CodeRelay may use. Never put keys here. |
| `coderelay.models` | `[]` | Models it may route between, and what each can do. |
| `coderelay.requireToolCalling` | `true` | Only route to models that can call tools. Turn off only for read-only analysis. |
| `coderelay.minContextWindow` | `0` | Exclude models with a smaller declared window. |
| `coderelay.checkpoints` | `true` | Snapshot the workspace before each file-modifying step. |
| `coderelay.maxTurns` | `32` | Stop a task after this many model turns. A backstop against a loop that makes no progress. |

### Commands

Every command is prefixed `CodeRelay:` in the Command Palette. Most are reachable from
the views as well, and you should not need the palette for day-to-day use.

`Start Task` (`Ctrl/Cmd+Alt+N`) · `Resume Interrupted Task` · `Stop Task` ·
`Resolve Pending Decision` · `Add API Key` · `Manage API Keys` ·
`Show Execution Timeline` · `Inspect Task Ledger` · `Open Settings` ·
`Focus Task View` (`Ctrl/Cmd+Alt+C`) · `Show Logs`

---

## Privacy and security

- **No telemetry.** CodeRelay collects nothing and sends nothing anywhere except the AI endpoints you configure.
- **No backend.** Everything runs locally. There is no CodeRelay server.
- **Zero runtime dependencies.** The packaged extension is compiled TypeScript and nothing else.
- **Keys never leave SecretStorage** except to sign a request. No command echoes one, no error message interpolates one, and the output channel never sees a request header.
- **Your code goes to the providers you configure**, and to no one else. Ledgers and checkpoints stay on your machine.
- CodeRelay requires a trusted workspace and will not activate its task commands in an untrusted one.

---

## Limitations

Worth knowing before you install:

- **Setup is manual.** You declare providers, models and capabilities yourself. This is deliberate, but it is real friction.
- **Unverifiable operations stop and ask.** That is the correct behaviour, not a workaround — but it means CodeRelay occasionally hands a decision back to you rather than guessing.
- **No offline mode yet.** CodeRelay does not currently distinguish "your network is down" from "this provider is down", so an outage consumes the retry budget.
- **Cost is only shown when you declare prices.** The header reports it from
  `costPerMTokIn`/`costPerMTokOut` in your model entries; without those it shows nothing
  rather than a confident zero.
- **Streams are regenerated, not resumed.** After a truncated response CodeRelay regenerates the turn, carrying the partial text forward as a labelled hint. It does not re-attach to the original generation.

---

## FAQ

**Does this replace Copilot, Cline or Continue?**
No. It solves a different problem — surviving provider failure without corrupting your workspace. It has a much smaller tool surface than any of them.

**Will it re-run an edit and duplicate my work?**
That is the specific thing it is built to prevent. Where the evidence is ambiguous it stops and asks rather than guessing.

**Can I use several keys for the same provider?**
Yes. Add more than one and CodeRelay will rotate on rate-limit and take a rejected key out of rotation. Use this to separate personal and work billing — not to work around a provider's quota, which their terms generally prohibit.

**Does it need a server or an account?**
No. There is no CodeRelay account, no proxy and no backend.

**What happens if I close VS Code mid-task?**
The ledger is on disk. Reopen the folder and CodeRelay offers to resume, re-deriving what did and did not happen before continuing.

**Why so few tools?**
Because every tool is a side effect that recovery has to reason about. The file tools are the ones whose effects can be verified from the workspace by comparing hashes; `run_command` cannot be, which is why it is opt-in and why an interrupted command falls back to asking you.

**What happens if VS Code dies while a command is running?**
CodeRelay writes a log for the command *before* starting it, so on restart it can tell three cases apart: no log means it never started and is safe to run; a recorded exit code means it finished, and that outcome is used; a log with no outcome means it started and may not have finished — and that one it asks you about rather than guessing.

---

## Source and license

Source: [github.com/BakulBd/CodeRelay](https://github.com/BakulBd/CodeRelay)
Issues: [github.com/BakulBd/CodeRelay/issues](https://github.com/BakulBd/CodeRelay/issues)

Published by **Bakul Labs**. Released under the [MIT License](LICENSE), © 2026 Bakul Labs.
