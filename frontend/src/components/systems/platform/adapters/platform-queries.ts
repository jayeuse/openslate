import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
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
