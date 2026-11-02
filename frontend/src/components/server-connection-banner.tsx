"use client";

import { ServerOff } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { probeServerHealth } from "@/lib/api";
import {
  getServerConnection,
  startServerRetry,
  subscribeServerConnection,
} from "@/lib/server-connection";

// How long the "can reach its server again" announcement stays.
const RECOVERED_MILLISECONDS = 4000;

// `quiet`: a modal's announcer that opened while the server did not answer.
// It says nothing until the server answers again (D4 item 11).
type BannerState = "hidden" | "quiet" | "showing" | "recovered";

/** What a connection change does to the banner: no answer shows it, the next
 * answer after that says so, and an answer with nothing shown changes
 * nothing. */
export function nextBannerState(
  current: BannerState,
  connection: "reachable" | "unreachable",
): BannerState {
  if (connection === "unreachable") return "showing";
  return current === "showing" || current === "quiet" ? "recovered" : current;
}

/** The banner state from `initial`, then from each connection change; the
 * recovered sentence empties after 4 seconds. */
function useBannerState(initial: () => BannerState): BannerState {
  const [state, setState] = useState<BannerState>(initial);
  useEffect(() => {
    let timer: number | undefined;
    const stop = subscribeServerConnection(() => {
      window.clearTimeout(timer);
      const connection = getServerConnection();
      setState((current) => nextBannerState(current, connection));
      if (connection === "unreachable") return;
      timer = window.setTimeout(
        () =>
          setState((current) => (current === "recovered" ? "hidden" : current)),
        RECOVERED_MILLISECONDS,
      );
    });
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, []);
  return state;
}

/** Whether the server has stopped answering; while it has, the banner names
 * the problem and the other connection messages stay hidden (D3.7). */
export function useServerUnreachable(): boolean {
  return (
    useSyncExternalStore(
      subscribeServerConnection,
      getServerConnection,
      () => "reachable" as const,
    ) === "unreachable"
  );
}

/**
 * The shell banner (D3, docs/specs/system-health.md): shown at once when a
 * request gets no answer, cleared at the next answer. It sits in the page flow
 * under the top bar, holds no control, never moves focus and never blocks a
 * click. While it shows, it asks `/api/health` on its own.
 */
export function ServerConnectionBanner() {
  const unreachable = useServerUnreachable();
  const state = useBannerState(() =>
    getServerConnection() === "unreachable" ? "showing" : "hidden",
  );
  useEffect(() => {
    if (!unreachable) return;
    const retry = startServerRetry({
      probe: () => void probeServerHealth(),
      timers: {
        set: (run, delay) => window.setTimeout(run, delay),
        clear: (id) => window.clearTimeout(id),
      },
    });
    if (document.hidden) retry.pause();
    const visibility = () => (document.hidden ? retry.pause() : retry.wake());
    const wake = () => retry.wake();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      retry.stop();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [unreachable]);
  return <ServerConnectionBannerView state={state} />;
}

/** The banner as it shows for one state. The status region is in the DOM,
 * empty, at all times, so its text is announced politely once. */
export function ServerConnectionBannerView({ state }: { state: BannerState }) {
  return (
    <div role="status" aria-atomic="true" className="min-w-0">
      {state === "showing" ? (
        <div className="border-warn-rule bg-warn-tint text-foreground flex min-h-10 items-center gap-2 border-b px-4 py-2 text-sm sm:px-5">
          <ServerOff
            aria-hidden="true"
            className="text-warn-text size-4 shrink-0"
          />
          <p className="min-w-0">
            Slate Operations cannot reach its server. Changes you make now may
            not save. It tries again on its own.
          </p>
        </div>
      ) : state === "recovered" ? (
        <span className="sr-only">
          Slate Operations can reach its server again.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The banner's announcement inside a modal dialog or sheet (D4 item 11): a
 * modal makes the shell inert, so the banner's own region cannot speak. It
 * starts empty, because the person heard the banner before the modal opened,
 * and then speaks each change. It shows nothing.
 */
export function ServerConnectionAnnouncer() {
  return (
    <ServerConnectionAnnouncerView
      state={useBannerState(() =>
        getServerConnection() === "unreachable" ? "quiet" : "hidden",
      )}
    />
  );
}

export function ServerConnectionAnnouncerView({
  state,
}: {
  state: BannerState;
}) {
  return (
    <span role="status" aria-atomic="true" className="sr-only">
      {state === "showing"
        ? "Slate Operations cannot reach its server. Changes you make now may not save. It tries again on its own."
        : state === "recovered"
          ? "Slate Operations can reach its server again."
          : ""}
    </span>
  );
}
