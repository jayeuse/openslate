"use client";

import { useState, type ReactNode } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronsUpDown,
  House,
  LoaderCircle,
  MailOpen,
} from "lucide-react";

import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import {
  GuardedWorkspaceLink,
  useWorkspaceNavigationRequest,
} from "@/components/workspace-navigation-guard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import type { AccountRole } from "@/lib/auth-api";
import { cn } from "@/lib/utils";

/** The membership role as people read it ("Administrator", "Member", "Guest"). */
export const membershipRoleLabels: Record<AccountRole, string> = {
  admin: "Administrator",
  member: "Member",
  guest: "Guest",
};

const WORKSPACE_HOME = "/openview" as Route;

type OrganizationMenuProps = {
  /** The organization name the shell shows. */
  name: string;
  organizationId: string | null;
  onSwitchOrganization: (orgId: string) => Promise<void>;
  /** Runs once the switch passed the unsaved-work guard (closes a drawer). */
  onAccepted?: () => void;
  /** The phone drawer header sets the name at body size. */
  compact?: boolean;
  /**
   * The collapsed rail: the organization mark is the whole trigger, and the
   * menu starts with the workspace home link that the rail no longer shows.
   */
  mark?: ReactNode;
};

/**
 * The organization name as a menu: the account's organizations, with the
 * current one checked, and its pending invitations. Choosing another
 * organization reopens this tab in it at the workspace home.
 */
export function OrganizationMenu({
  name,
  organizationId,
  onSwitchOrganization,
  onAccepted,
  compact = false,
  mark,
}: OrganizationMenuProps) {
  const iconOnly = mark !== undefined;
  const router = useRouter();
  const requestNavigation = useWorkspaceNavigationRequest();
  const userId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const identity = useQuery({ ...authMeOptions(), enabled: !suspended });
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const current =
    !suspended && identity.data?.id === userId ? identity.data : undefined;
  const memberships = current?.memberships ?? [];
  const invitations = current?.pendingInvitations ?? [];

  function choose(orgId: string) {
    setOpen(false);
    if (orgId === organizationId || switching) return;
    const resume = () => {
      onAccepted?.();
      setSwitching(true);
      void onSwitchOrganization(orgId)
        .then(() => router.push(WORKSPACE_HOME))
        .catch(() =>
          toast.add({
            title: "Could not switch organization",
            description: `You are still in ${name}. Try again.`,
            type: "error",
          }),
        )
        .finally(() => setSwitching(false));
    };
    if (requestNavigation(WORKSPACE_HOME, resume, "organization")) resume();
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={
              switching ? `Switching from ${name}` : `Organization: ${name}`
            }
            aria-busy={switching || undefined}
            disabled={suspended || switching}
            title={name}
            className={cn(
              "hover:bg-sidebar-accent focus-visible:outline-ring flex min-h-11 items-center gap-1.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait",
              iconOnly
                ? "min-w-11 shrink-0 justify-center xl:min-h-8 xl:min-w-8"
                : "min-w-0 flex-1 pr-1 pl-1.5 xl:min-h-10",
            )}
          />
        }
      >
        {iconOnly ? (
          switching ? null : (
            mark
          )
        ) : (
          // The full name shows; it wraps to two lines before it truncates.
          <span
            className={cn(
              "line-clamp-2 min-w-0 flex-1 font-semibold wrap-anywhere",
              compact ? "text-base leading-5" : "text-sm leading-4.25",
            )}
          >
            {switching ? "Switching…" : name}
          </span>
        )}
        {iconOnly && !switching ? null : switching ? (
          <LoaderCircle
            aria-hidden="true"
            className="text-sidebar-muted size-4 shrink-0 animate-spin motion-reduce:animate-none"
          />
        ) : (
          <ChevronsUpDown
            aria-hidden="true"
            className="text-sidebar-muted size-4 shrink-0"
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label="Organizations"
        className="w-72 max-w-[calc(100vw-2rem)]"
      >
        {iconOnly ? (
          <>
            <DropdownMenuItem
              className="min-h-11 xl:min-h-8"
              render={
                <GuardedWorkspaceLink
                  href={WORKSPACE_HOME}
                  onAcceptedNavigate={() => setOpen(false)}
                />
              }
            >
              <House aria-hidden="true" />
              Workspace home
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
            Organizations
          </DropdownMenuLabel>
          {identity.isPending ? (
            <p
              className="text-muted-foreground px-2 py-2 text-sm"
              role="status"
            >
              Loading organizations…
            </p>
          ) : memberships.length === 0 ? (
            <>
              <p
                className="text-muted-foreground px-2 py-2 text-sm"
                role="status"
              >
                Organizations could not be loaded.
              </p>
              <DropdownMenuItem
                className="min-h-11"
                closeOnClick={false}
                onClick={() => void identity.refetch()}
              >
                Try again
              </DropdownMenuItem>
            </>
          ) : null}
          {memberships.map((organization) => {
            const selected = organization.orgId === organizationId;
            return (
              <DropdownMenuItem
                key={organization.orgId}
                className="min-h-11"
                aria-current={selected ? "true" : undefined}
                onClick={() => choose(organization.orgId)}
              >
                <Check
                  aria-hidden="true"
                  className={cn("shrink-0", selected ? "" : "invisible")}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{organization.name}</span>
                  <span className="text-muted-foreground block text-xs">
                    {membershipRoleLabels[organization.role]}
                    {selected ? (
                      <span className="sr-only"> (current)</span>
                    ) : null}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        {invitations.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="min-h-11"
              render={
                <GuardedWorkspaceLink
                  href={"/auth/setup" as Route}
                  onAcceptedNavigate={() => {
                    setOpen(false);
                    onAccepted?.();
                  }}
                />
              }
            >
              <MailOpen aria-hidden="true" />
              {invitations.length === 1
                ? "1 invitation"
                : `${invitations.length} invitations`}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
