"use client";

import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { ApiContractError, ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fileErrorMessage } from "../../shared/adapters/files-api";
import { FileList } from "../../shared/components/file-list";
import {
  attachBoardFile,
  detachBoardFile,
  downloadBoardAttachment,
  listBoardAttachments,
  MAX_BOARD_ATTACHMENT_BYTES,
  reserveBoardFile,
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

// An uploaded, ready file whose attach request failed; it can be retried.
type PendingFile = {
  id: string;
  filename: string;
};

// A stored-file state that the user can act on; its message is shown as is.
class AttachmentFileError extends Error {}

// File validation refuses the bytes (422), or the file is stored as rejected.
const REJECTED_UPLOAD =
  "This file could not be stored. Check the file and try again.";
// The bytes may have been stored even though the response was unusable.
const UNCLEAR_UPLOAD =
  "The upload result is unclear. Use Attach file to finish, or choose the file again.";

function ambiguousUpload(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 500;
  return !(error instanceof AttachmentFileError);
}
// Matches the backend extension allowlist in files/validation.py.
const ATTACHMENT_ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx";

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function targetKey(target: BoardAttachmentTarget): string {
  return target.kind === "event"
    ? `event:${target.boardId}:${target.contentId}`
    : `post:${target.boardId}:${target.contentId}:${target.view}`;
}

function uploadFailure(file: BoardAttachmentFile): Error | null {
  if (file.state === "ready") return null;
  if (file.state === "rejected")
    return new AttachmentFileError(REJECTED_UPLOAD);
  if (file.state === "purged" || file.state === "deleting")
    return new AttachmentFileError(
      "This file is no longer available to attach.",
    );
  return new ApiContractError();
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
    if (!editable || editable.locked) return;
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
          setPendingFile(file);
          setError(
            "The content changed. Reload it before attaching this file.",
          );
          return;
        }
      }
      setPendingFile(file);
      setError(fileErrorMessage(attachError, "attach the file"));
    } finally {
      setOperation(null);
    }
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
    setOperation(`Uploading ${file.name}…`);
    let reserved: PendingFile | null = null;
    try {
      reserved = await reserveBoardFile(boardId, {
        filename: file.name,
        expectedSize: file.size,
      });
      const uploaded = await uploadBoardFile(
        boardId,
        reserved.id,
        file,
        controller.signal,
      );
      const failure = uploadFailure(uploaded);
      if (failure) throw failure;
      await attachReadyFile({ id: uploaded.id, filename: uploaded.filename });
    } catch (uploadError) {
      if (isAbort(uploadError)) return;
      if (reserved && ambiguousUpload(uploadError)) {
        // Keep the reservation so the user can finish; attach refuses a file that
        // never became ready.
        setPendingFile({ id: reserved.id, filename: reserved.filename });
        setError(UNCLEAR_UPLOAD);
        return;
      }
      setError(
        uploadError instanceof AttachmentFileError
          ? uploadError.message
          : uploadError instanceof ApiError && uploadError.status === 422
            ? REJECTED_UPLOAD
            : fileErrorMessage(uploadError, "upload the file"),
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
        setNotice(`${file.filename} removed.`);
      } catch {
        setError(
          "The file was removed, but the editor could not refresh its versions. Reload the editor before saving more changes.",
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
      setError(fileErrorMessage(detachError, "remove the file"));
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
      setError(fileErrorMessage(downloadError, "download the file"));
    } finally {
      setDownloadingId(null);
    }
  }

  const title =
    props.target.kind === "event" ? "Event attachments" : "Post attachments";
  // Edit mode shows feedback next to the upload control; read mode at the top.
  // The status region stays mounted so screen readers announce text changes.
  const feedback = (
    <>
      {error ? (
        <Alert role="alert" variant="destructive">
          {error}
        </Alert>
      ) : null}
      <p role="status" className="text-muted-foreground text-sm">
        {operation ?? notice ?? ""}
      </p>
    </>
  );

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
          {editable ? null : feedback}
          {listStatus === "loading" ? (
            <p role="status" className="text-muted-foreground text-sm">
              Loading attachments…
            </p>
          ) : null}
          {listStatus === "error" ? (
            <Alert
              variant="destructive"
              className="flex flex-wrap items-center gap-2"
            >
              <p className="text-sm">
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
            </Alert>
          ) : null}
          {listStatus === "ready" && items.length === 0 ? (
            <p className="text-muted-foreground text-sm">No attachments yet.</p>
          ) : null}
          {items.length > 0 ? (
            <FileList
              items={items}
              adapter={{ download: (file) => void download(file) }}
              downloadingId={downloadingId}
              secondaryAction={
                editable
                  ? {
                      label: "Remove",
                      disabled: busy || editable.locked === true,
                      run: (file) => void removeAttachment(file),
                    }
                  : undefined
              }
            />
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
                accept={ATTACHMENT_ACCEPT}
                aria-describedby={`board-file-${sourceKey}-help`}
                className="min-h-11 max-w-full py-2"
                disabled={busy || editable.locked === true}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void uploadSelectedFile(file);
                }}
              />
              <p
                id={`board-file-${sourceKey}-help`}
                className="text-muted-foreground text-sm"
              >
                Files up to 25 MiB. PDF, PNG, JPEG, DOCX, XLSX or PPTX.
              </p>
              {feedback}
              {pendingFile ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-sm break-words">
                    {pendingFile.filename} is uploaded but not attached yet.
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={busy || editable.locked === true}
                    onClick={() => void attachReadyFile(pendingFile)}
                  >
                    Attach file
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
