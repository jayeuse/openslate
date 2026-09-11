import type { ReactNode } from "react";
import { AppPage } from "@/components/app-page";

export default function AuthenticatedGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Keep the session gate and shared shell mounted across workspace routes.
  // UI-first workspace state is local; no business-data or realtime providers
  // mount here. Public authentication routes remain outside this group.
  return <AppPage>{children}</AppPage>;
}
