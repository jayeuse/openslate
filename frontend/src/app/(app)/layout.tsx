import type { ReactNode } from "react";
import { AppPage } from "@/components/app-page";

export default function AuthenticatedGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Single mount point for the authenticated shell: the session gate,
  // RealtimeProvider, and AppShell (composed in AppPage) mount once for every
  // route in this group, so client-side navigation swaps only `children`
  // instead of remounting the shell (no white flicker, no duplicate GoTrue
  // clients). Public routes live outside this group and are untouched.
  return <AppPage>{children}</AppPage>;
}
