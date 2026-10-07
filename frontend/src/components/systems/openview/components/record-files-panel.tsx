"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiContractError, ApiError } from "@/lib/api";
import { reportDone, reportError } from "@/lib/feedback";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { FilePickerButton } from "@/components/ui/file-picker-button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { FileList } from "../../shared/components/file-list";
import {
  fileErrorMessage,
  MAX_FILE_BYTES,
} from "../../shared/adapters/files-api";
import {
  archiveRecordFile,
  downloadRecordFile,
  getRecordFile,
  listRecordFiles,
  reserveRecordFile,
  uploadRecordFile,
  type RecordFile,
} from "../adapters/record-files-api";
import {
  extendsRead,
  openViewKeys,
  readStamp,
  recordFilesOptions,
  recordPageDenial,
} from "../adapters/openview-queries";
import { useOpenViewAccessDenied } from "../adapters/openview-access";
import type { OpenViewRecord } from "../adapters/views-api";

// A known reservation survives tab/record unmounts in this account's client.
// It holds no bytes or history and sits outside SSE-invalidated read keys.
type UploadCheck = {
  id: string;
  filename: string;
  expectedSize: number;
  operationId: string;
};
const uploadKey = (recordId: string) =>
  ["openview-file-upload", recordId] as const;
type Operation = {
  kind: "upload" | "check" | "archive" | "download" | "page";
  fileId: string | null;
  controller: AbortController;
};
type FileExtension = {
  readAt: number;
  items: RecordFile[];
  nextOffset: number;
  hasMore: boolean;
};
const refused = (error: unknown): error is ApiError =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);

