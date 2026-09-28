"use client";

import { useState } from "react";
import { X } from "lucide-react";

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

import type { GroupRow, MemberOption } from "../helpers/groups";
import type { AccessDepartment, AccessModule } from "../state/api";
import { useAccessDraftNavigation } from "../state/draft-navigation";
import { GroupEditor, type GroupEditorTab } from "./group-editor";
import { DiscardChangesDialog } from "./people-fields";

/**
 * One group, opened from the list. On a phone it fills the screen. Closing
 * with unsaved changes asks first; the editor owns the drafts.
 */
export function GroupPanel({
  row,
  mode,
  departments,
  modules,
  memberOptions,
  listFresh,
  initialTab,
  onClose,
}: {
  row: GroupRow | null;
  mode: "admin" | "manager";
  departments: readonly AccessDepartment[];
  modules: readonly AccessModule[];
  memberOptions: readonly MemberOption[];
  listFresh: boolean;
  initialTab: GroupEditorTab | null;
  onClose: () => void;
}) {
  const { hasUnsavedDraft, discardUnsavedDrafts } = useAccessDraftNavigation();
  const [confirmClose, setConfirmClose] = useState(false);
  const defaultTab: GroupEditorTab = mode === "manager" ? "members" : "details";
  const [tab, setTab] = useState<GroupEditorTab | null>(null);
  const group = row?.group ?? null;

  function close() {
    setTab(null);
    onClose();
  }

  function requestClose() {
    if (hasUnsavedDraft) setConfirmClose(true);
    else close();
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
              <GroupEditor
                key={group.id}
                group={group}
                mode={mode}
                departments={departments}
                modules={modules}
                memberOptions={memberOptions}
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
        onKeep={() => setConfirmClose(false)}
        onDiscard={() => {
          if (!discardUnsavedDrafts()) return;
          setConfirmClose(false);
          close();
        }}
      />
    </>
  );
}
