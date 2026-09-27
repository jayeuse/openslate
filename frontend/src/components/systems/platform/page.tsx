"use client";
import { useCallback, useEffect, useState } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import {
  sampleOperationMessage,
  useSampleResource,
} from "@/components/systems/shared/runtime/sample-async";
import { useSampleRuntime } from "@/components/systems/shared/runtime/sample-state";
import { PageHeader } from "@/components/page-header";
import { SampleDataNote } from "@/components/sample-data-note";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import { Action } from "../shared/components/ui";
import ImportExport from "./components/import-export";
import Account from "./components/account";
import Files from "./components/files";
import Notifications from "./components/notifications";
import Records from "./components/records";
import Search, { type PlatformSearchGroup } from "./components/search";
import { usePlatformCommands } from "./adapters/runtime";
import {
  PLATFORM_OWNER_KEYS,
  readPlatformSnapshot,
  type PlatformSnapshot,
} from "./adapters/snapshot";
import { pagePlatformSearch } from "./domain/records";
const PLATFORM_SECTIONS = {
  search: "Search",
  notifications: "Notifications",
  "import-export": "Import & export",
  account: "Account & presence",
  files: "File library",
  records: "Record actions",
} as const;

type PlatformSection =
  (typeof PLATFORM_SECTIONS)[keyof typeof PLATFORM_SECTIONS];

