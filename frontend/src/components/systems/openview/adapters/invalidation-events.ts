"use client";

export type OpenViewInvalidation =
  { type: "resync" } | { type: "invalidate"; entity: string };

type Listener = (event: OpenViewInvalidation) => void;

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

// Subscribers in one tab share one stream. The first subscriber opens it and
// the last one closes it at once, so a new account never inherits a stream
// that the previous session opened.
const listeners = new Set<Listener>();
let stream: EventSource | null = null;

function emit(event: OpenViewInvalidation) {
  for (const listener of [...listeners]) listener(event);
}

function openStream(): EventSource {
  const source = new EventSource("/api/events");
  let firstResync = true;
  let errorNotified = false;

  source.addEventListener("open", () => {
    errorNotified = false;
  });
  source.addEventListener("resync", () => {
    if (firstResync) {
      firstResync = false;
      return;
    }
    emit({ type: "resync" });
  });
  source.addEventListener("invalidate", (event: Event) => {
    if (!(event instanceof MessageEvent)) return;
    const entity = invalidationEntity(event.data);
    if (entity !== null) emit({ type: "invalidate", entity });
  });
  source.addEventListener("error", () => {
    if (errorNotified) return;
    errorNotified = true;
    firstResync = false;
    emit({ type: "resync" });
  });
  return source;
}

export function subscribeOpenViewInvalidations(
  onInvalidation: Listener,
): () => void {
  // A wrapper keeps two subscriptions of the same function independent.
  const listener: Listener = (event) => onInvalidation(event);
  listeners.add(listener);
  stream ??= openStream();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stream) {
      stream.close();
      stream = null;
    }
  };
}
