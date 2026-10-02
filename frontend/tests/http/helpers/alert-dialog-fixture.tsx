import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../src/components/ui/alert-dialog";

function CallerCancellationFixture() {
  const initiallyOpen = document.body.dataset.initialOpen === "true";
  const [cancelOpen, setCancelOpen] = useState(!initiallyOpen);
  const [cancelClose, setCancelClose] = useState(true);
  return (
    <>
      <button onClick={() => setCancelOpen(false)}>Allow opening</button>
      <AlertDialog
        defaultOpen={initiallyOpen}
        onOpenChange={(next, details) => {
          if (next ? cancelOpen : cancelClose) details.cancel();
        }}
      >
        <AlertDialogTrigger>Open confirmation</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Caller-controlled cancellation</AlertDialogTitle>
          <AlertDialogDescription>
            This unfinished confirmation must remain in its caller-approved
            state.
          </AlertDialogDescription>
          <button onClick={() => setCancelClose(false)}>Allow closing</button>
          <AlertDialogCancel>Close confirmation</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

createRoot(document.getElementById("fixture")!).render(
  <CallerCancellationFixture />,
);
