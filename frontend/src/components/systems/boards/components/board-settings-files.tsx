"use client";

import { useId } from "react";
import type { WorkspaceRegion } from "@/lib/date-time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { LifecyclePurgeReview } from "@/components/systems/shared/lifecycle-purge-review";
import type { BoardPurgePreview } from "../adapters/board-management-api";
import type {
  BoardUnlinkedFile,
  BoardUnlinkedFilePage,
} from "../adapters/board-files-api";

const control = "min-h-11 xl:min-h-8";

export type BoardFileStatus = "exclude" | "only";

/**
 * Unattached files of a board, in Details › Advanced (BR27): archive an
 * active file, permanently delete an archived one. Administrators only.
 */
export function BoardUnattachedFiles({
  archived,
  status,
  onStatusChange,
  loading,
  error,
  onRetry,
  page,
  stale,
  pending,
  locked,
  purgeEnabled,
  offset,
  onArchive,
  onPurge,
  onPrevious,
  onNext,
}: {
  archived: boolean;
  status: BoardFileStatus;
  onStatusChange: (status: BoardFileStatus) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  page: BoardUnlinkedFilePage | null;
  /** The shown page is from an older read; its actions wait. */
  stale: boolean;
  /** An action runs. */
  pending: boolean;
  /** An action runs, or the details have a draft or a conflict. */
  locked: boolean;
  purgeEnabled: boolean;
  offset: number;
  onArchive: (file: BoardUnlinkedFile) => void;
  onPurge: (file: BoardUnlinkedFile) => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const id = useId();
  return (
    <section
      aria-label="Unattached board files"
      className="flex flex-col gap-3"
    >
      <h3 data-slot="section-title" className="text-sm font-medium">
        Unattached files
      </h3>
      {archived ? (
        <p className="text-muted-foreground text-sm">
          Restore this board to manage its unattached files.
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Files on no post or event. Linked files stay with their content.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor={`${id}-status`}
              className="text-muted-foreground text-sm"
            >
              File status
            </label>
            <NativeSelect
              id={`${id}-status`}
              className="[&_select]:min-h-11"
              value={status}
              disabled={pending}
              onChange={(event) =>
                onStatusChange(
                  event.target.value === "only" ? "only" : "exclude",
                )
              }
            >
              <NativeSelectOption value="exclude">Active</NativeSelectOption>
              <NativeSelectOption value="only">Archived</NativeSelectOption>
            </NativeSelect>
          </div>
          {loading ? (
            <p role="status" className="text-muted-foreground text-sm">
              Loading unattached files…
            </p>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="text-danger-text flex flex-wrap items-center gap-2 text-sm"
            >
              <span>{error}</span>
              <Button
                type="button"
                variant="outline"
                className={control}
                onClick={onRetry}
              >
                Retry file list
              </Button>
            </div>
          ) : null}
          {page ? (
            <>
              {page.items.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No unattached files on this page.
                </p>
              ) : (
                <ul className="divide-border flex flex-col divide-y rounded-lg border">
                  {page.items.map((file) => (
                    <li
                      key={file.id}
                      className="flex min-h-10 min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-1"
                    >
                      <span className="min-w-0 text-sm break-words">
                        {file.filename}
                      </span>
                      {file.state === "purged" ? (
                        <span className="text-muted-foreground text-sm">
                          Deleted forever
                        </span>
                      ) : file.state === "deleting" ||
                        file.state === "uploading" ? (
                        <span className="text-muted-foreground text-sm">
                          This file is still changing. Try again later.
                        </span>
                      ) : !file.isDeleted ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className={control}
                          aria-label={`Archive ${file.filename}`}
                          disabled={locked || loading || stale}
                          onClick={() => onArchive(file)}
                        >
                          Archive file
                        </Button>
                      ) : purgeEnabled ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className={`${control} text-danger-text`}
                          aria-label={`Delete ${file.filename} forever`}
                          disabled={locked || loading || stale}
                          onClick={() => onPurge(file)}
                        >
                          Delete forever
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {offset > 0 || page.pagination.hasMore ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className={control}
                    disabled={pending || loading || offset === 0}
                    onClick={onPrevious}
                  >
                    Previous files
                  </Button>
                  <span className="text-muted-foreground text-sm tabular-nums">
                    {page.items.length
                      ? `${page.pagination.offset + 1}–${page.pagination.offset + page.items.length} of ${page.pagination.total}`
                      : `0 of ${page.pagination.total}`}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    className={control}
                    disabled={
                      pending || loading || stale || !page.pagination.hasMore
                    }
                    onClick={onNext}
                  >
                    Next files
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * The review before an archived file is deleted forever: its impact, the
 * typed file name and the administrator password.
 */
export function BoardFilePurgeDialog({
  open,
  pending,
  loading,
  error,
  preview,
  region,
  confirmationName,
  password,
  confirmDisabled,
  canReviewAgain,
  onConfirmationName,
  onPassword,
  onConfirm,
  onReviewAgain,
  onCancel,
}: {
  open: boolean;
  pending: boolean;
  loading: boolean;
  error: string | null;
  preview: BoardPurgePreview | null;
  region: WorkspaceRegion | undefined;
  confirmationName: string;
  password: string;
  confirmDisabled: boolean;
  canReviewAgain: boolean;
  onConfirmationName: (value: string) => void;
  onPassword: (value: string) => void;
  onConfirm: () => void;
  onReviewAgain: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      dismissible={!pending}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <DialogContent className="slim-ui max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Delete file forever?</DialogTitle>
          <DialogDescription>
            This removes the archived file forever. Review its impact before
            confirming.
          </DialogDescription>
        </DialogHeader>
        {loading ? <p role="status">Preparing review…</p> : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {preview ? (
          <>
            <LifecyclePurgeReview preview={preview} region={region} />
            {preview.impact.blockers.length === 0 ? (
              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  onConfirm();
                }}
              >
                <p className="text-sm break-words">
                  File name: <code>{preview.confirmation_name}</code>
                </p>
                <label className="flex flex-col gap-2 text-sm">
                  Type the file name
                  <Input
                    autoComplete="off"
                    value={confirmationName}
                    disabled={pending}
                    className="h-11"
                    onChange={(event) => onConfirmationName(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm">
                  Administrator password
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    disabled={pending}
                    className="h-11"
                    onChange={(event) => onPassword(event.target.value)}
                  />
                </label>
                <Button
                  variant="destructive"
                  className={`${control} self-start`}
                  type="submit"
                  disabled={confirmDisabled}
                >
                  Delete file forever
                </Button>
              </form>
            ) : null}
          </>
        ) : canReviewAgain ? (
          <Button
            variant="outline"
            className={`${control} self-start`}
            disabled={pending}
            onClick={onReviewAgain}
          >
            Review again
          </Button>
        ) : null}
        <Button
          variant="outline"
          className={`${control} self-start`}
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </DialogContent>
    </Dialog>
  );
}
