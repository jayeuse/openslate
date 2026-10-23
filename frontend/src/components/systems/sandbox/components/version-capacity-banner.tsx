"use client";

import { useRef, useState } from "react";
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
import type { SandboxCommandResult } from "../state/commands";

export type VersionCapacityActions = {
  state:
    | { status: "loading" }
    | { status: "unavailable" }
    | { status: "ready"; mutableCount: number; versionCap: number };
  pending: boolean;
  onRetry: () => Promise<void>;
  onPrune: () => Promise<SandboxCommandResult<number>>;
};

export function VersionCapacityBanner({
  state,
  pending,
  onRetry,
  onPrune,
}: VersionCapacityActions) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  async function prune() {
    if (submitting.current || pending || state.status !== "ready") return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await onPrune();
      if (result.ok) setOpen(false);
      else setError(result.error);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const capacity = state.status === "ready" && state.mutableCount >= 45;
  return (
    <>
      {state.status === "loading" ? (
        <p role="status" className="text-muted-foreground text-sm">
          Checking version capacity…
        </p>
      ) : state.status === "unavailable" ? (
        <Alert variant="destructive" className="space-y-3">
          <p>
            Version capacity is unavailable. Retry before deleting old
            checkpoints.
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={pending || busy}
            onClick={() => void onRetry()}
          >
            Retry capacity
          </Button>
        </Alert>
      ) : capacity ? (
        <Alert variant="warning" className="space-y-3">
          <p>
            {state.mutableCount} of {state.versionCap} versions used. Delete the
            oldest unpublished checkpoints to free space.
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={pending || busy}
            onClick={() => {
              setError("");
              setOpen(true);
            }}
          >
            Delete old checkpoints
          </Button>
        </Alert>
      ) : null}
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!submitting.current) setOpen(next);
        }}
      >
        <AlertDialogContent className="slim-ui">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete old checkpoints?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete the oldest unpublished checkpoints and imported versions
              until 40 remain. Published versions and the newest version are
              kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <Alert role="alert" variant="destructive">
              {error}
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={busy || pending || state.status !== "ready"}
              onClick={() => void prune()}
            >
              {busy ? "Deleting…" : "Delete old checkpoints"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
