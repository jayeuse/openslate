"use client";

import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiContractError, ApiError } from "@/lib/api";
import { reportDone, reportError } from "@/lib/feedback";
import { formatWorkspaceDateTime } from "@/lib/date-time";
import type { AccessLevel } from "@/lib/auth-api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LoadingRegion } from "@/components/ui/loading-region";
import { SearchField } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import type { AccessDepartment } from "../../access/state/api-contracts";
import {
  manageKeys,
  manageWorkspaceOptions,
} from "../../manage/adapters/manage-queries";
import { subscribeOpenViewInvalidations } from "../../openview/adapters/invalidation-events";
import {
  authMeOptions,
  extendsRead,
  readStamp,
} from "../../openview/adapters/openview-queries";
import { openViewLevel } from "../../openview/domain/manage-access";
import {
  fileErrorMessage,
  formatFileSize,
  MAX_FILE_BYTES,
} from "../../shared/adapters/files-api";
import { FileList } from "../../shared/components/file-list";
import { Choice, Panel } from "../../shared/components/ui";
import {
  archiveLibraryFile,
  downloadLibraryFile,
  getLibraryFile,
  listLibraryFiles,
  reopenLibraryFile,
  reserveLibraryFile,
  uploadLibraryFile,
  type LibraryFile,
  type LibraryFileCriteria,
} from "../adapters/library-files-api";
import {
  isLibraryRefused,
  libraryDepartmentsOptions,
  libraryFilesOptions,
  libraryRefusalOptions,
  platformKeys,
  trackLibraryRead,
} from "../adapters/platform-queries";

const ACCESS_ENTITIES = new Set([
  "departments",
  "group_access",
  "group_members",
  "groups",
  "users",
]);
const SORTS = {
  newest: {
    label: "Added (newest first)",
    sortBy: "created_at",
    sortOrder: "desc",
  },
  "name-asc": { label: "Name (A–Z)", sortBy: "name", sortOrder: "asc" },
  "name-desc": { label: "Name (Z–A)", sortBy: "name", sortOrder: "desc" },
  "size-asc": {
    label: "Size (smallest first)",
    sortBy: "size",
    sortOrder: "asc",
  },
  "size-desc": {
    label: "Size (largest first)",
    sortBy: "size",
    sortOrder: "desc",
  },
} as const;
type SortChoice = keyof typeof SORTS;
type UploadCheck = {
  id: string;
  filename: string;
  expectedSize: number;
  operationId: string;
};
const uploadKey = (departmentId: string) =>
  ["platform-file-upload", departmentId] as const;
type Operation = {
  kind: "upload" | "check" | "archive" | "reopen" | "download" | "page";
  fileId: string | null;
  controller: AbortController;
};
type FileExtension = {
  readAt: number;
  scope: string;
  items: LibraryFile[];
  creatorLabels: Record<string, string>;
  nextOffset: number;
  hasMore: boolean;
};

