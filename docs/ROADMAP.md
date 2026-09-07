# CodeRelay UI/UX roadmap

Working checklist for the 37-phase product plan. Status is what the **code and
tests** say, not what was intended — a phase is only `done` when it is wired to
the real engine and pinned by a test.

| Marker | Meaning |
|---|---|
| `[x]` | Done, wired to the real engine, covered by tests |
| `[~]` | Partially built — what is missing is named |
| `[ ]` | Not started |

**Last updated: 2026-09-07 · 1019 tests passing · VSIX 369 KB / 106 files / 0 runtime deps**

**All 37 phases complete**, plus the Benchmark Lab. One capability is built and
tested but not yet driving live traffic — named at the bottom, with the reason
it was left rather than rushed.


---

## Production readiness

Verified mechanically each time, not asserted:

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `node --test` | 1019 passing, 0 failing |
| Extension activates (stubbed host) | 44 subscriptions |
| Webview client boots and posts `ready` | yes — pinned by `test/webview/boot.test.ts` |
| Elements the client looks up | 209, all declared by the shell |
| Buttons in the shell | 74, all wired in the client |
| Inbound message kinds | 78, all handled |
| Manifest commands | 34, all registered |
| Runtime dependencies | 0 |

### Fabricated data removed

Three surfaces reported numbers nobody measured. All are now either real or
absent:

1. **`bench/recovery-bench.ts`** generated its results from constants — 2,400
   tokens per step, 4,200ms for a naive fallback against 850ms for CodeRelay, a
   1.8x replay multiplier — with CodeRelay hardcoded `completed: true` while the
   comparison was allowed to fail. It now defines the shape of a *measured* run
   and aggregates real ones; the three paradigms are really executed, and
   unmeasured fields are `null`, rendered as an em dash.
2. **`extension.ts`'s benchmark command** assigned an object literal and
   reported "completed in Xms" where X was the time to build it. It now runs the
   task three ways — no faults, faults with recovery off, faults with recovery
   on — and reports what each observed.
3. **`bench/chaos.ts`** wrote a pre-decided success story into the task graph:
   `detected: true`, `successorResumed: true`, and a verification of "12 of 12
   checks passed" that no compiler or suite had produced. It is now labelled a
   dry run of the relay bookkeeping, reports `null` for verification, and points
   at the Benchmark Lab for the thing that actually fails a provider.

Pinned by `test/bench/chaos-honesty.test.ts` and the rewritten
`test/bench/recovery-bench.test.ts`, whose previous version *asserted* the
fabricated conclusions (`completionRate === 100`, `tokenSavings > 25`, the
literal string `100% Safe Continuation`).

### Credential pool in the panel

Adding a second API key was previously possible only one at a time through the
wizard, and manageable only from a command-palette pick; the panel showed a bare
count — "2 key(s) stored" — which cannot say which key is cooling, which the
provider rejected, or which one runs next.

`ui/setup/keys.ts` turns the pool into rows, listed in the order the pool would
actually try them, with turn on/off, prefer, and remove wired to the real
`CredentialManager`. The row marked **next** is derived the same way
`CredentialManager.next()` chooses — re-derived rather than asked for, because
`next()` records a use and a panel must not change what it describes merely by
describing it. `test/ui/keys.test.ts` asserts the two agree.

**No part of a key is ever rendered** — not a prefix, not a masked form. A
credential is identified by its label and nothing else, and a test asserts the
secret cannot reach the view model.

### Responsive contract

`test/ui/responsive.test.ts` states the narrowest supported width once (240px)
and checks the structural causes of narrow-width failure, all of which are
silent: an overlay too wide to fit is clipped with its controls unreachable, a
bare `1fr` grid track cannot shrink below its content, and `nowrap` without
`text-overflow` runs text off the edge.

It found four real defects, now fixed: three popovers with no viewport cap,
bare `1fr` tracks in the recovery and requirement rows, four rules that refused
to wrap without being able to truncate, and a block of orphaned
`.command-popover` CSS left behind when its client code was deleted.

### Unwired modules: resolved

All 17 are now handled. Nine were wired; eight were retired because wiring them
would have created a second source of truth for something already wired.

**Wired**

