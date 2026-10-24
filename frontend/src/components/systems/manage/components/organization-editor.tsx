"use client";

import { useState } from "react";

import { AdvancedSection } from "@/components/ui/advanced-section";
import { Button } from "@/components/ui/button";
import { FilePickerButton } from "@/components/ui/file-picker-button";
import { Input } from "@/components/ui/input";
import { LoadingRegion } from "@/components/ui/loading-region";
import {
  SearchSelect,
  type SearchSelectOption,
} from "@/components/ui/search-select";
import { Select, SelectItem } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { OrganizationTheme } from "@/lib/appearance-preferences";

import { WorkspaceLogo } from "../../shared/runtime/workspace-logo";
import {
  organizationLocaleLabel,
  organizationLocaleTags,
  type ManageWorkspaceProfile,
  type WorkspaceProfileField,
  type WorkspaceProfileFormFields,
} from "../adapters/workspace-api";
import { activeCurrencies } from "../state/currency-options";
import type { ManageSettings } from "../state/model";
import { PROFILE_FIELDS, profileSummary } from "../state/organization-profile";
import { OrganizationLook } from "./organization-look";
import {
  RowError,
  RowNote,
  SettingsGroup,
  SettingsRow,
} from "./organization-rows";
import type { OrganizationLogoProps } from "./organization-panel";

/** The row label names the field; the control keeps its full name. */
const hiddenFieldLabel = "[&_[data-slot=field-label]]:sr-only";

function timezoneOption(timezone: string, reference: Date): SearchSelectOption {
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(reference)
    .find((part) => part.type === "timeZoneName")?.value;
  return {
    value: timezone,
    label: `${offset === "GMT" ? "UTC+00:00" : offset?.replace("GMT", "UTC")} · ${readableTimezone(timezone)}`,
  };
}

/** IANA names use underscores for spaces; show them as people write them. */
export function readableTimezone(timezone: string): string {
  return timezone.replaceAll("_", " ");
}

export function currencyLabel(code: string): string {
  const known = activeCurrencies.find((currency) => currency.code === code);
  return `${code} · ${known ? known.name : "Current saved currency"}`;
}

const describedBy = (...ids: (string | false | undefined)[]) =>
  ids.filter(Boolean).join(" ") || undefined;

/**
 * The administrator's settings (MD4): Identity, Region and Look as
 * label-left rows, then the optional Profile in one closed block, last. The
 * pinned footer that saves them belongs to the panel.
 */
