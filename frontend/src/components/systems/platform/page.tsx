"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import {
  sampleOperationMessage,
  useSampleResource,
} from "@/components/systems/shared/runtime/sample-async";
import { useSampleRuntime } from "@/components/systems/shared/runtime/sample-state";
import { PageHeader } from "@/components/page-header";
import { SampleDataNote } from "@/components/sample-data-note";
import {
  useWorkspaceNavigationGuard,
  type WorkspaceNavigationGuard,
} from "@/components/workspace-navigation-guard";
import { Action } from "../shared/components/ui";
import ImportExport from "./components/import-export";
import Account from "./components/account";
import Files from "./components/files";
import Notifications from "./components/notifications";
import Search from "./components/search";
import { usePlatformCommands } from "./adapters/runtime";
import {
  PLATFORM_OWNER_KEYS,
  readPlatformSnapshot,
  type PlatformSnapshot,
} from "./adapters/snapshot";
const PLATFORM_SECTIONS = {
  search: "Search",
  notifications: "Notifications",
  "import-export": "Import & export",
  account: "Account & presence",
  files: "File library",
} as const;

type PlatformSection =
  (typeof PLATFORM_SECTIONS)[keyof typeof PLATFORM_SECTIONS];

function platformSectionFromSearch(
  requestedSection: string | null,
  hash: string,
  fileId: string | null,
): PlatformSection {
  if (requestedSection !== null)
    return Object.hasOwn(PLATFORM_SECTIONS, requestedSection)
      ? PLATFORM_SECTIONS[requestedSection as keyof typeof PLATFORM_SECTIONS]
      : "Search";
  if (hash === "#account") return "Account & presence";
  if (hash === "#notifications") return "Notifications";
  return fileId ? "File library" : "Search";
}

function platformSectionHref(
  section: PlatformSection,
  current: URLSearchParams,
): string {
  const params = new URLSearchParams(current);
  const slug = Object.entries(PLATFORM_SECTIONS).find(
    ([, label]) => label === section,
  )?.[0];
  if (!slug) return "/platform";
  params.set("section", slug);
  return `/platform?${params.toString()}`;
}