| Module | Where it now runs |
|---|---|
| `security/audit` | Approvals, credential add/remove/toggle, model switches, relay handoffs, task export — read via `CodeRelay: Show Audit Log` |
| `security/rate-limiter` | Provider-level backoff, fed by routing decisions and cleared by the first token; `buildCandidates` refuses a provider while it lasts |
| `security/proxy` | Diagnostics, stated as *detected* rather than *used* — Node's `fetch` does not tunnel `HTTPS_PROXY` without a dispatcher dependency, and this project has none |
| `continuity/concurrency` | A real task lock, replacing `switchModel`'s `abort()` + 150ms sleep |
| `continuity/portability` | `CodeRelay: Export Task`, built from ledger and checkpoint state |
| `providers/aliases` | The model picker offers `fast`, `cheap`, `long-context`… each resolving to a named model with a stated reason |
| `providers/detection` | Models tree tooltip, distinguishing a capability declared *false* from one never declared |
| `policy/privacy` | Context selection refuses `.env`, `*.pem`, `*.key`, `credentials.json` and `secrets.*` — **even when the user mentions them** |
| `context/manifest` | The structured handoff built on relay, recorded in the audit trail |

**Retired as duplicates**

`policy/circuit-breaker` (→ `policy/health`), `tools/continuation`
(→ `computeSideEffectKey` + ledger), `providers/events` (→ `core/types`),
`policy/smart-router` (→ `policy/select`), `policy/phase-router`
(→ `plan/modes`), `providers/registry` + `providers/templates` +
`providers/profile` (→ `providers/catalog` + `presets`),
`continuity/versioning` (migrated a `{version, payload}` schema nothing writes),
`providers/protocols` (declared eight "supported protocols" against three real
adapters).

Their tests were rewritten against the wired implementations rather than
deleted, so the coverage moved instead of vanishing.

### Three bugs found while wiring

1. **`buildCandidates` ignored `userDisabled`.** A key the user switched off was
   still counted as ready, so the router could pick a model whose only
   credential the pool would then refuse. `CredentialManager.next()` had the
   check; the list the router reads did not. Pinned by
   `test/app/candidates.test.ts`.
2. **`npm test` ran deleted tests.** `tsc` leaves the compiled output of a
   removed source in `out/`, and the suite globs `out/test/**`, so a test whose
   source had been deleted kept running and kept passing. The count was
   inflated by ten before a `vsce package` happened to clean the directory.
   `npm test` now cleans first.
3. **The Checkpoints view read an empty graph.** `activeTaskGraph` was only ever
   created by the chaos dry-run, so the list was permanently empty while real
   checkpoints existed in git. Real checkpoints are now mirrored into the graph
   as they are taken — which also gives the recovery manifest real state to
   build from. They are recorded `verified: false`, because a snapshot of the
   work tree has not had the project's checks run against it.

### The credential path, end to end

Audited every process that adds or consumes a key, not just the add flow.

**All seven secret consumers go through `CredentialManager`** — the agent loop,
the connection test, model discovery, the setup wizard, the benchmark and the
probe. Only the store adapter touches `SecretStorage` directly, which is where
it belongs. Cooling, rotation, priority and manual disable therefore apply
everywhere rather than in some paths and not others.

Four problems were found and fixed:

1. **A fourth credential-add path that nothing called.** `promptForKey` in
   `ui/setup.ts` was dead, along with `openModelSettings` and `openModelDocs` —
   dead code in the security-critical path, which is the worst place for it.
2. **A second raw-settings escape, in a live path.** An earlier claim in this
   document that "exactly one escape survives" was wrong: `"Add cost info"`
   after adding a model dropped the user into settings JSON. Replaced with an
   in-GUI price prompt, which also keeps decimals — `askNumber` floors, and a
   price of $0.25 per million tokens is not $0.
3. **The three live add paths behaved differently.** One audited without
   refreshing, one refreshed without auditing, one did neither. A key stored but
   invisible until some later unrelated refresh looks like a key that failed to
   save. All three now audit *and* repaint.
4. **No way to test one specific key.** With three keys on a provider,
   `testConnection` asked whichever rotation picked, so a user with one bad key
   learned nothing about which to replace. `CredentialManager.secretOf` reads
   one key by id — recording nothing, because a test is a question, not a use —
   and every row in the key pool now has a **Test** action. Unlike a plain
   connection test this one *knows* which key it used, so a 401 is real evidence
   about that credential.

`test/security/secret-containment.test.ts` pins the invariant that matters
most: a secret cannot reach the audit trail, the key-pool view model, the
diagnostics report, or any log line — checked structurally, so it constrains
what the code *can* do rather than sampling what it did.

