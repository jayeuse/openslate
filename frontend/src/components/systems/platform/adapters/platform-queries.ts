import {
  queryOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { ApiContractError, ApiError } from "@/lib/api";
import {
  authMeOptions,
  recordPageDenial,
} from "../../openview/adapters/openview-queries";
import { openViewLevel } from "../../openview/domain/manage-access";
import { listAccessDepartments } from "../../access/state/api";
import type { AccessDepartment } from "../../access/state/api-contracts";
import { loadAllAccessPages } from "../../access/state/pagination";

import { listAccountSessions } from "./account-api";
import {
  getNotificationUnreadCount,
  listNotifications,
  type Notification,
} from "../../shared/adapters/notifications-api";
import { getOpenViewReport } from "../../openview/adapters/reports-api";
import {
  listManageBackups,
  defaultManageBackupsRequest,
} from "../../manage/adapters/backup-api";
import { readBoard } from "../../boards/adapters/board-management-api";
import { readBoardEvent } from "../../boards/adapters/board-events-api";
import {
  libraryFileDefaults,
  listLibraryFiles,
  type LibraryFileCriteria,
} from "./library-files-api";

export const platformKeys = {
  all: ["platform"] as const,
  accountSessions: (accountId: string) =>
    ["platform", "account-sessions", accountId] as const,
  libraryDepartments: () => ["platform", "library-departments"] as const,
  libraryFiles: ["platform", "library-files"] as const,
  departmentFiles: (departmentId: string) =>
    ["platform", "library-files", departmentId] as const,
  libraryFileList: (departmentId: string, criteria: LibraryFileCriteria) =>
    [
      "platform",
      "library-files",
      departmentId,
      { ...criteria, search: criteria.search.trim(), limit: 25, offset: 0 },
    ] as const,
};

export const libraryDepartmentsOptions = () =>
  queryOptions({
    queryKey: platformKeys.libraryDepartments(),
    queryFn: ({ signal }) =>
      loadAllAccessPages(
        (page) =>
          listAccessDepartments({
            ...page,
            deleted: "include",
            sort_by: "department_name",
            sort_order: "asc",
          }),
        { signal },
      ),
  });

// A refusal belongs to one department and this account's client. Keeping it
// outside list keys hides every cached filter without resetting upload work.
const refusalKey = (departmentId: string) =>
  ["platform-library-refusal", departmentId] as const;
type ReadState = {
  sequence: number;
  latestSuccess: number;
  deniedAt: number | null;
};
const libraryReads = new WeakMap<QueryClient, Map<string, ReadState>>();

export const libraryRefusalOptions = (departmentId: string) =>
  queryOptions({
    queryKey: refusalKey(departmentId),
    queryFn: async () => false,
    enabled: false,
    initialData: false,
    gcTime: Infinity,
  });

export function isLibraryRefused(
  client: QueryClient,
  departmentId: string,
): boolean {
  return client.getQueryData(refusalKey(departmentId)) === true;
}

export async function trackLibraryRead<Value>(
  client: QueryClient,
  departmentId: string,
  read: () => Promise<Value>,
): Promise<Value> {
  let departments = libraryReads.get(client);
  if (!departments) {
    departments = new Map();
    libraryReads.set(client, departments);
  }
  let state = departments.get(departmentId);
  if (!state) {
    state = { sequence: 0, latestSuccess: 0, deniedAt: null };
    departments.set(departmentId, state);
  }
  const startedAt = ++state.sequence;
  try {
    const result = await read();
    state.latestSuccess = Math.max(state.latestSuccess, startedAt);
    if (state.deniedAt !== null && startedAt > state.deniedAt) {
      state.deniedAt = null;
      client.setQueryData(refusalKey(departmentId), false);
    }
    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      [401, 403, 404].includes(error.status) &&
      state.latestSuccess <= startedAt
    ) {
      state.deniedAt = Math.max(state.deniedAt ?? 0, startedAt);
      const deniedAt = state.deniedAt;
      const refusedState = state;
      client.setQueryData(refusalKey(departmentId), true);
      const queryKey = platformKeys.departmentFiles(departmentId);
      const fetching = client
        .getQueryCache()
        .findAll({ queryKey, fetchStatus: "fetching" });
      void Promise.all(
        fetching.map((query) => query.cancel({ revert: true })),
      ).then(() => {
        if (refusedState.deniedAt === deniedAt)
          recordPageDenial(client, [queryKey], error);
      });
    }
    throw error;
  }
}

export const libraryFilesOptions = (
  departmentId: string,
  criteria: LibraryFileCriteria,
) =>
  queryOptions({
    queryKey: platformKeys.libraryFileList(departmentId, criteria),
    queryFn: ({ signal, client }) =>
      trackLibraryRead(client, departmentId, () =>
        listLibraryFiles(departmentId, {
          ...criteria,
          limit: 25,
          offset: 0,
          signal,
        }),
      ),
  });

