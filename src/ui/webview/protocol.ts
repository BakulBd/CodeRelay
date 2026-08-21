/**
 * The host↔webview message contract.
 *
 * A webview is a browser frame. Its script can be replaced by anything that gets
 * code into that frame, so a message arriving from it is *untrusted input* — the
 * same standing as a provider response body. This module is where that is
 * enforced, and it is pure so the enforcement is testable without an editor.
 *
 * Two directions, two different problems:
 *
 * - **Host → client** is a view model. It is built from already-validated state,
 *   so it needs no checking; it is typed here so the client and the host cannot
 *   drift apart silently.
 * - **Client → host** is a command that can start a task, stop one, or open a
 *   file. Every field is validated before anything acts on it. `parseInbound`
 *   returns null rather than throwing, because a malformed message is something
 *   to drop, not something to crash the extension over.
 *
 * Nothing here trusts a string's length either: an unbounded objective from a
 * compromised frame would go straight into a ledger entry and a provider request,
 * so the caps are part of the contract rather than an afterthought.
 */
import type { ModelRef } from '../../core/types.js';
import type { SetupViewModel } from '../setup/present.js';
import type { TaskViewModel } from './present.js';

/** Longest objective accepted from the composer. Generous, but finite. */
export const MAX_OBJECTIVE_CHARS = 20_000;
/** Longest path accepted in a message that opens or diffs a file. */
export const MAX_PATH_CHARS = 4_096;
/**
 * Longest value accepted from a setup field.
 *
 * Applies to the API key too. A key is a bounded token in every provider on the
 * list, and an unbounded one would go into the OS keychain — so the cap is a
 * guard on what a compromised frame can make the host store, not a guess about
 * key formats.
 */
export const MAX_SETUP_VALUE_CHARS = 4_096;

/**
 * What the host sends.
 *
 * Defined by `present.ts`, which is where every displayed string is decided, and
 * re-exported here so the contract can be read in one place. Declaring a second
 * shape would let the presenter and the client drift apart with nothing to catch
 * it.
 */
export type Outbound = TaskViewModel | SetupViewModel;

/** Agent execution mode. */
export type TaskMode =
  | 'code'
  | 'architect'
  | 'ask'
  | 'build'
  | 'plan'
  | 'debug'
  | 'review'
  | 'test';

/** What the client may ask the host to do. */
export type Inbound =
  | { readonly kind: 'ready' }
  | { readonly kind: 'start'; readonly objective: string; readonly model: ModelRef | null }
  | { readonly kind: 'stop' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'switchModel' }
  | { readonly kind: 'pickModel' }
  | { readonly kind: 'openFile'; readonly path: string }
  | { readonly kind: 'openChange'; readonly path: string }
  | { readonly kind: 'openTimeline' }
  | { readonly kind: 'openSettings' }
  | { readonly kind: 'newSession' }
  | { readonly kind: 'switchSession'; readonly taskId: string }
  | { readonly kind: 'deleteSession'; readonly taskId: string }
  | { readonly kind: 'exportMarkdown' }
  | { readonly kind: 'compactContext' }
  | { readonly kind: 'revertAllChanges' }
  | { readonly kind: 'rewindToCheckpoint'; readonly commitOrTurnId: string }
  | { readonly kind: 'setMode'; readonly mode: TaskMode }
  | { readonly kind: 'enhancePrompt'; readonly text: string }
  | { readonly kind: 'searchMention'; readonly query: string }
  | { readonly kind: 'toggleSound'; readonly enabled: boolean }
  | { readonly kind: 'approvePlan' }
  | { readonly kind: 'rejectPlan' }
  | { readonly kind: 'regeneratePlan' }
  | { readonly kind: 'refreshViews' }
  | { readonly kind: 'showDiagnostics' }
  /** Opens guided setup inside the panel. Never a settings file, never a quick pick. */
  | { readonly kind: 'setUp' }
  | { readonly kind: 'setupLocal' }
  | { readonly kind: 'setupOpenManage' }
  | { readonly kind: 'setupOpenAdd' }
  | { readonly kind: 'setupEditProvider'; readonly providerId: string }
  | { readonly kind: 'setupDeleteProvider'; readonly providerId: string }
  | { readonly kind: 'setupTestConnection' }
  | { readonly kind: 'setupFilterModels'; readonly query: string }
  | { readonly kind: 'setupChoose'; readonly presetKey: string }
  /**
   * One field edited.
   *
   * `apiKey` is carried here and goes straight to SecretStorage; it is never
   * stored in wizard state and never sent back to the frame.
   */
  | { readonly kind: 'setupField'; readonly field: SetupField; readonly value: string }
  | { readonly kind: 'setupPrimary' }
  | { readonly kind: 'setupBack' }
  | { readonly kind: 'setupCancel' }
  | { readonly kind: 'setupToggleModel'; readonly modelId: string }
  | { readonly kind: 'setupAddModel'; readonly modelId: string }
  | { readonly kind: 'setupDefaultModel'; readonly modelId: string }
  | { readonly kind: 'setupReorder'; readonly modelId: string; readonly direction: -1 | 1 }
  | { readonly kind: 'setupRefreshModels' }
  | { readonly kind: 'addCredential' }

  | { readonly kind: 'resolve' }
  | { readonly kind: 'attachFile' }
  | { readonly kind: 'openInEditor' };

