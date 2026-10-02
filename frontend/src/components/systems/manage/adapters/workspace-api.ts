import { z } from "zod";

import { ApiError, apiFetch } from "@/lib/api";

const workspaceProfileSchema = z.object({
  id: z.uuid(),
  display_name: z.string().min(1).max(200),
  locale: z.string().min(1).max(35),
  timezone: z.string().min(1).max(64),
  revision: z.number().int().positive(),
});

const workspaceSettingsPatchSchema = z
  .object({
    revision: z.number().int().positive(),
    display_name: z.string().trim().min(1).max(200).optional(),
    locale: z.string().trim().min(1).max(35).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .refine((fields) =>
    Object.entries(fields).some(
      ([key, value]) => key !== "revision" && value !== undefined,
    ),
  );

export type ManageWorkspaceProfile = z.output<typeof workspaceProfileSchema>;
export type ManageWorkspaceSettingsPatch = z.output<
  typeof workspaceSettingsPatchSchema
>;

export type WorkspaceSettingsFormFields = {
  name: string;
  locale: string;
  timezone: string;
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
  };
}

export function workspaceSettingsPatch(
  workspace: ManageWorkspaceProfile,
  draft: WorkspaceSettingsFormDraft,
): ManageWorkspaceSettingsPatch | null {
  const fields = workspaceSettingsFormFields(workspace);
  const patch: {
    revision: number;
    display_name?: string;
    locale?: string;
    timezone?: string;
  } = { revision: workspace.revision };

  if (draft.name !== undefined && draft.name.trim() !== fields.name)
    patch.display_name = draft.name.trim();
  if (draft.locale !== undefined) {
    const locale = organizationLocaleTag(draft.locale);
    if (locale !== workspace.locale) patch.locale = locale;
  }
  if (draft.timezone !== undefined && draft.timezone !== fields.timezone)
    patch.timezone = draft.timezone;

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
