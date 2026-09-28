"use client";

import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { ApiContractError, ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  attachBoardFile,
  detachBoardFile,
  downloadBoardAttachment,
  listBoardAttachments,
  MAX_BOARD_ATTACHMENT_BYTES,
  readBoardFile,
  reserveBoardFile,
  scanBoardFile,
  uploadBoardFile,
  type BoardAttachmentFile,
  type BoardAttachmentTarget,
  type BoardAttachmentVersions,
} from "../adapters/board-files-api";

type EventAttachmentTarget = {
  kind: "event";
  boardId: string;
  contentId: string;
};
type PostAttachmentTarget = {
  kind: "post";
  boardId: string;
  contentId: string;
  view: "published" | "draft";
};
type ReadOnlyTarget =
  EventAttachmentTarget | (PostAttachmentTarget & { view: "published" });
type EditableTarget =
  EventAttachmentTarget | (PostAttachmentTarget & { view: "draft" });

type ReadOnlyProps = {
  access: "read";
  target: ReadOnlyTarget;
};
type EditableProps = {
  access: "edit";
  target: EditableTarget;
  versions: BoardAttachmentVersions;
  refreshVersions: () => Promise<BoardAttachmentVersions>;
  onBusyChange: (busy: boolean) => void;
  locked?: boolean;
};
type Props = ReadOnlyProps | EditableProps;

type PendingFile = {
  id: string;
  filename: string;
  expectedSize: number;
  state: "pending_scan" | "ready";
};