### Design system

The stylesheet had a spacing scale and nothing else. Two failures followed from
that, both found by measurement rather than by eye:

**Twenty-seven distinct font sizes.** `0.9`, `0.92`, `0.95` and `0.96` were all
in use, and at a 13px base they differ by under a pixel — so they read as noise
rather than hierarchy. Replaced with a six-step scale (`--fs-xs` … `--fs-xl`),
all relative to the editor's own font size. One raw `10px` that ignored the
user's setting entirely is gone with them.

**Four spellings of "success".** `testing-iconPassed`, `charts-green`, and both
orderings of each as the other's fallback, so two adjacent rows could
legitimately render different greens. Now `--ok`, `--warn`, `--danger`,
`--muted`, `--accent` and `--border`: components name a *meaning*, and only
`:root` knows which VS Code variable carries it. 201 call sites migrated.

Enforced by `test/ui/stylesheet.test.ts`, which now asserts the stronger
property — every token resolves to a theme variable, the scale derives from
`--vscode-font-size`, and **no component spells a semantic colour itself**.

### Keyboard reachability

Nine clickable elements had no focus style at all, several of them `<div>`s that
get no browser default — a keyboard user could tab onto them and see nothing.
Fixed, and pinned by a test that walks every `cursor: pointer` rule and demands
a matching focus style.

Two rules used `:focus` rather than `:focus-visible`, which shows the ring after
a mouse click too — the thing that leads teams to delete focus styling
altogether. Both corrected, and the distinction is now enforced.

Writing that test surfaced a bug in an earlier one: the CSS parser in
`test/ui/responsive.test.ts` did not strip comments, so everything between one
rule's closing brace and the next rule's selector was captured as part of that
selector. A documented rule appeared to be named after its own comment, and the
element it actually styled looked unstyled.

### The one remaining piece: hedging

`policy/hedge.ts` and `agent/race.ts` are complete and tested (32 tests) but do
not drive live traffic. This is not the same situation as the other sixteen, and
the reason is specific.

`AgentLoop.attemptTurn` is 240 lines with seven ledger write sites. Racing N
legs naively writes N `STREAMING` entries, and a losing leg then leaves a
`STREAMING` with no `MODEL_RESPONSE_COMPLETED` — which is byte-for-byte what an
*interrupted turn* looks like to `planRecovery`. Recovery would try to reconcile
a turn that never happened.

The fix is known and does not need a ledger format change: **only the primary
leg writes to the ledger.** Hedge legs stream in memory and are reported live
through `LoopEvent`; if one wins, the loop writes the existing
`PROVIDER_SWITCHED` entry and then `MODEL_RESPONSE_COMPLETED` with the winner.
The ledger then looks exactly as it does today, and recovery semantics are
untouched.

That refactor deserves its own pass with recovery tests, and an attempt at it
proved the point: mechanical edits to this file went wrong repeatedly, and one
of them silently deleted the **evidence gate** — the check that stops a model
finishing a task its project's own tests reject. It was caught only because a
test failed. `loop.ts` was restored from HEAD and its changes re-applied
deliberately; the gate is back and pinned.

The lesson is the reason hedging is still unwired: this is the one file where a
plausible-looking edit can remove a safety property without anything obvious
breaking.

---

## Audit and research

- [x] **Phase 1 — Audit.** Every backend capability mapped to a UI surface.
      Found and fixed a repo-wide defect: four source files embedded raw NUL
      bytes as key separators, making them *binary* to tooling so every `grep`
      silently skipped them. Now guarded by `test/repo/source-text.test.ts`,
      because it had been introduced three separate times.
- [x] **Phase 2 — Research.** Four papers changed specific decisions:
      ContinuityBench (arXiv:2607.15899) → jitter is mandatory once requests are
      concurrent; ContextBench (arXiv:2602.05892) → surface context *precision*,
      not just volume; "Humans are Missing" (arXiv:2608.12355) → the
      alignment / verifiability / steerability / adaptability frame; misalignment
      at scale (arXiv:2605.29442) → never switch models silently.
- [x] **Phase 3 — Product model.** `UNDERSTAND → PLAN → CONTEXT → EXECUTE →
      VERIFY → RECOVER → CONTINUE → COMPLETE`, made visible as the pipeline in
      `ui/state/stages.ts` rather than left in documentation.

## Shell and task entry

