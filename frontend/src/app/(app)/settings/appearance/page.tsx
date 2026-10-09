"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWorkspaceNavigationRequest } from "@/components/workspace-navigation-guard";

export default function AppearancePage() {
  const router = useRouter();
  const requestNavigation = useWorkspaceNavigationRequest();
  useEffect(() => {
    const replace = () => router.replace("/profile#look");
    if (requestNavigation("/profile#look", replace)) replace();
  }, [router, requestNavigation]);
  return (
    <p role="status" className="text-muted-foreground">
      Opening your profile…
    </p>
  );
}
