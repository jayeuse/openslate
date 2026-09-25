"use client";

export type OpenViewInvalidation =
  { type: "resync" } | { type: "invalidate"; entity: string };

function invalidationEntity(data: string): string | null {
  try {
    const payload: unknown = JSON.parse(data);
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("entity" in payload) ||
      typeof payload.entity !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(payload.entity)
    )
      return null;
    return payload.entity;
  } catch {
    return null;
  }
}

export function subscribeOpenViewInvalidations(
  onInvalidation: (event: OpenViewInvalidation) => void,
): () => void {
  const stream = new EventSource("/api/events");
  let firstResync = true;
  let errorNotified = false;

  stream.addEventListener("open", () => {
    errorNotified = false;
  });
  stream.addEventListener("resync", () => {
    if (firstResync) {
      firstResync = false;
      return;
    }
    onInvalidation({ type: "resync" });
  });
  stream.addEventListener("invalidate", (event: Event) => {
    if (!(event instanceof MessageEvent)) return;
    const entity = invalidationEntity(event.data);
    if (entity !== null) onInvalidation({ type: "invalidate", entity });
  });
  stream.addEventListener("error", () => {
    if (errorNotified) return;
    errorNotified = true;
    firstResync = false;
    onInvalidation({ type: "resync" });
  });

  return () => stream.close();
}
