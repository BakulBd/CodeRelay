/**
 * `FetchLike` over the platform `fetch`.
 *
 * The transport takes `fetch` as a dependency so its failure paths can be tested
 * without a network, which leaves exactly one place that has to touch the real
 * thing. This is it, and it does nothing but translate shapes.
 *
 * The translation is explicit rather than a cast. Node's `Response.body` is a
 * `ReadableStream` that also happens to be async-iterable, and its reader's
 * `read()` is typed as a discriminated union that does not structurally satisfy
 * `ByteReaderLike` under `exactOptionalPropertyTypes`. A cast would compile and
 * then be wrong the day either type moves; six lines of adapter cannot be.
 */
import type {
  ByteReaderLike,
  ByteStreamLike,
  FetchLike,
  HttpRequestInitLike,
  HttpResponseLike,
} from './transport.js';

/** The slice of the platform `fetch` we depend on. */
export type PlatformFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | undefined;
    signal?: AbortSignal | undefined;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body: unknown;
  text(): Promise<string>;
}>;

function wrapBody(body: unknown): ByteStreamLike | null {
  if (body === null || body === undefined) {
    return null;
  }
  const candidate = body as { getReader?: unknown };
  if (typeof candidate.getReader !== 'function') {
    return null;
  }
  return {
    getReader(): ByteReaderLike {
      const reader = (
        body as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock?(): void } }
      ).getReader();
      return {
        async read(): Promise<{ done: boolean; value?: Uint8Array | undefined }> {
          const result = await reader.read();
          return result.value === undefined
            ? { done: result.done }
            : { done: result.done, value: result.value };
        },
        releaseLock(): void {
          reader.releaseLock?.();
        },
      };
    },
  };
}

/**
 * Adapts a platform `fetch` to the transport's contract.
 *
 * `signal` and `body` are passed through only when present rather than as
 * explicit `undefined`, because some `fetch` implementations treat a present-but-
 * undefined `body` on a POST differently from an absent one.
 */
export function createFetch(impl?: PlatformFetch): FetchLike {
  const platform = impl ?? (globalThis.fetch as unknown as PlatformFetch | undefined);
  if (platform === undefined) {
    throw new Error(
      'No fetch implementation is available. CodeRelay requires Node 20 or newer, ' +
        'which is the runtime VS Code 1.96 ships.',
    );
  }

  return async (url: string, init: HttpRequestInitLike): Promise<HttpResponseLike> => {
    const response = await platform(url, {
      method: init.method,
      headers: { ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });

    return {
      status: response.status,
      headers: response.headers,
      body: wrapBody(response.body),
      text: () => response.text(),
    };
  };
}
