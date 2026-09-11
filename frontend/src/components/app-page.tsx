"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";

type AppPageProps = {
  children: ReactNode;
};

export function AppPage({ children }: AppPageProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);

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

  if (checking) {
    return (
      <main className="bg-background text-foreground grid min-h-screen place-items-center">
        <p className="text-muted-foreground text-sm" role="status">
          Checking your session…
        </p>
      </main>
    );
  }

  return <AppShell>{children}</AppShell>;
}