/** The editable fields of the connect step. */
export type SetupField = 'providerId' | 'baseUrl' | 'apiVersion' | 'apiKey';

const SETUP_FIELDS: readonly SetupField[] = ['providerId', 'baseUrl', 'apiVersion', 'apiKey'];
const TASK_MODES: readonly TaskMode[] = [
  'code',
  'architect',
  'ask',
  'build',
  'plan',
  'debug',
  'review',
  'test',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string within a length cap, or null. */
function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > maxChars) {
    return null;
  }
  return trimmed;
}

/**
 * A model reference, or null.
 *
 * Null is a legitimate answer — it means "let the host choose" — so an absent
 * model is not an error. A *malformed* one is, and it yields null too: the host
 * then prompts, which is safer than acting on half a reference.
 */
function modelRef(value: unknown): ModelRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const providerId = boundedString(value['providerId'], 200);
  const modelId = boundedString(value['modelId'], 200);
  if (providerId === null || modelId === null) {
    return null;
  }
  return { providerId, modelId };
}

/**
 * Validates a message from the webview.
 *
 * Returns null for anything unrecognised. Every accepted variant is listed
 * explicitly rather than derived from the type, because a `default` branch that
 * passed unknown kinds through would be exactly the hole this function exists to
 * close.
 */
export function parseInbound(raw: unknown): Inbound | null {
  if (!isRecord(raw)) {
    return null;
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string') {
    return null;
  }

  switch (kind) {
    case 'ready':
    case 'stop':
    case 'resume':
    case 'retry':
    case 'switchModel':
    case 'pickModel':
    case 'openTimeline':
    case 'openSettings':
    case 'newSession':
    case 'exportMarkdown':
    case 'compactContext':
    case 'revertAllChanges':
    case 'approvePlan':
    case 'rejectPlan':
    case 'regeneratePlan':
    case 'refreshViews':
    case 'showDiagnostics':
    case 'setUp':
    case 'setupLocal':
    case 'setupOpenManage':
    case 'setupOpenAdd':
    case 'setupTestConnection':
    case 'setupPrimary':
    case 'setupBack':
    case 'setupCancel':
    case 'setupRefreshModels':
    case 'addCredential':

    case 'resolve':
    case 'attachFile':
    case 'openInEditor':
      // No payload, so nothing further to validate.
      return { kind } as Inbound;

    case 'start': {
      const objective = boundedString(raw['objective'], MAX_OBJECTIVE_CHARS);
      if (objective === null) {
        return null;
      }
      return { kind: 'start', objective, model: modelRef(raw['model']) };
    }

    case 'setMode': {
      const mode = raw['mode'];
      if (typeof mode !== 'string' || !(TASK_MODES as readonly string[]).includes(mode)) {
        return null;
      }
      return { kind: 'setMode', mode: mode as TaskMode };
    }

    case 'enhancePrompt': {
      const text = typeof raw['text'] === 'string' ? raw['text'].slice(0, MAX_OBJECTIVE_CHARS) : '';
      return { kind: 'enhancePrompt', text };
    }

    case 'searchMention': {
      const query = typeof raw['query'] === 'string' ? raw['query'].slice(0, 200) : '';
      return { kind: 'searchMention', query };
    }

    case 'toggleSound': {
      const enabled = Boolean(raw['enabled']);
      return { kind: 'toggleSound', enabled };
    }

    case 'switchSession':
    case 'deleteSession': {
      const taskId = boundedString(raw['taskId'], 200);
      return taskId === null ? null : ({ kind, taskId } as Inbound);
    }

    case 'rewindToCheckpoint': {
      const commitOrTurnId = boundedString(raw['commitOrTurnId'], 200);
      return commitOrTurnId === null ? null : { kind: 'rewindToCheckpoint', commitOrTurnId };
    }

    case 'setupChoose': {
      const presetKey = boundedString(raw['presetKey'], 100);
      return presetKey === null ? null : { kind: 'setupChoose', presetKey };
    }

    case 'setupEditProvider':
    case 'setupDeleteProvider': {
      const providerId = boundedString(raw['providerId'], 200);
      return providerId === null ? null : ({ kind, providerId } as Inbound);
    }

    case 'setupFilterModels': {
      const query = typeof raw['query'] === 'string' ? raw['query'].slice(0, 100) : '';
      return { kind: 'setupFilterModels', query };
    }

    case 'setupField': {
      const field = raw['field'];
      if (typeof field !== 'string' || !(SETUP_FIELDS as readonly string[]).includes(field)) {
        return null;
      }
      const value = raw['value'];
      if (typeof value !== 'string' || value.length > MAX_SETUP_VALUE_CHARS) {
        return null;
      }
      return { kind: 'setupField', field: field as SetupField, value };
    }

    case 'setupToggleModel':
    case 'setupAddModel':
    case 'setupDefaultModel': {
      const modelId = boundedString(raw['modelId'], 200);
      return modelId === null ? null : ({ kind, modelId } as Inbound);
    }

    case 'setupReorder': {
      const modelId = boundedString(raw['modelId'], 200);
      const direction = raw['direction'];
      if (modelId === null || (direction !== -1 && direction !== 1)) {
        return null;
      }
      return { kind: 'setupReorder', modelId, direction };
    }

    case 'openFile':
    case 'openChange': {
      const path = boundedString(raw['path'], MAX_PATH_CHARS);
      if (path === null) {
        return null;
      }
      return { kind, path };
    }

    default:
      return null;
  }
}
