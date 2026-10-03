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

export type ConfirmActionRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  /** Focus returns here when the dialog closes. */
  opener?: HTMLElement | null;
};

/** Asks before an OpenComms action that is hard to notice or reverse. */
export function ConfirmActionDialog({
  request,
  onClose,
}: {
  request: ConfirmActionRequest | null;
  onClose: () => void;
}) {
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {request && (
        <AlertDialogContent
          finalFocus={() =>
            request.opener?.isConnected ? request.opener : true
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{request.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {request.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" className="min-h-11" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant={request.destructive ? "destructive" : "default"}
              className="min-h-11"
              onClick={() => {
                onClose();
                request.onConfirm();
              }}
            >
              {request.confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