export default function Files() {
  const client = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const identity = useQuery(authMeOptions());
  const identityRefused =
    identity.error instanceof ApiError &&
    [401, 403, 404].includes(identity.error.status);
  const identityReady = identity.data !== undefined && !identityRefused;
  const departments = useQuery({
    ...libraryDepartmentsOptions(),
    enabled: identityReady,
  });
  const catalogRefused =
    departments.error instanceof ApiError &&
    [401, 403, 404].includes(departments.error.status);
  const choices = useMemo(
    () =>
      identityReady && !catalogRefused
        ? (departments.data ?? []).filter(
            (department) =>
              openViewLevel(identity.data, department.id) !== null,
          )
        : [],
    [catalogRefused, departments.data, identity.data, identityReady],
  );
  const requested = searchParams.get("department");
  const department =
    requested === null
      ? choices[0]
      : choices.find((item) => item.id === requested);
  const level = department ? openViewLevel(identity.data, department.id) : null;

  useEffect(() => {
    if (requested !== null || !department) return;
    const parameters = new URLSearchParams(searchParams.toString());
    parameters.set("section", "files");
    parameters.set("department", department.id);
    router.replace(`/platform?${parameters}` as Route, { scroll: false });
  }, [department, requested, router, searchParams]);

  useEffect(() => {
    const refresh = (queryKey: QueryKey) => {
      const cold = client
        .getQueryCache()
        .findAll({ queryKey, fetchStatus: "fetching" })
        .filter((query) => query.state.data === undefined);
      void Promise.all(
        cold.map((query) => query.cancel({ revert: true })),
      ).then(() => client.invalidateQueries({ queryKey }));
    };
    const everyRead = () => {
      refresh(platformKeys.libraryFiles);
      refresh(platformKeys.libraryDepartments());
      refresh(authMeOptions().queryKey);
      refresh(manageKeys.workspace());
    };
    const unsubscribe = subscribeOpenViewInvalidations((event) => {
      if (event.type === "resync") return everyRead();
      if (event.entity === "files") refresh(platformKeys.libraryFiles);
      if (ACCESS_ENTITIES.has(event.entity)) {
        refresh(platformKeys.libraryFiles);
        refresh(platformKeys.libraryDepartments());
        refresh(authMeOptions().queryKey);
      }
      if (event.entity === "workspace_profiles")
        refresh(manageKeys.workspace());
    }, everyRead);
    return () => {
      unsubscribe();
      void client.invalidateQueries({
        queryKey: platformKeys.libraryFiles,
        refetchType: "none",
      });
      void client.invalidateQueries({
        queryKey: platformKeys.libraryDepartments(),
        refetchType: "none",
      });
    };
  }, [client]);

  const loading =
    identity.isPending || (identityReady && departments.isPending);
  return (
    <Panel title="Department file library">
      <div className="max-w-xl">
        <Choice
          label="Department"
          value={department?.id ?? ""}
          disabled={loading || !choices.length}
          onChange={(event) => {
            const id = event.currentTarget.value;
            if (!choices.some((item) => item.id === id)) return;
            const parameters = new URLSearchParams(searchParams.toString());
            parameters.set("section", "files");
            parameters.set("department", id);
            router.push(`/platform?${parameters}` as Route, { scroll: false });
          }}
        >
          <option value="" disabled>
            Choose a department
          </option>
          {choices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.department_name}
              {item.is_deleted ? " (Closed)" : ""}
            </option>
          ))}
        </Choice>
      </div>
      {identity.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert variant="destructive">
            Your department access could not be checked. Retry before opening
            files.
          </Alert>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={identity.isFetching}
            onClick={() => void identity.refetch()}
          >
            Retry access
          </Button>
        </div>
      ) : departments.error ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert variant="destructive">
            Departments could not be loaded. Retry to load the complete list.
          </Alert>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={departments.isFetching}
            onClick={() => void departments.refetch()}
          >
            Retry departments
          </Button>
        </div>
      ) : null}
      <LoadingRegion
        loading={loading}
        label="Loading departments…"
        skeleton={<Skeleton className="h-24 w-full" />}
      >
        {identityReady && !catalogRefused && departments.data ? (
          department && level ? (
            <LibraryContents
              key={department.id}
              department={department}
              level={level}
            />
          ) : requested !== null ? (
            <Alert variant="destructive">
              This department is unavailable. Choose another department.
            </Alert>
          ) : (
            <p className="text-muted-foreground text-sm">
              No departments are available to you.
            </p>
          )
        ) : null}
      </LoadingRegion>
    </Panel>
  );
}

