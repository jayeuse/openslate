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

/**
 * The shell's question before a sign-out or an organization switch clears an
 * Access save that may have completed. The navigation guard owns its state
 * and loads this file only when the question first shows.
 */
export function WorkspaceUncertainSaveDialog({
  open,
  discardFailed,
  onKeepEditing,
  onDiscard,
}: {
  open: boolean;
  discardFailed: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onKeepEditing()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            A change in Access may not have been saved. Leaving this page
            discards it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {discardFailed ? (
          <p role="alert" className="text-destructive text-sm">
            Your draft could not be cleared from this browser. Keep editing, or
            try again.
          </p>
        ) : null}
        <AlertDialogFooter>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={onKeepEditing}
          >
            Keep editing
          </Button>
          <Button
            variant="destructive"
            className="min-h-11"
            onClick={onDiscard}
          >
            Discard changes
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
