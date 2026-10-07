import type { ReactNode } from "react";
import { AppPage } from "@/components/app-page";

export default function AuthenticatedGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Keep the session gate and shared shell mounted across workspace routes.
  // Public authentication routes remain outside this group.
  return <AppPage>{children}</AppPage>;
}
