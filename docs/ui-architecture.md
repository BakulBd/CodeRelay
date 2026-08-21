# CodeRelay UI architecture

The state of the interface layer as built, and the reasoning behind the parts that
were decided rather than obvious. Written for whoever extends it next.

---

## The one-sentence version

The ledger is the source of truth; the UI is a pure projection of it plus the small
amount of state that is only observable live.

Everything else follows from that. It is why the timeline is trustworthy (it shows
what a resumed task would act on, not a parallel commentary), why the honesty
properties are testable (the projection is a pure function), and why the backend
needed only three additive changes.

---

## Layers

```
extension.ts            actions, credentials, catalog, commands (owns every side effect)
  └── ui/activate.ts    assembles the surfaces, one change event drives them all
        ├── ui/state/store.ts        ledger cache + live Runtime per task   [vscode: EventEmitter]
        ├── ui/state/project.ts      PURE  ledger → nodes/header/changes
        ├── ui/state/format.ts       PURE  durations, tokens, cost, paths
        ├── ui/statusBar.ts          one item, hidden when silent
        ├── ui/view/tasksTree.ts     grouped by what needs attention
        ├── ui/view/changesTree.ts   M/A/D from recorded fingerprints
        ├── ui/view/modelsTree.ts    from buildCandidates(), never a local table
        ├── ui/view/diff.ts          checkpoint URI + vscode.diff (no own viewer)
        └── ui/view/taskView.ts      WebviewView
              ├── ui/webview/present.ts   PURE  projection → exact display strings
              ├── ui/webview/protocol.ts  PURE  validates every inbound message
              ├── ui/webview/shell.ts     PURE  HTML shell, CSP, landmarks
              └── media/task.{css,js}     paints only; no logic, no build step
```

**Host thinks, client paints.** `media/task.js` receives finished labels, a glyph, a
tone and an accessible sentence. It never formats a number, decides a word, or
interprets a ledger entry. That is what keeps every wording decision — including the
observed/inferred distinction — inside `node --test`, and why the client needs no
bundler.

**One event, every surface.** `TaskStore.onDidChange` is the only refresh trigger.
Four views polling independently would disagree the moment a task advanced, and four
timers would be four ways to poll a file that already reports its own writes.

---

## The three backend bridges

The existing agent was left authoritative. Three additive changes, no logic moved:

| Change | Why the alternatives were worse |
|---|---|
| `ExecutionLedger.open(dir, id, { observer })` | The ledger already *is* the ordered, complete, tested event log. Tailing the file would be polling; a second event bus would be a second source of truth that could disagree with recovery. The callback fires **after** the write (and after `fsync` for `append`), inside the append chain, wrapped in try/catch — so a view can neither see an entry that is not durable nor fail one that is. |
| `SessionOptions.ledgerObserver` | Pass-through. Kept separate from the existing `observer` because `LoopEvent` is transient progress while a `LedgerEntry` is the durable record; conflating them would make the timeline a commentary rather than a projection. |
| `Session.checkpoints` | Exposing what `openSession` already built, so the UI can diff against a snapshot. Read-only in use: only `list` and `restore`, and `restore` writes nothing. |

Pinned by `test/continuity/observer.test.ts`, which asserts durability-before-notify,
that a throwing observer cannot fail an append or wedge the chain, and that ordering
matches the file.

**Deliberately not built:** a pre-execution approval gate. It would need
`RunnerDeps.confirm` inside `ToolRunner.run` *before* `TOOL_EXECUTING`, i.e. inside the
write-ahead protocol. The existing escalation flow already handles the real cases, so
the risk was not worth taking for slice one.

---

## Properties the tests defend

These are the assertions worth keeping when this code is changed:

- **Absent is never zero.** Token usage is observable only on a live stream and is
  deliberately not persisted, so a projection of history reports `null`. A header
  claiming "0 tokens" would state a measurement nobody took. Same for cost: an
  undeclared price yields no cost display, because `resolveCapabilities` defaults
  `costPerMTok*` to `0` and "free" is not what that means.
