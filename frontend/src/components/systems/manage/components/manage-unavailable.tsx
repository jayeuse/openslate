"use client";
import type { Route } from "next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import type { WorkspaceNavigationItem } from "@/components/workspace-navigation";

type ManageSectionTitle =
  "Organization" | "Audit" | "Backup" | "Jobs" | "Updates & licensing";

/** The installation owner runs Backup and Updates; the rest follow the role. */
export function manageUnavailableMessage(section: ManageSectionTitle): string {
  if (section === "Backup")
    return "Backup is managed by the installation owner.";
  if (section === "Updates & licensing")
    return "Updates are managed by the installation owner.";
  return `${section} is not available to your account.`;
}

/**
 * What a link to a Manage section the account cannot open shows (MD3): one
 * calm line and a way to the first section it can open. Retry would only send
 * the same refused request again.
 */
export function ManageUnavailable({
  section,
  home,
  message,
  onRetry,
  retrying = false,
}: {
  section: ManageSectionTitle;
  home: WorkspaceNavigationItem | null;
  /** Replaces the refusal when the access check itself failed. */
  message?: string;
  /** A Retry for a check that can still succeed; a refusal has none. */
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <Alert className="flex shrink-0 flex-wrap items-center gap-3">
      <p className="mr-auto">{message ?? manageUnavailableMessage(section)}</p>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={retrying}
          onClick={onRetry}
        >
          Retry
        </Button>
      ) : null}
      {home ? (
        <GuardedWorkspaceLink
          href={home.href as Route}
          className="text-action-text inline-flex min-h-11 items-center font-medium underline underline-offset-4"
        >
          Go to {home.label}
        </GuardedWorkspaceLink>
      ) : null}
    </Alert>
  );
}