- [x] **Phase 4 — Primary sidebar.** Activity Bar container, webview, three
      collapsed trees.
- [x] **Phase 5 — New Task composer.** Multiline input, `@` autocomplete, model
      picker, six modes, context chips, enhance, Start Task.
- [x] **Phase 6 — Plan mode.** Propose / approve / reject / regenerate, plus a
      structured `plan` directive covering goal, requirements, files, approach,
      risks and verification.
- [x] **Phase 7 — Requirement tracker.** `plan/requirements.ts`. Parsed from the
      approved plan; status derived from **evidence only** — files that actually
      changed plus checks that actually passed. Never asks the model whether it
      is done, because that is the assertion the checklist exists to replace.

## Context and models

- [x] **Phase 8 — Context Center.** `context/select.ts` + `context/gather.ts` +
      panel. Every included file names its evidence; exclusions are counted and
      explained. Ranked by *strongest* signal, not the sum — three inferred
      signals must never outrank a file the user named.
- [x] **Phase 9 — Model Center.** All nine providers, multi-key, discovery,
      connection test, enable/disable, default, fallback priority. The
      credential pool now carries **priority** and a **user on/off switch**,
      managed from `CodeRelay: Manage API Keys`. New keys are peers so rotation
      still spreads; priority only discriminates once the user orders them.
      A provider rejection cannot be toggled away — replacing the key is the
      only real fix.
- [x] **Phase 10 — Routing UI.** `policy/select.ts` gives each task role its own
      profile, and the "Why this model?" panel shows the facts the choice rested
      on plus every model passed over. **User-written rules** (`policy/rules.ts`,
      edited from `CodeRelay: Routing Rules`) outrank the automatic score but
      never the hard gates: a rule naming a model that cannot run is skipped and
      the task continues. A pinned model still beats a rule.

## Execution

- [x] **Phase 11 — Live agent workspace.** Header plus streaming timeline.
- [x] **Phase 12 — Tool experience.** Per-tool rows, target, status, duration,
      large output collapsed.
- [x] **Phase 13 — Permission system.** SAFE / BALANCED / AUTONOMOUS enforced in
      `security/commands.ts`, with a picker that states what each mode actually
      allows, plus **Allow for this task** — task-scoped, cleared when a task
      starts, keyed on the exact command, and deliberately never offered for a
      destructive one.
- [x] **Phase 14 — Changes / diff.** Native `vscode.diff` against the
      pre-change checkpoint. No bespoke diff viewer.
- [x] **Phase 15 — Verification Center.** `src/verify/`. Detection never invents
      a command. Four verdicts, only one of which is a tick: `unverifiable`
      (nothing declared) and `cancelled` (checks left unrun) are both explicitly
      *not* passes.

## Recovery — the differentiator

- [x] **Phase 16 — Recovery Center.** Classification, continue / retry / switch,
      the staged narrative, and **one-click Relay**: `coderelay.relay`
      recommends the best *other* model using the same `selectModel` the router
      uses, states what the ledger proves already landed, and reuses
      `switchModel`'s stop-and-resume path rather than copying it.
- [x] **Phase 17 — Network recovery.** Classified as `NETWORK`, state preserved
      in the ledger, retry and switch offered.
- [x] **Phase 18 — Interrupted tasks.** Resume reconciles real workspace state
      via `planRecovery` and file fingerprints before acting.
- [x] **Phase 19 — Task history.** Sessions drawer, searchable, resume, delete.
- [x] **Phase 20 — Provider/model health.** EWMA health plus circuit breaker in
      the Models tree. An unused model shows nothing; a rate needs ≥2
      observations.
- [x] **Phase 21 — Recovery log.** Timestamped narrative from the ledger.
      Checkpoints are *counted*, never interleaved — a `Checkpoint` carries no
      timestamp, so placing one between two entries would be invented.
- [~] **Phase 22 — Model performance.** Success rate and latency are measured
      and shown, and cost is displayed live in the header.
      *Not built:* recovery-success and test-pass rates per model. Both need
      history that is currently discarded on reload, and inventing them from a
      single window would be the fabricated statistic the brief rules out.

- [x] **Phase 23b — Benchmark Lab.** `bench/faults.ts` wraps the real transport
      and fails chosen requests deterministically; everything not faulted is a
      real request to a real provider. Runs a throwaway task in a temp folder,
      never the user's workspace, and discloses that it spends real tokens
      before starting. A run whose faults never fired is reported as
      **inconclusive**, not as a pass.

