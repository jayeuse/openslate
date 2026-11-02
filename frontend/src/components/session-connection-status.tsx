"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { getSessionConnection, subscribeSessionConnection } from "@/lib/api";

// A refresh that recovers within this time never shows anything.
const QUIET_MILLISECONDS = 5000;

/**
 * Shows "Reconnecting…" while the session refresh waits for Auth to answer again.
 *
 * It is a status, not a curtain: the page stays usable, actions wait for the
 * session, and the status clears itself when the refresh succeeds. While the
 * server banner shows, it stays hidden: the banner names the larger problem
 * (D3.7, docs/specs/system-health.md). After the banner clears, the quiet
 * period starts again.
 */
export function SessionConnectionStatus({
  serverBannerShown,
}: {
  serverBannerShown: boolean;
}) {
  const connection = useSyncExternalStore(
    subscribeSessionConnection,
    getSessionConnection,
    () => "connected" as const,
  );
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (connection !== "reconnecting" || serverBannerShown) return;
    const timer = setTimeout(() => setDelayed(true), QUIET_MILLISECONDS);
    return () => {
      clearTimeout(timer);
      setDelayed(false);
    };
  }, [connection, serverBannerShown]);
  const visible =
    connection === "reconnecting" && delayed && !serverBannerShown;
  return (
    <div
      role="status"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[70] flex justify-center px-4"
    >
      {visible && (
        <span className="border-border bg-card text-card-foreground flex min-h-9 items-center gap-2 rounded-[var(--radius)] border px-3 text-sm shadow-lg">
          <RefreshCw
            aria-hidden="true"
            className="text-muted-foreground size-4"
          />
          Reconnecting…
        </span>
      )}
    </div>
  );
}
