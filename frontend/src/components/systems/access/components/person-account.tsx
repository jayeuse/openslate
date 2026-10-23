"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AdvancedSection } from "@/components/ui/advanced-section";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { reportDone, reportError, reportUndoable } from "@/lib/feedback";

import { afterAccessUserChange } from "../adapters/access-queries";
import { peopleErrorMessage, personName, personState } from "../helpers/people";
import {
  deleteAccessUser,
  reconcileAccessInvitation,
  resendAccessInvitation,
  restoreAccessUser,
  revokeAccessInvitation,
  updateAccessUser,
  type AccessUser,
} from "../state/api";
import { useAccessVerifying, verifyingReason } from "../state/draft-navigation";
import { ActionError } from "./editor-conflicts";

type AccountAction =
  | "reconcile"
  | "resend"
  | "revoke"
  | "disable"
  | "enable"
  | "delete"
  | "restore";

type ActionCopy = {
  button: string;
  title: string;
  description: string;
  confirm: string;
  /** The confirm button's label while the request runs. */
  pending: string;
  done: string;
  destructive: boolean;
};

function actionCopy(action: AccountAction, person: AccessUser): ActionCopy {
  const name = personName(person);
  switch (action) {
    case "reconcile":
      return {
        button: "Finish sending invitation",
        title: "Finish sending the invitation?",
        description: `Complete the pending invitation for ${person.email}. They will receive an invitation email.`,
        confirm: "Finish sending",
        pending: "Sending…",
        done: "Invitation sent",
        destructive: false,
      };
    case "resend":
      return {
        button: "Resend invitation",
        title: "Resend the invitation?",
        description: `Renew the invitation for ${person.email}. Existing accounts accept when signed in; new accounts get an email.`,
        confirm: "Resend",
        pending: "Sending…",
        done: "Invitation sent again",
        destructive: false,
      };
    case "revoke":
      return {
        button: "Revoke invitation",
        title: "Revoke the invitation?",
        description:
          "This invitation can no longer be accepted, in the app or by email link.",
        confirm: "Revoke",
        pending: "Revoking…",
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
        pending: "Disabling…",
        done: `${name} is disabled`,
        destructive: true,
      };
    case "enable":
      return {
        button: "Enable",
        title: `Enable ${name}?`,
        description: "They can sign in again with the access they had before.",
        confirm: "Enable",
        pending: "Enabling…",
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
        pending: "Deleting…",
        done: `${name} deleted`,
        destructive: true,
      };
    case "restore":
      return {
        button: "Restore",
        title: `Restore ${name}?`,
        description: "They come back to the directory and can sign in again.",
        confirm: "Restore",
        pending: "Restoring…",
        done: `${name} is restored`,
        destructive: false,
      };
  }
}

