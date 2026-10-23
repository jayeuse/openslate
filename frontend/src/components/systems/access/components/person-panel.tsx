"use client";

import { useState } from "react";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
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
import type { AccessDirectoryUser, AccessUser } from "../state/api";
import type { PersonMemberships } from "../hooks/use-people-memberships";
import { useAccessDraftNavigation } from "../state/draft-navigation";
import type { DraftScope } from "../state/draft-registry";
import { DiscardChangesDialog } from "./people-fields";
import { PersonAccess } from "./person-access";
import { PersonAccount } from "./person-account";
import { PersonDetails } from "./person-details";
import { PersonFacts } from "./person-facts";
import { PersonSecurity } from "./person-security";
import { PersonSessions } from "./person-sessions";

type PanelTab = "details" | "access" | "sessions" | "security";

/** The drafts this sheet owns; other Access drafts stay as they are. */
const personSheet: DraftScope = (id) =>
  id === "person-editor" || id.startsWith("person-security-");

/**
 * One person, opened from the directory. On a phone it fills the screen.
 * Closing with unsaved details asks first; the editor owns the draft.
 */
export function PersonPanel({
  row,
  membership,
  recorded,
  people,
  listFresh,
  onClose,
}: {
  row: DirectoryRow<AccessDirectoryUser> | null;
  /**
   * The person's directory row when it is on the current page: the read a
   * session change refreshes, so its recorded facts are the newest.
   */
  recorded?: AccessDirectoryUser;
  membership?: PersonMemberships;
  people: readonly AccessUser[];
  listFresh: boolean;
  onClose: () => void;
}) {
  const signedInId = useVerifiedWorkspaceUserId();
  const region = useWorkspaceDisplayRegion();
  const { unsavedIn, pendingIn, discardUnsavedDrafts } =
    useAccessDraftNavigation();
  const hasUnsavedDraft = unsavedIn(personSheet);
  const hasPendingOperation = pendingIn(personSheet);
  const [blocked, setBlocked] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [discardError, setDiscardError] = useState("");
  const [tab, setTab] = useState<PanelTab>("details");
  const person = row?.user ?? null;

  function requestClose() {
    if (hasPendingOperation) {
      setBlocked(true);
      return;
    }
    if (hasUnsavedDraft) {
      setDiscardError("");
      setConfirmClose(true);
    } else {
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
        <SheetContent className="access-ui flex w-full max-w-none flex-col gap-0 overflow-hidden p-0 sm:w-[min(92vw,42rem)]">
          {row && person ? (
            <>
              <SheetHeader className="shrink-0 border-b p-5 pr-16">
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
                      Ends {formatDate(person.expires_at, region)}
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
                <Alert className="m-5 mb-0 shrink-0">
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
                className="min-h-0 flex-1 gap-0"
              >
                <div className="shrink-0 border-b px-5 py-3">
                  <TabsList
                    aria-label="Person"
                    className="grid w-full grid-cols-4 sm:w-fit"
                  >
                    <TabsTrigger
                      className="min-h-11 xl:min-h-8"
                      value="details"
                    >
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
                    <TabsTrigger className="min-h-11 xl:min-h-8" value="access">
                      Access
                    </TabsTrigger>
                    <TabsTrigger
                      className="min-h-11 xl:min-h-8"
                      value="sessions"
                    >
                      Sessions
                    </TabsTrigger>
                    <TabsTrigger
                      className="min-h-11 xl:min-h-8"
                      value="security"
                    >
                      Security
                    </TabsTrigger>
                  </TabsList>
                </div>
                {/* The editor stays mounted while other tabs show, so a
                    draft survives a look at Access or Sessions. */}
                <TabsContent
                  value="details"
                  keepMounted
                  className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-5"
                >
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
                      membership={membership}
                      self={person.id === signedInId}
                    />
                    <PersonFacts
                      person={recorded?.id === person.id ? recorded : person}
                      membership={membership}
                    />
                  </div>
                </TabsContent>
                <TabsContent
                  value="access"
                  className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-5"
                >
                  <PersonAccess person={person} />
                </TabsContent>
                <TabsContent
                  value="sessions"
                  className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-5"
                >
                  <PersonSessions
                    person={person}
                    self={person.id === signedInId}
                  />
                </TabsContent>
                <TabsContent
                  value="security"
                  className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-5"
                >
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
        error={discardError}
        onKeep={() => setConfirmClose(false)}
        onDiscard={() => {
          if (!discardUnsavedDrafts(personSheet)) {
            setDiscardError(
              "Your draft could not be cleared from this browser. Keep editing, or try again.",
            );
            return;
          }
          setConfirmClose(false);
          setTab("details");
          onClose();
        }}
      />
    </>
  );
}
