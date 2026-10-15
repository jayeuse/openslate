export type RecordedRequest = { input: RequestInfo | URL; init?: RequestInit };

/**
 * Replaces `fetch` for one test and records each request; `restore()` puts
 * the original back. A responder may return a pending promise to hold the
 * answer.
 */
export function installFetch(
  response: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): { requests: RecordedRequest[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return response(input, init);
  };
  return { requests, restore: () => (globalThis.fetch = originalFetch) };
}

/** Synchronous responder failures stay synchronous; restore returns void. */
export function installSyncFetch(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Response,
) {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Promise.resolve(responder(input, init));
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Call the original responder with no arguments, as the Boards originals did. */
export function installNoArgumentFetch(responder: () => Response) {
  return installSyncFetch(() => responder());
}
