"use client";

import type { OrganizationTheme } from "@/lib/appearance-preferences";

import { WorkspaceLogo } from "../../shared/runtime/workspace-logo";
import {
  organizationLocaleLabel,
  type ManageWorkspaceProfile,
  type WorkspaceProfileFormFields,
} from "../adapters/workspace-api";
import type { ManageSettings } from "../state/model";
import {
  PROFILE_FIELDS,
  profileHasValues,
} from "../state/organization-profile";
import { readableTimezone } from "@/lib/timezone-options";
import { currencyLabel } from "./organization-editor";
import { OrganizationLookTile } from "./organization-look";
import { ReaderRow, ReaderRows, SettingsGroup } from "./organization-rows";
import type { OrganizationLogoProps } from "./organization-panel";

/**
 * Organization for someone who cannot change it (MD5): the saved settings,
 * never a draft, in the same label-left rows as plain text, "Not set" for an
 * empty value, the saved look as one tile, and no footer. The header's meta
 * line says who can change it.
 */
export function OrganizationReader({
  saved,
  workspace,
  theme,
  profile,
  contactsVisible,
  logo,
  organizationName,
}: {
  saved: ManageSettings;
  workspace: ManageWorkspaceProfile | undefined;
  theme: OrganizationTheme;
  profile: WorkspaceProfileFormFields | undefined;
  contactsVisible: boolean;
  logo: OrganizationLogoProps;
  organizationName: string;
}) {
  if (!workspace)
    return (
      <p role="status" className="text-muted-foreground py-5 text-sm">
        The organization settings are unavailable.
      </p>
    );
  return (
    <div className="min-w-0">
      <SettingsGroup title="Identity">
        <ReaderRows>
          <ReaderRow label="Name">{saved.name}</ReaderRow>
          <ReaderRow label="Mark">{saved.logo}</ReaderRow>
          <ReaderRow label="Logo">
            {workspace.logo_file_id && !logo.concealed ? (
              <WorkspaceLogo
                blob={logo.blob}
                name={organizationName}
                mark={saved.logo}
                className="size-8 rounded-md"
              />
            ) : null}
          </ReaderRow>
        </ReaderRows>
      </SettingsGroup>
      <SettingsGroup title="Region">
        <ReaderRows>
          <ReaderRow label="Format">
            {organizationLocaleLabel(saved.locale)}
          </ReaderRow>
          <ReaderRow label="Timezone">
            {readableTimezone(saved.timezone)}
          </ReaderRow>
          <ReaderRow label="Currency">
            {currencyLabel(saved.currency)}
          </ReaderRow>
          <ReaderRow label="Week starts">{saved.week}</ReaderRow>
          <ReaderRow label="Business hours">{saved.hours}</ReaderRow>
        </ReaderRows>
      </SettingsGroup>
      <SettingsGroup
        title="Look"
        hint="Words and layout stay the same; each person still picks light or dark."
      >
        <OrganizationLookTile theme={theme} />
      </SettingsGroup>
      {profile && profileHasValues(profile, contactsVisible) ? (
        <SettingsGroup title="Profile" className="border-b-0">
          <ReaderRows>
            {PROFILE_FIELDS.filter(
              (field) => contactsVisible || !field.contact,
            ).map(({ key, label }) => (
              <ReaderRow key={key} label={label}>
                {profile[key]}
              </ReaderRow>
            ))}
          </ReaderRows>
        </SettingsGroup>
      ) : null}
    </div>
  );
}