export default function SamplePlatform() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [hash, setHash] = useState(() =>
    typeof window === "undefined" ? "" : window.location.hash,
  );
  const tab = platformSectionFromSearch(
    searchParams.get("section"),
    hash,
    searchParams.get("file"),
  );
  const runtime = useSampleRuntime();
  const platformResource = useSampleResource<PlatformSnapshot>({
    keys: PLATFORM_OWNER_KEYS,
    queryKey: "platform:workspace",
    load: (signal) =>
      runtime.load((draft) => readPlatformSnapshot(draft.read), {
        keys: PLATFORM_OWNER_KEYS,
        signal,
      }),
  });
  const [fallback] = useState<PlatformSnapshot>(() =>
    readPlatformSnapshot((_, initial) => initial),
  );
  const workspace = platformResource.data ?? fallback;
  const { records, notifications, preferences, files } = workspace;
  const platformCommands = usePlatformCommands();
  const [query, setQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const fileId = searchParams.get("file") ?? "";
  const [notice, setNotice] = useState("");
  const selectedRecord = records[0] ?? null;
  const file = files.find((item) => item.id === fileId);
  const pendingRecordId = selectedRecord?.id ?? "";
  const pendingSimulation = pendingRecordId
    ? platformCommands.isPending(
        `platform:notification:simulate:${pendingRecordId}`,
      )
    : false;
  const isNavigationPending = () => platformCommands.isPending();
  const navigationPending = isNavigationPending();
  const navigate = useCallback(
    (
      nextTab: PlatformSection,
      options?: { fileId?: string; replace?: boolean },
    ) => {
      if (platformCommands.isPending()) return;
      const params = new URLSearchParams(searchParams.toString());
      if (options?.fileId) {
        params.set("file", options.fileId);
      } else if (options?.fileId === "") {
        params.delete("file");
      }
      const href = platformSectionHref(nextTab, params);
      if (options?.replace) router.replace(href as Route, { scroll: false });
      else router.push(href as Route, { scroll: false });
    },
    [router, searchParams, platformCommands.isPending],
  );

  const importGuardRef = useRef<WorkspaceNavigationGuard | null>(null);
  const registerImportGuard = useCallback(
    (guard: WorkspaceNavigationGuard | null) => {
      importGuardRef.current = guard;
    },
    [],
  );
  useWorkspaceNavigationGuard(
    useCallback(
      (href, resume) => {
        if (navigationPending) return false;
        return importGuardRef.current?.(href, resume) ?? true;
      },
      [navigationPending],
    ),
  );

  useEffect(() => {
    const syncHash = () => setHash(window.location.hash);
    const click = (event: MouseEvent) => {
      const anchor =
        event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor) return;
      const url = new URL(anchor.href, window.location.href);
      if (
        url.origin === window.location.origin &&
        url.pathname === window.location.pathname &&
        ["#account", "#notifications"].includes(url.hash)
      ) {
        if (isNavigationPending()) {
          event.preventDefault();
        }
      }
    };
    window.addEventListener("hashchange", syncHash);
    document.addEventListener("click", click);
    return () => {
      window.removeEventListener("hashchange", syncHash);
      document.removeEventListener("click", click);
    };
  }, [platformCommands.isPending]);
  function commandError(error: unknown, fallback: string): string {
    return sampleOperationMessage(error, fallback);
  }
  async function markAllNotificationsRead() {
    try {
      const result = await platformCommands.markAllNotificationsRead();
      setNotice(
        result.ok
          ? result.value
            ? `${result.value} notifications marked as read.`
            : "All notifications are already read."
          : result.error,
      );
    } catch (error) {
      setNotice(commandError(error, "Notifications could not be updated."));
    }
  }
  async function simulateRecordUpdate() {
    if (!selectedRecord) return;
    try {
      const result = await platformCommands.simulateRecordUpdate(
        selectedRecord.id,
      );
      setNotice(
        result.ok ? "Record update added to notifications." : result.error,
      );
    } catch (error) {
      setNotice(commandError(error, "The update could not be simulated."));
    }
  }
  async function updateNotificationPreference(
    patch: Parameters<typeof platformCommands.updateNotificationPreferences>[0],
  ) {
    try {
      const result =
        await platformCommands.updateNotificationPreferences(patch);
      setNotice(result.ok ? "Notification preferences saved." : result.error);
    } catch (error) {
      setNotice(
        commandError(error, "Notification preferences could not be saved."),
      );
    }
  }
  function toggleNotification(notificationId: string) {
    void platformCommands
      .toggleNotification(notificationId)
      .then((result) => {
        if (!result.ok) setNotice(result.error);
      })
      .catch((error: unknown) =>
        setNotice(
          commandError(error, "This notification could not be updated."),
        ),
      );
  }
  const usesSampleData = tab === "Notifications" || tab === "File library";
  if (
    usesSampleData &&
    platformResource.status === "loading" &&
    platformResource.data === undefined
  )
    return (
      <section
        aria-label="Platform"
        className="flex min-h-64 items-center justify-center p-6"
      >
        <p role="status" className="text-muted-foreground text-sm">
          Loading Platform…
        </p>
      </section>
    );
  if (
    usesSampleData &&
    platformResource.status === "error" &&
    platformResource.data === undefined
  )
    return (
      <section
        aria-label="Platform"
        className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <p role="alert" className="text-destructive text-sm">
          {platformResource.error}
        </p>
        <Action
          type="button"
          variant="outline"
          onClick={platformResource.reload}
        >
          Try again
        </Action>
      </section>
    );
  return (
    <div className="space-y-6">
      {usesSampleData &&
        (platformResource.refreshing || platformResource.error) && (
          <div className="bg-muted/50 flex items-center gap-3 rounded-lg border p-3 text-sm">
            <p role="status" className="text-muted-foreground flex-1">
              {platformResource.refreshing
                ? "Refreshing Platform…"
                : `Showing the last saved Platform data. ${platformResource.error}`}
            </p>
            {!platformResource.refreshing && (
              <Action
                type="button"
                variant="ghost"
                size="sm"
                onClick={platformResource.reload}
              >
                Retry
              </Action>
            )}
          </div>
        )}
      <PageHeader
        title="Platform"
        description="Search, notifications, files, and your account."
      />
      {tab === "Account & presence" ? (
        <p
          role="note"
          aria-label="Account data"
          className="text-muted-foreground -mt-4 text-sm"
        >
          Password, device sessions, and theme use your signed-in account.
          Language and presence are not available yet.
        </p>
      ) : tab === "File library" ? (
        <SampleDataNote className="-mt-4">
          Records, files, and people here are examples.
        </SampleDataNote>
      ) : null}
      {usesSampleData && notice && (
        <p role="status" className="bg-muted rounded-lg border p-3 text-sm">
          {notice}
        </p>
      )}
      {tab === "Import & export" ? (
        <ImportExport onNavigationGuardChange={registerImportGuard} />
      ) : tab === "Account & presence" ? (
        <Account />
      ) : tab === "Search" ? (
        <Search
          query={query}
          onQueryChange={setQuery}
          navigationPending={navigationPending}
          isNavigationPending={isNavigationPending}
        />
      ) : tab === "Notifications" ? (
        <Notifications
          notifications={notifications}
          preferences={preferences}
          hasSelectedRecord={Boolean(selectedRecord)}
          pendingSimulation={pendingSimulation}
          isPending={(key) => platformCommands.isPending(key)}
          onMarkAllRead={() => void markAllNotificationsRead()}
          onSimulateRecordUpdate={() => void simulateRecordUpdate()}
          onToggleNotification={toggleNotification}
          onPreferenceChange={(patch) =>
            void updateNotificationPreference(patch)
          }
        />
      ) : tab === "File library" ? (
        <Files
          files={files}
          records={records}
          fileQuery={fileQuery}
          onFileQueryChange={setFileQuery}
          file={file}
          navigationPending={navigationPending}
          isNavigationPending={isNavigationPending}
          onOpenFile={(selectedFileId) =>
            navigate("File library", { fileId: selectedFileId })
          }
          onCloseDetails={() => navigate("File library", { fileId: "" })}
        />
      ) : null}
    </div>
  );
}
