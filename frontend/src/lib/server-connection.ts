/**
 * Whether Slate Operations' server answers (D3, docs/specs/system-health.md).
 * `sendApiRequest` in `api.ts` reports every request of `apiFetch` and the
 * session refresh here; the shell banner reads it.
 *
 * Every response that passes the server's request middleware carries
 * `X-Request-ID`, of any status. A response without it comes from something in
 * front of the server: Caddy (502, 504), the development proxy (500) or the
 * concurrency limit (503). Only a failed fetch or a 500, 502 or 504 without the
 * header means that the server did not answer; a 503 or a 400/404 from a proxy
 * proves that something answers, so the failing control shows its own error.
 */
export type ServerConnection = "reachable" | "unreachable";

const UNANSWERED_STATUSES = new Set([500, 502, 504]);

let connection: ServerConnection = "reachable";
const listeners = new Set<() => void>();

function setServerConnection(next: ServerConnection): void {
  if (next === connection) return;
  connection = next;
  for (const listener of listeners) listener();
}

export function getServerConnection(): ServerConnection {
  return connection;
}

export function subscribeServerConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A response arrived: the server answered, unless a proxy says it did not. */
export function noteServerResponse(response: Response): void {
  if (response.headers.has("X-Request-ID")) setServerConnection("reachable");
  else if (UNANSWERED_STATUSES.has(response.status))
    setServerConnection("unreachable");
}

/** A request got no response. Navigation and cleanup abort requests; an abort
 * never counts. */
export function noteServerFailure(error: unknown, aborted: boolean): void {
  if (aborted || (error instanceof Error && error.name === "AbortError"))
    return;
  setServerConnection("unreachable");
}

export type RetryTimers = {
  set: (run: () => void, delay: number) => number;
  clear: (id: number) => void;
};

// After 5, 10 and 20 seconds, then every 30 seconds (D3.4).
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000];

/**
 * Asks the server again on its own while the banner shows, so "It tries again
 * on its own" is true when the person does nothing. `pause` stops it while the
 * tab is hidden; `wake` asks at once (the tab is visible again, the window has
 * focus, or the browser is online) and continues the schedule.
 */
export function startServerRetry({
  probe,
  timers,
}: {
  probe: () => void;
  timers: RetryTimers;
}) {
  let attempt = 0;
  let timer: number | null = null;
  const cancel = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const schedule = () => {
    cancel();
    const delay =
      RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    timer = timers.set(() => {
      timer = null;
      attempt += 1;
      probe();
      schedule();
    }, delay);
  };
  schedule();
  return {
    pause: cancel,
    wake() {
      attempt += 1;
      probe();
      schedule();
    },
    stop: cancel,
  };
}
