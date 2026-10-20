"use client";

import { useUserPreferences } from "@/components/theme-provider";
import { useQuery } from "@tanstack/react-query";
import { workspaceCalendarQueryOptions } from "@/components/systems/manage/adapters/workspace-api";
import { isIanaTimezone, type WorkspaceRegion } from "@/lib/date-time-display";

/** Presentation only: callers retain the original workspace query/input zone. */
export function useDisplayRegion<T extends WorkspaceRegion>(
  workspace: T | undefined,
) {
  const { regional } = useUserPreferences();
  if (!workspace) return undefined;
  return {
    ...workspace,
    timezone:
      regional?.timezone && isIanaTimezone(regional.timezone)
        ? regional.timezone
        : workspace.timezone,
    dateFormat: regional?.date_format,
    timeFormat: regional?.time_format,
  };
}

/** Grid presentation only; never use this result to select a records window. */
export function useDisplayWeekStart(workspace: "monday" | "sunday") {
  const { regional } = useUserPreferences();
  return regional?.week_start && regional.week_start !== "organization"
    ? regional.week_start
    : workspace;
}

/** For signed-in display callers that do not already own a workspace read. */
export function useWorkspaceDisplayRegion() {
  return useDisplayRegion(useQuery(workspaceCalendarQueryOptions()).data);
}