// Search results list message text, so formatting markers are removed.
function plainMessageText(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}

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
  const {
    people,
    records,
    messages,
    notifications,
    preferences,
    followed,
    recordThreads,
    account,
    sessions,
    files,
  } = workspace;
  const platformCommands = usePlatformCommands();
  const [query, setQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const fileId = searchParams.get("file") ?? "";
  const [recordId, setRecordId] = useState(workspace.records[0]?.id ?? "");
  const [notice, setNotice] = useState("");
  const selectedRecord =
    records.find((record) => record.id === recordId) ?? records[0] ?? null;
  const selectedRecordId = selectedRecord?.id ?? "";
  const [assigneeDrafts, setAssigneeDrafts] = useState<Record<string, string>>(
    {},
  );
  const [assigneeErrors, setAssigneeErrors] = useState<Record<string, string>>(
    {},
  );
  const file = files.find((item) => item.id === fileId);
  const searchGroups: PlatformSearchGroup[] = [
    {
      type: "People",
      items: people.map((person) => ({
        id: person.id,
        title: person.name,
        href: `/access?user=${encodeURIComponent(person.id)}`,
      })),
    },
    {
      type: "Records",
      items: records.map((record) => ({
        id: record.id,
        title: record.title,
        href: `/openview?record=${encodeURIComponent(record.id)}`,
      })),
    },
    {
      type: "Messages",
      items: messages.map((message) => ({
        id: message.id,
        title: plainMessageText(message.text),
        href: `/comms?conversation=${encodeURIComponent(message.conversation)}&message=${encodeURIComponent(message.id)}`,
      })),
    },
    {
      type: "Files",
      items: files.map((item) => ({
        id: item.id,
        title: item.name,
        href: `/platform?file=${encodeURIComponent(item.id)}&section=files`,
      })),
    },
  ].map((group) => {
    const { complete, page } = pagePlatformSearch(
      group.items,
      query,
      `platform-search:${group.type}:${query.trim().toLowerCase()}`,
    );
    return { type: group.type, complete, page };
  });
  const pendingRecordId = selectedRecord?.id ?? "";
  const pendingAssignment = pendingRecordId
    ? platformCommands.isPending(`platform:record:assign:${pendingRecordId}`)
    : false;
  const pendingSimulation = pendingRecordId
    ? platformCommands.isPending(
        `platform:notification:simulate:${pendingRecordId}`,
      )
    : false;
  const pendingDiscussion = pendingRecordId
    ? platformCommands.isPending(
        `platform:record-discussion:${pendingRecordId}`,
      )
    : false;
  const pendingFollow = pendingRecordId
    ? platformCommands.isPending(`platform:follow:${pendingRecordId}`)
    : false;
  const isNavigationPending = () => platformCommands.isPending();
  const navigationPending = isNavigationPending();
  const assignmentValue = selectedRecord
    ? (assigneeDrafts[selectedRecord.id] ?? selectedRecord.assignee)
    : "";
  const assignmentError = selectedRecord
    ? assigneeErrors[selectedRecord.id]
    : undefined;
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

  useWorkspaceNavigationGuard(
    useCallback(
      (href, resume) => {
        void href;
        void resume;
        return !navigationPending;
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
  useEffect(() => {
    if (isNavigationPending() || recordId === selectedRecordId) return;
    setRecordId(selectedRecordId);
  }, [recordId, selectedRecordId, platformCommands.isPending]);
  useEffect(() => {
    if (!selectedRecord) return;
    const draft = assigneeDrafts[selectedRecord.id];
    if (draft === undefined || draft !== selectedRecord.assignee) return;
    setAssigneeDrafts((current) => {
      if (current[selectedRecord.id] !== draft) return current;
      const next = { ...current };
      delete next[selectedRecord.id];
      return next;
    });
    setAssigneeErrors((current) => {
      if (!(selectedRecord.id in current)) return current;
      const next = { ...current };
      delete next[selectedRecord.id];
      return next;
    });
  }, [selectedRecord, assigneeDrafts]);
  const hasRecordDiscussion = selectedRecord
    ? recordThreads.some((item) => item.recordId === selectedRecord.id)
    : false;
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
  async function assignRecord(recordId: string, assignee: string) {
    const record = records.find((item) => item.id === recordId);
    if (!record) return;
    setAssigneeDrafts((current) => ({ ...current, [recordId]: assignee }));
    setAssigneeErrors((current) => {
      if (!(recordId in current)) return current;
      const next = { ...current };
      delete next[recordId];
      return next;
    });
    try {
      const result = await platformCommands.updateRecordAssignee(
        recordId,
        assignee,
      );
      if (result.ok) {
        setNotice("Record assignment updated.");
        return;
      }
      setAssigneeErrors((current) => ({
        ...current,
        [recordId]: result.error,
      }));
      setNotice(result.error);
    } catch (error) {
      const message = commandError(error, "The record could not be updated.");
      setAssigneeErrors((current) => ({ ...current, [recordId]: message }));
      setNotice(message);
    }
  }
  function retryRecordAssignment() {
    if (!selectedRecord) return;
    const assignee = assigneeDrafts[selectedRecord.id];
    if (assignee === undefined) return;
    void assignRecord(selectedRecord.id, assignee);
  }
  function selectRecord(recordId: string) {
    if (isNavigationPending()) return;
    setRecordId(recordId);
  }
  function assignRecordWhenNavigationIdle(recordId: string, assignee: string) {
    if (isNavigationPending()) return;
    void assignRecord(recordId, assignee);
  }
  async function startRecordDiscussion() {
    if (!selectedRecord) return;
    try {
      const result = await platformCommands.startRecordDiscussion(
        selectedRecord.id,
      );
      setNotice(
        result.ok ? "Record discussion ready in OpenComms." : result.error,
      );
    } catch (error) {
      setNotice(commandError(error, "The discussion could not be started."));
    }
  }
  async function toggleRecordFollow() {
    if (!selectedRecord) return;
    try {
      const result = await platformCommands.toggleFollow(selectedRecord.id);
      setNotice(
        result.ok
          ? result.value
            ? "Following this record."
            : "Record follow removed."
          : result.error,
      );
    } catch (error) {
      setNotice(commandError(error, "The record follow could not be updated."));
    }
  }
  if (
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
      {(platformResource.refreshing || platformResource.error) && (
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
      {tab !== "Notifications" ? (
        <SampleDataNote className="-mt-4">
          Records, files, and people here are examples.
        </SampleDataNote>
      ) : null}
      {notice && (
        <p role="status" className="bg-muted rounded-lg border p-3 text-sm">
          {notice}
        </p>
      )}
      {tab === "Import & export" ? (
        <ImportExport
          records={records}
          people={people}
          onImport={platformCommands.importRecords}
          onPrepareExport={platformCommands.loadRecordsForExport}
          pending={platformCommands.isPending}
        />
      ) : tab === "Account & presence" ? (
        <Account
          preferences={account}
          sessions={sessions}
          onAccountChange={platformCommands.updateAccount}
          onEndSession={platformCommands.endSession}
          pending={platformCommands.isPending}
        />
      ) : tab === "Search" ? (
        <Search
          query={query}
          onQueryChange={setQuery}
          groups={searchGroups}
          navigationPending={navigationPending}
          isNavigationPending={isNavigationPending}
          onOpenFile={(selectedFileId) =>
            navigate("File library", { fileId: selectedFileId })
          }
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
      ) : (
        <Records
          records={records}
          people={people}
          selectedRecord={selectedRecord}
          followed={followed}
          assignmentValue={assignmentValue}
          assignmentError={assignmentError}
          navigationPending={navigationPending}
          pendingAssignment={pendingAssignment}
          pendingDiscussion={pendingDiscussion}
          pendingFollow={pendingFollow}
          hasRecordDiscussion={hasRecordDiscussion}
          isNavigationPending={isNavigationPending}
          onSelectRecord={selectRecord}
          onAssignRecord={assignRecordWhenNavigationIdle}
          onRetryAssignment={retryRecordAssignment}
          onStartDiscussion={() => void startRecordDiscussion()}
          onToggleFollow={() => void toggleRecordFollow()}
        />
      )}
    </div>
  );
}
