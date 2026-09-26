"use client";

import Link from "next/link";
import { ArrowUpRight, Compass, UsersRound, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import {
  SettingSelect,
  SettingInput,
  SettingActions,
  type SettingsPanelForm,
} from "./panel-ui";

type OrganizationPanelProps = {
  form: SettingsPanelForm;
  panelClass: string;
  regionalDate: string;
  regionalCurrency: string;
};

export function OrganizationPanel({
  form,
  panelClass,
  regionalDate,
  regionalCurrency,
}: OrganizationPanelProps) {
  const { dirty, saveSection, current, changeSetting, errors, clearDraft } =
    form;
  const organizationName = current.name.trim() || "Unnamed organization";

  return (
    <section
      className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(300px,0.9fr)] lg:gap-10 xl:gap-12"
      aria-label="Organization settings"
    >
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
            <SettingInput
              id="organization-name"
              label="Organization name"
              required
              value={current.name}
              onChange={(value) => changeSetting("organization", "name", value)}
              error={errors.name ?? null}
            />
            <SettingSelect
              id="organization-logo"
              label="Organization mark"
              value={current.logo}
              error={errors.logo}
              options={["RS", "R", "Compass"]}
              onChange={(value) => changeSetting("organization", "logo", value)}
            />
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
            <SettingSelect
              id="locale"
              label="Locale"
              value={current.locale}
              error={errors.locale}
              options={["English (Philippines)", "Filipino", "English (US)"]}
              onChange={(value) =>
                changeSetting("organization", "locale", value)
              }
            />
            <SettingSelect
              id="timezone"
              label="Timezone"
              value={current.timezone}
              error={errors.timezone}
              options={["Asia/Manila", "UTC", "Asia/Singapore"]}
              onChange={(value) =>
                changeSetting("organization", "timezone", value)
              }
            />
            <SettingSelect
              id="currency"
              label="Currency"
              value={current.currency}
              error={errors.currency}
              options={["PHP", "USD", "SGD"]}
              onChange={(value) =>
                changeSetting("organization", "currency", value)
              }
            />
            <SettingSelect
              id="week-start"
              label="Week starts on"
              value={current.week}
              error={errors.week}
              options={["Monday", "Sunday"]}
              onChange={(value) => changeSetting("organization", "week", value)}
            />
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
            <SettingInput
              id="business-hours"
              label="Business hours"
              value={current.hours}
              onChange={(value) =>
                changeSetting("organization", "hours", value)
              }
              description="Use 24-hour time and a dash, for example 09:00–18:00."
              error={errors.hours ?? null}
            />
          </div>
        </FieldSet>

        <SettingActions
          dirty={dirty}
          onDiscard={() => clearDraft("organization")}
          onSave={() => saveSection("organization")}
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
                className="bg-primary text-primary-foreground flex size-28 shrink-0 items-center justify-center rounded-2xl text-4xl font-semibold sm:size-32"
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
                  {organizationName}
                </h3>
                <p className="text-muted-foreground text-sm break-words">
                  {current.locale} · {current.timezone}
                </p>
              </div>
            </div>

            <dl className="divide-border divide-y">
              <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] sm:items-baseline sm:gap-4">
                <dt className="text-muted-foreground text-sm">Date and time</dt>
                <dd className="min-w-0 text-sm font-medium break-words sm:text-right">
                  {regionalDate}
                </dd>
              </div>
              <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] sm:items-baseline sm:gap-4">
                <dt className="text-muted-foreground text-sm">
                  Currency format
                </dt>
                <dd className="min-w-0 text-sm font-medium break-words sm:text-right">
                  {regionalCurrency}
                </dd>
              </div>
              <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] sm:items-baseline sm:gap-4">
                <dt className="text-muted-foreground text-sm">Working week</dt>
                <dd className="min-w-0 text-sm font-medium break-words sm:text-right">
                  {current.week} · {current.hours}
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
            <Link href="/access?view=identities">
              <UsersRound className="size-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  People and permissions
                </span>
                <span className="text-muted-foreground block text-sm font-normal">
                  Manage your team and access.
                </span>
              </span>
              <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
            </Link>
          </Button>
          <Button
            asChild
            variant="ghost"
            className="h-auto min-h-12 w-full justify-start gap-3 rounded-lg px-3 py-3 text-left whitespace-normal"
          >
            <Link href="/sandbox?section=build">
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
            </Link>
          </Button>
        </nav>
      </aside>
    </section>
  );
}
