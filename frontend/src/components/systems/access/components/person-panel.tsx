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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";

import { formatDate, roleLabels, type DirectoryRow } from "../helpers/people";
import type { AccessUser } from "../state/api";
import { useAccessDraftNavigation } from "../state/draft-navigation";
import { DiscardChangesDialog } from "./people-fields";
import { PersonAccess } from "./person-access";
import { PersonAccount } from "./person-account";
import { PersonDetails } from "./person-details";
import { PersonSecurity } from "./person-security";
import { PersonSessions } from "./person-sessions";

type PanelTab = "details" | "access" | "sessions" | "security";

/**
 * One person, opened from the directory. On a phone it fills the screen.
 * Closing with unsaved details asks first; the editor owns the draft.
 */
export function PersonPanel({
  row,
  people,
  listFresh,
  onClose,
}: {
  row: DirectoryRow | null;
  people: readonly AccessUser[];
  listFresh: boolean;
  onClose: () => void;
}) {
  const signedInId = useVerifiedWorkspaceUserId();
  const { hasUnsavedDraft, hasPendingOperation, discardUnsavedDrafts } =
    useAccessDraftNavigation();
  const [blocked, setBlocked] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [tab, setTab] = useState<PanelTab>("details");
  const person = row?.user ?? null;

  function requestClose() {
    if (hasPendingOperation) {
      setBlocked(true);
      return;
    }
    if (hasUnsavedDraft) setConfirmClose(true);
    else {
      setTab("details");
      onClose();
    }
  }

  return (
    <>
      <Sheet
        open={row !== null}
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <SheetContent className="w-full max-w-none gap-0 p-0 sm:w-[min(92vw,42rem)]">
          {row && person ? (
            <>
              <SheetHeader className="border-b p-5 pr-16">
                <SheetTitle className="text-lg break-words">
                  {row.name}
                </SheetTitle>
                <SheetDescription className="break-words">
                  {person.email}
                  {person.job_title ? ` · ${person.job_title}` : ""}
                </SheetDescription>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Badge variant="secondary">{roleLabels[person.role]}</Badge>
                  <Badge variant={row.state.tone}>{row.state.label}</Badge>
                  {row.state.expiresSoon ? (
                    <Badge variant="warning">
                      Ends {formatDate(person.expires_at)}
                    </Badge>
                  ) : null}
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
                  Finish the current change before closing or switching tabs.
                </Alert>
              ) : null}
              <Tabs
                value={tab}
                onValueChange={(value) => {
                  if (hasPendingOperation) {
                    setBlocked(true);
                    return;
                  }
                  if (
                    value === "details" ||
                    value === "access" ||
                    value === "sessions" ||
                    value === "security"
                  )
                    setTab(value);
                }}
                className="gap-0"
              >
                <div className="border-b px-5 py-3">
                  <TabsList
                    aria-label="Person"
                    className="grid w-full grid-cols-4 sm:w-fit"
                  >
                    <TabsTrigger className="min-h-9" value="details">
                      Details
                      {hasUnsavedDraft ? (
                        <>
                          <span
                            aria-hidden="true"
                            className="bg-warn ml-1 size-1.5 shrink-0 rounded-full"
                          />
                          <span className="sr-only">, unsaved changes</span>
                        </>
                      ) : null}
                    </TabsTrigger>
                    <TabsTrigger className="min-h-9" value="access">
                      Access
                    </TabsTrigger>
                    <TabsTrigger className="min-h-9" value="sessions">
                      Sessions
                    </TabsTrigger>
                    <TabsTrigger className="min-h-11" value="security">
                      Security
                    </TabsTrigger>
                  </TabsList>
                </div>
                {/* The editor stays mounted while other tabs show, so a
                    draft survives a look at Access or Sessions. */}
                <TabsContent value="details" keepMounted className="p-5">
                  <div className="flex flex-col gap-6">
                    <PersonDetails
                      key={person.id}
                      person={person}
                      people={people}
                      listFresh={listFresh}
                    />
                    <PersonAccount
                      key={`account-${person.id}`}
                      person={person}
                      groups={row.groups}
                      self={person.id === signedInId}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="access" className="p-5">
                  <PersonAccess person={person} />
                </TabsContent>
                <TabsContent value="sessions" className="p-5">
                  <PersonSessions
                    person={person}
                    self={person.id === signedInId}
                  />
                </TabsContent>
                <TabsContent value="security" className="p-5">
                  <PersonSecurity
                    key={`${signedInId}-${person.id}`}
                    person={person}
                  />
                </TabsContent>
              </Tabs>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
      <DiscardChangesDialog
        open={confirmClose}
        title="Discard unsaved changes?"
        description="Your changes to this person have not been saved."
        onKeep={() => setConfirmClose(false)}
        onDiscard={() => {
          if (!discardUnsavedDrafts()) return;
          setConfirmClose(false);
          setTab("details");
          onClose();
        }}
      />
    </>
  );
}
