"use client";

import { useEffect, useState } from "react";

const HEALTH_CHECK_TIMEOUT_MS = 5_000;

function isHealthyResponse(
  value: unknown,
): value is { status: "ok"; service: string } {
  if (typeof value !== "object" || value === null) return false;

  const response = value as Record<string, unknown>;
  return response.status === "ok" && typeof response.service === "string";
}

type ApiState = "checking" | "online" | "offline";

export function ApiStatus() {
  const [state, setState] = useState<ApiState>("checking");

  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, HEALTH_CHECK_TIMEOUT_MS);

    async function checkHealth() {
      try {
        const response = await fetch("/api/health", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("API health check failed");
        if (!isHealthyResponse(await response.json()))
          throw new Error("Invalid API response");
        setState("online");
      } catch (error) {
        const wasUnmounted =
          error instanceof DOMException &&
          error.name === "AbortError" &&
          !timedOut;
        if (!wasUnmounted) {
          setState("offline");
        }
      }
    }

    void checkHealth();
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const label =
    state === "checking"
      ? "Checking API"
      : state === "online"
        ? "API online"
        : "API offline";

  return (
    <div
      className="flex items-center gap-2 font-mono text-[11px] tracking-wider text-stone-400 uppercase"
      role="status"
      aria-live="polite"
    >
      <span
        className={`size-1.5 rounded-full ${
          state === "online"
            ? "bg-lime-300"
            : state === "offline"
              ? "bg-red-400"
              : "bg-amber-300 motion-safe:animate-pulse"
        }`}
        aria-hidden="true"
      />
      {label}
    </div>
  );
}
