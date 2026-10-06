import { z } from "zod";
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { ApiError, apiFetch } from "@/lib/api";
import {
  ORGANIZATION_THEMES,
  type OrganizationTheme,
} from "@/lib/appearance-preferences";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";

const organizationThemeSchema = z.enum(ORGANIZATION_THEMES);
const workspaceAppearanceSchema = z
  .object({ theme: organizationThemeSchema })
  .strict();

/** Public palette only; an unavailable read must never enter the auth refresh flow. */
export function getWorkspaceAppearance(signal?: AbortSignal) {
  return apiFetch("/workspace/appearance", workspaceAppearanceSchema, {
    cache: "no-store",
    signal,
    refreshOnUnauthorized: false,
  });
}

const workspaceCommonProfileSchema = z.object({
  id: z.uuid(),
  display_name: z.string().min(1).max(200),
  legal_name: z.string().nullable(),
  description: z.string().nullable(),
  locale: z.string().min(1).max(35),
  timezone: z.string().min(1).max(64),
  mark: z.string().max(32),
  currency: z.string().regex(/^[A-Z]{3}$/),
  week_start: z.enum(["monday", "sunday"]),
  business_hours: z.string().max(200),
  theme: organizationThemeSchema,
  revision: z.number().int().positive(),
});
const workspaceFullProfileSchema = workspaceCommonProfileSchema.extend({
  contact_email: z.string().nullable(),
  contact_phone: z.string().nullable(),
  postal_address: z.string().nullable(),
});
// Test raw keys before the non-strict common projection can erase evidence
// of a partial or malformed full response.
const workspaceGuestProfileSchema = z
  .unknown()
  .refine(
    (raw) =>
      typeof raw === "object" &&
      raw !== null &&
      !["contact_email", "contact_phone", "postal_address"].some((key) =>
        Object.hasOwn(raw, key),
      ),
  )
  .pipe(workspaceCommonProfileSchema);
const workspaceProfileSchema = z.union([
  workspaceFullProfileSchema,
  workspaceGuestProfileSchema,
]);

const workspaceSettingsPatchSchema = z
  .object({
    revision: z.number().int().positive(),
    display_name: z.string().trim().min(1).max(200).optional(),
    legal_name: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    contact_email: z.string().trim().max(254).nullable().optional(),
    contact_phone: z.string().trim().max(50).nullable().optional(),
    postal_address: z.string().trim().max(2000).nullable().optional(),
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
    theme: organizationThemeSchema.optional(),
  })
  .refine((fields) =>
    Object.entries(fields).some(
      ([key, value]) => key !== "revision" && value !== undefined,
    ),
  );

export type ManageWorkspaceProfile = z.output<typeof workspaceProfileSchema>;
export type ManageWorkspaceFullProfile = z.output<
  typeof workspaceFullProfileSchema
>;

export function workspaceHasContacts(
  workspace: ManageWorkspaceProfile,
): workspace is ManageWorkspaceFullProfile {
  return "contact_email" in workspace;
}

const workspaceCalendarSchema = workspaceCommonProfileSchema
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

const workspaceLifecycleSchema = z.object({ purge_enabled: z.boolean() });

/** The server owns permanent-deletion availability; it is not a workspace edit. */
export function getWorkspaceLifecycleSettings(signal?: AbortSignal) {
  return apiFetch("/workspace", workspaceLifecycleSchema, {
    cache: "no-store",
    signal,
  });
}

export function workspaceLifecycleQueryOptions() {
  return queryOptions({
    queryKey: ["workspace", "lifecycle"] as const,
    queryFn: ({ signal }) => getWorkspaceLifecycleSettings(signal),
    // The operator setting may change when the API restarts.
    staleTime: 0,
  });
}

/** Refresh the shared flag after server reconnects and workspace invalidations. */
export function subscribeWorkspaceLifecycleSettings(client: QueryClient) {
  const queryKey = workspaceLifecycleQueryOptions().queryKey;
  const refresh = () => {
    const cold = client
      .getQueryCache()
      .findAll({ queryKey, fetchStatus: "fetching" })
      .filter((query) => query.state.data === undefined);
    void Promise.all(cold.map((query) => query.cancel({ revert: true }))).then(
      () => client.invalidateQueries({ queryKey }),
    );
  };
  const unsubscribe = subscribeWorkspaceInvalidations((event) => {
    if (event.type === "resync" || event.entity === "workspace_profiles")
      refresh();
  }, refresh);
  return () => {
    unsubscribe();
    void client.invalidateQueries({ queryKey, refetchType: "none" });
  };
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
  theme: OrganizationTheme;
  legalName: string;
  description: string;
  contactEmail?: string;
  contactPhone?: string;
  postalAddress?: string;
};
export type WorkspaceSettingsFormDraft = Partial<WorkspaceSettingsFormFields>;
export type WorkspaceProfileField =
  | "legalName"
  | "description"
  | "contactEmail"
  | "contactPhone"
  | "postalAddress";
export type WorkspaceProfileFormFields = Pick<
  WorkspaceSettingsFormFields,
  WorkspaceProfileField
>;

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
    theme: workspace.theme,
    legalName: workspace.legal_name ?? "",
    description: workspace.description ?? "",
    ...(workspaceHasContacts(workspace)
      ? {
          contactEmail: workspace.contact_email ?? "",
          contactPhone: workspace.contact_phone ?? "",
          postalAddress: workspace.postal_address ?? "",
        }
      : {}),
  };
}

export function workspaceSettingsPatch(
  workspace: ManageWorkspaceProfile,
  draft: WorkspaceSettingsFormDraft,
  committedTheme: OrganizationTheme,
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

  if (draft.theme !== undefined && draft.theme !== committedTheme)
    patch.theme = draft.theme;

  const profileKeys = {
    legalName: "legal_name",
    description: "description",
    contactEmail: "contact_email",
    contactPhone: "contact_phone",
    postalAddress: "postal_address",
  } as const;
  for (const key of Object.keys(profileKeys) as WorkspaceProfileField[]) {
    const value = draft[key];
    if (value === undefined) continue;
    const normalized = value.trim() || null;
    if (normalized !== (fields[key]?.trim() || null))
      patch[profileKeys[key]] = normalized;
  }

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
): Promise<ManageWorkspaceFullProfile> {
  return apiFetch("/workspace", workspaceFullProfileSchema, {
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
