import { z } from "zod";
import { queryOptions } from "@tanstack/react-query";

import { ApiError, apiFetch } from "@/lib/api";

const workspaceProfileSchema = z.object({
  id: z.uuid(),
  display_name: z.string().min(1).max(200),
  locale: z.string().min(1).max(35),
  timezone: z.string().min(1).max(64),
  mark: z.string().max(32),
  currency: z.string().regex(/^[A-Z]{3}$/),
  week_start: z.enum(["monday", "sunday"]),
  business_hours: z.string().max(200),
  revision: z.number().int().positive(),
});

const workspaceSettingsPatchSchema = z
  .object({
    revision: z.number().int().positive(),
    display_name: z.string().trim().min(1).max(200).optional(),
    locale: z.string().trim().min(1).max(35).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    mark: z.string().trim().max(32).optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    week_start: z.enum(["monday", "sunday"]).optional(),
    business_hours: z.string().trim().max(200).optional(),
  })
  .refine((fields) =>
    Object.entries(fields).some(
      ([key, value]) => key !== "revision" && value !== undefined,
    ),
  );

export type ManageWorkspaceProfile = z.output<typeof workspaceProfileSchema>;
const workspaceCalendarSchema = workspaceProfileSchema
  .pick({ week_start: true })
  .extend({ today: z.iso.date() });
export type WorkspaceCalendarSettings = z.output<
  typeof workspaceCalendarSchema
>;

/** Calendar preferences are readable by every authenticated workspace user. */
export function getWorkspaceCalendarSettings(signal?: AbortSignal) {
  return apiFetch("/workspace", workspaceCalendarSchema, {
    cache: "no-store",
    signal,
  });
}

export function workspaceCalendarQueryOptions() {
  return queryOptions({
    queryKey: ["workspace", "calendar"] as const,
    queryFn: ({ signal }) => getWorkspaceCalendarSettings(signal),
    // A return from Organization settings rechecks its persisted preference.
    staleTime: 0,
  });
}

export type ManageWorkspaceSettingsPatch = z.output<
  typeof workspaceSettingsPatchSchema
>;

export type WorkspaceSettingsFormFields = {
  name: string;
  locale: string;
  timezone: string;
  logo: string;
  currency: string;
  week: "Monday" | "Sunday";
  hours: string;
};
export type WorkspaceSettingsFormDraft = Partial<WorkspaceSettingsFormFields>;

const ORGANIZATION_LOCALE_TAGS = {
  "English (Philippines)": "en-PH",
  Filipino: "fil-PH",
  "English (US)": "en-US",
} as const;

export const organizationLocaleLabels = Object.keys(
  ORGANIZATION_LOCALE_TAGS,
) as (keyof typeof ORGANIZATION_LOCALE_TAGS)[];

export const organizationLocaleTags = Object.values(ORGANIZATION_LOCALE_TAGS);

export function organizationLocaleTag(value: string): string {
  return (
    ORGANIZATION_LOCALE_TAGS[value as keyof typeof ORGANIZATION_LOCALE_TAGS] ??
    value
  );
}

export function organizationLocaleLabel(value: string): string {
  const bundledLabel = organizationLocaleLabels.find(
    (label) => ORGANIZATION_LOCALE_TAGS[label] === value,
  );
  if (bundledLabel) return bundledLabel;
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "language" }).of(value) ?? value
    );
  } catch {
    return value;
  }
}

export function workspaceSettingsFormFields(
  workspace: ManageWorkspaceProfile,
): WorkspaceSettingsFormFields {
  return {
    name: workspace.display_name,
    locale: workspace.locale,
    timezone: workspace.timezone,
    logo: workspace.mark,
    currency: workspace.currency,
    week: workspace.week_start === "monday" ? "Monday" : "Sunday",
    hours: workspace.business_hours,
  };
}

export function workspaceSettingsPatch(
  workspace: ManageWorkspaceProfile,
  draft: WorkspaceSettingsFormDraft,
): ManageWorkspaceSettingsPatch | null {
  const fields = workspaceSettingsFormFields(workspace);
  const patch: ManageWorkspaceSettingsPatch = { revision: workspace.revision };

  if (draft.name !== undefined && draft.name.trim() !== fields.name)
    patch.display_name = draft.name.trim();
  if (draft.locale !== undefined) {
    const locale = organizationLocaleTag(draft.locale);
    if (locale !== workspace.locale) patch.locale = locale;
  }
  if (draft.timezone !== undefined && draft.timezone !== fields.timezone)
    patch.timezone = draft.timezone;
  if (draft.logo !== undefined && draft.logo.trim() !== fields.logo)
    patch.mark = draft.logo.trim();
  if (draft.currency !== undefined && draft.currency !== fields.currency)
    patch.currency = draft.currency;
  if (draft.week !== undefined && draft.week !== fields.week)
    patch.week_start = draft.week === "Monday" ? "monday" : "sunday";
  if (draft.hours !== undefined && draft.hours.trim() !== fields.hours)
    patch.business_hours = draft.hours.trim();

  if (Object.keys(patch).length === 1) return null;
  return patch;
}

export function getManageWorkspace(
  signal?: AbortSignal,
): Promise<ManageWorkspaceProfile> {
  return apiFetch("/workspace", workspaceProfileSchema, {
    cache: "no-store",
    signal,
  });
}

export function updateManageWorkspace(
  patch: ManageWorkspaceSettingsPatch,
  signal?: AbortSignal,
): Promise<ManageWorkspaceProfile> {
  return apiFetch("/workspace", workspaceProfileSchema, {
    method: "PATCH",
    body: JSON.stringify(workspaceSettingsPatchSchema.parse(patch)),
    signal,
  });
}

export function isStaleWorkspaceRevision(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  const details: unknown = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "code" in details &&
    details.code === "stale_revision"
  );
}