export function OrganizationEditor({
  current,
  errors,
  changeSetting,
  workspace,
  workspaceLoading,
  editDisabled,
  theme,
  onThemeChange,
  profile,
  profileErrors,
  onProfileChange,
  contactsVisible,
  logo,
  organizationName,
}: {
  current: ManageSettings;
  errors: Partial<Record<keyof ManageSettings, string>>;
  changeSetting: (key: keyof ManageSettings, value: string) => void;
  workspace: ManageWorkspaceProfile | undefined;
  workspaceLoading: boolean;
  editDisabled: boolean;
  theme: OrganizationTheme;
  onThemeChange: (theme: OrganizationTheme) => void;
  profile: WorkspaceProfileFormFields | undefined;
  profileErrors: Partial<Record<WorkspaceProfileField, string>>;
  onProfileChange: (key: WorkspaceProfileField, value: string) => void;
  contactsVisible: boolean;
  logo: OrganizationLogoProps;
  organizationName: string;
}) {
  const localeOptions: string[] = [...organizationLocaleTags];
  if (current.locale && !localeOptions.includes(current.locale))
    localeOptions.push(current.locale);
  // Keep one current instant/list while a draft changes. Offset labels describe
  // this visit; choosing a zone still saves its original IANA identifier.
  const [timezoneCatalog] = useState(() => {
    const reference = new Date();
    return {
      reference,
      options: [...Intl.supportedValuesOf("timeZone"), "UTC"]
        .sort()
        .map((timezone) => timezoneOption(timezone, reference)),
    };
  });
  const timezoneOptions = [...timezoneCatalog.options];
  if (
    current.timezone &&
    !timezoneOptions.some((option) => option.value === current.timezone)
  )
    timezoneOptions.push(
      timezoneOption(current.timezone, timezoneCatalog.reference),
    );
  const currencyOptions = activeCurrencies.map(({ code, name }) => ({
    value: code,
    label: `${code} · ${name}`,
  }));
  if (
    current.currency &&
    !currencyOptions.some((option) => option.value === current.currency)
  )
    currencyOptions.push({
      value: current.currency,
      label: currencyLabel(current.currency),
    });
  const ready = workspace !== undefined;
  const profileFields = PROFILE_FIELDS.filter(
    (field) => contactsVisible || !field.contact,
  );
  const profileHasError = profileFields.some(({ key }) =>
    Boolean(profileErrors[key]),
  );

  return (
    <fieldset disabled={editDisabled} className="min-w-0">
      <SettingsGroup title="Identity">
        {ready ? (
          <>
            <SettingsRow label="Name" htmlFor="organization-name">
              <Input
                id="organization-name"
                aria-label="Organization name"
                required
                maxLength={200}
                value={current.name}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={describedBy(
                  errors.name && "organization-name-error",
                )}
                onChange={(event) => changeSetting("name", event.target.value)}
                className="min-h-11"
              />
              <RowError id="organization-name-error">{errors.name}</RowError>
            </SettingsRow>
            <SettingsRow label="Mark" htmlFor="organization-logo">
              <Input
                id="organization-logo"
                aria-label="Organization mark"
                maxLength={3}
                value={current.logo}
                aria-invalid={Boolean(errors.logo)}
                aria-describedby={describedBy(
                  "organization-logo-description",
                  errors.logo && "organization-logo-error",
                )}
                onChange={(event) => changeSetting("logo", event.target.value)}
                className="min-h-11 md:max-w-28"
              />
              <RowNote id="organization-logo-description">
                Up to 3 letters or numbers.
              </RowNote>
              <RowError id="organization-logo-error">{errors.logo}</RowError>
            </SettingsRow>
            <SettingsRow label="Logo" htmlFor="organization-logo-file">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {/* The preview names the logo; this copy is only visual. */}
                <span aria-hidden="true" className="contents">
                  <WorkspaceLogo
                    blob={logo.blob}
                    name={organizationName}
                    mark={current.logo}
                    hidden={logo.concealed}
                    className="size-8 rounded-md"
                  />
                </span>
                <FilePickerButton
                  id="organization-logo-file"
                  aria-label="Organization logo"
                  accept=".png,.jpg,.jpeg,image/png,image/jpeg"
                  selectedName={
                    logo.selection.kind === "selected"
                      ? logo.selection.name
                      : null
                  }
                  aria-describedby={describedBy(
                    logo.error && "organization-logo-error-file",
                  )}
                  aria-invalid={Boolean(logo.error)}
                  onFiles={(files, event) => {
                    const file = files[0];
                    if (file) logo.onSelect(file);
                    event.currentTarget.value = "";
                  }}
                >
                  Choose logo
                </FilePickerButton>
                {workspace.logo_file_id ||
                logo.selection.kind === "selected" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11"
                    onClick={logo.onRemove}
                  >
                    Remove logo
                  </Button>
                ) : null}
                {logo.onCheckUpload ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={logo.onCheckUpload}
                  >
                    Check upload
                  </Button>
                ) : null}
              </div>
              {logo.selection.kind === "removed" ? (
                <p role="status" className="text-muted-foreground text-sm">
                  Save settings to remove the logo and use the mark.
                </p>
              ) : null}
              <RowError id="organization-logo-error-file">
                {logo.error}
              </RowError>
              {logo.notice ? (
                <p role="status" className="text-muted-foreground text-sm">
                  {logo.notice}
                </p>
              ) : null}
              {logo.cleanupPending ? (
                <div
                  role="status"
                  className="bg-muted/50 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border p-3 text-sm"
                >
                  <p className="min-w-0 flex-1">
                    Logo saved. The old logo will be removed shortly.
                  </p>
                  {logo.onRetryCleanup ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      onClick={logo.onRetryCleanup}
                    >
                      Retry cleanup
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </SettingsRow>
          </>
        ) : (
          <>
            <PlaceholderRow
              id="organization-name"
              label="Name"
              loading={workspaceLoading}
            />
            <PlaceholderRow
              id="organization-logo"
              label="Mark"
              loading={workspaceLoading}
            />
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="Region">
        {ready ? (
          <>
            <SettingsRow label="Format" htmlFor="locale">
              <div className={hiddenFieldLabel}>
                <SearchSelect
                  id="locale"
                  popupClassName="slim-ui"
                  label="Regional format"
                  value={current.locale}
                  disabled={editDisabled}
                  options={localeOptions.map((tag) => ({
                    value: tag,
                    label: organizationLocaleLabel(tag),
                  }))}
                  onValueChange={(value) => changeSetting("locale", value)}
                />
              </div>
            </SettingsRow>
            <SettingsRow label="Timezone" htmlFor="timezone">
              <div className={hiddenFieldLabel}>
                <SearchSelect
                  id="timezone"
                  popupClassName="slim-ui"
                  label="Timezone"
                  value={current.timezone}
                  disabled={editDisabled}
                  options={timezoneOptions}
                  onValueChange={(value) => changeSetting("timezone", value)}
                />
              </div>
            </SettingsRow>
            <SettingsRow label="Currency" htmlFor="currency">
              <div className={hiddenFieldLabel}>
                <SearchSelect
                  id="currency"
                  popupClassName="slim-ui"
                  label="Currency"
                  value={current.currency}
                  disabled={editDisabled}
                  options={currencyOptions}
                  onValueChange={(value) => changeSetting("currency", value)}
                />
              </div>
            </SettingsRow>
            <SettingsRow label="Week starts" htmlFor="week-start">
              <div className="min-w-0 md:max-w-48">
                <Select
                  id="week-start"
                  aria-label="Week starts on"
                  value={
                    current.week === "Monday" || current.week === "Sunday"
                      ? current.week
                      : ""
                  }
                  placeholder={
                    current.week === "Monday" || current.week === "Sunday"
                      ? undefined
                      : "Choose a valid option"
                  }
                  aria-invalid={Boolean(errors.week)}
                  aria-describedby={describedBy(
                    errors.week && "week-start-error",
                  )}
                  onValueChange={(value) => changeSetting("week", value)}
                  className="min-h-11"
                >
                  <SelectItem value="Monday">Monday</SelectItem>
                  <SelectItem value="Sunday">Sunday</SelectItem>
                </Select>
              </div>
              <RowError id="week-start-error">{errors.week}</RowError>
            </SettingsRow>
            <SettingsRow label="Business hours" htmlFor="business-hours">
              <Input
                id="business-hours"
                maxLength={200}
                value={current.hours}
                aria-invalid={Boolean(errors.hours)}
                aria-describedby={describedBy(
                  "business-hours-description",
                  errors.hours && "business-hours-error",
                )}
                onChange={(event) => changeSetting("hours", event.target.value)}
                className="min-h-11 md:max-w-48"
              />
              <RowNote id="business-hours-description">
                Use 24-hour time and a dash, for example 09:00–18:00.
              </RowNote>
              <RowError id="business-hours-error">{errors.hours}</RowError>
            </SettingsRow>
          </>
        ) : (
          <>
            <PlaceholderRow
              id="locale"
              label="Format"
              loading={workspaceLoading}
            />
            <PlaceholderRow
              id="timezone"
              label="Timezone"
              loading={workspaceLoading}
            />
            <PlaceholderRow
              id="currency"
              label="Currency"
              loading={workspaceLoading}
            />
            <PlaceholderRow
              id="week-start"
              label="Week starts"
              loading={workspaceLoading}
            />
            <PlaceholderRow
              id="business-hours"
              label="Business hours"
              loading={workspaceLoading}
            />
          </>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Look"
        hint="Words and layout stay the same; each person still picks light or dark."
        className={profile ? undefined : "border-b-0"}
      >
        <OrganizationLook
          theme={theme}
          onChange={onThemeChange}
          disabled={editDisabled}
        />
      </SettingsGroup>

      {profile ? (
        <AdvancedSection
          storageKey="manage.organization.profile"
          title="Profile"
          summary={profileSummary(profile, contactsVisible)}
          forceOpen={profileHasError}
          className="border-t-0 py-3"
        >
          <div role="group" aria-label="Organization profile">
            {profileFields.map(({ key, label }) => {
              const id = profileFieldIds[key];
              const error = profileErrors[key];
              const multiline =
                key === "description" || key === "postalAddress";
              const control = {
                id,
                value: profile[key] ?? "",
                maxLength: profileLimits[key],
                "aria-invalid": Boolean(error),
                "aria-describedby": describedBy(error && `${id}-error`),
              };
              return (
                <SettingsRow key={key} label={label} htmlFor={id}>
                  {multiline ? (
                    <Textarea
                      {...control}
                      onChange={(event) =>
                        onProfileChange(key, event.target.value)
                      }
                    />
                  ) : (
                    <Input
                      {...control}
                      onChange={(event) =>
                        onProfileChange(key, event.target.value)
                      }
                      className="min-h-11"
                    />
                  )}
                  <RowError id={`${id}-error`}>{error}</RowError>
                </SettingsRow>
              );
            })}
          </div>
        </AdvancedSection>
      ) : null}
    </fieldset>
  );
}

const profileFieldIds: Record<WorkspaceProfileField, string> = {
  legalName: "organization-legal-name",
  description: "organization-description",
  contactEmail: "organization-contact-email",
  contactPhone: "organization-contact-phone",
  postalAddress: "organization-postal-address",
};

const profileLimits: Record<WorkspaceProfileField, number> = {
  legalName: 200,
  description: 2000,
  contactEmail: 254,
  contactPhone: 50,
  postalAddress: 2000,
};

function PlaceholderRow({
  id,
  label,
  loading,
}: {
  id: string;
  label: string;
  loading: boolean;
}) {
  return (
    <LoadingRegion
      loading={loading}
      label={`Loading ${label.toLowerCase()}…`}
      skeleton={<Skeleton className="my-1 h-10 w-full" />}
    >
      <SettingsRow label={label} htmlFor={id}>
        <p
          id={id}
          role="status"
          className="text-muted-foreground flex min-h-10 items-center text-sm"
        >
          Unavailable
        </p>
      </SettingsRow>
    </LoadingRegion>
  );
}
