"use client";

import { useQuery } from "@tanstack/react-query";
import { useUserPreferences } from "@/components/theme-provider";
import { useDisplayRegion } from "@/components/use-display-region";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import { manageWorkspaceOptions } from "@/components/systems/manage/adapters/manage-queries";
import { isIanaTimezone, type WorkspaceRegion } from "@/lib/date-time-display";

export type SettingsRegion = {
  /** The person's formats, or undefined until they can be known. */
  display: WorkspaceRegion | undefined;
  /** "loading" or "failed" only for the organization read. */
  state: "ready" | "loading" | "failed";
  retry: () => void;
  /** The organization's own timezone, for "Organization timezone (<zone>)". */
  organizationZone: string | null;
  /** The organization's currency for the formats preview; null without one. */
  currency: string | null;
};

/**
 * The formats Account settings shows in (session times, Your formats): the
 * organization's region with the person's choices on top. Without an
 * organization it reads nothing more and uses the personal timezone, or this
 * device's, in this browser's language.
 */
export function useSettingsRegion(): SettingsRegion {
  const identity = useQuery(authMeOptions());
  const preference = useUserPreferences();
  const bound = Boolean(identity.data?.currentOrganization);
  const workspace = useQuery({
    ...manageWorkspaceOptions(),
    enabled: bound,
  });
  const organizationDisplay = useDisplayRegion(workspace.data);
  if (bound)
    return {
      display: organizationDisplay,
      state: workspace.isError
        ? "failed"
        : workspace.isLoading
          ? "loading"
          : "ready",
      retry: () => void workspace.refetch(),
      organizationZone: workspace.data?.timezone ?? null,
      currency: workspace.data?.currency ?? null,
    };
  const personal = preference.regional?.timezone;
  return {
    display: identity.data
      ? {
          timezone:
            personal && isIanaTimezone(personal)
              ? personal
              : Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale:
            typeof navigator === "undefined" ? "en-US" : navigator.language,
          dateFormat: preference.regional?.date_format,
          timeFormat: preference.regional?.time_format,
        }
      : undefined,
    state: "ready",
    retry: () => undefined,
    organizationZone: null,
    currency: null,
  };
}
