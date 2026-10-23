"use client";

import { useState } from "react";
import { X } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import type { GroupRow } from "../helpers/groups";
import { useAccessDraftNavigation } from "../state/draft-navigation";
import type { DraftScope } from "../state/draft-registry";
import { GroupEditor, type GroupEditorTab } from "./group-editor";
import { DiscardChangesDialog } from "./people-fields";

/** The drafts this sheet owns; other Access drafts stay as they are. */
const groupSheet: DraftScope = (id) => id === "group-editor";

/**
 * One group, opened from the list. On a phone it fills the screen. Closing
 * with unsaved changes asks first; the editor owns the drafts.
 */
export function GroupPanel({
  row,
  mode,
  listFresh,
  initialTab,
  onClose,
}: {
  row: GroupRow | null;
  mode: "admin" | "manager";
  listFresh: boolean;
  initialTab: GroupEditorTab | null;
  onClose: () => void;
}) {
  const { unsavedIn, pendingIn, discardUnsavedDrafts } =
    useAccessDraftNavigation();
  const hasUnsavedDraft = unsavedIn(groupSheet);
  const hasPendingOperation = pendingIn(groupSheet);
  const [blocked, setBlocked] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [discardError, setDiscardError] = useState("");
  const defaultTab: GroupEditorTab = mode === "manager" ? "members" : "details";
  const [tab, setTab] = useState<GroupEditorTab | null>(null);
  const group = row?.group ?? null;

  function close() {
    setTab(null);
    setBlocked(false);
    onClose();
  }

  function requestClose() {
    // A save in flight finishes first, so it never reports a discarded change.
    if (hasPendingOperation) {
      setBlocked(true);
      return;
    }
    if (hasUnsavedDraft) {
      setDiscardError("");
      setConfirmClose(true);
    } else close();
  }

  const members = group?.member_ids.length ?? 0;

  return (
    <>
      <Sheet
        open={row !== null}
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <SheetContent className="w-full max-w-none gap-0 p-0 sm:w-[min(92vw,44rem)]">
          {row && group ? (
            <>
              <SheetHeader className="border-b p-5 pr-16">
                <SheetTitle className="text-lg break-words">
                  {group.name}
                </SheetTitle>
                <SheetDescription className="break-words">
                  {group.description || "No description"}
                </SheetDescription>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Badge variant="secondary">
                    {members} {members === 1 ? "member" : "members"}
                  </Badge>
                  <Badge variant={row.reach.length ? "secondary" : "warning"}>
                    {row.reach.length
                      ? `${row.reach.length} ${row.reach.length === 1 ? "department" : "departments"}`
                      : "No access"}
                  </Badge>
                </div>
              </SheetHeader>
              <SheetClose
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute top-3 right-3 size-11"
                    aria-label="Close"
                  />
                }
              >
                <X aria-hidden="true" />
              </SheetClose>
              {blocked && hasPendingOperation ? (
                <Alert className="m-5 mb-0">
                  Finish the current change before closing.
                </Alert>
              ) : null}
              <GroupEditor
                key={group.id}
                group={group}
                mode={mode}
                listFresh={listFresh}
                tab={tab ?? initialTab ?? defaultTab}
                onTabChange={setTab}
                onDeleted={close}
              />
            </>
          ) : null}
        </SheetContent>
      </Sheet>
      <DiscardChangesDialog
        open={confirmClose}
        title="Discard unsaved changes?"
        description="Your changes to this group have not been saved."
        error={discardError}
        onKeep={() => setConfirmClose(false)}
        onDiscard={() => {
          if (!discardUnsavedDrafts(groupSheet)) {
            setDiscardError(
              "Your draft could not be cleared from this browser. Keep editing, or try again.",
            );
            return;
          }
          setConfirmClose(false);
          close();
        }}
      />
    </>
  );
}
