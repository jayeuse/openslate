"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import {
  useWorkspaceNavigationGuard,
  type WorkspaceNavigationGuard,
} from "@/components/workspace-navigation-guard";
import ImportExport from "./components/import-export";
import Account from "./components/account";
import Notifications from "./components/notifications";
import Search from "./components/search";

const PLATFORM_SECTIONS = {
  search: "Search",
  notifications: "Notifications",
  "import-export": "Import & export",
  account: "Account",
} as const;

type PlatformSection =
  (typeof PLATFORM_SECTIONS)[keyof typeof PLATFORM_SECTIONS];

function platformSectionFromSearch(
  requestedSection: string | null,
  hash: string,
): PlatformSection {
  if (requestedSection !== null)
    return Object.hasOwn(PLATFORM_SECTIONS, requestedSection)
      ? PLATFORM_SECTIONS[requestedSection as keyof typeof PLATFORM_SECTIONS]
      : "Search";
  if (hash === "#account") return "Account";
  if (hash === "#notifications") return "Notifications";
  return "Search";
}

export default function Platform() {
  const searchParams = useSearchParams();
  const [hash, setHash] = useState(() =>
    typeof window === "undefined" ? "" : window.location.hash,
  );
  const tab = platformSectionFromSearch(searchParams.get("section"), hash);
  const [query, setQuery] = useState("");
  const importGuardRef = useRef<WorkspaceNavigationGuard | null>(null);
  const registerImportGuard = useCallback(
    (guard: WorkspaceNavigationGuard | null) => {
      importGuardRef.current = guard;
    },
    [],
  );
  useWorkspaceNavigationGuard(
    useCallback(
      (href, resume) => importGuardRef.current?.(href, resume) ?? true,
      [],
    ),
  );

  useEffect(() => {
    const syncHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform"
        description="Search, notifications, and your account."
      />
      {tab === "Account" ? (
        <p
          role="note"
          aria-label="Account data"
          className="text-muted-foreground -mt-4 text-sm"
        >
          Password, device sessions, and theme use your signed-in account.
        </p>
      ) : null}
      {tab === "Import & export" ? (
        <ImportExport onNavigationGuardChange={registerImportGuard} />
      ) : tab === "Account" ? (
        <Account />
      ) : tab === "Search" ? (
        <Search query={query} onQueryChange={setQuery} />
      ) : tab === "Notifications" ? (
        <Notifications />
      ) : null}
    </div>
  );
}
