"use client";

import { useCallback } from "react";
import { initialPeople, type Person } from "../../shared/data/sample-people";
import { useSampleCommands } from "../../shared/runtime/sample-async";
import {
  useSampleRuntime,
  type SampleTransactionDraft,
} from "../../shared/runtime/sample-state";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "../../shared/data/sample-data";
import { type SampleNotification } from "../../comms/domain/model";
import { normalizeCommsConfiguration } from "../../comms/domain/configuration";
import { previewCommsNotification } from "../../comms/domain/notification-policy";
import {
  INITIAL_PLATFORM_ACCOUNT,
  INITIAL_PLATFORM_PREFERENCES,
  type PlatformAccount,
  type PlatformNotificationPreferences,
  type PlatformImportRow,
} from "../domain/model";
import {
  completePlatformExport,
  normalizePlatformImportRows,
} from "../domain/records";

export {
  INITIAL_PLATFORM_ACCOUNT,
  INITIAL_PLATFORM_PREFERENCES,
  PLATFORM_FILES,
} from "../domain/model";
export type {
  PlatformAccount,
  PlatformFile,
  PlatformImportRow,
  PlatformNotificationPreferences,
} from "../domain/model";
export {
  completePlatformExport,
  normalizePlatformImportRows,
  pagePlatformSearch,
} from "../domain/records";
export { PLATFORM_OWNER_KEYS, readPlatformSnapshot } from "./snapshot";
export type { PlatformReader, PlatformSnapshot } from "./snapshot";

export type PlatformCommandFailure = { ok: false; error: string };
export type PlatformCommandSuccess<T> = { ok: true; value: T };
export type PlatformCommandResult<T> =
  PlatformCommandSuccess<T> | PlatformCommandFailure;

function reject(draft: SampleTransactionDraft, error: string): never {
  return draft.reject<PlatformCommandFailure>({ ok: false, error });
}

function accepted<T>(value: T): PlatformCommandSuccess<T> {
  return { ok: true, value };
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
  return {
    run,
    loadRecordsForExport,
    markAllNotificationsRead,
    toggleNotification,
    simulateRecordUpdate,
    updateNotificationPreferences,
    importRecords,
    updateAccount,
    isPending: commands.isPending,
    pendingKeys: commands.pendingKeys,
  };
}