function addedAt(value: string, region: WorkspaceRegion | undefined): string {
  if (!region || Number.isNaN(new Date(value).valueOf()))
    return "Date unavailable";
  return formatWorkspaceDateTime(value, region, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function RecordFilesPanel({
  record,
  canWrite,
  region,
}: {
  record: OpenViewRecord;
  canWrite: boolean;
  region: WorkspaceRegion | undefined;
}) {
  const client = useQueryClient();
  const inputId = useId();
  const accessDenied = useOpenViewAccessDenied();
  const files = useQuery(recordFilesOptions(record.id));
  const pending = useQuery<UploadCheck | null>({
    queryKey: uploadKey(record.id),
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
  const [readRefused, setReadRefused] = useState(false);
  const [activeOperation, setActiveOperation] = useState<Operation | null>(
    null,
  );
  const operation = useRef<Operation | null>(null);
  const mounted = useRef(true);
  const denied = accessDenied || readRefused || refused(files.error);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const owned = operation.current;
      operation.current = null;
      owned?.controller.abort();
      setActiveOperation(null);
      if (client.getQueryData(uploadKey(record.id)) === null)
        client.removeQueries({ queryKey: uploadKey(record.id), exact: true });
    };
  }, [client, record.id]);
  useEffect(() => {
    if (files.dataUpdatedAt) setReadRefused(false);
  }, [files.dataUpdatedAt]);

  const getCheck = useCallback(
    () => client.getQueryData<UploadCheck | null>(uploadKey(record.id)) ?? null,
    [client, record.id],
  );
  const live = useCallback(
    (owned: Operation) =>
      mounted.current &&
      operation.current === owned &&
      !owned.controller.signal.aborted,
    [],
  );
  const begin = useCallback(
    (kind: Operation["kind"], fileId: string | null = null) => {
      if (!mounted.current || operation.current) return null;
      const owned: Operation = {
        kind,
        fileId,
        controller: new AbortController(),
      };
      operation.current = owned;
      setActiveOperation(owned);
      return owned;
    },
    [],
  );
  const finish = useCallback(
    (owned: Operation) => {
      if (!live(owned)) return;
      operation.current = null;
      setActiveOperation(null);
    },
    [live],
  );
  const refresh = useCallback(
    () =>
      client.invalidateQueries({
        queryKey: openViewKeys.recordFileList(record.id),
      }),
    [client, record.id],
  );

  const applyUploadStatus = useCallback(
    async (check: UploadCheck, file: RecordFile, owned: Operation) => {
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
        client.setQueryData(uploadKey(record.id), null);
        setError(
          file.state === "rejected"
            ? "This upload was rejected. Check the file and try again."
            : "This upload is no longer available. Choose the file again.",
        );
        void refresh();
      } else if (file.state === "ready") {
        client.setQueryData(uploadKey(record.id), null);
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
    [client, getCheck, live, record.id, refresh],
  );

  const readUploadStatus = useCallback(
    async (check: UploadCheck, owned: Operation) => {
      try {
        const file = await getRecordFile(
          record.id,
          check.id,
          owned.controller.signal,
        );
        await applyUploadStatus(check, file, owned);
      } catch (caught) {
        if (refused(caught))
          recordPageDenial(
            client,
            [openViewKeys.recordFileList(record.id)],
            caught,
          );
        if (!live(owned) || getCheck()?.operationId !== check.operationId)
          return;
        if (refused(caught)) setReadRefused(true);
        setCheckedState("unknown");
        setError(fileErrorMessage(caught, "check the upload"));
      }
    },
    [applyUploadStatus, client, getCheck, live, record.id],
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
    extension && extendsRead(extension.readAt, files) ? extension : null;
  const items = files.data ? [...files.data.items, ...(more?.items ?? [])] : [];
  const nextOffset =
    more?.nextOffset ??
    (files.data
      ? files.data.pagination.offset + files.data.pagination.count
      : 0);
  const hasMore = more?.hasMore ?? files.data?.pagination.hasMore ?? false;
  const busy = activeOperation !== null;
  const canUpload = canWrite && !record.isDeleted;

  async function upload(file: File) {
    if (!canUpload || denied || !hasFirstPage || operation.current) return;
    if (file.size < 1 || file.size > MAX_FILE_BYTES) {
      setError("Choose a file larger than 0 bytes and no larger than 25 MB.");
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
        const reserved = await reserveRecordFile(
          record.id,
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
        client.setQueryData(uploadKey(record.id), check);
      }
      setCheckedState("unknown");
      const uploaded = await uploadRecordFile(
        record.id,
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

  async function archive(file: RecordFile) {
    if (!canWrite || denied || file.isDeleted) return;
    const owned = begin("archive", file.id);
    if (!owned) return;
    try {
      const archived = await archiveRecordFile(
        record.id,
        file.id,
        owned.controller.signal,
      );
      if (!live(owned)) return;
      if (getCheck()?.id === archived.id) {
        client.setQueryData(uploadKey(record.id), null);
        setError("");
      }
      await refresh();
      if (live(owned)) reportDone(`${file.filename} archived.`);
    } catch (caught) {
      if (live(owned))
        reportError(fileErrorMessage(caught, "archive the file"));
    } finally {
      finish(owned);
    }
  }

  async function download(file: RecordFile) {
    if (denied || file.state !== "ready" || file.isDeleted) return;
    const owned = begin("download", file.id);
    if (!owned) return;
    try {
      const blob = await downloadRecordFile(file, owned.controller.signal);
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
      if (refused(caught))
        recordPageDenial(
          client,
          [openViewKeys.recordFileList(record.id)],
          caught,
        );
      if (live(owned)) {
        if (refused(caught)) setReadRefused(true);
        reportError(fileErrorMessage(caught, "download the file"));
      }
    } finally {
      finish(owned);
    }
  }

  async function loadMore() {
    if (denied || !hasMore || !readAt) return;
    const owned = begin("page");
    if (!owned) return;
    setPageError("");
    try {
      const page = await listRecordFiles(record.id, {
        limit: 25,
        offset: nextOffset,
        signal: owned.controller.signal,
      });
      if (
        !live(owned) ||
        client.getQueryState(openViewKeys.recordFileList(record.id))
          ?.dataUpdatedAt !== readAt
      )
        return;
      setExtension({
        readAt,
        items: [
          ...new Map(
            [...(more?.items ?? []), ...page.items].map((item) => [
              item.id,
              item,
            ]),
          ).values(),
        ],
        nextOffset: page.pagination.offset + page.pagination.count,
        hasMore: page.pagination.hasMore,
      });
    } catch (caught) {
      if (refused(caught))
        recordPageDenial(
          client,
          [openViewKeys.recordFileList(record.id)],
          caught,
        );
      if (live(owned))
        setPageError(fileErrorMessage(caught, "load more files"));
    } finally {
      finish(owned);
    }
  }

  if (denied)
    return (
      <div className="py-4">
        <Alert
          variant="destructive"
          className="flex w-full flex-wrap items-center justify-between gap-3"
        >
          <p className="min-w-0">
            Files are no longer available to you. Retry after your access is
            restored.
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void files.refetch()}
          >
            Retry files
          </Button>
        </Alert>
      </div>
    );

  const ready = items.filter(
    (file) => file.state === "ready" && !file.isDeleted,
  );
  const unfinished = items.filter(
    (file) => file.state !== "ready" && !file.isDeleted,
  );
  const secondaryAction = canWrite
    ? {
        label: "Archive",
        disabled: busy,
        run: (file: RecordFile) => void archive(file),
      }
    : undefined;
  // The record file list names no uploader, so only the date is shown.
  const metadata = (file: RecordFile) => (
    <span className="block">
      Added{" "}
      <time dateTime={file.createdAt}>{addedAt(file.createdAt, region)}</time>
    </span>
  );
  return (
    <div className="flex min-w-0 flex-col gap-4 py-4">
      {canUpload ? (
        <Field>
          <FieldLabel htmlFor={inputId}>Upload file</FieldLabel>
          <FilePickerButton
            id={inputId}
            accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx"
            disabled={
              busy ||
              !hasFirstPage ||
              Boolean(pending && checkedState !== "awaiting_upload")
            }
            aria-describedby={`${inputId}-hint`}
            onFiles={(chosen, event) => {
              const file = chosen[0];
              event.currentTarget.value = "";
              if (file) void upload(file);
            }}
          >
            Choose file
          </FilePickerButton>
          <p id={`${inputId}-hint`} className="text-muted-foreground text-sm">
            PDF, images, and Office files up to 25 MB.
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
                : activeOperation.kind === "download"
                  ? "Downloading file…"
                  : "Loading more files…"}
        </p>
      ) : null}
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {pending ? (
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
        <Alert
          variant="destructive"
          className="flex w-full flex-wrap items-center justify-between gap-3"
        >
          <p className="min-w-0">
            {fileErrorMessage(files.error, "load files")}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={files.isFetching}
            onClick={() => void files.refetch()}
          >
            Retry files
          </Button>
        </Alert>
      ) : null}
      <LoadingRegion
        loading={files.isPending}
        label="Loading files…"
        skeleton={
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        }
      >
        {items.length === 0 && hasFirstPage ? (
          <p className="text-muted-foreground text-sm">No files attached.</p>
        ) : null}
        {ready.length ? (
          <FileList
            items={ready}
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
          <ul aria-label="Unfinished files" className="flex flex-col gap-2">
            {unfinished.map((file) => (
              <li
                key={file.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b py-3"
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
                {canWrite ? (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    disabled={
                      busy || ["purged", "deleting"].includes(file.state)
                    }
                    onClick={() => void archive(file)}
                  >
                    Archive<span className="sr-only"> {file.filename}</span>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {pageError ? (
          <Alert variant="destructive" className="mt-3">
            {pageError}
          </Alert>
        ) : null}
        {hasMore ? (
          <Button
            variant="outline"
            className="mt-3 min-h-11"
            disabled={busy}
            onClick={() => void loadMore()}
          >
            Load more files
          </Button>
        ) : null}
      </LoadingRegion>
    </div>
  );
}