- **One operation is one card.** A tool call is written three or four times
  (requested → executing → completed/reconciled) because that ordering is what makes
  recovery possible. Rendering it as four rows would present bookkeeping as activity.
  Merged by `toolCallId`, with a stable id so the client patches instead of rebuilding.
- **Observed and inferred never render alike.** `TOOL_COMPLETED` is a tool reporting
  itself; `TOOL_RECONCILED` is CodeRelay concluding from fingerprints. The second
  carries `provenance: 'inferred'`, a visible `inferred` tag, and the words "inferred
  by recovery" in its spoken sentence.
- **A cancellation is not a failure.** The loop records both as `TASK_ABANDONED`;
  matching the reason string separates "you pressed stop" from "CodeRelay gave up".
- **Net changes, not event counts.** A file created then deleted is not a change. Two
  writes to one file are one change against the original state.
- **No failure reads as "Error."** Every `ErrorClass` maps to plain words plus the
  progress the ledger proves already landed.
- **Nothing untrusted becomes markup.** The shell contains no task content at all, and
  the client uses `textContent` exclusively. The CSP is `default-src 'none'` with a
  per-load script nonce and no `connect-src`/`img-src`/`font-src`.
- **Every inbound message is validated.** `parseInbound` lists accepted kinds
  explicitly — no `default` pass-through — and bounds every string. Path containment is
  checked by the host, which is the only layer that knows the workspace root.

---

## Deliberate omissions

Absent because the backend cannot honestly support them yet, not because they were
forgotten:

- **No Pause.** There is cancel + resume-from-ledger. A "Pause" button that actually
  cancelled would be the kind of lie this codebase refuses elsewhere. The UI says
  "Stop", and an interrupted task shows Resume.
- **No terminal or test cards.** The agent has three file tools and no shell. The tool
  card is data-driven, so a terminal tool would slot in — but nothing renders a test
  run that cannot happen.
- **No auto-approve / YOLO mode.** Directly contradicts the project's thesis.
- **No custom diff viewer.** `vscode.diff` against a checkpoint URI, so the user gets
  syntax highlighting, navigation and accessibility for free.

---

## Performance

- Store coalesces bursts into one repaint (~80 ms), so a streaming turn costs one frame
  per burst rather than one per token.
- The client patches keyed rows; an append-only stream touches one node.
- Timeline capped at the newest 300 nodes; the full ledger stays available in the text
  view.
- Streamed text retained as a bounded tail (2 000 chars), not the whole turn.
- `render()` returns immediately when the view is hidden — `postMessage` to a hidden
  webview is dropped, so building a model for one is wasted work.
- The entry cache drops ledgers that no longer exist on disk.

---

## Verified in the Extension Development Host

`ExtensionService#_doActivateExtension bakullabs.coderelay` with zero errors, against a
sandbox folder with a git baseline. Visual verification of the rendered panel in light
and dark themes found two real CSS defects, both fixed and both now covered by
`test/ui/stylesheet.test.ts`:

1. `[hidden]` lost to `.empty { display: flex }`, so the empty state and a full timeline
   rendered simultaneously.
2. The recovery notice grew past the viewport and slid under the timeline, taking its
   Retry and Switch model buttons off screen.

---

## Where to go next

In rough order of value:

1. **Changes actions** — Accept / Reject / Rollback per file, on top of
   `CheckpointStore.restore`. The read path exists; this is the write path, and it needs
   the same care as the rest of the safety layer.
2. **Model switch mid-task without a full stop.** Today it aborts and resumes from the
   ledger, which is correct but coarser than it needs to be.
3. **Task history polish** — rename, duplicate, filter.
4. **`ToolRunner.confirm`** approval gate, if graduated permissions are wanted.
5. **Multi-task concurrency.** The store is designed for N runtimes; the UI currently
   assumes one active task and says so rather than half-supporting many.