function run(action: AccountAction, person: AccessUser): Promise<unknown> {
  switch (action) {
    case "reconcile":
      return reconcileAccessInvitation(person.id);
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
  if (person.status === "pending")
    return person.invitation_sent_at === null
      ? ["reconcile"]
      : ["resend", "revoke"];
  if (self) return [];
  return person.status === "disabled"
    ? ["enable", "delete"]
    : ["disable", "delete"];
}

/** Sending an invitation is the pending person's next step, so it stays in view. */
const inviteActions: readonly AccountAction[] = ["reconcile", "resend"];

type FocusTarget = readonly (AccountAction | "invitation")[];

/** Where focus goes once an action has run and its button may be gone. */
const focusAfter: Record<AccountAction, FocusTarget> = {
  reconcile: ["resend"],
  resend: ["resend"],
  revoke: ["invitation"],
  disable: ["enable"],
  enable: ["disable"],
  // A deleted person leaves the directory and the sheet closes.
  delete: [],
  restore: ["enable", "disable"],
};

/**
 * A person's account: a pending invitation's next step in view, then the
 * person's recorded facts (`children`), then the lifecycle actions in one
 * closed Advanced block, last in Details (the Advanced Last Rule). Deleting
 * closes the sheet and offers Undo, which restores the person.
 */
export function PersonAccount({
  person,
  self,
  onDeleted,
  children,
}: {
  person: AccessUser;
  self: boolean;
  /** The person left the directory; the sheet closes. */
  onDeleted: () => void;
  children?: ReactNode;
}) {
  const client = useQueryClient();
  const verifying = useAccessVerifying();
  const [action, setAction] = useState<AccountAction | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [now] = useState(() => Date.now());
  const mounted = useRef(false);
  const pendingRef = useRef(false);
  const buttons = useRef(new Map<AccountAction, HTMLButtonElement>());
  const invitationTitle = useRef<HTMLHeadingElement>(null);
  // Set when an action has run; the effect below moves focus to the
  // control that replaced the one that started it.
  const focusTarget = useRef<FocusTarget | null>(null);
  const actions = availableActions(person, self);
  const copy = action ? actionCopy(action, person) : null;
  const state = personState(person, now);
  const invitation = actions.filter((item) => inviteActions.includes(item));
  const lifecycle = actions.filter((item) => !inviteActions.includes(item));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // After every render: once the replacing control exists, focus it.
  useEffect(() => {
    const target = focusTarget.current;
    if (!target || action !== null) return;
    const element = target
      .map((item) =>
        item === "invitation"
          ? invitationTitle.current
          : (buttons.current.get(item) ?? null),
      )
      .find((candidate) => candidate?.isConnected);
    if (!element) return;
    focusTarget.current = null;
    element.focus();
  });

  function bindButton(item: AccountAction) {
    return (element: HTMLButtonElement | null) => {
      if (element) buttons.current.set(item, element);
      else buttons.current.delete(item);
    };
  }

  async function undoDelete(name: string) {
    try {
      await restoreAccessUser(person.id);
      reportDone(`${name} is restored`);
    } catch (caught) {
      reportError(
        peopleErrorMessage(caught, `${name} could not be restored. Try again.`),
      );
    } finally {
      void afterAccessUserChange(client);
    }
  }

  async function confirm() {
    if (
      !action ||
      !copy ||
      pending ||
      pendingRef.current ||
      verifying ||
      !actions.includes(action)
    )
      return;
    const selected = action;
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      await run(selected, person);
      if (selected === "delete") {
        // The person leaves the directory, so the sheet closes and the
        // notice carries Undo (the Four Moments Rule).
        const name = personName(person);
        reportUndoable(copy.done, () => void undoDelete(name));
        void afterAccessUserChange(client);
        if (!mounted.current) return;
        setAction(null);
        onDeleted();
        return;
      }
      // The sheet shows the new state before the dialog closes, so focus
      // lands on the control that replaced this one.
      await afterAccessUserChange(client);
      if (!mounted.current) return;
      reportDone(copy.done);
      focusTarget.current = focusAfter[selected];
      setAction(null);
    } catch (caught) {
      if (!mounted.current) return;
      setError(
        peopleErrorMessage(caught, "The change could not be made. Try again."),
      );
      // A refused change may mean this person changed elsewhere.
      void afterAccessUserChange(client);
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  }

  function open(item: AccountAction) {
    focusTarget.current = null;
    setError("");
    setAction(item);
  }

  const summary = person.is_deleted
    ? "This account is deleted."
    : state.id === "expired"
      ? "This guest's access has ended. Set a later end date to let them sign in again."
      : person.status === "disabled"
        ? "This account cannot sign in."
        : "This account can sign in.";

  return (
    <>
      {person.status === "pending" ? (
        <section
          aria-labelledby="person-invitation-title"
          className="space-y-2"
        >
          <h3
            id="person-invitation-title"
            ref={invitationTitle}
            tabIndex={-1}
            className="font-semibold outline-none"
          >
            Invitation
          </h3>
          <p className="text-muted-foreground text-sm">
            {person.is_deleted
              ? "This invitation was revoked. Invite this email address again to give them access."
              : person.invitation_sent_at === null
                ? "The invitation has not been sent yet. Finish sending it to give this person their invitation link."
                : "The invitation has not been accepted yet."}
          </p>
          {invitation.map((item) => (
            <Button
              key={item}
              ref={bindButton(item)}
              variant="secondary"
              className="min-h-11 w-full sm:w-auto"
              onClick={() => open(item)}
            >
              {actionCopy(item, person).button}
            </Button>
          ))}
        </section>
      ) : null}

      {children}

      {self && person.status !== "pending" ? (
        <p className="text-muted-foreground text-sm">
          This is your account. Another administrator can disable or delete it.
        </p>
      ) : null}

      {lifecycle.length ? (
        <AdvancedSection
          storageKey="access.person"
          summary={lifecycle
            .map((item) => actionCopy(item, person).button)
            .join(", ")}
        >
          {person.status === "pending" ? null : (
            <p className="text-muted-foreground text-sm">{summary}</p>
          )}
          {/* Ghost buttons start at their text, in line with the sentence. */}
          <div className="flex flex-col gap-2 sm:-ml-3 sm:flex-row sm:flex-wrap">
            {lifecycle.map((item) => {
              const itemCopy = actionCopy(item, person);
              return (
                <Button
                  key={item}
                  ref={bindButton(item)}
                  variant="ghost"
                  className={
                    itemCopy.destructive
                      ? "text-danger-text min-h-11 w-full sm:w-auto"
                      : "min-h-11 w-full sm:w-auto"
                  }
                  onClick={() => open(item)}
                >
                  {itemCopy.button}
                </Button>
              );
            })}
          </div>
        </AdvancedSection>
      ) : null}

      <AlertDialog
        open={action !== null}
        onOpenChange={(next) => !next && !pending && setAction(null)}
      >
        <AlertDialogContent
          className="access-ui"
          finalFocus={() => focusTarget.current === null}
        >
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
            <DisabledReason reason={verifying ? verifyingReason : null}>
              <Button
                variant={copy?.destructive ? "destructive" : "default"}
                className="min-h-11"
                pending={pending}
                pendingLabel={copy?.pending}
                onClick={() => void confirm()}
              >
                {copy?.confirm}
              </Button>
            </DisabledReason>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
