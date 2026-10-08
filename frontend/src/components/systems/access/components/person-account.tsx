"use client";

import type { Route } from "next";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";

import { afterAccessUserChange } from "../adapters/access-queries";
import type { PersonMemberships } from "../hooks/use-people-memberships";
import {
  peopleErrorMessage,
  personName,
  personState,
  type NamedItem,
} from "../helpers/people";
import {
  deleteAccessUser,
  resendAccessInvitation,
  restoreAccessUser,
  revokeAccessInvitation,
  updateAccessUser,
  type AccessUser,
} from "../state/api";
import { ActionError } from "./editor-conflicts";

type AccountAction =
  "resend" | "revoke" | "disable" | "enable" | "delete" | "restore";

type ActionCopy = {
  button: string;
  title: string;
  description: string;
  confirm: string;
  done: string;
  destructive: boolean;
};

function actionCopy(action: AccountAction, person: AccessUser): ActionCopy {
  const name = personName(person);
  switch (action) {
    case "resend":
      return {
        button: "Resend invitation",
        title: "Resend the invitation?",
        description: `${person.email} gets a new invitation email.`,
        confirm: "Resend",
        done: "Invitation sent again",
        destructive: false,
      };
    case "revoke":
      return {
        button: "Revoke invitation",
        title: "Revoke the invitation?",
        description:
          "The link in the invitation email stops working. You can invite this email address again later.",
        confirm: "Revoke",
        done: "Invitation revoked",
        destructive: true,
      };
    case "disable":
      return {
        button: "Disable",
        title: `Disable ${name}?`,
        description:
          "They are signed out everywhere and cannot sign in until you enable them again.",
        confirm: "Disable",
        done: `${name} is disabled`,
        destructive: true,
      };
    case "enable":
      return {
        button: "Enable",
        title: `Enable ${name}?`,
        description: "They can sign in again with the access they had before.",
        confirm: "Enable",
        done: `${name} is enabled`,
        destructive: false,
      };
    case "delete":
      return {
        button: "Delete",
        title: `Delete ${name}?`,
        description:
          "They are signed out everywhere and leave the directory. You can restore them later.",
        confirm: "Delete",
        done: `${name} is deleted`,
        destructive: true,
      };
    case "restore":
      return {
        button: "Restore",
        title: `Restore ${name}?`,
        description: "They come back to the directory and can sign in again.",
        confirm: "Restore",
        done: `${name} is restored`,
        destructive: false,
      };
  }
}

function run(action: AccountAction, person: AccessUser): Promise<unknown> {
  switch (action) {
    case "resend":
      return resendAccessInvitation(person.id);
    case "revoke":
      return revokeAccessInvitation(person.id);
    case "disable":
      return updateAccessUser(person.id, { status: "disabled" });
    case "enable":
      return updateAccessUser(person.id, { status: "active" });
    case "delete":
      return deleteAccessUser(person.id);
    case "restore":
      return restoreAccessUser(person.id);
  }
}

/** The account actions the backend accepts for a person in this state. */
function availableActions(person: AccessUser, self: boolean): AccountAction[] {
  if (person.is_deleted) return person.status === "pending" ? [] : ["restore"];
  if (person.status === "pending") return ["resend", "revoke"];
  if (self) return [];
  return person.status === "disabled"
    ? ["enable", "delete"]
    : ["disable", "delete"];
}

