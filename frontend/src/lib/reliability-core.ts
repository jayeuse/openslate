export const MAX_JSON_REQUEST_BYTES = 1024 * 1024;
export const MAX_BFF_RESPONSE_BYTES = 8 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload exceeds the configured limit");
  }
}

export class UpstreamResponseTooLargeError extends Error {
  constructor() {
    super("Upstream response exceeds the configured limit");
  }
}

export class RequestDeadlineExceededError extends Error {
  constructor() {
    super("Request deadline exceeded");
  }
}

function declaredLengthExceeds(headers: Headers, limit: number): boolean {
  const contentLength = headers.get("content-length");
  if (contentLength === null) return false;
  if (!/^\d+$/.test(contentLength)) return false;
  return Number(contentLength) > limit;
}

function discardStream(stream: ReadableStream<Uint8Array>): void {
  void stream.cancel().catch(() => undefined);
}

function discardReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => undefined);
}

export async function readLimitedStream(
  stream: ReadableStream<Uint8Array> | null,
  headers: Headers,
  limit: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (declaredLengthExceeds(headers, limit)) {
    if (stream !== null) discardStream(stream);
    throw new PayloadTooLargeError();
  }
  if (stream === null) return new ArrayBuffer(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    discardReader(reader);
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw new RequestDeadlineExceededError();
      const next = await reader.read();
      if (signal?.aborted) throw new RequestDeadlineExceededError();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        discardReader(reader);
        throw new PayloadTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

export function createRequestDeadline(milliseconds: number): {
  signal: AbortSignal;
  remaining(): number;
  throwIfExpired(): void;
  dispose(): void;
} {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), milliseconds);
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, milliseconds - (Date.now() - startedAt)),
    throwIfExpired: () => {
      if (controller.signal.aborted) throw new RequestDeadlineExceededError();
    },
    dispose: () => clearTimeout(timeout),
  };
}

export async function withinDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new RequestDeadlineExceededError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RequestDeadlineExceededError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function parseJsonBody(body: ArrayBuffer): unknown {
  if (body.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}
