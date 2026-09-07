/**
 * Shared plain-language wording for failures and routing decisions.
 *
 * Extracted from `present.ts` so more than one surface can use the same words
 * without importing the whole task presenter — the recovery log needs exactly
 * these two phrases, and importing `present.ts` for them would make the two
 * modules mutually dependent.
 *
 * There is deliberately one definition of each phrase in the codebase. Two
 * surfaces describing the same 429 differently is how a user ends up unable to
 * tell whether they are looking at one problem or two.
 */

export function describeDecisionKind(kind: string): string {
  switch (kind) {
    case 'RETRY_SAME':
      return 'Retrying the same model';
    case 'SWITCH_CREDENTIAL':
    case 'ROTATE_KEY':
      return 'Trying another key';
    case 'SWITCH_MODEL':
    case 'FAILOVER_MODEL':
      return 'Moving to another model';
    case 'COMPACT_CONTEXT':
      return 'Compacting the context';
    case 'REGENERATE_TURN':
      return 'Re-asking the model from the last checkpoint';
    case 'RECONCILE_FILES':
      return 'Checking which file edits landed';
    case 'ASK_USER':
      return 'Asking you how to proceed';
    case 'ABORT':
      return 'Stopping the task';
    default:
      return kind.replace(/_/g, ' ').toLowerCase();
  }
}

export function explainErrorClass(errorClass: string): {
  readonly short: string;
  readonly title: string;
  readonly advice: string;
} {
  switch (errorClass) {
    case 'AUTH':
      return {
        short: 'API key rejected',
        title: 'The API key was rejected',
        advice: 'Check the key in settings, or add a fresh key for this provider.',
      };
    // What `classifyFailure` actually produces for 408/429/5xx and provider
    // overload. The three legacy names below it are aliases: they predate the
    // current `ErrorClass` union and are kept so an old ledger still reads
    // correctly, but nothing live emits them.
    case 'RETRYABLE':
    case 'RATE_LIMIT':
    case 'SERVER_ERROR':
    case 'TIMEOUT':
      return {
        short: 'Provider was busy',
        title: 'The provider was busy or unavailable',
        advice:
          'CodeRelay can wait and retry, rotate to another key, or fail over to another model. ' +
          'Nothing already written to disk is lost.',
      };
    case 'CONTEXT':
    case 'CONTEXT_LENGTH':
      return {
        short: 'Context window full',
        title: 'The context window was exceeded',
        advice: 'Compact the context, switch to a model with a larger context window, or shorten files.',
      };
    case 'CONFIG':
    case 'INVALID_REQUEST':
    case 'MODEL_UNAVAILABLE':
      return {
        short: 'Invalid request',
        title: 'The provider rejected the request',
        advice: 'The prompt or request parameters were rejected by the model provider.',
      };
    case 'FORBIDDEN':
      return {
        short: 'Not permitted',
        title: 'The key is valid but not allowed to use this model',
        advice:
          'The provider accepted the credential and refused the request. The account may not have ' +
          'access to this model, or not from this region.',
      };
    case 'NETWORK':
      return {
        short: 'Connection lost',
        title: 'Connection lost',
        advice: 'Check the connection to the provider and try again.',
      };
    case 'TLS_UNTRUSTED':
      return {
        short: 'Untrusted certificate',
        title: 'TLS certificate verification failed',
        advice: 'The connection was intercepted by an untrusted TLS certificate or corporate proxy.',
      };
    case 'STREAM':
    case 'PROTOCOL_ERROR':
      return {
        short: 'Unrecognised response',
        title: 'The stream broke the protocol',
        advice: 'The endpoint emitted a response format that did not conform to the protocol.',
      };
    case 'TOOL_EXECUTION':
    case 'TOOL':
      return {
        short: 'Tool failed',
        title: 'A tool failed to execute',
        advice: 'A tool run encountered an error. You can retry or inspect the command logs.',
      };
    case 'FILESYSTEM':
      return {
        short: 'Filesystem error',
        title: 'Filesystem operation failed',
        advice: 'A file read or write failed due to permissions or missing directory.',
      };
    case 'UNKNOWN':
      return {
        short: 'Unexplained fault',
        title: 'The task could not proceed',
        advice: 'An unexplained fault interrupted execution. Check logs or retry.',
      };
    default:
      return {
        short: 'Unexplained fault',
        title: 'The task could not proceed',
        advice: 'An unexpected fault interrupted execution. Check logs or retry with another model.',
      };
  }
}
