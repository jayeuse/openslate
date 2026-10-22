"use client";
import { useEffect, useState } from "react";
import type { CommsViewClient as CommsClient } from "../contract/client";
import type { ConnectionState } from "../contract/types";
import { useCommsClient } from "../state/client-context";
import { Action } from "../../shared/components/ui";

export function ConnectionBanner() {
  const { client, error, reload, organizationName } = useCommsClient();
  const [observed, setObserved] = useState<{
    client: CommsClient;
    state: ConnectionState;
    delayed: boolean;
  }>();
  useEffect(() => {
    if (!client) return;
    const abort = new AbortController();
    let current: ConnectionState = { state: "connecting" };
    let delayed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = (next: ConnectionState) => {
      if (abort.signal.aborted) return;
      if (next.state !== current.state) {
        clearTimeout(timer);
        delayed = false;
        if (next.state === "reconnecting")
          timer = setTimeout(() => {
            if (!abort.signal.aborted) {
              delayed = true;
              setObserved({ client, state: current, delayed });
            }
          }, 3000);
      }
      current = next;
      setObserved({ client, state: next, delayed });
    };
    let stop = () => {};
    try {
      stop = client.events.subscribe(
        {
          on_event: () => {},
          on_connection: report,
          on_error: () => {
            if (current.state !== "paused") report({ state: "offline" });
          },
        },
        { signal: abort.signal },
      );
    } catch {
      report({ state: "offline" });
    }
    return () => {
      abort.abort();
      clearTimeout(timer);
      stop();
    };
  }, [client]);
  const state = error
    ? "offline"
    : observed?.client === client
      ? observed?.state.state
      : "connecting";
  const label =
    state === "live"
      ? "Live"
      : state === "offline"
        ? "Offline"
        : state === "paused"
          ? "Live updates paused in this tab"
          : state === "reconnecting"
            ? observed?.delayed
              ? "Reconnecting"
              : ""
            : "Connecting";
  return (
    <div
      role="status"
      aria-label="Conversation connection"
      aria-busy={
        state === "connecting" ||
        (state === "reconnecting" && !observed?.delayed)
      }
      className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 border-b px-3 py-1 text-xs"
    >
      {organizationName && (
        <span
          aria-label="Current organization"
          className="text-sm font-semibold"
        >
          {organizationName}
        </span>
      )}
      <span className="text-muted-foreground">Connection</span>
      <span>{label}</span>
      {(state === "offline" || state === "paused") && (
        <Action size="sm" variant="ghost" onClick={reload}>
          {state === "offline" ? "Retry" : "Refresh"}
        </Action>
      )}
    </div>
  );
}