const AUTOMATIC_SCAN_CHECKS = 100;
const SCAN_CHECK_INTERVAL_MS = 500;

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function messageFor(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return "This content changed. The latest versions were checked; retry the attachment action or reload the editor.";
    if ([401, 403, 404].includes(error.status))
      return "This content or file is no longer available to you.";
    if (error.status === 413) return "This file is too large to upload.";
    if (error.status === 422)
      return "The file or attachment request was rejected. Check the file and try again.";
  }
  if (error instanceof ApiContractError)
    return "The server returned an invalid attachment response. Refresh and try again.";
  return `Could not ${action}. Try again.`;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new DOMException("Request canceled", "AbortError"));
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    function abort() {
      window.clearTimeout(timeout);
      reject(new DOMException("Request canceled", "AbortError"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KB";
  if (value >= 1024) {
    value /= 1024;
    unit = units[1] ?? "MB";
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

function targetKey(target: BoardAttachmentTarget): string {
  return target.kind === "event"
    ? `event:${target.boardId}:${target.contentId}`
    : `post:${target.boardId}:${target.contentId}:${target.view}`;
}

function scanFailure(file: BoardAttachmentFile): Error | null {
  if (file.state === "rejected")
    return new Error(
      "The security scan rejected this file. It was not attached.",
    );
  if (file.state === "purged" || file.state === "deleting")
    return new Error("This file is no longer available to attach.");
  return null;
}

export function ServerBoardAttachments(props: Props) {
  const [expanded, setExpanded] = useState(props.access === "edit");
  const [listStatus, setListStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [items, setItems] = useState<BoardAttachmentFile[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [listRevision, setListRevision] = useState(0);
  const [operation, setOperation] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const operationController = useRef<AbortController | null>(null);
  const versionsRef = useRef<BoardAttachmentVersions | null>(
    props.access === "edit" ? props.versions : null,
  );
  const editable = props.access === "edit" ? props : null;
  const kind = props.target.kind;
  const boardId = props.target.boardId;
  const contentId = props.target.contentId;
  const view = props.target.kind === "post" ? props.target.view : null;
  const sourceKey = targetKey(props.target);
  const stableTarget = useMemo<BoardAttachmentTarget>(
    () =>
      kind === "event"
        ? { kind, boardId, contentId }
        : { kind, boardId, contentId, view: view ?? "published" },
    [boardId, contentId, kind, view],
  );
  const busy = operation !== null;
  const busyCallback = editable?.onBusyChange;
  const busyCallbackRef = useRef(busyCallback);
  const boardRevision = editable?.versions.boardRevision ?? null;
  const contentRevision = editable?.versions.contentRevision ?? null;

  useEffect(() => {
    busyCallbackRef.current = busyCallback;
  }, [busyCallback]);

  useEffect(() => {
    if (boardRevision === null || contentRevision === null) return;
    versionsRef.current = { boardRevision, contentRevision };
  }, [boardRevision, contentRevision]);

  useEffect(() => {
    if (props.access !== "edit") return;
    busyCallbackRef.current?.(busy);
  }, [busy, props.access]);

  useEffect(
    () => () => {
      operationController.current?.abort();
      busyCallbackRef.current?.(false);
    },
    [],
  );

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    let active = true;
    setListStatus("loading");
    setItems([]);
    setOffset(0);
    setHasMore(false);
    void listBoardAttachments(stableTarget, {
      limit: 25,
      offset: 0,
      signal: controller.signal,
    })
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setOffset(page.offset + page.items.length);
        setHasMore(page.hasMore);
        setListStatus("ready");
      })
      .catch((loadError: unknown) => {
        if (!active || isAbort(loadError)) return;
        setListStatus("error");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [expanded, listRevision, stableTarget]);

  async function refreshVersions(): Promise<BoardAttachmentVersions> {
    if (!editable) throw new ApiContractError();
    const latest = await editable.refreshVersions();
    versionsRef.current = latest;
    return latest;
  }

  async function refreshList() {
    if (!expanded) return;
    setListRevision((value) => value + 1);
  }

  async function attachReadyFile(file: PendingFile) {
    if (!editable || editable.locked || file.state !== "ready") return;
    setOperation(`Attaching ${file.filename}…`);
    setError(null);
    setNotice(null);
    try {
      const versions = versionsRef.current ?? editable.versions;
      await attachBoardFile(stableTarget, file.id, versions);
      setPendingFile(null);
      try {
        await refreshVersions();
        setNotice(`${file.filename} attached.`);
      } catch {
        setError(
          "The file was attached, but the editor could not refresh its versions. Reload the editor before saving more changes.",
        );
      }
      await refreshList();
    } catch (attachError) {
      if (isAbort(attachError)) return;
      if (attachError instanceof ApiError && attachError.status === 409) {
        try {
          await refreshVersions();
        } catch {
          setError(
            "The content changed. Reload it before attaching this file.",
          );
          return;
        }
      }
      setPendingFile(file);
      setError(messageFor(attachError, "attach the file"));
    } finally {
      setOperation(null);
    }
  }

  async function waitForScan(file: PendingFile, signal: AbortSignal) {
    for (let attempt = 0; attempt < AUTOMATIC_SCAN_CHECKS; attempt += 1) {
      await delay(SCAN_CHECK_INTERVAL_MS, signal);
      const current = await readBoardFile(boardId, file.id, signal);
      const failure = scanFailure(current);
      if (failure) throw failure;
      if (current.state === "ready")
        return { ...file, state: "ready" as const };
      setPendingFile({ ...file, state: "pending_scan" });
    }
    return null;
  }

  async function uploadSelectedFile(file: File) {
    if (!editable || editable.locked || busy) return;
    if (file.size < 1 || file.size > MAX_BOARD_ATTACHMENT_BYTES) {
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
    const controller = new AbortController();
    operationController.current = controller;
    setError(null);
    setNotice(null);
    setOperation(`Uploading and scanning ${file.name}…`);
    let reserved: BoardAttachmentFile | null = null;
    try {
      reserved = await reserveBoardFile(boardId, {
        filename: file.name,
        expectedSize: file.size,
      });
      await uploadBoardFile(boardId, reserved.id, file, controller.signal);
      const scan = await scanBoardFile(boardId, reserved.id, controller.signal);
      const failure = scanFailure(scan);
      if (failure) throw failure;
      const candidate: PendingFile = {
        id: reserved.id,
        filename: reserved.filename,
        expectedSize: reserved.expectedSize,
        state: scan.state === "ready" ? "ready" : "pending_scan",
      };
      setPendingFile(candidate);
      if (candidate.state === "ready") {
        await attachReadyFile(candidate);
        return;
      }
      const ready = await waitForScan(candidate, controller.signal);
      if (ready) {
        setPendingFile(ready);
        await attachReadyFile(ready);
      } else {
        setNotice(
          "The file is still being scanned. Check its status to continue.",
        );
      }
    } catch (uploadError) {
      if (isAbort(uploadError)) return;
      if (
        reserved &&
        uploadError instanceof ApiError &&
        uploadError.status === 409
      ) {
        setPendingFile({
          id: reserved.id,
          filename: reserved.filename,
          expectedSize: reserved.expectedSize,
          state: "pending_scan",
        });
      }
      setError(
        uploadError instanceof Error &&
          uploadError.message.includes("security scan")
          ? uploadError.message
          : messageFor(uploadError, "upload and scan the file"),
      );
    } finally {
      operationController.current = null;
      setOperation(null);
    }
  }

  async function checkPendingScan() {
    if (
      !editable ||
      editable.locked ||
      !pendingFile ||
      pendingFile.state !== "pending_scan" ||
      busy
    )
      return;
    const controller = new AbortController();
    operationController.current = controller;
    setError(null);
    setNotice(null);
    setOperation(`Checking ${pendingFile.filename}…`);
    try {
      const file = await readBoardFile(
        boardId,
        pendingFile.id,
        controller.signal,
      );
      const failure = scanFailure(file);
      if (failure) {
        setPendingFile(null);
        throw failure;
      }
      if (file.state === "ready") {
        const ready = { ...pendingFile, state: "ready" as const };
        setPendingFile(ready);
        await attachReadyFile(ready);
      } else {
        setNotice("The file is still being scanned. Check again shortly.");
      }
    } catch (scanError) {
      if (!isAbort(scanError))
        setError(
          scanError instanceof Error &&
            scanError.message.includes("security scan")
            ? scanError.message
            : messageFor(scanError, "check the file scan"),
        );
    } finally {
      operationController.current = null;
      setOperation(null);
    }
  }

  async function removeAttachment(file: BoardAttachmentFile) {
    if (!editable || editable.locked || busy) return;
    const controller = new AbortController();
    operationController.current = controller;
    setError(null);
    setNotice(null);
    setOperation(`Removing ${file.filename}…`);
    try {
      const versions = versionsRef.current ?? editable.versions;
      await detachBoardFile(stableTarget, file.id, versions);
      try {
        await refreshVersions();
        setNotice(`${file.filename} detached.`);
      } catch {
        setError(
          "The file was detached, but the editor could not refresh its versions. Reload the editor before saving more changes.",
        );
      }
      await refreshList();
    } catch (detachError) {
      if (isAbort(detachError)) return;
      if (detachError instanceof ApiError && detachError.status === 409) {
        try {
          await refreshVersions();
        } catch {
          setError(
            "The content changed. Reload it before changing attachments.",
          );
          return;
        }
      }
      setError(messageFor(detachError, "remove the file"));
      await refreshList();
    } finally {
      operationController.current = null;
      setOperation(null);
    }
  }

  async function loadMore() {
    if (busy || listStatus === "loading") return;
    const controller = new AbortController();
    setListStatus("loading");
    try {
      const page = await listBoardAttachments(stableTarget, {
        limit: 25,
        offset,
        signal: controller.signal,
      });
      setItems((current) => {
        const seen = new Set(current.map((file) => file.id));
        return [...current, ...page.items.filter((file) => !seen.has(file.id))];
      });
      setOffset(page.offset + page.items.length);
      setHasMore(page.hasMore);
      setListStatus("ready");
    } catch {
      setListStatus("error");
    }
  }

  async function download(file: BoardAttachmentFile) {
    if (downloadingId !== null) return;
    setDownloadingId(file.id);
    setError(null);
    try {
      const blob = await downloadBoardAttachment(
        stableTarget,
        file.id,
        file.actualSize ?? file.expectedSize,
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (downloadError) {
      setError(messageFor(downloadError, "download the file"));
    } finally {
      setDownloadingId(null);
    }
  }

  const title =
    props.target.kind === "event" ? "Event attachments" : "Post attachments";
  const bytes = pendingFile?.expectedSize ?? null;

  return (
    <section aria-label={title} className="mt-3 min-w-0">
      {props.access === "read" ? (
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 px-2"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide attachments" : "Attachments"}
        </Button>
      ) : (
        <h4 className="text-sm font-semibold">Attachments</h4>
      )}
      {expanded ? (
        <div className="mt-2 flex min-w-0 flex-col gap-3">
          {error ? (
            <Alert variant="destructive">
              <p role="alert">{error}</p>
            </Alert>
          ) : null}
          {notice ? (
            <p role="status" className="text-muted-foreground text-sm">
              {notice}
            </p>
          ) : null}
          {operation ? (
            <p role="status" className="text-muted-foreground text-sm">
              {operation}
            </p>
          ) : null}
          {listStatus === "loading" ? (
            <p role="status" className="text-muted-foreground text-sm">
              Loading attachments…
            </p>
          ) : null}
          {listStatus === "error" ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-destructive text-sm">
                Attachments are unavailable for this content.
              </p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setListRevision((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {listStatus === "ready" && items.length === 0 ? (
            <p className="text-muted-foreground text-sm">No attachments yet.</p>
          ) : null}
          {items.length > 0 ? (
            <ul
              aria-label="Attached files"
              className="flex min-w-0 flex-col gap-2"
            >
              {items.map((file) => (
                <li
                  key={file.id}
                  className="border-border flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <span className="min-w-0 text-sm break-words">
                    {file.filename}{" "}
                    <span className="text-muted-foreground">
                      ({formatSize(file.actualSize ?? file.expectedSize)})
                    </span>
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={downloadingId !== null}
                      onClick={() => void download(file)}
                    >
                      {downloadingId === file.id
                        ? "Downloading…"
                        : `Download ${file.filename}`}
                    </Button>
                    {editable ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={busy || editable.locked === true}
                        onClick={() => void removeAttachment(file)}
                      >
                        Remove {file.filename}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {hasMore ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-start"
              disabled={listStatus === "loading" || busy}
              onClick={() => void loadMore()}
            >
              Load more attachments
            </Button>
          ) : null}
          {editable ? (
            <div className="border-border flex min-w-0 flex-col gap-2 border-t pt-3">
              <label
                htmlFor={`board-file-${sourceKey}`}
                className="text-sm font-medium"
              >
                Add an attachment
              </label>
              <Input
                id={`board-file-${sourceKey}`}
                type="file"
                className="min-h-11 max-w-full"
                disabled={busy || editable.locked === true}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void uploadSelectedFile(file);
                }}
              />
              <p className="text-muted-foreground text-sm">
                Files up to 25 MiB are scanned before attachment. Only scanned
                files can be attached.
              </p>
              {pendingFile?.state === "pending_scan" ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-sm break-words">
                    Waiting for the scan of {pendingFile.filename}
                    {bytes !== null ? ` (${formatSize(bytes)})` : ""}.
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={busy || editable.locked === true}
                    onClick={() => void checkPendingScan()}
                  >
                    Check scan status
                  </Button>
                </div>
              ) : null}
              {pendingFile?.state === "ready" ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-sm break-words">
                    {pendingFile.filename} passed the scan and is ready to
                    attach.
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={busy || editable.locked === true}
                    onClick={() => void attachReadyFile(pendingFile)}
                  >
                    Attach scanned file
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function HydratedBoardAttachments(props: Props) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated ? createElement(ServerBoardAttachments, props) : null;
}
