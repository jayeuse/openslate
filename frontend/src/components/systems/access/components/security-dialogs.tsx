"use client";

import type { ReactNode, RefObject } from "react";
import { MfaPresentation, useMfaFlow } from "@/components/mfa-flow";
import { useQuery } from "@tanstack/react-query";
import { workspaceCalendarQueryOptions } from "../../manage/adapters/workspace-api";
import { useDisplayRegion } from "@/components/use-display-region";

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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";

export type ConfirmState = {
  origin?: "admin-sessions";
  /** End all remote sessions states its count, read when it opens. */
  kind?: "end-all";
  title: string;
  description: string;
  confirmLabel: string;
  /** The confirm button's label while the action runs ("Ending…"). */
  pendingLabel?: string;
  requiresDraftAck?: boolean;
  body?: ReactNode;
  action: () => Promise<boolean>;
};

type AccessConfirmationDialogProps = {
  confirm: ConfirmState | null;
  pending: boolean;
  actionsDisabled: boolean;
  error: string;
  draftAcknowledged: boolean;
  confirmOpener: RefObject<HTMLElement | null>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onDraftAcknowledgedChange: (checked: boolean) => void;
};

export function AccessConfirmationDialog({
  confirm,
  pending,
  actionsDisabled,
  error,
  draftAcknowledged,
  confirmOpener,
  headingRef,
  onClose,
  onDraftAcknowledgedChange,
}: AccessConfirmationDialogProps) {
  return (
    <AlertDialog
      open={confirm !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent
        className="access-ui slim-ui"
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
            pending={pending}
            pendingLabel={confirm?.pendingLabel ?? "Saving…"}
            disabled={Boolean(
              actionsDisabled ||
              (confirm?.requiresDraftAck && !draftAcknowledged),
            )}
            onClick={async () => {
              if (!confirm || pending || actionsDisabled) return;
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

type AccessMfaDialogProps = {
  opener: RefObject<HTMLButtonElement | null>;
};

export function AccessMfaDialog({ opener }: AccessMfaDialogProps) {
  const flow = useMfaFlow();
  const region = useQuery({
    ...workspaceCalendarQueryOptions(),
    enabled: flow.open && flow.mode === "workspace",
  });
  const displayRegion = useDisplayRegion(region.data);
  // Visibility changes belong to the AppPage identity gate, not cancellation.
  // Only actual dialog dismissal or leaving Access removes owned setup.
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
          <DialogTitle>Two-step verification</DialogTitle>
          <DialogDescription>
            Set up an authenticator app for this account. Ask your administrator
            if you need to recover your account.
          </DialogDescription>
        </DialogHeader>
        <MfaPresentation flow={flow} region={displayRegion} />
      </DialogContent>
    </Dialog>
  );
}
