"use client";

import type { Ref } from "react";
import { AlertCircle, ShieldCheck } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ConflictChoice, FieldConflict } from "../helpers/editor-helpers";

// Shared review and conflict surfaces for Access editors. An editor shows
// UncertainDraftWarning when a submitted draft may have completed, and
// ConflictDialog when the server changed a field the draft also changed.

export type DraftReviewValues = {
  name: string;
  description: string;
  entries: readonly { id: string; label: string }[];
};

function DraftReviewDetails({
  label,
  values,
  entriesLabel,
}: {
  label: string;
  values: DraftReviewValues;
  entriesLabel: string;
}) {
  return (
    <section aria-label={label} className="rounded-md border p-3 text-sm">
      <h4 className="font-medium">{label}</h4>
      <dl className="mt-2 space-y-2">
        <div>
          <dt className="text-muted-foreground">Name</dt>
          <dd className="break-words whitespace-pre-wrap">{values.name}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Description</dt>
          <dd className="break-words whitespace-pre-wrap">
            {values.description || "None"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{entriesLabel}</dt>
          <dd>
            {values.entries.length ? (
              <ul className="list-inside list-disc">
                {values.entries.map((entry) => (
                  <li key={entry.id} className="break-words">
                    {entry.label}
                  </li>
                ))}
              </ul>
            ) : (
              "None"
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function UncertainDraftWarning({
  subject,
  currentSummary,
  savedValues,
  currentValues,
  entriesLabel,
  canResolve,
  pending,
  onResolve,
}: {
  subject: "person" | "group";
  currentSummary: string;
  savedValues: DraftReviewValues;
  currentValues: DraftReviewValues | null;
  entriesLabel: string;
  canResolve: boolean;
  pending: boolean;
  onResolve: () => void;
}) {
  return (
    <Alert role="alert">
      <ShieldCheck aria-hidden />
      <div className="mt-2 space-y-2">
        <p className="font-medium">
          This change to the {subject} may have completed.
        </p>
        <p>
          The saved values are read-only. Review the current Access state before
          starting a new draft.
        </p>
        {canResolve && <p>{currentSummary}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <DraftReviewDetails
            label={`Saved ${subject} draft`}
            values={savedValues}
            entriesLabel={entriesLabel}
          />
          {canResolve && currentValues ? (
            <DraftReviewDetails
              label={`Current Access ${subject}`}
              values={currentValues}
              entriesLabel={entriesLabel}
            />
          ) : (
            <section
              aria-label={`Current Access ${subject}`}
              className="rounded-md border p-3 text-sm"
            >
              <h4 className="font-medium">Current Access {subject}</h4>
              <p className="mt-2">
                {canResolve
                  ? `No matching ${subject} is present in current Access.`
                  : "Reload Access to compare the current values."}
              </p>
            </section>
          )}
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={pending}
          onClick={canResolve ? onResolve : () => window.location.reload()}
        >
          {canResolve ? "Discard after review" : "Reload Access to review"}
        </Button>
      </div>
    </Alert>
  );
}

export function ConflictDialog({
  open,
  title,
  conflicts,
  choices,
  onChoice,
  onCancel,
  onContinue,
}: {
  open: boolean;
  title: string;
  conflicts: FieldConflict[];
  choices: Record<string, ConflictChoice | undefined>;
  onChoice: (field: string, choice: ConflictChoice) => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const resolved = conflicts.every((conflict) => Boolean(choices[conflict.id]));
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="access-ui slim-ui max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            These fields changed after you opened the editor. Choose which value
            to keep for each field.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {conflicts.map((conflict) => {
            const choice = choices[conflict.id];
            return (
              <FieldSet key={conflict.id}>
                <FieldLegend>{conflict.label}</FieldLegend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md border p-3 text-sm">
                    <p className="text-muted-foreground text-xs">Current</p>
                    <p className="mt-1 break-words">
                      {conflict.current || "Empty"}
                    </p>
                  </div>
                  <div className="rounded-md border p-3 text-sm">
                    <p className="text-muted-foreground text-xs">Your draft</p>
                    <p className="mt-1 break-words">
                      {conflict.draft || "Empty"}
                    </p>
                  </div>
                </div>
                <ToggleGroup
                  aria-label={`Resolve ${conflict.label}`}
                  value={choice ? [choice] : []}
                  onValueChange={(values) => {
                    const value = values[0];
                    if (value === "current" || value === "draft")
                      onChoice(conflict.id, value);
                  }}
                >
                  <ToggleGroupItem className="min-h-11" value="current">
                    Keep current
                  </ToggleGroupItem>
                  <ToggleGroupItem className="min-h-11" value="draft">
                    Use draft
                  </ToggleGroupItem>
                </ToggleGroup>
              </FieldSet>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onCancel}>
            Back to editor
          </Button>
          <Button
            className="min-h-11"
            disabled={!resolved}
            onClick={onContinue}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A failed action's reason; `title` null shows the reason alone. */
export function ActionError({
  message,
  title = "Could not apply the change",
}: {
  message: string;
  title?: string | null;
}) {
  if (!message) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle />
      <div className="mt-2">
        {title ? <p className="font-medium">{title}</p> : null}
        <p className={title ? "mt-1" : undefined}>{message}</p>
      </div>
    </Alert>
  );
}

/**
 * After Discard in a sheet editor: the result in place, with Undo. A toast
 * would sit behind the open sheet, out of reach, so the Undo stays inline
 * (the Four Moments Rule: inline when the result is visible).
 */
export function DiscardedNotice({
  onUndo,
  undoRef,
}: {
  onUndo: () => void;
  /** Focus moves here after Discard, so it never falls to the sheet. */
  undoRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <p
      role="status"
      className="text-muted-foreground flex items-center justify-end gap-1 text-sm"
    >
      Changes discarded
      <Button
        ref={undoRef}
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-11 px-2"
        onClick={onUndo}
      >
        Undo
      </Button>
    </p>
  );
}
