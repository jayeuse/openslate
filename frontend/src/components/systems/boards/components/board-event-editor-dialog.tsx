"use client";

import { useState, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import { cn } from "@/lib/utils";
import type { BoardAttachmentVersions } from "../adapters/board-files-api";
import {
  boardEventLinksChanged,
  ServerBoardEventEditorForm,
  type BoardEventDraft,
  type BoardEventLatestVersion,
} from "./server-backed-board-event-editor";
import { ConfirmAction } from "./ui";

export type EventConflict = {
  eventId: string | null;
  status: "needs-check" | "checking" | "ready";
  latest: BoardEventLatestVersion | null;
};

/**
 * The event editor in the shared dialog frame (BR21). Closing with changes
 * asks first. A conflict reads "Someone changed this event first." with
 * Use latest and Keep mine.
 */
export function BoardEventEditorDialog({
  draft,
  dirty,
  busy,
  conflict,
  error,
  onChange,
  onClose,
  onSave,
  onCheckLatest,
  onUseLatest,
  onKeepMine,
  onAttachmentBusyChange,
  onRecordLinkBusyChange,
  refreshAttachmentVersions,
  leading,
  leadingId,
}: {
  /**
   * My calendar's Board field, first in the form; the editor opens on it
   * (`leadingId` names its control).
   */
  leading?: ReactNode;
  leadingId?: string;
  draft: BoardEventDraft | null;
  dirty: boolean;
  busy: boolean;
  conflict: EventConflict | null;
  error: string | null;
  onChange: (patch: Partial<BoardEventDraft>) => void;
  onClose: () => void;
  onSave: () => void;
  onCheckLatest: () => void;
  onUseLatest: () => void;
  onKeepMine: () => void;
  onAttachmentBusyChange: (busy: boolean) => void;
  onRecordLinkBusyChange: (busy: boolean) => void;
  refreshAttachmentVersions: () => Promise<BoardAttachmentVersions>;
}) {
  const [discardOpen, setDiscardOpen] = useState(false);
  function requestClose() {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  }
  const title = draft?.eventId
    ? draft.recurrence === "none"
      ? "Edit event"
      : "Edit event series"
    : "New event";
  return (
    <>
      <Dialog
        open={draft !== null}
        dismissible={!busy}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <DialogContent
          className={cn(dialogFrameContentClass, "max-w-2xl")}
          // The editor opens on its first field: the Board, else the title.
          initialFocus={() =>
            document.getElementById(
              leading && leadingId ? leadingId : "live-board-event-title",
            )
          }
        >
          <DialogFrameHeader
            title={<DialogTitle>{title}</DialogTitle>}
            closeLabel="Close event editor"
            closeDisabled={busy}
            onClose={requestClose}
          />
          {draft && conflict ? (
            <ConflictNotice
              draft={draft}
              conflict={conflict}
              busy={busy}
              onCheckLatest={onCheckLatest}
              onUseLatest={onUseLatest}
              onKeepMine={onKeepMine}
            />
          ) : null}
          {draft ? (
            <ServerBoardEventEditorForm
              draft={draft}
              busy={busy}
              saveBlocked={conflict !== null}
              error={error}
              onChange={onChange}
              onCancel={requestClose}
              onSave={onSave}
              onAttachmentBusyChange={onAttachmentBusyChange}
              onRecordLinkBusyChange={onRecordLinkBusyChange}
              refreshAttachmentVersions={refreshAttachmentVersions}
              leading={leading}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmAction
        open={discardOpen}
        title="Discard unsaved event changes?"
        description="Your changes to this event will be lost."
        action="Discard changes"
        disabled={busy}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          setDiscardOpen(false);
          onClose();
        }}
      />
    </>
  );
}

function ConflictNotice({
  draft,
  conflict,
  busy,
  onCheckLatest,
  onUseLatest,
  onKeepMine,
}: {
  draft: BoardEventDraft;
  conflict: EventConflict;
  busy: boolean;
  onCheckLatest: () => void;
  onUseLatest: () => void;
  onKeepMine: () => void;
}) {
  const latest = conflict.latest;
  const editable =
    latest !== null && latest.boardActive && !latest.event?.archived;
  let linksChanged = false;
  try {
    linksChanged = boardEventLinksChanged(draft);
  } catch {
    linksChanged = false;
  }
  return (
    <Alert variant="warning">
      <div className="flex min-w-0 flex-col gap-3">
        <p className="font-medium">Someone changed this event first.</p>
        {conflict.status === "needs-check" ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-start xl:min-h-8"
            disabled={busy}
            onClick={onCheckLatest}
          >
            Check latest version
          </Button>
        ) : null}
        {conflict.status === "checking" ? (
          <p role="status">Checking the latest version…</p>
        ) : null}
        {conflict.status === "ready" && latest?.event ? (
          <details className="rounded-md border p-3 text-sm">
            <summary className="min-h-11 cursor-pointer py-2 font-medium xl:min-h-8 xl:py-1">
              Review the latest saved event
            </summary>
            <dl className="mt-2 grid gap-2 break-words">
              <div>
                <dt className="font-medium">Title</dt>
                <dd>{latest.event.title}</dd>
              </div>
              <div>
                <dt className="font-medium">Details</dt>
                <dd className="whitespace-pre-wrap">
                  {latest.event.details || "None"}
                </dd>
              </div>
              <div>
                <dt className="font-medium">Location</dt>
                <dd>{latest.event.location || "None"}</dd>
              </div>
            </dl>
          </details>
        ) : null}
        {conflict.status === "ready" && editable ? (
          <>
            <div className="flex flex-wrap gap-2">
              {latest?.event ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 xl:min-h-8"
                  disabled={busy}
                  onClick={onUseLatest}
                >
                  Use latest
                </Button>
              ) : null}
              <Button
                type="button"
                className="min-h-11 xl:min-h-8"
                disabled={busy}
                onClick={onKeepMine}
              >
                Keep mine
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">
              {latest?.event
                ? `Keep mine saves your title, details, place, and time over theirs. ${linksChanged ? "Your links replace theirs." : "Their links stay."}`
                : "Keep mine creates the event on the latest board."}
            </p>
          </>
        ) : null}
        {conflict.status === "ready" ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 self-start xl:min-h-8"
            disabled={busy}
            onClick={onCheckLatest}
          >
            Check again
          </Button>
        ) : null}
      </div>
    </Alert>
  );
}
