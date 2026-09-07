/**
 * The task pipeline, as a thing that can be looked at.
 *
 * CodeRelay's mental model is a sequence — understand, plan, gather context,
 * execute, verify, recover, complete — and a product whose mental model is only
 * in its documentation does not really have one. This turns the sequence into
 * six rows whose state is *derived from evidence*, so the diagram cannot drift
 * from what actually happened.
 *
 * The rule that makes it worth showing: **a stage is only `done` when something
 * proves it.** Not when the agent said it finished a phase, not when a turn
 * count passed a threshold — when a ledger entry or a verification result
 * exists that could not exist otherwise. A stage nobody has evidence for is
 * `pending`, and `pending` is drawn as an empty circle rather than a tick.
 *
 * Two stages are deliberately allowed to be `skipped`: planning, because plenty
 * of tasks are one edit and do not need a plan, and recovery, because a task
 * that never failed has nothing to recover from. Drawing those as incomplete
 * would make a clean run look deficient.
 */
import type { TaskProjection } from './project.js';
import type { Verdict } from '../../verify/run.js';

export type StageId =
  | 'understand'
  | 'plan'
  | 'context'
  | 'execute'
  | 'verify'
  | 'complete';

export type StageState =
  /** Nothing has happened here yet. */
  | 'pending'
  /** Happening now. */
  | 'active'
  /** Evidence exists that this stage happened. */
  | 'done'
  /** Deliberately not applicable to this task. */
  | 'skipped'
  /** Evidence exists that this stage went wrong. */
  | 'failed';

export interface Stage {
  readonly id: StageId;
  readonly label: string;
  readonly state: StageState;
  /** What makes this state true, or what is missing. Always displayable. */
  readonly detail: string;
  /** A single character. */
  readonly glyph: string;
  readonly spoken: string;
}

const LABELS: Readonly<Record<StageId, string>> = {
  understand: 'Understand',
  plan: 'Plan',
  context: 'Context',
  execute: 'Execute',
  verify: 'Verify',
  complete: 'Complete',
};

const GLYPHS: Readonly<Record<StageState, string>> = {
  pending: '○',
  active: '●',
  done: '✓',
  skipped: '–',
  failed: '✗',
};

export interface StageInput {
  readonly projection: TaskProjection | null;
  /** True while a request or tool is actually in flight. */
  readonly live: boolean;
  /** How many files the context set holds, or null when none was built. */
  readonly contextFileCount: number | null;
  /** The verification verdict, or null when nothing has been run. */
  readonly verdict: Verdict | null;
}

/**
 * Derive the pipeline.
 *
 * Pure, and every branch keys off something observable: a `TASK_STARTED` entry,
 * a proposed plan, a recorded file change, a verification verdict. There is no
 * input here that a model could assert its way past.
 */
