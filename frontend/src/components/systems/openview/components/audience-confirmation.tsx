"use client";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type OpenViewAudienceConfirmationProps = {
  open: boolean;
  artifact: "widget" | "artifact";
  cancelLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
};

/** Confirm the same sample-only audience expansion across OpenView editors. */
export function OpenViewAudienceConfirmation({
  open,
  artifact,
  cancelLabel,
  onCancel,
  onConfirm,
}: OpenViewAudienceConfirmationProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Preview sharing with everyone?</AlertDialogTitle>
          <AlertDialogDescription>
            This shows how a wider audience would appear. It does not grant
            access, send invitations, or publish this {artifact}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button className="min-h-11" onClick={onConfirm}>
            Use Everyone preview
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
