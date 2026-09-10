/** Only exact file routes receive larger transfer budgets. JSON remains unchanged. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FILE_BYTES = 25 * 1024 * 1024;
const LOGO_BYTES = 2 * 1024 * 1024;
let activeTransfers = 0;

export function fileTransferPolicy(path: string[], method: string) {
  if (
    path.length === 2 &&
    path[0] === "workspace" &&
    path[1] === "logo" &&
    method === "GET"
  )
    return {
      requestBytes: 1024 * 1024,
      responseBytes: LOGO_BYTES,
      deadlineMs: 120_000,
    };
  if (path.length !== 3 || path[0] !== "files" || !uuid.test(path[1]))
    return null;
  if (path[2] === "content" && (method === "PUT" || method === "GET"))
    return {
      requestBytes: method === "PUT" ? FILE_BYTES : 1024 * 1024,
      responseBytes: FILE_BYTES,
      deadlineMs: 120_000,
    };
  if ((path[2] === "reconcile" || path[2] === "purge") && method === "POST")
    return {
      requestBytes: 1024 * 1024,
      responseBytes: 8 * 1024 * 1024,
      deadlineMs: 120_000,
    };
  return null;
}

export function acquireFileTransfer(): (() => void) | null {
  if (activeTransfers >= 2) return null;
  activeTransfers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeTransfers--;
  };
}

/** Keep the slot while response bytes remain retained for delivery. */
export function fileResponseBody(
  body: ArrayBuffer,
  release: () => void,
): ReadableStream<Uint8Array> {
  let offset = 0;
  const bytes = new Uint8Array(body);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        release();
        return;
      }
      const end = Math.min(offset + 64 * 1024, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() {
      release();
    },
  });
}