export function deriveStages(input: StageInput): readonly Stage[] {
  const projection = input.projection;
  if (projection === null) {
    return [];
  }

  const status = projection.header.status;
  const terminal = status === 'completed' || status === 'failed' || status === 'stopped';
  const changed = projection.changes.length;
  const hasPlan = projection.requirements.length > 0 || projection.nodes.some((n) => n.kind === 'plan');
  const failedRun = projection.recovery.failureCount > 0;

  const stages: Stage[] = [];

  // Understand: a task exists at all. The weakest claim in the pipeline, and it
  // is stated as such — this is not "the agent understood the task".
  stages.push(
    make('understand', 'done', `Objective recorded: “${truncate(projection.header.title)}”.`),
  );

  // Plan: present only when one was proposed. Skipped, not pending, for the
  // many tasks that are a single edit and need no plan.
  if (hasPlan) {
    stages.push(
      make(
        'plan',
        'done',
        projection.requirements.length > 0
          ? `${projection.requirements.length} requirement${projection.requirements.length === 1 ? '' : 's'} from the approved plan.`
          : 'A plan was proposed for this task.',
      ),
    );
  } else {
    stages.push(make('plan', 'skipped', 'No plan was proposed — this task went straight to work.'));
  }

  // Context: a built set, or nothing. Never inferred from the files the agent
  // happened to read, because reading is not the same as being given.
  if (input.contextFileCount === null) {
    stages.push(make('context', 'pending', 'No context set has been built.'));
  } else {
    stages.push(
      make(
        'context',
        'done',
        `${input.contextFileCount} file${input.contextFileCount === 1 ? '' : 's'} selected, with the reason for each.`,
      ),
    );
  }

  // Execute: recorded file changes are the evidence. A task that ran turns and
  // changed nothing is genuinely different from one that has not started.
  if (changed > 0) {
    stages.push(
      make(
        'execute',
        input.live ? 'active' : 'done',
        `${changed} file${changed === 1 ? '' : 's'} changed.`,
      ),
    );
  } else if (input.live) {
    stages.push(make('execute', 'active', 'Working — nothing written yet.'));
  } else {
    stages.push(make('execute', 'pending', 'No file has been changed.'));
  }

  // Verify: the one stage that cannot be reached by the agent asserting it.
  stages.push(verifyStage(input.verdict));

  // Complete: only a finished task with a passing verification is `done`. A
  // task the agent called finished but nothing checked is `active`, because the
  // outstanding question is real.
  if (status === 'completed' && input.verdict === 'verified') {
    stages.push(make('complete', 'done', 'Finished, and the project’s checks passed.'));
  } else if (status === 'completed') {
    stages.push(
      make(
        'complete',
        'active',
        input.verdict === null
          ? 'The agent finished. Nothing has verified the result.'
          : 'The agent finished, but verification did not pass.',
      ),
    );
  } else if (terminal) {
    stages.push(
      make(
        'complete',
        'failed',
        // `stopped` is the user pressing stop and `failed` is CodeRelay giving
        // up. They are different events and must not read alike, even though
        // both end the task without finishing it.
        status === 'stopped' ? 'You stopped the task.' : 'The task did not finish.',
      ),
    );
  } else {
    stages.push(
      make(
        'complete',
        'pending',
        failedRun ? 'Still going, after recovering from a failure.' : 'Not finished yet.',
      ),
    );
  }

  return stages;
}

function verifyStage(verdict: Verdict | null): Stage {
  switch (verdict) {
    case null:
      return make('verify', 'pending', 'Nothing has been verified yet.');
    case 'verified':
      return make('verify', 'done', 'Every check the project declares passed.');
    case 'failed':
      return make('verify', 'failed', 'A check failed.');
    case 'unverifiable':
      // Not `skipped`: the project declaring no checks is a fact about the
      // project, and drawing it as deliberately skipped would imply someone
      // chose it.
      return make('verify', 'pending', 'This project declares no checks to run.');
    case 'cancelled':
      return make('verify', 'pending', 'Verification did not finish.');
  }
}

function make(id: StageId, state: StageState, detail: string): Stage {
  return {
    id,
    label: LABELS[id],
    state,
    detail,
    glyph: GLYPHS[state],
    spoken: `${LABELS[id]}: ${describeState(state)}. ${detail}`,
  };
}

function describeState(state: StageState): string {
  switch (state) {
    case 'pending':
      return 'not started';
    case 'active':
      return 'in progress';
    case 'done':
      return 'done';
    case 'skipped':
      return 'not needed';
    case 'failed':
      return 'failed';
  }
}

function truncate(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Whether the pipeline is worth showing at all.
 *
 * Hidden for a task simple enough that the six rows would be more UI than
 * information — the brief's "keep hidden for simple tasks". A task becomes
 * worth diagramming once it has a plan, has recovered from something, or has
 * touched more than a couple of files.
 */
export function stagesWorthShowing(input: StageInput): boolean {
  const projection = input.projection;
  if (projection === null) {
    return false;
  }
  return (
    projection.requirements.length > 0 ||
    projection.recovery.failureCount > 0 ||
    projection.changes.length > 2 ||
    input.verdict !== null
  );
}
