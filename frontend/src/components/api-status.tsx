"use client";

import { useEffect, useState } from "react";
import { z } from "zod";

const healthSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
});

type ApiState = "checking" | "online" | "offline";

export function ApiStatus() {
  const [state, setState] = useState<ApiState>("checking");

  useEffect(() => {
    const controller = new AbortController();

    async function checkHealth() {
      try {
        const response = await fetch("/api/health", { signal: controller.signal });
        if (!response.ok) throw new Error("API health check failed");
        healthSchema.parse(await response.json());
        setState("online");
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setState("offline");
        }
      }
    }

    void checkHealth();
    return () => controller.abort();
  }, []);

  const label = state === "checking" ? "Checking API" : state === "online" ? "API online" : "API offline";

  return (
    <div className="flex items-center gap-2 font-mono text-[11px] tracking-wider text-stone-500 uppercase" role="status">
      <span
        className={`size-1.5 rounded-full ${
          state === "online" ? "bg-lime-300" : state === "offline" ? "bg-red-400" : "animate-pulse bg-amber-300"
        }`}
      />
      {label}
    </div>
  );
}