export function PersonAccount({
  person,
  groups,
  membership,
  self,
}: {
  person: AccessUser;
  groups: readonly NamedItem[];
  membership?: PersonMemberships;
  self: boolean;
}) {
  const client = useQueryClient();
  const [action, setAction] = useState<AccountAction | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [now] = useState(() => Date.now());
  const actions = availableActions(person, self);
  const copy = action ? actionCopy(action, person) : null;
  const state = personState(person, now);

  async function confirm() {
    if (!action || !copy || pending) return;
    setPending(true);
    setError("");
    try {
      await run(action, person);
      toast.add({ title: copy.done, type: "success" });
      setAction(null);
    } catch (caught) {
      setError(
        peopleErrorMessage(caught, "The change could not be made. Try again."),
      );
    } finally {
      setPending(false);
      // A refused change may mean this person changed elsewhere.
      void afterAccessUserChange(client);
    }
  }

  return (
    <>
      <section aria-labelledby="person-groups-title" className="space-y-2">
        <h3 id="person-groups-title" className="font-semibold">
          Groups
        </h3>
        {person.role === "admin" ? (
          <p className="text-muted-foreground text-sm">
            Administrators have full access everywhere, so they are not members
            of groups.
          </p>
        ) : !membership || membership.loading ? (
          <p role="status" className="text-muted-foreground text-sm">
            Loading groups…
          </p>
        ) : membership.denied ||
          (membership.error && !groups.length) ? null : groups.length ? (
          <>
            <ul aria-label="Groups" className="flex flex-wrap gap-2">
              {groups.map((group) => (
                <li key={group.id}>
                  <GuardedWorkspaceLink
                    href={
                      `/access?view=groups&group=${encodeURIComponent(group.id)}&tab=members` as Route
                    }
                    className="bg-secondary text-secondary-foreground focus-visible:outline-ring inline-flex min-h-9 items-center rounded-md px-3 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    {group.name}
                  </GuardedWorkspaceLink>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-sm">
              Open a group to change who is in it.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            Not in any group yet, so this person has no access. Add them to a
            group on the Groups tab.
          </p>
        )}
        {person.role !== "admin" && membership ? (
          <>
            {!membership.denied &&
            (membership.hasMore || membership.loaded < membership.total) ? (
              <p className="text-muted-foreground text-sm">
                {membership.loaded} of {membership.total} groups
              </p>
            ) : null}
            {membership.error ? (
              <p role="alert" className="text-muted-foreground text-sm">
                {membership.error}
              </p>
            ) : null}
            {membership.retryFirstPage ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={membership.recovering}
                onClick={() => void membership.retry()}
              >
                Retry groups
              </Button>
            ) : null}
            {membership.hasMore ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={membership.loadingMore}
                onClick={() => void membership.loadMore()}
              >
                {membership.loadingMore
                  ? "Loading more groups…"
                  : "Load more groups"}
              </Button>
            ) : null}
          </>
        ) : null}
      </section>

      <section aria-labelledby="person-account-title" className="space-y-2">
        <h3 id="person-account-title" className="font-semibold">
          Account
        </h3>
        <p className="text-muted-foreground text-sm">
          {person.is_deleted
            ? person.status === "pending"
              ? "This invitation was revoked. Invite this email address again to give them access."
              : "This account is deleted."
            : person.status === "pending"
              ? "The invitation has not been accepted yet."
              : self
                ? "This is your account. Another administrator can disable or delete it."
                : state.id === "expired"
                  ? "This guest's access has ended. Set a later end date to let them sign in again."
                  : person.status === "disabled"
                    ? "This account cannot sign in."
                    : "This account can sign in."}
        </p>
        {actions.length ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {actions.map((item) => {
              const itemCopy = actionCopy(item, person);
              return (
                <Button
                  key={item}
                  variant={itemCopy.destructive ? "outline" : "secondary"}
                  className="min-h-11 w-full sm:w-auto"
                  onClick={() => {
                    setError("");
                    setAction(item);
                  }}
                >
                  {itemCopy.button}
                </Button>
              );
            })}
          </div>
        ) : null}
      </section>

      <AlertDialog
        open={action !== null}
        onOpenChange={(open) => !open && !pending && setAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <ActionError message={error} />
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={() => setAction(null)}
            >
              Cancel
            </Button>
            <Button
              variant={copy?.destructive ? "destructive" : "default"}
              className="min-h-11"
              disabled={pending}
              onClick={() => void confirm()}
            >
              {pending ? "Working…" : copy?.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
