"use client";

import { useState } from "react";

import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { ArrowUpRight, UsersRound, Workflow } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldDescription,
} from "@/components/ui/field";
import { FilePickerButton } from "@/components/ui/file-picker-button";
import { WorkspaceLogo } from "../../shared/runtime/workspace-logo";
import { Textarea } from "@/components/ui/textarea";
import {
  SearchSelect,
  type SearchSelectOption,
} from "@/components/ui/search-select";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SettingSelect,
  SettingInput,
  SettingActions,
  type SettingsPanelForm,
} from "./panel-ui";
import type { OrganizationTheme } from "@/lib/appearance-preferences";
import { OrganizationLook } from "./organization-look";
import {
  organizationLocaleTags,
  organizationLocaleLabel,
  workspaceSettingsFormFields,
  type ManageWorkspaceProfile,
  type WorkspaceProfileFormFields,
  type WorkspaceProfileField,
} from "../adapters/workspace-api";
import { activeCurrencies } from "../state/currency-options";

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

type OrganizationPanelProps = {
  form: SettingsPanelForm;
  panelClass: string;
  regionalDate: string;
  regionalCurrency: string;
  workspace: ManageWorkspaceProfile | undefined;
  workspaceLoading: boolean;
  workspaceLoadFailed: boolean;
  onRetryWorkspace: () => void;
  staleRevision: boolean;
  theme: OrganizationTheme;
  onThemeChange: (theme: OrganizationTheme) => void;
  readOnly: boolean;
  editDisabled: boolean;
  profile: WorkspaceProfileFormFields | undefined;
  profileErrors: Partial<Record<WorkspaceProfileField, string>>;
  onProfileChange: (key: WorkspaceProfileField, value: string) => void;
  contactsVisible: boolean;
  logo: {
    blob: Blob | null | undefined;
    concealed: boolean;
    selection:
      { kind: "none" | "removed" } | { kind: "selected"; name: string };
    error: string;
    notice: string;
    /** Settings saved, but the replaced logo file is not removed yet. */
    cleanupPending: boolean;
    onSelect: (file: File) => void;
    onRemove: () => void;
    onCheckUpload?: () => void;
    onRetryCleanup?: () => void;
    onRetryImage?: () => void;
  };
};

