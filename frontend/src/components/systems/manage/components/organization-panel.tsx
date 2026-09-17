"use client";
import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
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
  SectionHeading,
  SummaryItem,
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
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="manage-organization-heading"
    >
      <SectionHeading
        title="Organization"
        description="Identity, regional defaults and working hours for your workspace."
        dirty={dirty}
      />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
        <Card className={panelClass}>
          <CardHeader>
            <CardTitle id="manage-organization-heading">
              Workspace identity and defaults
            </CardTitle>
            <CardDescription>
              Choose a bundled logo style and preview how regional settings
              appear in the workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                saveSection("organization");
              }}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <SettingInput
                  id="organization-name"
                  label="Organization name"
                  required
                  value={current.name}
                  onChange={(value) =>
                    changeSetting("organization", "name", value)
                  }
                  error={errors.name ?? null}
                />
                <SettingSelect
                  id="organization-logo"
                  label="Organization logo"
                  value={current.logo}
                  error={errors.logo}
                  options={["RS", "R", "Compass"]}
                  onChange={(value) =>
                    changeSetting("organization", "logo", value)
                  }
                />
              </div>
              <FieldSet>
                <FieldLegend>Regional defaults</FieldLegend>
                <FieldGroup className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <SettingSelect
                    id="locale"
                    label="Locale"
                    value={current.locale}
                    error={errors.locale}
                    options={[
                      "English (Philippines)",
                      "Filipino",
                      "English (US)",
                    ]}
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
                    onChange={(value) =>
                      changeSetting("organization", "week", value)
                    }
                  />
                </FieldGroup>
              </FieldSet>
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
              <SettingActions
                dirty={dirty}
                onDiscard={() => clearDraft("organization")}
                onSave={() => saveSection("organization")}
              />
            </form>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-3">
          <Card aria-label="Organization preview" className={panelClass}>
            <CardHeader>
              <CardTitle>Organization preview</CardTitle>
              <CardDescription>
                Preview uses the current draft until you save it.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="bg-muted flex items-center gap-3 rounded-lg border p-4">
                <div
                  className="bg-background flex size-12 shrink-0 items-center justify-center rounded-xl border text-lg font-semibold"
                  aria-label={`${current.name} logo`}
                >
                  {current.logo === "Compass" ? (
                    <Sparkles aria-hidden="true" />
                  ) : (
                    current.logo
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    {current.name || "Unnamed organization"}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {current.locale} · {current.timezone}
                  </p>
                </div>
              </div>
              <dl className="divide-border divide-y">
                <SummaryItem label="Regional timestamp" value={regionalDate} />
                <SummaryItem
                  label="Currency preview"
                  value={regionalCurrency}
                />
                <SummaryItem
                  label="Working week"
                  value={`${current.week} · ${current.hours}`}
                />
              </dl>
            </CardContent>
          </Card>
          <Card className={panelClass}>
            <CardHeader>
              <CardTitle>Related administration</CardTitle>
              <CardDescription>
                Use the dedicated surfaces for people, permissions and app
                design.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
              <Button
                asChild
                variant="outline"
                className="min-h-11 justify-between"
              >
                <Link href="/access?view=identities">
                  People and permissions <ArrowUpRight data-icon="inline-end" />
                </Link>
              </Button>
              <Button
                asChild
                variant="outline"
                className="min-h-11 justify-between"
              >
                <Link href="/sandbox?view=Designer">
                  App design and workflows{" "}
                  <ArrowUpRight data-icon="inline-end" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
