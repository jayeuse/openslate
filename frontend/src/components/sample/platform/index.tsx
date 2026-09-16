"use client";
import { useBoardsController } from "../boards/controller";
import { DEFAULT_BOARD_ID } from "../boards/model";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Bell, Search, Files, ArrowUpRight } from "lucide-react";
import { initialPeople, type Person } from "@/components/sample/access/model";
import { initialDesign, type Design } from "@/components/sample/sandbox/model";
import { useSampleState } from "@/components/sample/sample-state";
import { SearchField } from "@/components/ui/search-field";
import { PageHeader } from "@/components/page-header";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "@/components/sample/sample-data";
import { Action, Choice, Panel, Toggle } from "../comms/ui";
import {
  MESSAGES,
  type Message,
  type RecordThread,
  type SampleNotification,
} from "../comms/model";
import ImportExport from "./import-export";
import Account from "./account";
import { useCommsConfiguration } from "../comms/configuration-state";
import { previewCommsNotification } from "../comms/notification-policy";

const FILES = [
  {
    id: "sample-file-checklist",
    name: "Inspection checklist.pdf",
    recordId: "sample-sr-1004",
    type: "PDF",
    size: "142 KB",
  },
  {
    id: "sample-file-workshop",
    name: "Workshop photo.jpg",
    recordId: "sample-sr-1005",
    type: "Image",
    size: "840 KB",
  },
  {
    id: "sample-file-report",
    name: "Service report.xlsx",
    recordId: "sample-sr-1006",
    type: "Spreadsheet",
    size: "28 KB",
  },
];
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
  useEffect(() => {
    const sync = () => setTab(initialTab());
    const click = (event: MouseEvent) => {
      const anchor =
        event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor) return;
      const url = new URL(anchor.href, window.location.href);
      if (
        url.origin === window.location.origin &&
        url.pathname === window.location.pathname &&
        ["#account", "#notifications"].includes(url.hash)
      )
        setTab(
          url.hash === "#account" ? "Account & presence" : "Notifications",
        );
    };
    window.addEventListener("hashchange", sync);
    document.addEventListener("click", click);
    return () => {
      window.removeEventListener("hashchange", sync);
      document.removeEventListener("click", click);
    };
  }, []);
  const [people] = useSampleState<Person[]>("access-people", initialPeople);
  const [design] = useSampleState<{
    past: Design[];
    present: Design;
    future: Design[];
  }>("sandbox.design", { past: [], present: initialDesign, future: [] });
  const [query, setQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [fileId, setFileId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).get("file") || "",
  );
  const [records, setRecords] = useSampleState<SampleRecord[]>(
    "records",
    INITIAL_RECORDS,
  );
  const [messages] = useSampleState<Message[]>("commsMessages", MESSAGES);
  const [commsConfig] = useCommsConfiguration();
  const [notifications, setNotifications] = useSampleState<
    SampleNotification[]
  >("platformNotifications", []);
  const [preferences, setPreferences] = useSampleState(
    "platformNotificationPreferences",
    { threads: true, records: true, digest: false },
  );
  const [followed, setFollowed] = useSampleState<string[]>(
    "platformFollowedRecords",
    [],
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
  const [recordThreads, setRecordThreads] = useSampleState<RecordThread[]>(
    "commsRecordThreads",
    [],
  );
  const [recordId, setRecordId] = useState(INITIAL_RECORDS[0].id);
  const [notice, setNotice] = useState("");
  const selectedRecord =
    records.find((record) => record.id === recordId) ?? records[0];
  const file = FILES.find((item) => item.id === fileId);
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
      items: design.present.departments.map((item) => ({
        id: item.id,
        title: item.name,
        href: `/sandbox?department=${encodeURIComponent(item.id)}`,
      })),
    },
    {
      type: "Modules",
      items: design.present.modules.map((item) => ({
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
      items: FILES.map((item) => ({
        id: item.id,
        title: item.name,
        href: `/platform?file=${encodeURIComponent(item.id)}`,
      })),
    },
  ].map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      item.title.toLowerCase().includes(query.toLowerCase()),
    ),
  }));
  return (
    <div className="space-y-6">
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
            onClick={() => {
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
        <ImportExport />
      ) : tab === "Account & presence" ? (
        <Account />
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
              <Panel key={group.type} title={group.type}>
                {!group.items.length && (
                  <p className="text-muted-foreground text-sm">
                    No matching {group.type.toLowerCase()}.
                  </p>
                )}
                <ul className="divide-y">
                  {group.items.slice(0, 8).map((item) => (
                    <li key={item.id}>
                      {group.type === "Files" ? (
                        <button
                          className="flex min-h-11 w-full items-center justify-between gap-3 py-3 text-left text-sm hover:underline"
                          onClick={() => {
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
                onClick={() =>
                  setNotifications((items) =>
                    items.map((item) => ({ ...item, read: true })),
                  )
                }
                disabled={!notifications.some((item) => !item.read)}
              >
                Mark all as read
              </Action>
              <Action
                onClick={() => {
                  if (!preferences.records) {
                    setNotice(
                      "Record notifications are off. Enable them to receive this sample update.",
                    );
                    return;
                  }
                  const preview = previewCommsNotification({
                    config: commsConfig,
                    platformPreferences: preferences,
                    person: people.find((person) => person.id === "sample-eli"),
                    event: {
                      kind: "record",
                      text: `${selectedRecord.title} was updated`,
                    },
                  });
                  if (!preview.allowed) {
                    setNotice(preview.reason);
                    return;
                  }
                  setNotifications((items) => [
                    {
                      id: `sample-notification-${crypto.randomUUID()}`,
                      title: preview.title,
                      recordId: selectedRecord.id,
                      read: false,
                    },
                    ...items,
                  ]);
                }}
              >
                Simulate record update
              </Action>
            </div>
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
                      setNotifications((items) =>
                        items.map((value) =>
                          value.id === item.id
                            ? { ...value, read: !value.read }
                            : value,
                        ),
                      )
                    }
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
              onCheckedChange={(checked) =>
                setPreferences((value) => ({
                  ...value,
                  threads: checked,
                }))
              }
            />
            <Toggle
              control="switch"
              label="Record update notifications"
              checked={preferences.records}
              onCheckedChange={(checked) =>
                setPreferences((value) => ({
                  ...value,
                  records: checked,
                }))
              }
            />
            <Toggle
              control="switch"
              label="Daily digest"
              checked={preferences.digest}
              onCheckedChange={(checked) =>
                setPreferences((value) => ({
                  ...value,
                  digest: checked,
                }))
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
            {FILES.filter((item) =>
              item.name.toLowerCase().includes(fileQuery.toLowerCase()),
            ).map((item) => (
              <button
                key={item.id}
                className="hover:bg-muted flex min-h-16 w-full items-center gap-3 rounded-lg border p-4 text-left"
                onClick={() => setFileId(item.id)}
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
            {!FILES.some((item) =>
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
                <Action onClick={() => setFileId("")}>Close details</Action>
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
            <Choice
              label="Select sample record"
              value={selectedRecord.id}
              onChange={(event) => setRecordId(event.target.value)}
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
              value={selectedRecord.assignee}
              onChange={(event) => {
                setRecords((items) =>
                  items.map((item) =>
                    item.id === selectedRecord.id
                      ? { ...item, assignee: event.target.value }
                      : item,
                  ),
                );
                setNotice("Sample record assignment updated.");
              }}
            >
              {Array.from(
                new Set([
                  "Unassigned",
                  ...people
                    .filter((person) => person.active)
                    .map((person) => person.name),
                  selectedRecord.assignee,
                ]),
              ).map((person) => (
                <option key={person}>{person}</option>
              ))}
            </Choice>
            <div className="flex flex-wrap gap-2">
              <Action
                onClick={() => {
                  const now = new Date().toISOString();
                  const result = boardsController.run({
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
                }}
                disabled={
                  !canPlaceOnBoard || boardRecords.includes(selectedRecord.id)
                }
              >
                {!canPlaceOnBoard
                  ? "Organization board unavailable"
                  : boardRecords.includes(selectedRecord.id)
                    ? "Added to Board"
                    : "Add record to Board"}
              </Action>
              <Action
                onClick={() => {
                  if (
                    !recordThreads.some(
                      (item) => item.recordId === selectedRecord.id,
                    )
                  )
                    setRecordThreads((items) => [
                      ...items,
                      {
                        id: `sample-record-thread-${crypto.randomUUID()}`,
                        recordId: selectedRecord.id,
                        text: `Discuss ${selectedRecord.title}`,
                      },
                    ]);
                  setNotice("Sample record discussion ready in OpenComms.");
                }}
              >
                Start chat about record
              </Action>
              <Action
                onClick={() =>
                  setFollowed((items) =>
                    items.includes(selectedRecord.id)
                      ? items.filter((id) => id !== selectedRecord.id)
                      : [...items, selectedRecord.id],
                  )
                }
              >
                {followed.includes(selectedRecord.id)
                  ? "Unfollow record"
                  : "Follow record"}
              </Action>
            </div>
            <p className="text-muted-foreground text-sm">
              {followed.includes(selectedRecord.id)
                ? "Following this sample record for future updates."
                : "Follow this record to keep its changes in your sample notification center."}
            </p>
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
            <Link
              className="flex min-h-14 items-center justify-between rounded-lg border p-4 text-sm"
              href={`/openview?record=${encodeURIComponent(selectedRecord.id)}`}
            >
              View record in OpenView
              <ArrowUpRight className="size-4" />
            </Link>
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
