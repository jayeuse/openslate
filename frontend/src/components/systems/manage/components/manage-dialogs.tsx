"use client";

import type { FormEvent, ReactNode, RefObject } from "react";
import { MfaPresentation, useMfaFlow } from "@/components/mfa-flow";

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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ManageSnapshot, ManageSnapshotDiff } from "../state/model";
import { SettingsChanges } from "./panel-ui";

export type ConfirmState = {
  origin?: "admin-sessions";
  title: string;
  description: string;
  confirmLabel: string;
  requiresDraftAck?: boolean;
  body?: ReactNode;
  action: () => Promise<boolean>;
};

export type PreviewState = {
  title: string;
  description?: string;
  body?: ReactNode;
};

type ManageConfirmationDialogProps = {
  confirm: ConfirmState | null;
  pending: boolean;
  error: string;
  draftAcknowledged: boolean;
  confirmOpener: RefObject<HTMLElement | null>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onDraftAcknowledgedChange: (checked: boolean) => void;
};

export function ManageConfirmationDialog({
  confirm,
  pending,
  error,
  draftAcknowledged,
  confirmOpener,
  headingRef,
  onClose,
  onDraftAcknowledgedChange,
}: ManageConfirmationDialogProps) {
  return (
    <AlertDialog
      open={confirm !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent
        finalFocus={() =>
          confirmOpener.current?.isConnected
            ? confirmOpener.current
            : headingRef.current
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirm?.title ?? "Confirm action"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirm?.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        ) : null}
        {pending ? <p role="status">Saving changes…</p> : null}
        {confirm?.body}
        {confirm?.requiresDraftAck ? (
          <Field className="mt-4 flex-row items-center gap-3">
            <Checkbox
              id="discard-affected-drafts"
              disabled={pending}
              checked={draftAcknowledged}
              onCheckedChange={(checked) =>
                onDraftAcknowledgedChange(checked === true)
              }
            />
            <FieldLabel
              htmlFor="discard-affected-drafts"
              className="font-normal"
            >
              Discard affected unsaved drafts
            </FieldLabel>
          </Field>
        ) : null}
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11"
            disabled={Boolean(
              pending || (confirm?.requiresDraftAck && !draftAcknowledged),
            )}
            onClick={async () => {
              if (!confirm || pending) return;
              if (await confirm.action()) onClose();
            }}
          >
            {confirm?.confirmLabel ?? "Confirm"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type ManageMfaDialogProps = {
  opener: RefObject<HTMLButtonElement | null>;
};

export function ManageMfaDialog({ opener }: ManageMfaDialogProps) {
  const flow = useMfaFlow();
  // Visibility changes belong to the AppPage identity gate, not cancellation.
  // Only actual dialog dismissal or leaving Manage removes owned setup.
  return (
    <Dialog
      open={flow.open && flow.mode === "workspace"}
      onOpenChange={(open) => {
        if (!open) flow.cancel();
      }}
    >
      <DialogContent
        className="max-w-lg"
        finalFocus={() =>
          opener.current?.isConnected ? opener.current : false
        }
      >
        <DialogHeader>
          <DialogTitle>MFA enrollment</DialogTitle>
          <DialogDescription>
            Set up and verify an authenticator for this account. Contact your
            administrator if you need account recovery.
          </DialogDescription>
        </DialogHeader>
        <MfaPresentation flow={flow} />
      </DialogContent>
    </Dialog>
  );
}

type ManageSnapshotRenameDialogProps = {
  open: boolean;
  pending: boolean;
  value: string;
  error: string;
  opener: RefObject<HTMLElement | null>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onValueChange: (value: string) => void;
  onErrorClear: () => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function ManageSnapshotRenameDialog({
  open,
  pending,
  value,
  error,
  opener,
  headingRef,
  onValueChange,
  onErrorClear,
  onCancel,
  onSubmit,
}: ManageSnapshotRenameDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !pending) onCancel();
      }}
    >
      <DialogContent
        finalFocus={() =>
          opener.current?.isConnected ? opener.current : headingRef.current
        }
      >
        <DialogHeader>
          <DialogTitle>Rename snapshot</DialogTitle>
          <DialogDescription>
            Give this configuration snapshot a recognizable name.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="rename-snapshot">Snapshot name</FieldLabel>
            <Input
              id="rename-snapshot"
              disabled={pending}
              value={value}
              onChange={(event) => {
                onValueChange(event.target.value);
                onErrorClear();
              }}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "rename-snapshot-error" : undefined}
              className="min-h-11"
              autoFocus
            />
            <FieldError id="rename-snapshot-error">{error}</FieldError>
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="min-h-11"
              disabled={pending || !value.trim()}
            >
              {pending ? "Renaming…" : "Rename snapshot"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type ManageSnapshotCompareDialogProps = {
  target: ManageSnapshot | null;
  differences: ManageSnapshotDiff[];
  onClose: () => void;
};

export function ManageSnapshotCompareDialog({
  target,
  differences,
  onClose,
}: ManageSnapshotCompareDialogProps) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Compare snapshot</DialogTitle>
          <DialogDescription>
            {target?.name} · saved Manage settings only
          </DialogDescription>
        </DialogHeader>
        {target ? <SettingsChanges differences={differences} /> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onClose}
          >
            Close comparison
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ManagePreviewDialogProps = {
  preview: PreviewState | null;
  onClose: () => void;
};

export function ManagePreviewDialog({
  preview,
  onClose,
}: ManagePreviewDialogProps) {
  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{preview?.title ?? "Details"}</DialogTitle>
          <DialogDescription>
            {preview?.description ?? "Details"}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55dvh] overflow-y-auto py-2">
          {preview?.body}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onClose}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
