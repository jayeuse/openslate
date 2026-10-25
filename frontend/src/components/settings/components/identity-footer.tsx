"use client";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { unsavedChangesLabel } from "@/lib/unsaved-changes";
import type { IdentityEditor } from "../hooks/use-identity-editor";

/**
 * The pinned footer of the settings panel (PD10), after Manage's: the
 * save-state chip, Discard changes while there is a draft, and Save profile,
 * the page's one primary action, which says why it waits at rest. A save
 * error shows here, beside the button that caused it. From 1280px it ends
 * the panel; on smaller screens it sticks to the bottom of the viewport.
 */
export function IdentityFooter({ editor }: { editor: IdentityEditor }) {
  const count = editor.changed.length;
  return (
    <div
      role="group"
      aria-label="Profile actions"
      className="bg-card border-border sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-b-[var(--radius)] border-t px-4 py-3 sm:px-6 xl:static"
    >
      {editor.saveError ? (
        <Alert role="alert" variant="destructive" className="basis-full">
          {editor.saveError}
        </Alert>
      ) : null}
      <span role="status" className="inline-flex items-center">
        {editor.pending ? (
          <Badge variant="outline">Saving profile…</Badge>
        ) : count ? (
          <Badge variant="warning">{unsavedChangesLabel(count)}</Badge>
        ) : (
          <Badge variant="outline" data-save-state="saved">
            {editor.saved ? "Profile saved." : "Saved"}
          </Badge>
        )}
      </span>
      <span className="ml-auto flex items-center gap-2">
        {count ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={editor.pending}
            onClick={editor.discard}
          >
            Discard changes
          </Button>
        ) : null}
        <DisabledReason
          stable
          reason={
            editor.pending
              ? "Saving the profile."
              : count
                ? null
                : "No changes to save."
          }
        >
          <Button
            type="submit"
            form="identity-form"
            className="min-h-11"
            disabled={!count || editor.blocked}
          >
            Save profile
          </Button>
        </DisabledReason>
      </span>
    </div>
  );
}
