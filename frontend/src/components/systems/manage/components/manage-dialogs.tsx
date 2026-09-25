"use client";

import type { FormEvent, ReactNode, RefObject } from "react";
import { Check, ChevronRight } from "lucide-react";

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
import { Progress } from "@/components/ui/progress";
import type { ManageSnapshot, ManageSnapshotDiff } from "../state/model";
import { SettingsChanges } from "./panel-ui";

export type ConfirmState = {
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
  open: boolean;
  step: number;
  opener: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  onBack: () => void;
  onNext: () => void;
};

export function ManageMfaDialog({
  open,
  step,
  opener,
  onOpenChange,
  onBack,
  onNext,
}: ManageMfaDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        finalFocus={() =>
          opener.current?.isConnected ? opener.current : false
        }
      >
        <DialogHeader>
          <DialogTitle>MFA enrollment</DialogTitle>
          <DialogDescription>
            Step {step + 1} of 3 · This walkthrough does not enroll a factor or
            generate recovery codes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <Progress
            value={step + 1}
            max={3}
            aria-label="MFA walkthrough progress"
          />
          {step === 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">Choose a factor</h3>
              <p className="text-muted-foreground text-sm">
                Choose an authenticator app or security key.
              </p>
            </div>
          ) : null}
          {step === 1 ? (
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">Verify the factor</h3>
              <p className="text-muted-foreground text-sm">
                This walkthrough stops before any code or credential is entered.
              </p>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">Review recovery options</h3>
              <p className="text-muted-foreground text-sm">
                Recovery options are stored securely by the account system.
              </p>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          {step > 0 ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={onBack}
            >
              Back
            </Button>
          ) : null}
          {step < 2 ? (
            <Button type="button" className="min-h-11" onClick={onNext}>
              Continue <ChevronRight data-icon="inline-end" />
            </Button>
          ) : (
            <Button
              type="button"
              className="min-h-11"
              onClick={() => onOpenChange(false)}
            >
              Done <Check data-icon="inline-end" />
            </Button>
          )}
        </DialogFooter>
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
