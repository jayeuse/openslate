"use client";

import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { ArrowUpRight, Compass, UsersRound, Workflow } from "lucide-react";
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
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SettingSelect,
  SettingInput,
  SettingActions,
  type SettingsPanelForm,
} from "./panel-ui";
import { OrganizationLook } from "./organization-look";
import {
  organizationLocaleTags,
  organizationLocaleLabel,
  workspaceSettingsFormFields,
  type ManageWorkspaceProfile,
} from "../adapters/workspace-api";

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
}: OrganizationPanelProps) {
  const { dirty, saveSection, current, changeSetting, errors, clearDraft } =
    form;
  const organizationName = workspace
    ? current.name.trim() || "Unnamed organization"
    : "Organization details unavailable";
  const localeOptions: string[] = [...organizationLocaleTags];
  if (current.locale && !localeOptions.includes(current.locale))
    localeOptions.push(current.locale);
  const timezoneOptions = ["Asia/Manila", "UTC", "Asia/Singapore"];
  if (current.timezone && !timezoneOptions.includes(current.timezone))
    timezoneOptions.push(current.timezone);
  const markOptions = ["", "RS", "R", "Compass"];
  if (!markOptions.includes(current.logo)) markOptions.push(current.logo);
  const currencyOptions = ["PHP", "USD", "SGD"];
  if (current.currency && !currencyOptions.includes(current.currency))
    currencyOptions.push(current.currency);
  const workspaceFields = workspace
    ? workspaceSettingsFormFields(workspace)
    : null;

  return (
    <section
      className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(300px,0.9fr)] lg:gap-10 xl:gap-12"
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
        <FieldSet className="border-border min-w-0 gap-0 border-b pb-6">
          <FieldLegend className="mb-1 text-lg font-semibold tracking-tight">
            Workspace identity
          </FieldLegend>
          <p className="text-muted-foreground mb-4 text-sm leading-6">
            Choose the name and bundled mark your team recognizes.
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
              <SettingSelect
                id="organization-logo"
                label="Organization mark"
                value={current.logo}
                error={errors.logo}
                options={markOptions}
                optionLabels={{ "": "No mark" }}
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
          </FieldGroup>
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
              <SettingSelect
                id="locale"
                label="Locale"
                value={current.locale}
                error={errors.locale}
                options={localeOptions}
                optionLabels={Object.fromEntries(
                  localeOptions.map((tag) => [
                    tag,
                    organizationLocaleLabel(tag),
                  ]),
                )}
                onChange={(value) =>
                  changeSetting("organization", "locale", value)
                }
              />
            ) : (
              <WorkspaceSettingsPlaceholder
                id="locale"
                label="Locale"
                loading={workspaceLoading}
              />
            )}
            {workspaceFields ? (
              <SettingSelect
                id="timezone"
                label="Timezone"
                value={current.timezone}
                error={errors.timezone}
                options={timezoneOptions}
                onChange={(value) =>
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
              <SettingSelect
                id="currency"
                label="Currency"
                value={current.currency}
                error={errors.currency}
                options={currencyOptions}
                onChange={(value) =>
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

        <FieldSet className="min-w-0 gap-0">
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

        <SettingActions
          dirty={dirty}
          onDiscard={() => clearDraft("organization")}
          onSave={() => saveSection("organization")}
          saveLabel={staleRevision ? "Save again" : "Save settings"}
        />
      </form>

      <aside className="min-w-0 space-y-4">
        <Card
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
              <div
                className="bg-foreground text-background flex size-28 shrink-0 items-center justify-center rounded-2xl text-4xl font-semibold sm:size-32"
                role="img"
                aria-label={`${organizationName} mark: ${current.logo}`}
              >
                {current.logo === "Compass" ? (
                  <Compass className="size-12" aria-hidden="true" />
                ) : (
                  current.logo
                )}
              </div>
              <div className="max-w-full min-w-0 space-y-1">
                <h3 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">
                  {workspace
                    ? organizationName
                    : "Workspace details unavailable"}
                </h3>
                <p className="text-muted-foreground text-sm break-words">
                  {workspace
                    ? `${organizationLocaleLabel(current.locale)} · ${current.timezone}`
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

      <OrganizationLook />
    </section>
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