export function OrganizationPanel({
  form,
  panelClass,
  regionalDate,
  regionalCurrency,
  workspace,
  workspaceLoading,
  workspaceLoadFailed,
  onRetryWorkspace,
  staleRevision,
  theme,
  onThemeChange,
  readOnly,
  editDisabled,
  profile,
  profileErrors,
  onProfileChange,
  contactsVisible,
  logo,
}: OrganizationPanelProps) {
  const { dirty, saveSection, current, changeSetting, errors, clearDraft } =
    form;
  const organizationName =
    !logo.concealed && workspace
      ? current.name.trim() || "Unnamed organization"
      : "Organization details unavailable";
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
      label: `${current.currency} · Current saved currency`,
    });
  const workspaceFields = workspace
    ? workspaceSettingsFormFields(workspace)
    : null;

  return (
    <section
      className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(18.75rem,0.9fr)] lg:gap-10 xl:gap-12"
      aria-label="Organization settings"
    >
      {workspaceLoadFailed ? (
        <Alert role="alert" variant="destructive" className="lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p>The organization settings could not be loaded.</p>
              {workspace ? (
                <p className="text-muted-foreground text-sm">
                  Your last loaded settings are still shown.
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onRetryWorkspace}
            >
              Retry organization settings
            </Button>
          </div>
        </Alert>
      ) : null}
      {staleRevision ? (
        <Alert variant="destructive" className="lg:col-span-2">
          Workspace settings changed. The latest values are loaded. Review your
          changes and save again.
        </Alert>
      ) : null}
      <form
        className="min-w-0 space-y-7"
        onSubmit={(event) => {
          event.preventDefault();
          saveSection("organization");
        }}
      >
        <fieldset disabled={editDisabled} className="min-w-0 space-y-7">
          <FieldSet className="border-border min-w-0 gap-0 border-b pb-6">
            <FieldLegend className="mb-1 text-lg font-semibold tracking-tight">
              Workspace identity
            </FieldLegend>
            <p className="text-muted-foreground mb-4 text-sm leading-6">
              Choose the name, logo and mark your team recognizes.
            </p>
            <FieldGroup className="grid min-w-0 gap-4 sm:grid-cols-2">
              {workspaceFields ? (
                <SettingInput
                  id="organization-name"
                  label="Organization name"
                  required
                  maxLength={200}
                  value={current.name}
                  onChange={(value) =>
                    changeSetting("organization", "name", value)
                  }
                  error={errors.name ?? null}
                />
              ) : (
                <WorkspaceSettingsPlaceholder
                  id="organization-name"
                  label="Organization name"
                  loading={workspaceLoading}
                />
              )}
              {workspaceFields ? (
                <SettingInput
                  id="organization-logo"
                  label="Organization mark"
                  value={current.logo}
                  error={errors.logo}
                  maxLength={3}
                  description="Up to 3 letters or numbers."
                  onChange={(value) =>
                    changeSetting("organization", "logo", value)
                  }
                />
              ) : (
                <WorkspaceSettingsPlaceholder
                  id="organization-logo"
                  label="Organization mark"
                  loading={workspaceLoading}
                />
              )}
              {workspace && !readOnly ? (
                <Field
                  className="min-w-0 sm:col-span-2"
                  data-invalid={Boolean(logo.error)}
                >
                  <FieldLabel htmlFor="organization-logo-file">
                    Organization logo
                  </FieldLabel>
                  <FilePickerButton
                    id="organization-logo-file"
                    accept=".png,.jpg,.jpeg,image/png,image/jpeg"
                    selectedName={
                      logo.selection.kind === "selected"
                        ? logo.selection.name
                        : null
                    }
                    aria-describedby={[
                      "organization-logo-help",
                      logo.error ? "organization-logo-error" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-invalid={Boolean(logo.error)}
                    onFiles={(files, event) => {
                      const file = files[0];
                      if (file) logo.onSelect(file);
                      event.currentTarget.value = "";
                    }}
                  >
                    Choose logo
                  </FilePickerButton>
                  <FieldDescription id="organization-logo-help">
                    PNG or JPEG, up to 2 MB. The preview changes now; your team
                    sees it after Save settings.
                  </FieldDescription>
                  {logo.selection.kind === "removed" ? (
                    <p role="status" className="text-muted-foreground text-sm">
                      Save settings to remove the logo and use the mark.
                    </p>
                  ) : null}
                  {workspace.logo_file_id ||
                  logo.selection.kind === "selected" ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 w-fit"
                      onClick={logo.onRemove}
                    >
                      Remove logo
                    </Button>
                  ) : null}
                  {logo.onCheckUpload ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 w-fit"
                      onClick={logo.onCheckUpload}
                    >
                      Check upload
                    </Button>
                  ) : null}
                  <FieldError id="organization-logo-error">
                    {logo.error}
                  </FieldError>
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
                </Field>
              ) : null}
            </FieldGroup>
          </FieldSet>

          <FieldSet className="border-border min-w-0 gap-0 border-b pb-6">
            <FieldLegend className="mb-1 text-lg font-semibold tracking-tight">
              Organization profile
            </FieldLegend>
            <p className="text-muted-foreground mb-4 text-sm leading-6">
              Add optional details for your organization.
            </p>
            {profile ? (
              <FieldGroup className="grid min-w-0 gap-4 sm:grid-cols-2">
                <SettingInput
                  id="organization-legal-name"
                  label="Legal name"
                  value={profile.legalName}
                  maxLength={200}
                  error={profileErrors.legalName}
                  onChange={(value) => onProfileChange("legalName", value)}
                />
                <div className="min-w-0 sm:col-span-2">
                  <ProfileTextarea
                    id="organization-description"
                    label="Description"
                    value={profile.description}
                    maxLength={2000}
                    error={profileErrors.description}
                    onChange={(value) => onProfileChange("description", value)}
                  />
                </div>
                {contactsVisible ? (
                  <>
                    <SettingInput
                      id="organization-contact-email"
                      label="Contact email"
                      value={profile.contactEmail ?? ""}
                      maxLength={254}
                      error={profileErrors.contactEmail}
                      onChange={(value) =>
                        onProfileChange("contactEmail", value)
                      }
                    />
                    <SettingInput
                      id="organization-contact-phone"
                      label="Contact phone"
                      value={profile.contactPhone ?? ""}
                      maxLength={50}
                      error={profileErrors.contactPhone}
                      onChange={(value) =>
                        onProfileChange("contactPhone", value)
                      }
                    />
                    <div className="min-w-0 sm:col-span-2">
                      <ProfileTextarea
                        id="organization-postal-address"
                        label="Postal address"
                        value={profile.postalAddress ?? ""}
                        maxLength={2000}
                        error={profileErrors.postalAddress}
                        onChange={(value) =>
                          onProfileChange("postalAddress", value)
                        }
                      />
                    </div>
                  </>
                ) : null}
              </FieldGroup>
            ) : (
              <WorkspaceSettingsPlaceholder
                id="organization-profile-loading"
                label="Profile details"
                loading={workspaceLoading}
              />
            )}
          </FieldSet>

          <FieldSet className="border-border min-w-0 gap-0 border-b pb-6">
            <FieldLegend className="mb-1 text-lg font-semibold tracking-tight">
              Regional defaults
            </FieldLegend>
            <p className="text-muted-foreground mb-4 text-sm leading-6">
              Choose how dates, times, and amounts appear.
            </p>
            <FieldGroup className="grid min-w-0 gap-4 sm:grid-cols-2">
              {workspaceFields ? (
                <SearchSelect
                  id="locale"
                  label="Regional format"
                  value={current.locale}
                  disabled={editDisabled}
                  options={localeOptions.map((tag) => ({
                    value: tag,
                    label: organizationLocaleLabel(tag),
                  }))}
                  onValueChange={(value) =>
                    changeSetting("organization", "locale", value)
                  }
                />
              ) : (
                <WorkspaceSettingsPlaceholder
                  id="locale"
                  label="Regional format"
                  loading={workspaceLoading}
                />
              )}
              {workspaceFields ? (
                <SearchSelect
                  id="timezone"
                  label="Timezone"
                  value={current.timezone}
                  disabled={editDisabled}
                  options={timezoneOptions}
                  onValueChange={(value) =>
                    changeSetting("organization", "timezone", value)
                  }
                />
              ) : (
                <WorkspaceSettingsPlaceholder
                  id="timezone"
                  label="Timezone"
                  loading={workspaceLoading}
                />
              )}
              {workspaceFields ? (
                <SearchSelect
                  id="currency"
                  label="Currency"
                  value={current.currency}
                  disabled={editDisabled}
                  options={currencyOptions}
                  onValueChange={(value) =>
                    changeSetting("organization", "currency", value)
                  }
                />
              ) : (
                <WorkspaceSettingsPlaceholder
                  id="currency"
                  label="Currency"
                  loading={workspaceLoading}
                />
              )}
              {workspaceFields ? (
                <SettingSelect
                  id="week-start"
                  label="Week starts on"
                  value={current.week}
                  error={errors.week}
                  options={["Monday", "Sunday"]}
                  onChange={(value) =>
                    changeSetting("organization", "week", value)
                  }
                />
              ) : (
                <WorkspaceSettingsPlaceholder
                  id="week-start"
                  label="Week starts on"
                  loading={workspaceLoading}
                />
              )}
            </FieldGroup>
          </FieldSet>

          <FieldSet className="border-border min-w-0 gap-0 border-b pb-6">
            <FieldLegend className="mb-1 text-lg font-semibold tracking-tight">
              Working hours
            </FieldLegend>
            <p className="text-muted-foreground mb-4 text-sm leading-6">
              Set a shared reference for your working day.
            </p>
            <div className="max-w-sm">
              {workspaceFields ? (
                <SettingInput
                  id="business-hours"
                  label="Business hours"
                  value={current.hours}
                  maxLength={200}
                  onChange={(value) =>
                    changeSetting("organization", "hours", value)
                  }
                  description="Use 24-hour time and a dash, for example 09:00–18:00."
                  error={errors.hours ?? null}
                />
              ) : (
                <WorkspaceSettingsPlaceholder
                  id="business-hours"
                  label="Business hours"
                  loading={workspaceLoading}
                />
              )}
            </div>
          </FieldSet>

          <OrganizationLook
            theme={theme}
            onChange={onThemeChange}
            readOnly={readOnly}
            disabled={editDisabled}
          />

          {readOnly ? null : (
            <SettingActions
              dirty={dirty}
              onDiscard={() => clearDraft("organization")}
              onSave={() => saveSection("organization")}
              saveLabel={staleRevision ? "Save again" : "Save settings"}
            />
          )}
        </fieldset>
      </form>

      <aside className="min-w-0 space-y-4">
        <Card
          role="region"
          aria-labelledby="manage-organization-preview-title"
          className={`${panelClass} self-stretch`}
        >
          <CardHeader>
            <CardTitle id="manage-organization-preview-title">
              Workspace preview
            </CardTitle>
            <CardDescription>
              Formatting examples update as you edit.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 p-5 sm:p-7">
            <div className="border-border flex min-w-0 flex-col items-center gap-4 border-b pb-7 text-center">
              <WorkspaceLogo
                blob={logo.blob}
                name={organizationName}
                mark={current.logo}
                hidden={logo.concealed}
                className="size-28 rounded-2xl text-4xl font-semibold sm:size-32"
              />
              {logo.onRetryImage ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={logo.onRetryImage}
                >
                  Retry logo
                </Button>
              ) : null}
              <div className="max-w-full min-w-0 space-y-1">
                <h3 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">
                  {workspace
                    ? organizationName
                    : "Workspace details unavailable"}
                </h3>
                <p className="text-muted-foreground text-sm break-words">
                  {workspace
                    ? `${organizationLocaleLabel(current.locale)} · ${readableTimezone(current.timezone)}`
                    : "Load the organization settings to preview them here."}
                </p>
              </div>
            </div>

            <dl className="divide-border divide-y">
              <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] sm:items-baseline sm:gap-4">
                <dt className="text-muted-foreground text-sm">Date and time</dt>
                <dd className="min-w-0 text-sm font-medium break-words sm:text-right">
                  {workspace ? regionalDate : "Unavailable"}
                </dd>
              </div>
              <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] sm:items-baseline sm:gap-4">
                <dt className="text-muted-foreground text-sm">
                  Currency format
                </dt>
                <dd className="min-w-0 text-sm font-medium break-words sm:text-right">
                  {workspace ? regionalCurrency : "Unavailable"}
                </dd>
              </div>
              <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] sm:items-baseline sm:gap-4">
                <dt className="text-muted-foreground text-sm">Working week</dt>
                <dd className="min-w-0 text-sm font-medium break-words sm:text-right">
                  {workspace
                    ? `${current.week} · ${current.hours}`
                    : "Unavailable"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <nav
          aria-label="Related workspace areas"
          className="divide-border divide-y"
        >
          <Button
            asChild
            variant="ghost"
            className="h-auto min-h-12 w-full justify-start gap-3 rounded-lg px-3 py-3 text-left whitespace-normal"
          >
            <GuardedWorkspaceLink href="/access?view=people">
              <UsersRound className="size-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">People and groups</span>
                <span className="text-muted-foreground block text-sm font-normal">
                  Invite people and choose what they can open.
                </span>
              </span>
              <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
            </GuardedWorkspaceLink>
          </Button>
          <Button
            asChild
            variant="ghost"
            className="h-auto min-h-12 w-full justify-start gap-3 rounded-lg px-3 py-3 text-left whitespace-normal"
          >
            <GuardedWorkspaceLink href="/sandbox?section=build">
              <Workflow className="size-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  App design and workflows
                </span>
                <span className="text-muted-foreground block text-sm font-normal">
                  Customize how your workspace works.
                </span>
              </span>
              <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
            </GuardedWorkspaceLink>
          </Button>
        </nav>
      </aside>
    </section>
  );
}

function ProfileTextarea({
  id,
  label,
  value,
  maxLength,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  error?: string;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        value={value}
        maxLength={maxLength}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

function WorkspaceSettingsPlaceholder({
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
      skeleton={
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-11 w-full" />
        </div>
      }
    >
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <p
          id={id}
          className="text-muted-foreground flex min-h-11 items-center text-sm"
          role="status"
        >
          Unavailable
        </p>
      </Field>
    </LoadingRegion>
  );
}
