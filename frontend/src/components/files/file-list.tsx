"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { LifecycleAction } from "@/components/lifecycle-dialog";
import { useWorkspace } from "@/components/workspace-provider";
import { formatWorkspaceDateTime } from "@/lib/date-time";
import {
  listFiles,
  fileAction,
  downloadFile,
  fileStateLabels,
  fileFailureMessage,
  canRetryScan,
  type ManagedFile,
  type FilePurpose,
} from "@/lib/files";
import { useFileRefresh } from "./use-file-refresh";
import { FileUpload } from "./file-upload";
export function FileList({
  purpose,
  recordId,
  canRead,
  canWrite,
  isParentClosed = false,
}: {
  purpose: FilePurpose;
  recordId?: string;
  canRead: boolean;
  canWrite: boolean;
  isParentClosed?: boolean;
}) {
  const { isAdmin, profile } = useWorkspace();
  const [items, setItems] = useState<ManagedFile[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [archive, setArchive] = useState<ManagedFile | null>(null);
  const [owned, setOwned] = useState<ManagedFile | null>(null);
  const { generation, visible, expired, refresh } = useFileRefresh(
    canRead,
    items.some((file) => file.state === "pending_scan" && !file.is_deleted),
  );
  useEffect(() => {
    if (!canRead || !visible) return;
    const controller = new AbortController();
    setLoading(true);
    void listFiles(purpose, recordId, offset, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setItems(result.items);
          setMore(result.pagination.has_more);
          setError("");
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Documents could not be loaded.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [purpose, recordId, offset, generation, canRead, visible]);
  async function run(action: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await action();
      refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "File operation failed. The action was not retried.",
      );
    } finally {
      setPending(false);
    }
  }
  const shown = canRead ? items : owned ? [owned] : [];
  return (
    <div className="flex flex-col gap-5">
      {canWrite && !isParentClosed && (
        <FileUpload
          purpose={purpose}
          recordId={recordId}
          disabled={pending}
          onBusyChange={setPending}
          onChange={(file) => {
            setOwned(file);
            refresh();
          }}
        />
      )}
      {isParentClosed && (
        <p className="text-muted-foreground text-sm">
          This record is closed. Retained ready files can still be downloaded.
        </p>
      )}
      {!canRead && (
        <p className="text-muted-foreground text-sm">
          Your role can upload attachments but cannot browse or download them.
        </p>
      )}
      {error && <Alert variant="destructive">{error}</Alert>}
      {canRead && (
        <Button
          variant="outline"
          className="self-start"
          disabled={loading || pending}
          onClick={refresh}
        >
          Refresh file status
        </Button>
      )}
      {expired && (
        <p role="status">
          Automatic status checks paused. Refresh file status to check again.
        </p>
      )}
      {loading && <p role="status">Loading documents…</p>}
      {!loading && canRead && !items.length && !error && (
        <p className="text-muted-foreground text-sm">No documents yet.</p>
      )}
      <ul className="divide-border divide-y">
        {shown.map((file) => (
          <li
            key={file.id}
            className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="font-medium break-words">{file.filename}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {((file.actual_size ?? file.expected_size) / 1024).toFixed(1)}{" "}
                KiB · {formatWorkspaceDateTime(file.created_at, profile)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge
                  variant={
                    file.state === "ready"
                      ? "success"
                      : file.state === "rejected"
                        ? "warning"
                        : "secondary"
                  }
                >
                  {fileStateLabels[file.state]}
                </Badge>
                {file.is_deleted && <Badge variant="warning">Archived</Badge>}
              </div>
              {file.failure_code && (
                <p className="text-muted-foreground mt-2 text-sm">
                  {fileFailureMessage(file.failure_code)}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {canRead && file.state === "ready" && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => void run(() => downloadFile(file))}
                >
                  Download <span className="sr-only">{file.filename}</span>
                </Button>
              )}
              {canWrite &&
                !isParentClosed &&
                !file.is_deleted &&
                canRetryScan(file) && (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void run(async () => {
                        const result = await fileAction(file.id, "scan");
                        setOwned(result);
                      })
                    }
                  >
                    Retry scanning{" "}
                    <span className="sr-only">{file.filename}</span>
                  </Button>
                )}
              {canWrite &&
                file.state !== "purged" &&
                file.state !== "deleting" &&
                (file.is_deleted ? (
                  <Button
                    variant="ghost"
                    disabled={pending || isParentClosed}
                    onClick={() =>
                      void run(async () =>
                        setOwned(await fileAction(file.id, "reopen")),
                      )
                    }
                  >
                    Reopen <span className="sr-only">{file.filename}</span>
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setArchive(file)}
                  >
                    Archive <span className="sr-only">{file.filename}</span>
                  </Button>
                ))}
              {isAdmin && ["uploading", "deleting"].includes(file.state) && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void run(() => fileAction(file.id, "reconcile"))
                  }
                >
                  Reconcile <span className="sr-only">{file.filename}</span>
                </Button>
              )}
              {isAdmin && file.is_deleted && file.state !== "purged" && (
                <LifecycleAction
                  targetType="file"
                  targetId={file.id}
                  targetName={file.filename}
                  isClosed
                  allowClose={false}
                  allowReopen={false}
                  onComplete={refresh}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
      {canRead && (
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-sm">
            Page {Math.floor(offset / 25) + 1}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={loading || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              Previous files
            </Button>
            <Button
              variant="outline"
              disabled={loading || !more}
              onClick={() => setOffset(offset + 25)}
            >
              Next files
            </Button>
          </div>
        </div>
      )}
      <ConfirmationDialog
        open={!!archive}
        onOpenChange={(open) => {
          if (!open) setArchive(null);
        }}
        title="Archive this document?"
        description="Private bytes are retained. Authorized readers can still download ready content."
        confirmLabel="Archive document"
        pending={pending}
        onConfirm={() =>
          run(async () => {
            if (archive) setOwned(await fileAction(archive.id, "archive"));
            setArchive(null);
          })
        }
      />
    </div>
  );
}
