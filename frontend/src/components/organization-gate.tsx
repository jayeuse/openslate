"use client";

import { useState } from "react";
import { Building2, ChevronRight, MailOpen } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type {
  AccountRole,
  OrganizationMembership,
  PendingInvitation,
} from "@/lib/auth-api";

const roleLabels: Record<AccountRole, string> = {
  admin: "Administrator",
  member: "Member",
  guest: "Guest",
};

const expiryFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

function expiryLabel(expiresAt: string): string {
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime())
    ? "Expiry not available"
    : `Expires ${expiryFormat.format(date)}`;
}

type PendingInvitationListProps = {
  invitations: readonly PendingInvitation[];
  /** Resolves when the account joined; rejects to keep the row and show an error. */
  onJoin: (invitation: PendingInvitation) => Promise<void>;
  disabled?: boolean;
};

/** Pending invitations of the signed-in account, each with a Join action. */
export function PendingInvitationList({
  invitations,
  onJoin,
  disabled = false,
}: PendingInvitationListProps) {
  const [joining, setJoining] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function join(invitation: PendingInvitation) {
    if (joining) return;
    setJoining(invitation.id);
    setFailed(null);
    try {
      await onJoin(invitation);
    } catch {
      setFailed(invitation.id);
    } finally {
      setJoining(null);
    }
  }

  return (
    <ul className="divide-border border-border bg-card divide-y rounded-lg border">
      {invitations.map((invitation) => (
        <li key={invitation.id} className="space-y-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium wrap-anywhere">{invitation.name}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {roleLabels[invitation.role]} ·{" "}
                {expiryLabel(invitation.expiresAt)}
              </p>
            </div>
            <Button
              type="button"
              className="min-h-11"
              aria-label={`Join ${invitation.name}`}
              disabled={disabled || joining !== null}
              onClick={() => void join(invitation)}
            >
              {joining === invitation.id ? "Joining…" : "Join"}
            </Button>
          </div>
          {failed === invitation.id ? (
            <Alert variant="destructive">
              We could not join {invitation.name}. The invitation may have
              expired. Try again, or ask for a new invitation.
            </Alert>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

type OrganizationGateProps = {
  memberships: readonly OrganizationMembership[];
  invitations: readonly PendingInvitation[];
  onChoose: (organization: OrganizationMembership) => Promise<void>;
  onJoin: (invitation: PendingInvitation) => Promise<void>;
  onCheckAgain: () => void;
  onSignOut: () => void;
  signOutError: boolean;
};

/**
 * Shown when the session has no organization to open: the account belongs to
 * several and none is chosen, or it belongs to none yet. It offers only the
 * account's own organizations, its pending invitations, and sign-out.
 */
export function OrganizationGate({
  memberships,
  invitations,
  onChoose,
  onJoin,
  onCheckAgain,
  onSignOut,
  signOutError,
}: OrganizationGateProps) {
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const hasOrganizations = memberships.length > 0;

  async function choose(organization: OrganizationMembership) {
    if (opening) return;
    setOpening(organization.orgId);
    setOpenFailed(false);
    try {
      await onChoose(organization);
    } catch {
      setOpenFailed(true);
    } finally {
      setOpening(null);
    }
  }

  return (
    <section
      className="w-full max-w-lg px-6 py-8"
      aria-labelledby="organization-gate-title"
    >
      <div className="bg-muted text-muted-foreground mb-5 grid size-11 place-items-center rounded-full">
        <Building2 aria-hidden="true" className="size-5" />
      </div>
      <h1
        id="organization-gate-title"
        data-slot="page-title"
        className="text-xl font-semibold"
      >
        {hasOrganizations ? "Choose an organization" : "No organization yet"}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {hasOrganizations
          ? "Your account belongs to more than one organization. Choose the one to open in this tab."
          : "Your account is ready, but it is not part of an organization yet. Join one from an invitation, or ask an administrator to invite you."}
      </p>

      {hasOrganizations ? (
        <div className="mt-6 space-y-3">
          <h2 data-slot="section-title" className="text-sm font-semibold">
            Your organizations
          </h2>
          <ul className="divide-border border-border bg-card divide-y rounded-lg border">
            {memberships.map((organization) => (
              <li key={organization.orgId}>
                <button
                  type="button"
                  disabled={opening !== null}
                  onClick={() => void choose(organization)}
                  className="hover:bg-muted focus-visible:outline-ring flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium wrap-anywhere">
                      {organization.name}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {opening === organization.orgId
                        ? "Opening…"
                        : roleLabels[organization.role]}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="text-muted-foreground size-4 shrink-0"
                  />
                </button>
              </li>
            ))}
          </ul>
          {openFailed ? (
            <Alert variant="destructive">
              We could not open that organization. Try again.
            </Alert>
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 space-y-3">
        <h2 data-slot="section-title" className="text-sm font-semibold">
          Invitations
        </h2>
        {invitations.length > 0 ? (
          <PendingInvitationList
            invitations={invitations}
            onJoin={onJoin}
            disabled={opening !== null}
          />
        ) : (
          <div className="border-border text-muted-foreground flex items-start gap-3 rounded-lg border border-dashed px-4 py-3 text-sm">
            <MailOpen aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>
              No pending invitations. When an organization invites this account,
              the invitation appears here.
            </p>
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={onCheckAgain}
        >
          Check again
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={onSignOut}
        >
          Sign out
        </Button>
      </div>
      {signOutError ? (
        <Alert variant="destructive" className="mt-3">
          Sign-out could not finish. Try again.
        </Alert>
      ) : null}
    </section>
  );
}