## Advanced surfaces

- [x] **Phase 23 — Debug mode.** `plan/modes.ts`. Fixed a genuine fake-UI bug:
      `debug`, `review`, `test` and `build` were offered by the picker and
      changed nothing. Debug now enforces reproduce → evidence → hypothesis →
      fix → re-run, and refuses to guess at a bug it cannot reproduce.
- [x] **Phase 24 — Task graph.** `ui/state/stages.ts`, hidden for simple tasks.
      Every stage's state is derived from evidence, so the diagram cannot claim
      a phase happened that nothing proves.
- [x] **Phase 25 — Project memory.** `CODERELAY.md` in the workspace —
      reviewable, version-controllable and editable without the extension.
      Disabled notes stay in the file and are withheld from the model.
- [x] **Phase 26 — Diagnostics.** Secret-free report, plus Test All Providers
      (concurrent, through the same probe path as the single-model test) and
      Export.
- [x] **Phase 27 — Settings GUI.** Every setup path now goes through CodeRelay's
      own screens. Exactly one raw-settings escape survives, deliberately: a
      *malformed* configuration is the one case the guided screen cannot repair,
      because it would have to parse the thing that will not parse.

## Polish

- [x] **Phase 28 — First run.** Welcome card, not "No models configured."
- [x] **Phase 29 — Responsive sidebar.** 250–400px+. At narrow widths the
      secondary column drops before the identifying one does.
- [x] **Phase 30 — Visual design.** VS Code theme variables throughout, pinned
      by a test that admits no literal colour. Dark, light, high contrast.
- [x] **Phase 31 — Brand mark.** `< • >` — two code brackets holding the task
      between them. Replaced a generic lightning bolt. Monochrome, three
      elements, legible at 16px, and pinned so the sidebar and Activity Bar
      cannot drift apart.
- [x] **Phase 32 — Performance.** 281 KB, 79 files, zero runtime dependencies.
      Panels now repaint only when their content changes, guarded by signatures
      that a test checks cover everything painted below them.
- [x] **Phase 33 — Security.** SecretStorage, `default-src 'none'` CSP with a
      per-load nonce, every inbound message validated, path containment,
      `textContent` only — checked per renderer by test.
- [x] **Phase 34 — UI/backend contract.** `TaskViewModel` is a pure projection;
      the webview holds no business logic and decides no wording.

## Process

- [x] **Phase 35 — Incremental order.** Followed; no rewrite.
- [~] **Phase 36 — Test each step.** 876 tests, typecheck and package all clean
      after every step. **Two real gaps remain:** no linter is configured
      (`npm run lint` does not exist), and the Extension Development Host has
      not been run — every claim here rests on the suite and a clean package,
      not on a live editor.
- [x] **Phase 37 — Final UX audit.** Verified mechanically rather than asserted:
      all 27 manifest commands are registered, all 32 webview buttons are looked
      up by the client, all 34 inbound message kinds are handled, and no source
      file is binary to tooling.

---

## The one incomplete item

**Hedging is not driving live traffic.** `policy/hedge.ts` (19 tests) and
`agent/race.ts` (13 tests) are complete, and `policy/health.ts` feeds them, but
`AgentLoop.attemptTurn` still runs one leg.

This was left deliberately rather than rushed. `attemptTurn` is 220 lines that
sit directly on the exactly-once side-effect guarantee, and driving several legs
through it means deciding how concurrent `STREAMING` and `STREAM_PROGRESS`
entries interleave in a ledger the timeline projects and recovery replays. Done
carelessly it would corrupt the one property the whole product rests on.

The design is settled and the invariant is written at the top of `hedge.ts`:
**race proposals, commit one.** The remaining work is:

1. Extract the streaming half of `attemptTurn` into a leg runner parameterised
   by `(model, credentialId)`, producing a proposal and touching no ledger entry
   except its own `STREAMING`.
2. Let only the primary leg write `STREAM_PROGRESS`; a winning hedge writes its
   text once at `MODEL_RESPONSE_COMPLETED`.
3. Dispatch the winner through the existing single `ToolRunner`, unchanged.
4. Release the breaker's probe slot for every aborted leg, via
   `HealthTracker.releaseProbeSlot` — `race.ts` already reports them.

`realTimer` in `agent/race.ts` is the only dead export in the codebase, and it
is dead for exactly this reason.