export const accountSessionsOptions = (accountId: string) =>
  queryOptions({
    queryKey: platformKeys.accountSessions(accountId),
    queryFn: ({ signal }) => listAccountSessions(signal),
    enabled: Boolean(accountId),
  });

export function prefetchPlatformSection(
  client: QueryClient,
  href: string,
  accountId: string | undefined,
): void {
  const url = new URL(href, "http://platform.invalid");
  if (url.pathname !== "/platform" || !accountId) return;
  if (url.searchParams.get("section") === "notifications") {
    void client.prefetchQuery(notificationPageOptions("all", 25));
    return;
  }
  if (url.searchParams.get("section") === "account") {
    void client.prefetchQuery(accountSessionsOptions(accountId));
    return;
  }
  if (url.searchParams.get("section") !== "files") return;
  void client.prefetchQuery(libraryDepartmentsOptions());
  const identity = client.getQueryData(authMeOptions().queryKey);
  const catalog = client.getQueryData<AccessDepartment[]>(
    platformKeys.libraryDepartments(),
  );
  const requested = url.searchParams.get("department");
  const department = catalog?.find(
    (item) =>
      (requested === null || item.id === requested) &&
      openViewLevel(identity, item.id) !== null,
  );
  if (
    department &&
    client.getQueryState(authMeOptions().queryKey)?.status === "success"
  )
    void client.prefetchQuery(
      libraryFilesOptions(department.id, libraryFileDefaults),
    );
}

export const notificationKeys = {
  all: ["platform", "notifications"] as const,
  count: ["platform", "notifications", "count"] as const,
  pages: ["platform", "notifications", "pages"] as const,
  page: (status: "all" | "unread", limit: number, offset = 0) =>
    ["platform", "notifications", "pages", status, limit, offset] as const,
  titles: ["platform", "notifications", "titles"] as const,
};
const notificationRefusalKey = ["platform-notification-refusal"] as const;
const notificationCommandKey = ["platform-notification-command"] as const;
type NotificationReadState = {
  sequence: number;
  latestSuccess: number;
  deniedAt: number | null;
};
const notificationReads = new WeakMap<QueryClient, NotificationReadState>();
const notificationAccounts = new WeakMap<QueryClient, boolean>();

// The shell commits this boundary synchronously with the privacy curtain.
// Commands may outlive an inbox, but never the verified account's client.
export function setNotificationAccountAvailable(
  client: QueryClient,
  available: boolean,
): void {
  notificationAccounts.set(client, available);
}
export function isNotificationAccountAvailable(client: QueryClient): boolean {
  return notificationAccounts.get(client) === true;
}

export function notificationReadRefused(error: unknown): error is ApiError {
  return error instanceof ApiError && [401, 403].includes(error.status);
}
export const notificationRefusalOptions = () =>
  queryOptions({
    queryKey: notificationRefusalKey,
    queryFn: async () => false,
    enabled: false,
    initialData: false,
    gcTime: Infinity,
  });
export const notificationCommandOptions = () =>
  queryOptions({
    queryKey: notificationCommandKey,
    queryFn: async (): Promise<string | null> => null,
    enabled: false,
    initialData: null,
    gcTime: Infinity,
  });
export function beginNotificationCommand(
  client: QueryClient,
  command: string,
): boolean {
  if (client.getQueryData(notificationCommandKey)) return false;
  client.setQueryData(notificationCommandKey, command);
  return true;
}
export function endNotificationCommand(client: QueryClient): void {
  client.setQueryData(notificationCommandKey, null);
}
export function refuseNotificationReads(
  client: QueryClient,
  error = new ApiError(403, "Request could not be completed"),
): void {
  let state = notificationReads.get(client);
  if (!state) {
    state = { sequence: 0, latestSuccess: 0, deniedAt: null };
    notificationReads.set(client, state);
  }
  const deniedAt = ++state.sequence;
  state.deniedAt = deniedAt;
  const refusedState = state;
  client.setQueryData(notificationRefusalKey, true);
  void client.cancelQueries({ queryKey: notificationKeys.all }).then(() => {
    if (refusedState.deniedAt === deniedAt)
      recordPageDenial(client, [notificationKeys.all], error);
  });
}
async function trackNotificationRead<Value>(
  client: QueryClient,
  read: () => Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  let state = notificationReads.get(client);
  if (!state) {
    state = { sequence: 0, latestSuccess: 0, deniedAt: null };
    notificationReads.set(client, state);
  }
  const startedAt = ++state.sequence;
  try {
    const value = await read();
    if (signal.aborted) throw new DOMException("Read cancelled", "AbortError");
    state.latestSuccess = Math.max(state.latestSuccess, startedAt);
    if (state.deniedAt === null || startedAt > state.deniedAt) {
      state.deniedAt = null;
      client.setQueryData(notificationRefusalKey, false);
    }
    return value;
  } catch (error) {
    if (
      !signal.aborted &&
      notificationReadRefused(error) &&
      state.latestSuccess <= startedAt
    ) {
      state.deniedAt = Math.max(state.deniedAt ?? 0, startedAt);
      refuseNotificationReads(client, error);
    }
    throw error;
  }
}
export const notificationCountOptions = () =>
  queryOptions({
    queryKey: notificationKeys.count,
    queryFn: ({ client, signal }) =>
      trackNotificationRead(
        client,
        () => getNotificationUnreadCount(signal),
        signal,
      ),
  });
