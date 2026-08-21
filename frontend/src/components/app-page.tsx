"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getSession } from "@/lib/session";

export function AppPage({ children }: { children: ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    if (!getSession()) router.replace("/login");
  }, [router]);
  return <AppShell>{children}</AppShell>;
}
