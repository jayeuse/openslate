"use client";

import { useCallback } from "react";
import { initialPeople, type Person } from "../../access/domain/model";
import { useSampleCommands } from "../../shared/runtime/sample-async";
import {
  useSampleRuntime,
  type SampleTransactionDraft,
} from "../../shared/runtime/sample-state";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "../../shared/data/sample-data";
import {
  MESSAGES,
  type Message,
  type RecordThread,
  type SampleNotification,
} from "../../comms/domain/model";
import {
  normalizeCommsConfiguration,
  type CommsConfiguration,
} from "../../comms/domain/configuration";
import { stageRecordDiscussion } from "../../comms/state/runtime";
import { previewCommsNotification } from "../../comms/domain/notification-policy";
import { normalizeSandboxHistory } from "../../sandbox/state/controller";
import { initialRuntimeSandboxHistory } from "../../sandbox/state/async";
import { initialDesign, type Design } from "../../sandbox/domain/model";
import {
  completeCollection,
  pageCollection,
  type CompleteCollection,
  type PageResult,
} from "../../shared/helpers/sample-collections";

export type PlatformNotificationPreferences = {
  threads: boolean;
  records: boolean;
  digest: boolean;
};

export const INITIAL_PLATFORM_PREFERENCES: PlatformNotificationPreferences = {
  threads: true,
  records: true,
  digest: false,
};

export type PlatformAccount = {
  language: string;
  theme: string;
  presence: string;
  passwordChanged: boolean;
  signedOut: boolean;
};

export const INITIAL_PLATFORM_ACCOUNT: PlatformAccount = {
  language: "English",
  theme: "Light",
  presence: "Available",
  passwordChanged: false,
  signedOut: false,
};

export type PlatformSession = {
  id: string;
  device: string;
  current: boolean;
};

export const INITIAL_PLATFORM_SESSIONS: PlatformSession[] = [
  { id: "sample-current", device: "This browser", current: true },
  { id: "sample-tablet", device: "Workshop tablet", current: false },
];

export const PLATFORM_FILES = [
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
] as const;

export type PlatformFile = (typeof PLATFORM_FILES)[number];

export const PLATFORM_OWNER_KEYS = [
  "access-people",
  "sandbox.design",
  "records",
  "commsMessages",
  "comms-configuration",
  "platformNotifications",
  "platformNotificationPreferences",
  "platformFollowedRecords",
  "commsRecordThreads",
  "platformAccount",
  "platformSessions",
] as const;

export type PlatformReader = <T>(key: string, initial: T) => T;

export type PlatformSnapshot = {
  people: Person[];
  design: Design;
  records: SampleRecord[];
  messages: Message[];
  commsConfiguration: CommsConfiguration;
  notifications: SampleNotification[];
  preferences: PlatformNotificationPreferences;
  followed: string[];
  recordThreads: RecordThread[];
  account: PlatformAccount;
  sessions: PlatformSession[];
  files: readonly PlatformFile[];
};

export function readPlatformSnapshot(read: PlatformReader): PlatformSnapshot {
  const design = normalizeSandboxHistory(
    read<unknown>("sandbox.design", initialRuntimeSandboxHistory),
    initialDesign,
  ).present;
  return {
    people: structuredClone(read("access-people", initialPeople)),
    design: structuredClone(design),
    records: structuredClone(read("records", INITIAL_RECORDS)),
    messages: structuredClone(read("commsMessages", MESSAGES)),
    commsConfiguration: normalizeCommsConfiguration(
      read<unknown>("comms-configuration", null),
    ),
    notifications: structuredClone(read("platformNotifications", [])),
    preferences: structuredClone(
      read("platformNotificationPreferences", INITIAL_PLATFORM_PREFERENCES),
    ),
    followed: structuredClone(read("platformFollowedRecords", [])),
    recordThreads: structuredClone(read("commsRecordThreads", [])),
    account: structuredClone(read("platformAccount", INITIAL_PLATFORM_ACCOUNT)),
    sessions: structuredClone(
      read("platformSessions", INITIAL_PLATFORM_SESSIONS),
    ),
    files: PLATFORM_FILES,
  };
}

export type PlatformCommandFailure = { ok: false; error: string };
export type PlatformCommandSuccess<T> = { ok: true; value: T };
export type PlatformCommandResult<T> =
  PlatformCommandSuccess<T> | PlatformCommandFailure;

export type PlatformImportRow = {
  title: string;
  customer: string;
  assignee: string;
  dueDate: string;
};

function reject(draft: SampleTransactionDraft, error: string): never {
  return draft.reject<PlatformCommandFailure>({ ok: false, error });
}

function accepted<T>(value: T): PlatformCommandSuccess<T> {
  return { ok: true, value };
}

export function normalizePlatformImportRows(
  rows: readonly PlatformImportRow[],
) {
  return rows
    .map((row) => ({
      title: row.title.trim(),
      customer: row.customer.trim(),
      assignee: row.assignee.trim() || "Unassigned",
      dueDate: row.dueDate.trim(),
    }))
    .filter((row) => row.title.length > 0);
}

