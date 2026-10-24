"use client";

import { useQuery } from "@tanstack/react-query";

import { useDisplayRegion } from "@/components/use-display-region";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";

import { manageWorkspaceOptions } from "../adapters/manage-queries";

/** Backup times use the workspace region; callers without it get the device format. */
export function formatBackupTime(
  value: string | null,
  region?: WorkspaceRegion,
): string {
  if (value === null) return "—";
  const options = { dateStyle: "medium", timeStyle: "short" } as const;
  if (region) return formatWorkspaceDateTime(value, region, options);
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, options).format(date);
}

export function useWorkspaceRegion(): WorkspaceRegion | undefined {
  return useDisplayRegion(useQuery(manageWorkspaceOptions()).data);
}
