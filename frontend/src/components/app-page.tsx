"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  OPENSLADE_INVALIDATION_EVENT,
  RealtimeProvider,
} from "@/components/realtime-provider";

export function AppPage({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [invalidationGeneration, setInvalidationGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    void fetch("/session/status", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        const authenticated =
          typeof body === "object" &&
          body !== null &&
          "authenticated" in body &&
          body.authenticated === true;
        if (!response.ok || !authenticated) router.replace("/login");
        else if (active) setChecking(false);
      })
      .catch(() => router.replace("/login"));
    return () => {
      active = false;
    };
  }, [router]);

  useEffect(() => {
    const invalidate = () =>
      setInvalidationGeneration((current) => current + 1);
    window.addEventListener(OPENSLADE_INVALIDATION_EVENT, invalidate);
    return () =>
      window.removeEventListener(OPENSLADE_INVALIDATION_EVENT, invalidate);
  }, []);

  if (checking) {
    return (
      <main className="bg-background text-foreground grid min-h-screen place-items-center">
        <p className="text-muted-foreground text-sm" role="status">
          Checking your session…
        </p>
      </main>
    );
  }

  return (
    <RealtimeProvider>
      <AppShell key={invalidationGeneration}>{children}</AppShell>
    </RealtimeProvider>
  );
}
