"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  OPENSLADE_INVALIDATION_EVENT,
  RealtimeProvider,
} from "@/components/realtime-provider";

type AppPageProps = {
  children: ReactNode;
};

export function AppPage({ children }: AppPageProps) {
  const router = useRouter();
  const pathname = usePathname();
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
        // `checking` starts true and is only ever cleared here, so the
        // "Checking your session…" splash shows solely on first mount;
        // later pathname changes revalidate silently in the background.
        else if (active) setChecking(false);
      })
      .catch(() => router.replace("/login"));
    return () => {
      active = false;
    };
  }, [router, pathname]);

  // The (app) group layout takes no per-page props, so the preserve-state
  // mapping formerly expressed via `preserveStateOnInvalidation` is derived
  // from the pathname here: record authoring routes (`*/records/new` and
  // `*/records/*/edit`, in both the canonical `/modules/...` shape and the
  // department-alias `/departments/.../modules/...` shape) keep in-progress
  // form state by skipping the AppShell remount; every other authenticated
  // route remounts the shell on invalidation.
  const preserveStateOnInvalidation =
    /\/records\/new\/?$/.test(pathname) ||
    /\/records\/[^/]+\/edit\/?$/.test(pathname);

  useEffect(() => {
    const invalidate = () => {
      if (!preserveStateOnInvalidation) {
        setInvalidationGeneration((current) => current + 1);
      }
    };
    window.addEventListener(OPENSLADE_INVALIDATION_EVENT, invalidate);
    return () =>
      window.removeEventListener(OPENSLADE_INVALIDATION_EVENT, invalidate);
  }, [preserveStateOnInvalidation]);

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
