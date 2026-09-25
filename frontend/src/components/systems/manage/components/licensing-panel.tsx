"use client";
import { Clock3 } from "lucide-react";
import { type FormEvent, type MouseEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { type ManageSettings } from "../state/state";
import type { PreviewState } from "./manage-dialogs";
import { SettingSelect, SectionHeading } from "./panel-ui";
type LicensingPanelProps = {
  panelClass: string;
  settings: ManageSettings;
  activeUsers: number;
  seatLimit: 100 | 25;
  actions: {
    renewLicense: (event: MouseEvent<HTMLElement>) => void;
    setPreview: import("react").Dispatch<
      import("react").SetStateAction<PreviewState | null>
    >;
  };
  licenseForm: {
    activateLicense: (event: FormEvent<HTMLFormElement>) => void;
    dummyKey: string;
    setDummyKey: import("react").Dispatch<
      import("react").SetStateAction<string>
    >;
  };
};
export function LicensingPanel({
  panelClass,
  settings,
  activeUsers,
  seatLimit,
  actions,
  licenseForm,
}: LicensingPanelProps) {
  const { renewLicense, setPreview } = actions;
  const { activateLicense, dummyKey, setDummyKey } = licenseForm;
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="manage-licensing-heading"
    >
      <SectionHeading
        title="License & usage"
        description="Compare bundled tiers and capacity. No payment, subscription or license service is connected."
      />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className={panelClass}>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Current plan</Badge>
              <Badge variant="success">Active</Badge>
            </div>
            <CardTitle id="manage-licensing-heading" className="text-3xl">
              {settings.tier}
            </CardTitle>
            <CardDescription>Expires {settings.expiry}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <div className="mb-2 flex justify-between text-sm">
                <span>Active users</span>
                <span>
                  {activeUsers} / {seatLimit}
                </span>
              </div>
              <Progress
                aria-label="User license usage"
                aria-valuetext={`${activeUsers} active users; ${seatLimit} seats`}
                value={activeUsers}
                max={seatLimit}
              />
            </div>
            {activeUsers > seatLimit ? (
              <Alert variant="warning" role="status">
                <p className="font-medium">User limit exceeded</p>
                <p>
                  {activeUsers} active users exceed the {settings.tier} plan
                  limit of {seatLimit}. This preview does not restrict access.
                </p>
              </Alert>
            ) : null}
            <div>
              <div className="mb-2 flex justify-between text-sm">
                <span>Storage</span>
                <span>
                  1.2 / {settings.tier === "Business" ? "100" : "10"} GB
                </span>
              </div>
              <Progress
                aria-label="Storage license usage"
                value={1.2}
                max={settings.tier === "Business" ? 100 : 10}
              />
            </div>
            <Alert>
              <p className="font-medium">About these figures</p>
              <p className="mt-1 text-sm">
                User usage comes from the Access directory. Storage values are
                not measured workspace data.
              </p>
            </Alert>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-start"
              onClick={renewLicense}
            >
              <Clock3 data-icon="inline-start" /> Renew license
            </Button>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-3">
          <Card className={panelClass}>
            <CardHeader>
              <CardTitle>Activate a license</CardTitle>
              <CardDescription>
                Choose a provided key. This changes the displayed license only;
                no license service is contacted. Never enter a real key here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-3" onSubmit={activateLicense}>
                <SettingSelect
                  id="bundled-dummy-license-key"
                  label="Bundled license key"
                  value={dummyKey}
                  options={["SAMPLE-TEAM-2026", "SAMPLE-BUSINESS-2026"]}
                  optionLabels={{
                    "SAMPLE-TEAM-2026": "Team key · 2026",
                    "SAMPLE-BUSINESS-2026": "Business key · 2026",
                  }}
                  onChange={setDummyKey}
                />
                <Button type="submit" className="min-h-11 self-start">
                  Activate license
                </Button>
              </form>
            </CardContent>
          </Card>
          <Card className={panelClass}>
            <CardHeader>
              <CardTitle>Compare tiers</CardTitle>
              <CardDescription>
                Compare the included limits. These figures are not published
                plan terms.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div
                className={`rounded-lg border p-4 ${settings.tier === "Team" ? "border-primary ring-ring/30 ring-2" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">Team</h3>
                  {settings.tier === "Team" ? (
                    <Badge variant="success">Current</Badge>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-2 text-sm">
                  25 users · 10 GB storage
                </p>
              </div>
              <div
                className={`rounded-lg border p-4 ${settings.tier === "Business" ? "border-primary ring-ring/30 ring-2" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">Business tier</h3>
                  {settings.tier === "Business" ? (
                    <Badge variant="success">Current</Badge>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-2 text-sm">
                  100 users · 100 GB storage
                </p>
              </div>
            </CardContent>
            <CardFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() =>
                  setPreview({
                    title: "Tier details",
                    description: "These are not published plan terms.",
                    body: (
                      <div className="flex flex-col gap-3 text-sm">
                        <p>Team: 25 users and 10 GB storage.</p>
                        <p>Business: 100 users and 100 GB storage.</p>
                        <p className="text-muted-foreground">
                          These figures are not an offer or a published
                          OpenSlate plan.
                        </p>
                      </div>
                    ),
                  })
                }
              >
                View tier details
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </section>
  );
}
