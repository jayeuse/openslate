"use client";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";

import { unsavedChangesLabel } from "@/lib/unsaved-changes";

/**
 * The pinned footer of the Organization settings (MD4): the save-state chip,
 * Discard only while there is a draft, and Save settings, which says why it
 * waits at rest. A save error shows here, beside the button that caused it.
 * From 1280px it ends the panel; on smaller screens it sticks to the bottom
 * of the viewport while the settings are in view.
 */
export function OrganizationFooter({
  unsavedCount,
  checkingSaved,
  saveLabel,
  saveError,
  saving,
  disabled,
  onDiscard,
}: {
  /** Changes in the draft; 0 means nothing to save. */
  unsavedCount: number;
  /**
   * A save landed but its readback failed: the held draft is neither saved
   * nor unsaved until a fresh read confirms it.
   */
  checkingSaved: boolean;
  saveLabel: string;
  saveError: string;
  /**
   * A save is running. Save stays focusable (`aria-disabled`, through its
   * reason) so focus does not drop to the page while it runs (Phase 8).
   */
  saving: boolean;
  /** The settings cannot be saved now (loading, a refusal, a pending save). */
  disabled: boolean;
  onDiscard: () => void;
}) {
  const dirty = unsavedCount > 0;
  return (
    <div
      role="group"
      aria-label="Organization actions"
      className="bg-card border-border sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-b-[var(--radius)] border-t px-4 py-3 sm:px-6"
    >
      {saveError ? (
        <Alert role="alert" variant="destructive" className="basis-full">
          {saveError}
        </Alert>
      ) : null}
      <span role="status" className="inline-flex items-center">
        {checkingSaved ? (
          <Badge variant="outline">Checking saved changes…</Badge>
        ) : dirty ? (
          <Badge variant="warning">{unsavedChangesLabel(unsavedCount)}</Badge>
        ) : (
          <Badge variant="outline" data-save-state="saved">
            Saved
          </Badge>
        )}
      </span>
      {/* The buttons wrap as one, so on a phone they share the next line. */}
      <span className="ml-auto flex items-center gap-2">
        {dirty ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={disabled}
            onClick={onDiscard}
          >
            Discard changes
          </Button>
        ) : null}
        <DisabledReason
          stable
          reason={
            saving
              ? "Saving the settings."
              : checkingSaved
                ? "Checking the saved changes first."
                : dirty
                  ? null
                  : "No changes to save."
          }
        >
          <Button
            type="submit"
            className="min-h-11"
            disabled={!dirty || disabled}
          >
            {saveLabel}
          </Button>
        </DisabledReason>
      </span>
    </div>
  );
}