export const notificationPageOptions = (
  status: "all" | "unread",
  limit: number,
  offset = 0,
) =>
  queryOptions({
    queryKey: notificationKeys.page(status, limit, offset),
    queryFn: ({ client, signal }) =>
      trackNotificationRead(
        client,
        () =>
          listNotifications(
            { limit, offset, ...(status === "unread" ? { status } : {}) },
            signal,
          ),
        signal,
      ),
    // Opening an observed inbox/popover rechecks current visibility while
    // retaining this account's last good page during transient failures.
    staleTime: 0,
  });
export async function refreshNotificationReads(
  client: QueryClient,
  queryKey: QueryKey = notificationKeys.all,
): Promise<void> {
  const cold = client
    .getQueryCache()
    .findAll({ queryKey, fetchStatus: "fetching" })
    .filter((query) => query.state.data === undefined);
  await Promise.all(cold.map((query) => query.cancel({ revert: true })));
  await client.invalidateQueries({ queryKey });
}
export async function resetNotificationPages(
  client: QueryClient,
): Promise<void> {
  await client.cancelQueries({ queryKey: notificationKeys.pages });
  recordPageDenial(
    client,
    [notificationKeys.pages],
    new ApiError(404, "Notification not found"),
  );
  await client.invalidateQueries({
    queryKey: notificationKeys.pages,
    predicate: (query) => query.queryKey[5] === 0,
  });
  await client.invalidateQueries({ queryKey: notificationKeys.count });
}

export function notificationTitleOptions(item: Notification) {
  const source =
    item.kind === "report-run" || item.kind === "report-run-failed"
      ? ["report", item.reportId]
      : item.kind === "post-publish"
        ? ["board", item.boardId]
        : item.kind === "event-reminder"
          ? ["event", item.boardId, item.eventId]
          : [item.kind, item.subjectId];
  return queryOptions({
    queryKey: [...notificationKeys.titles, ...source],
    queryFn: async ({ client, signal }): Promise<{ title: string }> => {
      try {
        let title: string;
        switch (item.kind) {
          case "report-run":
          case "report-run-failed":
            title = (await getOpenViewReport(item.reportId)).name;
            break;
          case "post-publish":
            title = (await readBoard(item.boardId)).name;
            break;
          case "event-reminder":
            title = (await readBoardEvent(item.boardId, item.eventId)).title;
            break;
          case "backup-failed": {
            const page = await listManageBackups(
              {
                ...defaultManageBackupsRequest,
                limit: 1,
                offset: 0,
                run_id: item.subjectId,
              },
              signal,
            );
            const run = page.items.find(
              (candidate) => candidate.id === item.subjectId,
            );
            // No row means the backup is gone; a different row is a bad
            // response that a retry may fix.
            if (!run) {
              if (page.items.length === 0)
                throw new ApiError(404, "Source is unavailable");
              throw new ApiContractError();
            }
            title = run.name;
            break;
          }
          case "record-assigned":
            title = "Record assigned to you";
            break;
          case "invitation-accepted":
            title = "Invitation accepted";
            break;
          case "sandbox-published":
            title = `Sandbox version ${item.versionSequence} published`;
            break;
          case "access-changed":
            title = "Your access changed";
            break;
        }
        if (signal.aborted)
          throw new DOMException("Read cancelled", "AbortError");
        return { title };
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof ApiError &&
          [401, 403, 404].includes(error.status)
        ) {
          // A source refusal hides only this title. Reconcile recipient
          // visibility without treating OpenView's access latch as the inbox.
          void client.invalidateQueries({ queryKey: notificationKeys.pages });
          void client.invalidateQueries({ queryKey: notificationKeys.count });
        }
        throw error;
      }
    },
    staleTime: 0,
    gcTime: 0,
  });
}