export function pagePlatformSearch<T extends { title: string }>(
  items: readonly T[],
  query: string,
  queryKey: string,
  limit = 8,
): { complete: CompleteCollection<T>; page: PageResult<T> } {
  const normalized = query.trim().toLowerCase();
  const complete = completeCollection(
    items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.title.toLowerCase().includes(normalized))
      .sort(
        (left, right) =>
          left.item.title.localeCompare(right.item.title) ||
          left.index - right.index,
      )
      .map(({ item }) => item),
    queryKey,
  );
  return { complete, page: pageCollection(complete, 0, limit) };
}

export function completePlatformExport(
  records: readonly SampleRecord[],
): CompleteCollection<SampleRecord> {
  return completeCollection(records, "platform:records:export");
}

/**
 * Platform's feature-owned command boundary. Every command executes against
 * the latest sample snapshot and publishes accepted owner changes atomically.
 */
export function usePlatformCommands() {
  const runtime = useSampleRuntime();
  const commands = useSampleCommands();
  const run = useCallback(
    <T>(
      key: string,
      recipe: (draft: SampleTransactionDraft) => T,
      keys: readonly string[],
    ): Promise<T> =>
      commands.run(key, (signal) => runtime.execute(recipe, { keys, signal })),
    [commands, runtime],
  );
  const loadRecordsForExport = useCallback(
    () =>
      commands.run("platform:export", (signal) =>
        runtime.load(
          (draft) =>
            completePlatformExport(draft.read("records", INITIAL_RECORDS)),
          { keys: ["records"], signal },
        ),
      ),
    [commands, runtime],
  );
  const updateRecordAssignee = useCallback(
    (recordId: string, assignee: string) =>
      run<PlatformCommandResult<SampleRecord>>(
        `platform:record:assign:${recordId}`,
        (draft) => {
          const records = draft.read<SampleRecord[]>(
            "records",
            INITIAL_RECORDS,
          );
          const current = records.find((record) => record.id === recordId);
          if (!current)
            return reject(draft, "This record is no longer available.");
          if (!assignee.trim())
            return reject(draft, "Choose an assignee before saving.");
          const next = { ...current, assignee: assignee.trim() };
          draft.update<SampleRecord[]>("records", INITIAL_RECORDS, (items) =>
            items.map((item) => (item.id === recordId ? next : item)),
          );
          return accepted(next);
        },
        ["records"],
      ),
    [run],
  );
  const markAllNotificationsRead = useCallback(
    () =>
      run<PlatformCommandResult<number>>(
        "platform:notifications:read-all",
        (draft) => {
          const current = draft.read<SampleNotification[]>(
            "platformNotifications",
            [],
          );
          const unread = current.filter((item) => !item.read).length;
          draft.update<SampleNotification[]>(
            "platformNotifications",
            [],
            (items) => items.map((item) => ({ ...item, read: true })),
          );
          return accepted(unread);
        },
        ["platformNotifications"],
      ),
    [run],
  );
  const toggleNotification = useCallback(
    (notificationId: string) =>
      run<PlatformCommandResult<boolean>>(
        `platform:notification:${notificationId}`,
        (draft) => {
          const current = draft.read<SampleNotification[]>(
            "platformNotifications",
            [],
          );
          const notification = current.find(
            (item) => item.id === notificationId,
          );
          if (!notification)
            return reject(draft, "This notification is no longer available.");
          const read = !notification.read;
          draft.update<SampleNotification[]>(
            "platformNotifications",
            [],
            (items) =>
              items.map((item) =>
                item.id === notificationId ? { ...item, read } : item,
              ),
          );
          return accepted(read);
        },
        ["platformNotifications"],
      ),
    [run],
  );
  const simulateRecordUpdate = useCallback(
    (recordId: string) =>
      run<PlatformCommandResult<SampleNotification>>(
        `platform:notification:simulate:${recordId}`,
        (draft) => {
          const records = draft.read<SampleRecord[]>(
            "records",
            INITIAL_RECORDS,
          );
          const record = records.find((item) => item.id === recordId);
          if (!record)
            return reject(draft, "This record is no longer available.");
          const preferences = draft.read<PlatformNotificationPreferences>(
            "platformNotificationPreferences",
            INITIAL_PLATFORM_PREFERENCES,
          );
          if (!preferences.records)
            return reject(
              draft,
              "Record notifications are off. Enable them to see this update.",
            );
          const people = draft.read<Person[]>("access-people", initialPeople);
          const preview = previewCommsNotification({
            config: normalizeCommsConfiguration(
              draft.read<unknown>("comms-configuration", null),
            ),
            platformPreferences: preferences,
            person: people.find((person) => person.id === "sample-eli"),
            event: { kind: "record", text: `${record.title} was updated` },
          });
          if (!preview.allowed) return reject(draft, preview.reason);
          const notification = {
            id: `sample-notification-${crypto.randomUUID()}`,
            title: preview.title,
            recordId: record.id,
            read: false,
          } satisfies SampleNotification;
          draft.update<SampleNotification[]>(
            "platformNotifications",
            [],
            (items) => [notification, ...items],
          );
          return accepted(notification);
        },
        [
          "records",
          "platformNotificationPreferences",
          "access-people",
          "comms-configuration",
          "platformNotifications",
        ],
      ),
    [run],
  );
  const updateNotificationPreferences = useCallback(
    (patch: Partial<PlatformNotificationPreferences>) =>
      run<PlatformCommandResult<PlatformNotificationPreferences>>(
        "platform:notification-preferences",
        (draft) => {
          const current = draft.read<PlatformNotificationPreferences>(
            "platformNotificationPreferences",
            INITIAL_PLATFORM_PREFERENCES,
          );
          const next = { ...current, ...patch };
          draft.update(
            "platformNotificationPreferences",
            INITIAL_PLATFORM_PREFERENCES,
            next,
          );
          return accepted(next);
        },
        ["platformNotificationPreferences"],
      ),
    [run],
  );
  const toggleFollow = useCallback(
    (recordId: string) =>
      run<PlatformCommandResult<boolean>>(
        `platform:follow:${recordId}`,
        (draft) => {
          const records = draft.read<SampleRecord[]>(
            "records",
            INITIAL_RECORDS,
          );
          if (!records.some((record) => record.id === recordId))
            return reject(draft, "This record is no longer available.");
          const current = draft.read<string[]>("platformFollowedRecords", []);
          const following = !current.includes(recordId);
          draft.update<string[]>("platformFollowedRecords", [], (items) =>
            following
              ? [...items, recordId]
              : items.filter((item) => item !== recordId),
          );
          return accepted(following);
        },
        ["records", "platformFollowedRecords"],
      ),
    [run],
  );
  const startRecordDiscussion = useCallback(
    (recordId: string) =>
      run<PlatformCommandResult<RecordThread>>(
        `platform:record-discussion:${recordId}`,
        (draft) => {
          const record = draft
            .read<SampleRecord[]>("records", INITIAL_RECORDS)
            .find((item) => item.id === recordId);
          if (!record)
            return reject(draft, "This record is no longer available.");
          return accepted(stageRecordDiscussion(draft, record));
        },
        ["records", "commsRecordThreads"],
      ),
    [run],
  );
  const importRecords = useCallback(
    (rows: readonly PlatformImportRow[]) =>
      run<PlatformCommandResult<SampleRecord[]>>(
        "platform:records:import",
        (draft) => {
          const normalized = normalizePlatformImportRows(rows);
          if (!normalized.length)
            return reject(draft, "Choose at least one valid row to import.");
          const imported = normalized.map((row) => ({
            id: `sample-import-${crypto.randomUUID()}`,
            title: row.title,
            customer: row.customer,
            status: "Open",
            assignee: row.assignee,
            dueDate: row.dueDate,
          }));
          draft.update<SampleRecord[]>("records", INITIAL_RECORDS, (items) => [
            ...items,
            ...imported,
          ]);
          return accepted(imported);
        },
        ["records"],
      ),
    [run],
  );
  const updateAccount = useCallback(
    (patch: Partial<PlatformAccount>) =>
      run<PlatformCommandResult<PlatformAccount>>(
        "platform:account:update",
        (draft) => {
          const current = draft.read<PlatformAccount>(
            "platformAccount",
            INITIAL_PLATFORM_ACCOUNT,
          );
          const next = { ...current, ...patch };
          draft.update("platformAccount", INITIAL_PLATFORM_ACCOUNT, next);
          return accepted(next);
        },
        ["platformAccount"],
      ),
    [run],
  );
  const endSession = useCallback(
    (sessionId: string) =>
      run<PlatformCommandResult<string>>(
        `platform:session:end:${sessionId}`,
        (draft) => {
          const current = draft.read<PlatformSession[]>(
            "platformSessions",
            INITIAL_PLATFORM_SESSIONS,
          );
          const session = current.find((item) => item.id === sessionId);
          if (!session)
            return reject(draft, "This session is no longer available.");
          if (session.current)
            return reject(draft, "The current session cannot be ended here.");
          draft.update<PlatformSession[]>(
            "platformSessions",
            INITIAL_PLATFORM_SESSIONS,
            (items) => items.filter((item) => item.id !== sessionId),
          );
          return accepted(sessionId);
        },
        ["platformSessions"],
      ),
    [run],
  );
  return {
    run,
    loadRecordsForExport,
    updateRecordAssignee,
    markAllNotificationsRead,
    toggleNotification,
    simulateRecordUpdate,
    updateNotificationPreferences,
    toggleFollow,
    startRecordDiscussion,
    importRecords,
    updateAccount,
    endSession,
    isPending: commands.isPending,
    pendingKeys: commands.pendingKeys,
  };
}