function LibraryContents({
  department,
  level,
}: {
  department: AccessDepartment;
  level: AccessLevel;
}) {
  const client = useQueryClient();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const search = query.trim();
  const [settled, setSettled] = useState("");
  const [sort, setSort] = useState<SortChoice>("newest");
  const [deleted, setDeleted] = useState<"exclude" | "only">("exclude");
  const sorting = SORTS[sort];
  const criteria: LibraryFileCriteria = {
    search: settled,
    sortBy: sorting.sortBy,
    sortOrder: sorting.sortOrder,
    deleted,
  };
  const scope = JSON.stringify(criteria);
  const files = useQuery(libraryFilesOptions(department.id, criteria));
  const denied = useQuery(libraryRefusalOptions(department.id)).data;
  const workspace = useQuery(manageWorkspaceOptions());
  const pending = useQuery<UploadCheck | null>({
    queryKey: uploadKey(department.id),
    queryFn: async () => null,
    enabled: false,
    initialData: null,
    gcTime: Infinity,
  }).data;
  const [extension, setExtension] = useState<FileExtension | null>(null);
  const [error, setError] = useState("");
  const [pageError, setPageError] = useState("");
  const [checkedState, setCheckedState] = useState<
    "unknown" | "awaiting_upload" | "uploading"
  >("unknown");
  const [activeOperation, setActiveOperation] = useState<Operation | null>(
    null,
  );
  const operation = useRef<Operation | null>(null);
  const mounted = useRef(true);
  const currentScope = useRef(scope);
  const permissions = useRef({ canUpload: false, canManage: false });
  const canWrite = level === "write" || level === "manage";
  const canManage = level === "manage";
  const canUpload = canWrite && !department.is_deleted && deleted === "exclude";
  const waiting = search !== settled;

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  useLayoutEffect(() => {
    permissions.current = { canUpload, canManage };
  }, [canManage, canUpload]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const owned = operation.current;
      operation.current = null;
      owned?.controller.abort();
      setActiveOperation(null);
      if (client.getQueryData(uploadKey(department.id)) === null)
        client.removeQueries({
          queryKey: uploadKey(department.id),
          exact: true,
        });
    };
  }, [client, department.id]);
  useLayoutEffect(() => {
    currentScope.current = scope;
    const owned = operation.current;
    if (owned?.kind === "page") {
      operation.current = null;
      owned.controller.abort();
      setActiveOperation(null);
    }
    setPageError("");
  }, [scope]);

  const getCheck = useCallback(
    () =>
      client.getQueryData<UploadCheck | null>(uploadKey(department.id)) ?? null,
    [client, department.id],
  );
  const owns = useCallback(
    (owned: Operation) =>
      mounted.current &&
      operation.current === owned &&
      !owned.controller.signal.aborted,
    [],
  );
  const live = useCallback(
    (owned: Operation) =>
      owns(owned) && !isLibraryRefused(client, department.id),
    [client, department.id, owns],
  );
  const begin = useCallback(
    (kind: Operation["kind"], fileId: string | null = null) => {
      if (
        !mounted.current ||
        operation.current ||
        isLibraryRefused(client, department.id)
      )
        return null;
      const owned: Operation = {
        kind,
        fileId,
        controller: new AbortController(),
      };
      operation.current = owned;
      setActiveOperation(owned);
      return owned;
    },
    [client, department.id],
  );
  const finish = useCallback(
    (owned: Operation) => {
      if (!owns(owned)) return;
      operation.current = null;
      setActiveOperation(null);
    },
    [owns],
  );
  const refresh = useCallback(
    () =>
      client.invalidateQueries({
        queryKey: platformKeys.departmentFiles(department.id),
      }),
    [client, department.id],
  );

  const applyUploadStatus = useCallback(
    async (check: UploadCheck, file: LibraryFile, owned: Operation) => {
      if (!live(owned) || getCheck()?.operationId !== check.operationId) return;
      if (
        file.id !== check.id ||
        file.filename !== check.filename ||
        file.expectedSize !== check.expectedSize
      )
        throw new ApiContractError();
      if (
        file.isDeleted ||
        ["rejected", "purged", "deleting"].includes(file.state)
      ) {
        client.setQueryData(uploadKey(department.id), null);
        setError(
          file.state === "rejected"
            ? "This upload was rejected. Check the file and try again."
            : "This upload is no longer available. Choose the file again.",
        );
        void refresh();
      } else if (file.state === "ready") {
        client.setQueryData(uploadKey(department.id), null);
        setError("");
        await refresh();
        if (live(owned)) reportDone(`${file.filename} uploaded.`);
      } else {
        setCheckedState(
          file.state === "awaiting_upload" ? "awaiting_upload" : "uploading",
        );
        setError(
          file.state === "awaiting_upload"
            ? "The upload did not finish."
            : "The upload outcome is not confirmed. Check status before trying again.",
        );
      }
    },
    [client, department.id, getCheck, live, refresh],
  );
  const readUploadStatus = useCallback(
    async (check: UploadCheck, owned: Operation) => {
      try {
        const file = await trackLibraryRead(client, department.id, () =>
          getLibraryFile(department.id, check.id, owned.controller.signal),
        );
        await applyUploadStatus(check, file, owned);
      } catch (caught) {
        if (!live(owned) || getCheck()?.operationId !== check.operationId)
          return;
        setCheckedState("unknown");
        setError(fileErrorMessage(caught, "check the upload"));
      }
    },
    [applyUploadStatus, client, department.id, getCheck, live],
  );
  const checkStatus = useCallback(async () => {
    const check = getCheck();
    if (!check) return;
    const owned = begin("check", check.id);
    if (!owned) return;
    setError("");
    try {
      await readUploadStatus(check, owned);
    } finally {
      finish(owned);
    }
  }, [begin, finish, getCheck, readUploadStatus]);
  const hasFirstPage = files.data !== undefined;
  useEffect(() => {
    if (pending && hasFirstPage && !denied) void checkStatus();
  }, [pending?.operationId, hasFirstPage, denied, checkStatus]);

  const readAt = readStamp(files);
  const more =
    extension &&
    extension.scope === scope &&
    extendsRead(extension.readAt, files)
      ? extension
      : null;
  const items = files.data ? [...files.data.items, ...(more?.items ?? [])] : [];
  const labels = { ...files.data?.creatorLabels, ...more?.creatorLabels };
  const nextOffset =
    more?.nextOffset ??
    (files.data
      ? files.data.pagination.offset + files.data.pagination.count
      : 0);
  const hasMore = more?.hasMore ?? files.data?.pagination.hasMore ?? false;
  const busy = activeOperation !== null;

  async function upload(file: File) {
    if (!canUpload || denied || waiting || !hasFirstPage || operation.current)
      return;
    if (file.size < 1 || file.size > MAX_FILE_BYTES) {
      setError("Choose a file larger than 0 bytes and no larger than 25 MiB.");
      return;
    }
    if (
      file.name.length > 255 ||
      file.name === "." ||
      file.name === ".." ||
      /[\\/\u0000-\u001f\u007f]/.test(file.name)
    ) {
      setError("Choose a plain file name up to 255 characters.");
      return;
    }
    let check = getCheck();
    if (
      check &&
      (checkedState !== "awaiting_upload" ||
        file.name !== check.filename ||
        file.size !== check.expectedSize)
    ) {
      setError(
        "Choose a file with the same file name and size to retry this upload.",
      );
      return;
    }
    const owned = begin("upload", check?.id);
    if (!owned) return;
    setError("");
    try {
      if (!check) {
        const reserved = await reserveLibraryFile(
          department.id,
          { filename: file.name, expectedSize: file.size },
          owned.controller.signal,
        );
        if (!live(owned)) return;
        check = {
          id: reserved.id,
          filename: reserved.filename,
          expectedSize: reserved.expectedSize,
          operationId: crypto.randomUUID(),
        };
        client.setQueryData(uploadKey(department.id), check);
      }
      setCheckedState("unknown");
      if (!permissions.current.canUpload) {
        await readUploadStatus(check, owned);
        return;
      }
      const uploaded = await uploadLibraryFile(
        department.id,
        check.id,
        file,
        owned.controller.signal,
      );
      await applyUploadStatus(check, uploaded, owned);
    } catch (caught) {
      if (!live(owned)) return;
      if (check) await readUploadStatus(check, owned);
      else setError(fileErrorMessage(caught, "upload the file"));
    } finally {
      finish(owned);
    }
  }

  async function lifecycle(file: LibraryFile, reopen: boolean) {
    if (
      !canManage ||
      denied ||
      (reopen && department.is_deleted) ||
      ["purged", "deleting"].includes(file.state)
    )
      return;
    const owned = begin(reopen ? "reopen" : "archive", file.id);
    if (!owned) return;
    try {
      const confirmed = reopen
        ? await reopenLibraryFile(
            department.id,
            file.id,
            owned.controller.signal,
          )
        : await archiveLibraryFile(
            department.id,
            file.id,
            owned.controller.signal,
          );
      if (!live(owned)) return;
      if (!reopen && getCheck()?.id === confirmed.id) {
        client.setQueryData(uploadKey(department.id), null);
        setError("");
      }
      await refresh();
      if (live(owned))
        reportDone(`${file.filename} ${reopen ? "reopened" : "archived"}.`);
    } catch (caught) {
      if (live(owned))
        reportError(
          fileErrorMessage(
            caught,
            reopen ? "reopen the file" : "archive the file",
          ),
        );
    } finally {
      finish(owned);
    }
  }

  async function download(file: LibraryFile) {
    if (denied || file.state !== "ready") return;
    const owned = begin("download", file.id);
    if (!owned) return;
    try {
      const blob = await trackLibraryRead(client, department.id, () =>
        downloadLibraryFile(file, owned.controller.signal),
      );
      if (!live(owned)) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      reportDone(`${file.filename} downloaded.`);
    } catch (caught) {
      if (live(owned))
        reportError(fileErrorMessage(caught, "download the file"));
    } finally {
      finish(owned);
    }
  }

  async function loadMore() {
    if (denied || waiting || !hasMore || !readAt) return;
    const owned = begin("page");
    if (!owned) return;
    setPageError("");
    const readKey = platformKeys.libraryFileList(department.id, criteria);
    try {
      const page = await trackLibraryRead(client, department.id, () =>
        listLibraryFiles(department.id, {
          ...criteria,
          limit: 25,
          offset: nextOffset,
          signal: owned.controller.signal,
        }),
      );
      if (
        !live(owned) ||
        currentScope.current !== scope ||
        client.getQueryState(readKey)?.dataUpdatedAt !== readAt
      )
        return;
      setExtension({
        scope,
        readAt,
        items: [
          ...new Map(
            [...(more?.items ?? []), ...page.items].map((file) => [
              file.id,
              file,
            ]),
          ).values(),
        ],
        creatorLabels: { ...more?.creatorLabels, ...page.creatorLabels },
        nextOffset: page.pagination.offset + page.pagination.count,
        hasMore: page.pagination.hasMore,
      });
    } catch (caught) {
      if (live(owned))
        setPageError(fileErrorMessage(caught, "load more files"));
    } finally {
      finish(owned);
    }
  }

  const metadata = (file: LibraryFile) => {
    let added = "Date format unavailable";
    if (workspace.data) {
      try {
        added = formatWorkspaceDateTime(file.createdAt, workspace.data);
      } catch {
        /* The file remains usable while date settings recover. */
      }
    }
    return (
      <>
        <span className="block">
          Added <time dateTime={file.createdAt}>{added}</time>
        </span>
        <span className="block">
          Added by {labels[file.creatorId] ?? "Unavailable user"}
        </span>
      </>
    );
  };
  const ready = items.filter((file) => file.state === "ready");
  const unfinished = items.filter((file) => file.state !== "ready");
  const canReopen = canManage && !department.is_deleted;
  const secondaryAction = (deleted === "only" ? canReopen : canManage)
    ? {
        label: deleted === "only" ? "Reopen" : "Archive",
        disabled: busy,
        run: (file: LibraryFile) => void lifecycle(file, deleted === "only"),
      }
    : undefined;

  return (
    <div className="min-w-0 space-y-5">
      {department.is_deleted ? (
        <p role="note" className="text-muted-foreground text-sm">
          This department is closed. You can still read files and archive them
          if you manage this department.
        </p>
      ) : null}
      <div className="grid items-end gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,13.75rem)_minmax(0,11.25rem)]">
        <SearchField
          label="Search files by name"
          value={query}
          onValueChange={setQuery}
          maxLength={100}
          placeholder="Find a file…"
        />
        <Choice
          label="Sort files"
          value={sort}
          onChange={(event) => {
            if (Object.hasOwn(SORTS, event.currentTarget.value))
              setSort(event.currentTarget.value as SortChoice);
          }}
        >
          {Object.entries(SORTS).map(([value, option]) => (
            <option key={value} value={value}>
              {option.label}
            </option>
          ))}
        </Choice>
        <Choice
          label="File status"
          value={deleted}
          onChange={(event) => {
            if (
              event.currentTarget.value === "exclude" ||
              event.currentTarget.value === "only"
            )
              setDeleted(event.currentTarget.value);
          }}
        >
          <option value="exclude">Active</option>
          <option value="only">Archived</option>
        </Choice>
      </div>
      {denied ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert variant="destructive">
            Files are no longer available to you. Retry after your access is
            restored.
          </Alert>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={files.isFetching}
            onClick={() => void files.refetch()}
          >
            Retry files
          </Button>
        </div>
      ) : (
        <>
          {files.data ? (
            <div className="space-y-1">
              <p className="text-sm">
                <strong>Storage used:</strong>{" "}
                {formatFileSize(files.data.storageUsedBytes)}
              </p>
              <p className="text-muted-foreground text-xs">
                Includes archived files. Unfinished uploads are not counted.
              </p>
            </div>
          ) : null}
          {canUpload ? (
            <Field>
              <FieldLabel htmlFor={inputId}>Upload file</FieldLabel>
              <Input
                id={inputId}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx"
                disabled={
                  busy ||
                  waiting ||
                  !hasFirstPage ||
                  Boolean(pending && checkedState !== "awaiting_upload")
                }
                aria-invalid={Boolean(error)}
                aria-describedby={
                  error ? `${inputId}-error` : `${inputId}-hint`
                }
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void upload(file);
                }}
              />
              <p
                id={`${inputId}-hint`}
                className="text-muted-foreground text-sm"
              >
                PDF, images, and Office files up to 25 MiB.
              </p>
            </Field>
          ) : null}
          {activeOperation ? (
            <p role="status" className="text-muted-foreground text-sm">
              {activeOperation.kind === "upload"
                ? "Uploading file…"
                : activeOperation.kind === "check"
                  ? "Checking upload status…"
                  : activeOperation.kind === "archive"
                    ? "Archiving file…"
                    : activeOperation.kind === "reopen"
                      ? "Reopening file…"
                      : activeOperation.kind === "download"
                        ? "Downloading file…"
                        : "Loading more files…"}
            </p>
          ) : null}
          {error ? (
            <Alert id={`${inputId}-error`} variant="destructive">
              {error}
            </Alert>
          ) : null}
          {pending && hasFirstPage ? (
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 text-sm wrap-anywhere">
                <p>{pending.filename}</p>
                <p>
                  {checkedState === "awaiting_upload" && canUpload
                    ? "Choose the same file to retry this upload."
                    : "The upload is pending. Check its status before trying again."}
                </p>
              </div>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() => void checkStatus()}
              >
                Check status
              </Button>
            </div>
          ) : null}
          {files.error ? (
            <div className="flex flex-wrap items-center gap-3">
              <Alert variant="destructive">
                {fileErrorMessage(files.error, "load files")}
              </Alert>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={files.isFetching}
                onClick={() => void files.refetch()}
              >
                Retry files
              </Button>
            </div>
          ) : null}
          {workspace.error ? (
            <div className="flex flex-wrap items-center gap-3">
              <Alert variant="destructive">
                File dates could not be formatted. File actions remain
                available.
              </Alert>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={workspace.isFetching}
                onClick={() => void workspace.refetch()}
              >
                Retry date settings
              </Button>
            </div>
          ) : null}
          <LoadingRegion
            loading={files.isPending || waiting}
            label="Loading files…"
            skeleton={
              <div className="space-y-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            }
          >
            {!items.length && hasFirstPage ? (
              <p className="text-muted-foreground text-sm">
                {deleted === "only"
                  ? "No archived files in this department."
                  : "No files in this department."}
              </p>
            ) : null}
            {ready.length ? (
              <FileList
                items={ready}
                label="Library files"
                metadata={metadata}
                adapter={{ download: (file) => void download(file) }}
                downloadingId={
                  activeOperation?.kind === "download"
                    ? activeOperation.fileId
                    : busy
                      ? ""
                      : null
                }
                secondaryAction={secondaryAction}
              />
            ) : null}
            {unfinished.length ? (
              <ul
                aria-label="Unfinished library files"
                className="flex min-w-0 flex-col gap-2"
              >
                {unfinished.map((file) => (
                  <li
                    key={file.id}
                    className="border-border flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0 text-sm wrap-anywhere">
                      <p>{file.filename}</p>
                      <p className="text-muted-foreground">
                        {file.state === "rejected"
                          ? "Upload rejected."
                          : ["purged", "deleting"].includes(file.state)
                            ? "File unavailable."
                            : "Upload pending."}
                      </p>
                      <span className="text-muted-foreground mt-1 block text-xs">
                        {metadata(file)}
                      </span>
                    </div>
                    {(deleted === "only" ? canReopen : canManage) &&
                    !["purged", "deleting"].includes(file.state) ? (
                      <Button
                        variant="outline"
                        className="min-h-11"
                        disabled={busy}
                        onClick={() => void lifecycle(file, deleted === "only")}
                      >
                        {deleted === "only" ? "Reopen" : "Archive"}
                        <span className="sr-only"> {file.filename}</span>
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {pageError ? (
              <Alert variant="destructive">{pageError}</Alert>
            ) : null}
            {hasMore ? (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() => void loadMore()}
              >
                Load more files
              </Button>
            ) : null}
          </LoadingRegion>
        </>
      )}
    </div>
  );
}
