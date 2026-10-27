"use client";

import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { WorkspaceRegion } from "@/lib/date-time";
import type { LifecyclePurgePreview } from "@/lib/lifecycle";
import { LifecyclePurgeReview } from "../../shared/lifecycle-purge-review";
import type { BoardEventLifecycleAction } from "./server-backed-board-event-lifecycle";

/** Archive asks once with its consequence; Restore confirms the series. */
export function BoardEventLifecycleDialog({
  open,
  target,
  error,
  pending,
  canConfirm,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  target: BoardEventLifecycleAction | null;
  error: string | null;
  pending: boolean;
  canConfirm: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <AlertDialogContent className="slim-ui">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {target?.kind === "archive" ? "Archive event?" : "Restore event?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target?.kind === "archive"
              ? `Archive “${target.title}” and all its occurrences? It will leave the active calendar and can be restored by a Board manager.`
              : `Restore “${target?.title ?? "this event"}” and its occurrences to the active calendar?`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={target?.kind === "archive" ? "destructive" : "default"}
            className="min-h-11 xl:min-h-8"
            disabled={pending || !canConfirm}
            onClick={onConfirm}
          >
            {target?.kind === "archive"
              ? pending
                ? "Archiving…"
                : "Archive event"
              : pending
                ? "Restoring…"
                : "Restore event"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Delete forever (admins, archived events): the existing guarded review. */
export function BoardEventPurgeDialog({
  open,
  pending,
  enabled,
  preview,
  error,
  name,
  password,
  region,
  onName,
  onPassword,
  onConfirm,
  onReviewAgain,
  onClose,
}: {
  open: boolean;
  pending: boolean;
  enabled: boolean;
  preview: LifecyclePurgePreview | null;
  error: string;
  name: string;
  password: string;
  region: WorkspaceRegion | undefined;
  onName: (value: string) => void;
  onPassword: (value: string) => void;
  onConfirm: () => void;
  onReviewAgain: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      dismissible={!pending}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="slim-ui">
        <DialogHeader>
          <DialogTitle>Permanently delete event?</DialogTitle>
          <DialogDescription>
            This permanently removes the archived event and its occurrences.
          </DialogDescription>
        </DialogHeader>
        {pending && !preview ? <p role="status">Preparing review…</p> : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {preview ? (
          <div className="mt-4 space-y-4">
            <LifecyclePurgeReview preview={preview} region={region} />
            {preview.impact.blockers.length === 0 ? (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  onConfirm();
                }}
              >
                <p className="text-sm break-words">
                  Event name: <code>{preview.confirmation_name}</code>
                </p>
                <label className="block space-y-2 text-sm">
                  Type the event name
                  <Input
                    autoComplete="off"
                    value={name}
                    disabled={pending}
                    onChange={(event) => onName(event.target.value)}
                  />
                </label>
                <label className="block space-y-2 text-sm">
                  Administrator password
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    disabled={pending}
                    onChange={(event) => onPassword(event.target.value)}
                  />
                </label>
                <Button
                  type="submit"
                  variant="destructive"
                  className="min-h-11 xl:min-h-8"
                  disabled={
                    pending ||
                    !enabled ||
                    name !== preview.confirmation_name ||
                    !password
                  }
                >
                  Confirm permanent deletion
                </Button>
              </form>
            ) : null}
          </div>
        ) : !pending ? (
          <Button
            className="mt-4 min-h-11 xl:min-h-8"
            variant="outline"
            onClick={onReviewAgain}
          >
            Review again
          </Button>
        ) : null}
        <Button
          className="mt-4 min-h-11 xl:min-h-8"
          variant="outline"
          disabled={pending}
          onClick={onClose}
        >
          Cancel
        </Button>
      </DialogContent>
    </Dialog>
  );
}
