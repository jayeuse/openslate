"use client";

/**
 * A change notice. `moduleId` names the module of a module-scoped change; the
 * server sends it only to users who can read that module.
 */
export type WorkspaceInvalidation =
  | { type: "resync" }
  | { type: "invalidate"; entity: string; moduleId?: string };

type Listener = (event: WorkspaceInvalidation) => void;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidationPayload(
  data: string,
): { entity: string; moduleId?: string } | null {
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
    if (!("module_id" in payload) || payload.module_id === undefined)
      return { entity: payload.entity };
    if (
      typeof payload.module_id !== "string" ||
      !UUID_PATTERN.test(payload.module_id)
    )
      return null;
    return { entity: payload.entity, moduleId: payload.module_id };
  } catch {
    return null;
  }
}

// Subscribers in one tab share one stream. The first subscriber opens it and
// the last one closes it at once, so a new account never inherits a stream
// that the previous session opened.
const listeners = new Set<Listener>();
const connectedListeners = new Set<() => void>();
let stream: EventSource | null = null;
// True once the open stream delivered its opening resync: from then on, no
// server change can be missed.
let connected = false;
let available = false;

function emit(event: WorkspaceInvalidation) {
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
      connected = true;
      available = true;
      for (const listener of [...connectedListeners]) listener();
      return;
    }
    available = true;
    emit({ type: "resync" });
  });
  source.addEventListener("invalidate", (event: Event) => {
    if (!(event instanceof MessageEvent)) return;
    const payload = invalidationPayload(event.data);
    if (payload !== null) emit({ type: "invalidate", ...payload });
  });
  source.addEventListener("error", () => {
    available = false;
    if (errorNotified) return;
    errorNotified = true;
    firstResync = false;
    emit({ type: "resync" });
  });
  return source;
}

/**
 * Subscribes to server invalidations. `onConnected` runs once the stream is
 * connected (at once if it already is): data read before that moment could
 * have missed a change, so a cache can refresh it then.
 */
export function subscribeWorkspaceInvalidations(
  onInvalidation: Listener,
  onConnected?: () => void,
): () => void {
  // A wrapper keeps two subscriptions of the same function independent.
  const listener: Listener = (event) => onInvalidation(event);
  listeners.add(listener);
  const connectedListener = () => onConnected?.();
  if (onConnected) {
    if (stream && connected) queueMicrotask(connectedListener);
    else connectedListeners.add(connectedListener);
  }
  if (!stream) {
    connected = false;
    available = false;
    stream = openStream();
  }

  return () => {
    listeners.delete(listener);
    connectedListeners.delete(connectedListener);
    if (listeners.size === 0 && stream) {
      stream.close();
      stream = null;
      connected = false;
      available = false;
    }
  };
}

export function isWorkspaceStreamAvailable(): boolean {
  return stream !== null && available && stream.readyState === EventSource.OPEN;
}
