"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { plural } from "../helpers/designer-impacts";
import type { TriggerDraft } from "./use-trigger-draft";

/**
 * Leaving the Triggers section with unsaved changes asks what to do with
 * them: Save, Discard, or Stay (decision D1). A failed save stays in the
 * dialog with its reason; Escape and Stay keep the draft and the page.
 */
export function TriggerLeaveDialog({
  open,
  draft,
  onStay,
  onLeave,
}: {
  open: boolean;
  draft: Pick<TriggerDraft, "changes" | "save" | "discard">;
  onStay: () => void;
  onLeave: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || saving) return;
        setError("");
        onStay();
      }}
    >
      <DialogContent className="slim-ui grid gap-4">
        <DialogTitle>Unsaved trigger changes</DialogTitle>
        <DialogDescription>
          Discard removes {plural(draft.changes, "unsaved change")}.
        </DialogDescription>
        {error ? (
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        ) : null}
        <DialogFooter className="mt-1">
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => {
              setError("");
              onStay();
            }}
          >
            Stay
          </Button>
          <Button
            variant="outline"
            className="text-danger-text"
            disabled={saving}
            onClick={() => {
              setError("");
              draft.discard();
              onLeave();
            }}
          >
            Discard
          </Button>
          <Button
            pending={saving}
            pendingLabel="Saving…"
            onClick={async () => {
              setSaving(true);
              setError("");
              const result = await draft.save();
              setSaving(false);
              if (result.ok) onLeave();
              else setError(result.error);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
