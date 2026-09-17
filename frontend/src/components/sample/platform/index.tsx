"use client";
import { useBoardsController } from "../boards/controller";
import { DEFAULT_BOARD_ID } from "../boards/model";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Bell, Search, Files, ArrowUpRight } from "lucide-react";
import {
  sampleOperationMessage,
  useSampleResource,
} from "@/components/sample/sample-async";
import { useSampleRuntime } from "@/components/sample/sample-state";
import { SearchField } from "@/components/ui/search-field";
import { PageHeader } from "@/components/page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Action, Choice, Panel, Toggle } from "../ui";
import ImportExport from "./import-export";
import Account from "./account";
import {
  PLATFORM_OWNER_KEYS,
  pagePlatformSearch,
  readPlatformSnapshot,
  usePlatformCommands,
  type PlatformSnapshot,
} from "./runtime";
const TABS = [
  "Search",
  "Notifications",
  "Import & export",
  "Account & presence",
  "File library",
  "Record actions",
] as const;
function initialTab(): (typeof TABS)[number] {
  if (typeof window === "undefined") return "Search";
  if (window.location.hash === "#account") return "Account & presence";
  if (window.location.hash === "#notifications") return "Notifications";
  return new URLSearchParams(window.location.search).has("file")
    ? "File library"
    : "Search";
}
export default function SamplePlatform() {
  const [tab, setTab] = useState<(typeof TABS)[number]>(initialTab);
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
    design,
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
  const [fileId, setFileId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).get("file") || "",
  );
  const boardsController = useBoardsController();
  const boardRecords = boardsController.state.placements
    .filter((placement) => placement.boardId === DEFAULT_BOARD_ID)
    .map((placement) => placement.recordId);
  const canPlaceOnBoard =
    boardsController.state.boards.some(
      (board) => board.id === DEFAULT_BOARD_ID && board.status === "active",
    ) &&
    (boardsController.can(DEFAULT_BOARD_ID, "edit") ||
      boardsController.can(DEFAULT_BOARD_ID, "manage"));
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
  const searchGroups = [
    {
      type: "Users",
      items: people.map((person) => ({
        id: person.id,
        title: person.name,
        href: `/access?user=${encodeURIComponent(person.id)}`,
      })),
    },
    {
      type: "Departments",
      items: design.departments.map((item) => ({
        id: item.id,
        title: item.name,
        href: `/sandbox?department=${encodeURIComponent(item.id)}`,
      })),
    },
    {
      type: "Modules",
      items: design.modules.map((item) => ({
        id: item.id,
        title: item.name,
        href: `/sandbox?module=${encodeURIComponent(item.id)}`,
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
        title: message.text,
        href: `/comms?conversation=${encodeURIComponent(message.conversation)}&message=${encodeURIComponent(message.id)}`,
      })),
    },
    {
      type: "Files",
      items: files.map((item) => ({
        id: item.id,
        title: item.name,
        href: `/platform?file=${encodeURIComponent(item.id)}`,
      })),
    },
  ].map((group) => ({
    ...group,
    ...pagePlatformSearch(
      group.items,
      query,
      `platform-search:${group.type}:${query.trim().toLowerCase()}`,
    ),
  }));
  const pendingRecordId = selectedRecord?.id ?? "";
  const pendingAssignment = pendingRecordId
    ? platformCommands.isPending(`platform:record:assign:${pendingRecordId}`)
    : false;
  const pendingSimulation = pendingRecordId
    ? platformCommands.isPending(
        `platform:notification:simulate:${pendingRecordId}`,
      )
    : false;
  const boardPending = boardsController.isPending();
  const isNavigationPending = () =>
    platformCommands.isPending() || boardsController.isPending();
  const navigationPending = isNavigationPending();
  const assignmentValue = selectedRecord
    ? (assigneeDrafts[selectedRecord.id] ?? selectedRecord.assignee)
    : "";
  const assignmentError = selectedRecord
    ? assigneeErrors[selectedRecord.id]
    : undefined;
  useEffect(() => {
    const sync = () => {
      if (isNavigationPending()) return;
      setTab(initialTab());
    };
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
          return;
        }
        setTab(
          url.hash === "#account" ? "Account & presence" : "Notifications",
        );
      }
    };
    window.addEventListener("hashchange", sync);
    document.addEventListener("click", click);
    return () => {
      window.removeEventListener("hashchange", sync);
      document.removeEventListener("click", click);
    };
  }, [platformCommands.isPending, boardsController.isPending]);
  useEffect(() => {
    if (isNavigationPending() || recordId === selectedRecordId) return;
    setRecordId(selectedRecordId);
  }, [
    recordId,
    selectedRecordId,
    platformCommands.isPending,
    boardsController.isPending,
  ]);
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
            ? `${result.value} sample notifications marked as read.`
            : "All sample notifications are already read."
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
        result.ok
          ? "Sample record update added to notifications."
          : result.error,
      );
    } catch (error) {
      setNotice(
        commandError(error, "The sample update could not be simulated."),
      );
    }
  }
  async function updateNotificationPreference(
    patch: Parameters<typeof platformCommands.updateNotificationPreferences>[0],
  ) {
    try {
      const result =
        await platformCommands.updateNotificationPreferences(patch);
      if (!result.ok) setNotice(result.error);
    } catch (error) {
      setNotice(
        commandError(error, "Notification preferences could not be saved."),
      );
    }
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
        setNotice("Sample record assignment updated.");
        return;
      }
      setAssigneeErrors((current) => ({
        ...current,
        [recordId]: result.error,
      }));
      setNotice(result.error);
    } catch (error) {
      const message = commandError(
        error,
        "The sample record could not be updated.",
      );
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
  async function placeRecordOnBoard() {
    if (!selectedRecord) return;
    const now = new Date().toISOString();
    const result = await boardsController.run({
      type: "place-record",
      placement: {
        id: `board-placement-${crypto.randomUUID()}`,
        boardId: DEFAULT_BOARD_ID,
        recordId: selectedRecord.id,
        moduleId: "service-requests",
        pinned: false,
        position: boardRecords.length,
        createdAt: now,
        updatedAt: now,
      },
    });
    setNotice(
      result.ok
        ? "Sample record added to the organization board."
        : result.error,
    );
  }
  async function startRecordDiscussion() {
    if (!selectedRecord) return;
    try {
      const result = await platformCommands.startRecordDiscussion(
        selectedRecord.id,
      );
      setNotice(
        result.ok
          ? "Sample record discussion ready in OpenComms."
          : result.error,
      );
    } catch (error) {
      setNotice(
        commandError(error, "The sample discussion could not be started."),
      );
    }
  }
  async function toggleRecordFollow() {
    if (!selectedRecord) return;
    try {
      const result = await platformCommands.toggleFollow(selectedRecord.id);
      setNotice(
        result.ok
          ? result.value
            ? "Following this sample record."
            : "Sample record follow removed."
          : result.error,
      );
    } catch (error) {
      setNotice(
        commandError(error, "The sample record follow could not be updated."),
      );
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
          Loading workspace tools…
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
              ? "Refreshing workspace tools…"
              : `Showing the last saved workspace tools. ${platformResource.error}`}
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
        description="Sample search, notifications and workspace tools."
      />
      <nav
        aria-label="Platform sections"
        className="flex flex-wrap gap-2 border-b pb-4"
      >
        {TABS.map((item) => (
          <Action
            key={item}
            variant={tab === item ? "default" : "ghost"}
            disabled={navigationPending}
            onClick={() => {
              if (isNavigationPending()) return;
              setTab(item);
              setNotice("");
            }}
          >
            {item}
          </Action>
        ))}
      </nav>
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
        <section className="space-y-6">
          <div className="max-w-2xl">
            <SearchField
              label="Search sample workspace"
              value={query}
              onValueChange={setQuery}
              placeholder="Search people, records, conversations and files…"
            />
          </div>
          <div className="grid items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
            {searchGroups.map((group) => (
              <Panel
                key={group.type}
                title={`${group.type}${
                  group.complete.items.length > group.page.items.length
                    ? ` · showing ${group.page.items.length} of ${group.complete.items.length}`
                    : ""
                }`}
              >
                {!group.complete.items.length && (
                  <p className="text-muted-foreground text-sm">
                    No matching {group.type.toLowerCase()}.
                  </p>
                )}
                <ul className="divide-y">
                  {group.page.items.map((item) => (
                    <li key={item.id}>
                      {group.type === "Files" ? (
                        <button
                          className="flex min-h-11 w-full items-center justify-between gap-3 py-3 text-left text-sm hover:underline"
                          disabled={navigationPending}
                          onClick={(event) => {
                            if (isNavigationPending()) {
                              event.preventDefault();
                              return;
                            }
                            setTab("File library");
                            setFileId(item.id);
                          }}
                        >
                          {item.title}
                          <Files className="size-4 shrink-0" />
                        </button>
                      ) : (
                        <Link
                          href={item.href as Route}
                          className="flex min-h-11 items-center justify-between gap-3 py-3 text-sm hover:underline"
                        >
                          <span className="line-clamp-2">{item.title}</span>
                          <ArrowUpRight className="size-4 shrink-0" />
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </Panel>
            ))}
          </div>
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Search className="size-4" />
            Results are drawn only from synthetic sample content.
          </p>
        </section>
      ) : tab === "Notifications" ? (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Panel title="Notification center">
            <div className="flex flex-wrap gap-2">
              <Action
                onClick={() => void markAllNotificationsRead()}
                disabled={
                  !notifications.some((item) => !item.read) ||
                  platformCommands.isPending("platform:notifications:read-all")
                }
              >
                Mark all as read
              </Action>
              <Action
                aria-describedby={
                  selectedRecord ? undefined : "record-update-unavailable"
                }
                onClick={() => void simulateRecordUpdate()}
                disabled={!selectedRecord || pendingSimulation}
              >
                {pendingSimulation
                  ? "Simulating update…"
                  : "Simulate record update"}
              </Action>
            </div>
            {!selectedRecord && (
              <p
                id="record-update-unavailable"
                className="text-muted-foreground text-sm"
              >
                Record update simulation is unavailable because this sample
                workspace has no records.
              </p>
            )}
            {!notifications.length && (
              <div className="py-12 text-center">
                <Bell className="text-muted-foreground mx-auto mb-3 size-7" />
                <p className="text-sm font-medium">You’re all caught up</p>
                <p className="text-muted-foreground mt-2 text-xs">
                  Simulate an update or a thread reply to try notifications.
                </p>
              </div>
            )}
            {notifications.map((item) => (
              <article
                key={item.id}
                className={`space-y-3 rounded-lg border p-4 ${item.read ? "" : "bg-muted/40"}`}
              >
                <p className="text-sm font-medium">{item.title}</p>
                <div className="flex flex-wrap items-center gap-3">
                  <Action
                    onClick={() =>
                      void platformCommands
                        .toggleNotification(item.id)
                        .then((result) => {
                          if (!result.ok) setNotice(result.error);
                        })
                        .catch((error: unknown) =>
                          setNotice(
                            commandError(
                              error,
                              "This notification could not be updated.",
                            ),
                          ),
                        )
                    }
                    disabled={platformCommands.isPending(
                      `platform:notification:${item.id}`,
                    )}
                  >
                    Mark {item.read ? "unread" : "read"}
                  </Action>
                  {item.recordId ? (
                    <Link
                      className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                      href={`/openview?record=${encodeURIComponent(item.recordId)}`}
                    >
                      Open linked record
                    </Link>
                  ) : (
                    <Link
                      className="inline-flex min-h-11 items-center text-sm underline"
                      href={
                        item.channelId
                          ? `/comms?conversation=${encodeURIComponent(item.channelId)}${item.messageId ? `&message=${encodeURIComponent(item.messageId)}` : ""}`
                          : "/comms"
                      }
                    >
                      Open conversation
                    </Link>
                  )}
                </div>
              </article>
            ))}
          </Panel>
          <Panel title="Personal preferences">
            <Toggle
              control="switch"
              label="Thread reply notifications"
              checked={preferences.threads}
              disabled={platformCommands.isPending(
                "platform:notification-preferences",
              )}
              onCheckedChange={(checked) =>
                void updateNotificationPreference({ threads: checked })
              }
            />
            <Toggle
              control="switch"
              label="Record update notifications"
              checked={preferences.records}
              disabled={platformCommands.isPending(
                "platform:notification-preferences",
              )}
              onCheckedChange={(checked) =>
                void updateNotificationPreference({ records: checked })
              }
            />
            <Toggle
              control="switch"
              label="Daily digest"
              checked={preferences.digest}
              disabled={platformCommands.isPending(
                "platform:notification-preferences",
              )}
              onCheckedChange={(checked) =>
                void updateNotificationPreference({ digest: checked })
              }
            />
            <p className="text-muted-foreground text-xs">
              Sample preferences saved in this tab. No emails or background jobs
              are sent.
            </p>
          </Panel>
        </div>
      ) : tab === "File library" ? (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Panel title="Central file library">
            <SearchField
              label="Search files by name"
              value={fileQuery}
              onValueChange={setFileQuery}
              placeholder="Find a sample file…"
            />
            {files
              .filter((item) =>
                item.name.toLowerCase().includes(fileQuery.toLowerCase()),
              )
              .map((item) => (
                <button
                  key={item.id}
                  className="hover:bg-muted flex min-h-16 w-full items-center gap-3 rounded-lg border p-4 text-left"
                  disabled={navigationPending}
                  onClick={(event) => {
                    if (isNavigationPending()) {
                      event.preventDefault();
                      return;
                    }
                    setFileId(item.id);
                  }}
                >
                  <Files className="size-5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm">
                      {item.name}
                    </strong>
                    <span className="text-muted-foreground text-xs">
                      {item.type} · {item.size} · Bundled example
                    </span>
                  </span>
                  <ArrowUpRight className="size-4" />
                </button>
              ))}
            {!files.some((item) =>
              item.name.toLowerCase().includes(fileQuery.toLowerCase()),
            ) && (
              <p className="text-muted-foreground text-sm">
                No files match your search.
              </p>
            )}
          </Panel>
          <Panel title="File details">
            {file ? (
              <>
                <p className="font-medium break-words">{file.name}</p>
                <p className="text-muted-foreground text-sm">
                  Example attachment metadata. No real file was uploaded.
                </p>
                <h3 className="text-sm font-medium">Attached to</h3>
                <Link
                  className="block min-h-11 rounded-lg border p-3 text-sm underline"
                  href={`/openview?record=${encodeURIComponent(file.recordId)}`}
                >
                  {records.find((record) => record.id === file.recordId)
                    ?.title ?? "Sample service job"}
                </Link>
                <Action
                  disabled={navigationPending}
                  onClick={() => {
                    if (isNavigationPending()) return;
                    setFileId("");
                  }}
                >
                  Close details
                </Action>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                Select a file to see its record reference.
              </p>
            )}
          </Panel>
        </div>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-2">
          <Panel title="Connected record actions">
            {selectedRecord ? (
              <>
                <Choice
                  label="Select sample record"
                  value={selectedRecord.id}
                  disabled={navigationPending}
                  onChange={(event) => {
                    if (isNavigationPending()) return;
                    setRecordId(event.target.value);
                  }}
                >
                  {records.map((record) => (
                    <option key={record.id} value={record.id}>
                      {record.title}
                    </option>
                  ))}
                </Choice>
                <div className="bg-muted/40 rounded-lg p-5">
                  <p className="text-muted-foreground text-xs tracking-widest uppercase">
                    Service job
                  </p>
                  <h3 className="mt-2 text-xl font-semibold">
                    {selectedRecord.title}
                  </h3>
                  <p className="mt-2 text-sm">
                    {selectedRecord.customer} · {selectedRecord.status}
                  </p>
                </div>
                <Choice
                  label="Assign record to"
                  value={assignmentValue}
                  disabled={navigationPending || pendingAssignment}
                  onChange={(event) => {
                    if (isNavigationPending()) return;
                    void assignRecord(selectedRecord.id, event.target.value);
                  }}
                >
                  {Array.from(
                    new Set([
                      "Unassigned",
                      ...people
                        .filter((person) => person.active)
                        .map((person) => person.name),
                      selectedRecord.assignee,
                      assignmentValue,
                    ]),
                  ).map((person) => (
                    <option key={person}>{person}</option>
                  ))}
                </Choice>
                {assignmentError && (
                  <div
                    role="alert"
                    className="border-destructive/50 bg-destructive/10 space-y-2 rounded-lg border p-3 text-sm"
                  >
                    <p>{assignmentError}</p>
                    <Action
                      size="sm"
                      variant="outline"
                      disabled={navigationPending || pendingAssignment}
                      onClick={retryRecordAssignment}
                    >
                      Retry assignment
                    </Action>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Action
                    onClick={() => void placeRecordOnBoard()}
                    disabled={
                      !canPlaceOnBoard ||
                      boardRecords.includes(selectedRecord.id) ||
                      boardPending
                    }
                  >
                    {boardPending
                      ? "Adding to Board…"
                      : !canPlaceOnBoard
                        ? "Organization board unavailable"
                        : boardRecords.includes(selectedRecord.id)
                          ? "Added to Board"
                          : "Add record to Board"}
                  </Action>
                  <Action
                    onClick={() => void startRecordDiscussion()}
                    disabled={platformCommands.isPending(
                      `platform:record-discussion:${selectedRecord.id}`,
                    )}
                  >
                    {platformCommands.isPending(
                      `platform:record-discussion:${selectedRecord.id}`,
                    )
                      ? "Starting discussion…"
                      : hasRecordDiscussion
                        ? "Record discussion ready"
                        : "Start chat about record"}
                  </Action>
                  <Action
                    onClick={() => void toggleRecordFollow()}
                    disabled={platformCommands.isPending(
                      `platform:follow:${selectedRecord.id}`,
                    )}
                  >
                    {platformCommands.isPending(
                      `platform:follow:${selectedRecord.id}`,
                    )
                      ? "Updating follow…"
                      : followed.includes(selectedRecord.id)
                        ? "Unfollow record"
                        : "Follow record"}
                  </Action>
                </div>
                <p className="text-muted-foreground text-sm">
                  {followed.includes(selectedRecord.id)
                    ? "Following this sample record for future updates."
                    : "Follow this record to keep its changes in your sample notification center."}
                </p>
              </>
            ) : (
              <Empty className="min-h-64 border-dashed">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Files />
                  </EmptyMedia>
                  <EmptyTitle>No sample records yet</EmptyTitle>
                  <EmptyDescription>
                    Add a sample record through Platform import and export to
                    use connected record actions.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </Panel>
          <Panel title="Continue your workflow">
            <Link
              className="flex min-h-14 items-center justify-between rounded-lg border p-4 text-sm"
              href="/boards"
            >
              Open organization Board
              <ArrowUpRight className="size-4" />
            </Link>
            <Link
              className="flex min-h-14 items-center justify-between rounded-lg border p-4 text-sm"
              href="/comms"
            >
              Open record discussion
              <ArrowUpRight className="size-4" />
            </Link>
            {selectedRecord ? (
              <Link
                className="flex min-h-14 items-center justify-between rounded-lg border p-4 text-sm"
                href={`/openview?record=${encodeURIComponent(selectedRecord.id)}`}
              >
                View record in OpenView
                <ArrowUpRight className="size-4" />
              </Link>
            ) : (
              <p className="text-muted-foreground text-sm">
                Add a sample record to continue to its OpenView page.
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              Assignment and links are shared across sample pillars. Live work
              is unaffected.
            </p>
          </Panel>
        </div>
      )}
    </div>
  );
}
