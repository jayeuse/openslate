"use client";

import { ChevronDown, Clock3 } from "lucide-react";
import {
  type Dispatch,
  type FormEvent,
  type MouseEvent,
  type SetStateAction,
} from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ManageSettings } from "../state/state";
import type { PreviewState } from "./manage-dialogs";
import { SettingSelect } from "./panel-ui";

type PreviewSetter = Dispatch<SetStateAction<PreviewState | null>>;

type LicensingPanelProps = {
  settings: ManageSettings;
  activeUsers: number;
  seatLimit: 100 | 25;
  actions: {
    renewLicense: (event: MouseEvent<HTMLElement>) => void;
  };
  licenseForm: {
    activateLicense: (event: FormEvent<HTMLFormElement>) => void;
    dummyKey: string;
    setDummyKey: Dispatch<SetStateAction<string>>;
  };
};

type LicenseTierComparisonProps = {
  settings: ManageSettings;
  setPreview: PreviewSetter;
};

export function LicensingPanel({
  settings,
  activeUsers,
  seatLimit,
  actions,
  licenseForm,
}: LicensingPanelProps) {
  const { renewLicense } = actions;
  const { activateLicense, dummyKey, setDummyKey } = licenseForm;
  const storageLimit = settings.tier === "Business" ? 100 : 10;

  return (
    <section className="min-w-0 p-6" aria-labelledby="manage-licensing-heading">
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h2
            data-slot="section-title"
            id="manage-licensing-heading"
            className="text-xl font-semibold tracking-tight"
          >
            License &amp; usage
          </h2>
          <p className="text-muted-foreground text-sm">
            Plan status and included capacity.
          </p>
        </header>

        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">Current plan</p>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-3xl font-semibold">{settings.tier}</h3>
            <Badge variant="success">Active · Sample license</Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            Expires {settings.expiry}
          </p>
        </div>

        <div className="space-y-5 border-t pt-5">
          <div className="space-y-2">
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm">
              <h3 data-slot="section-title" className="font-medium">
                Active users
              </h3>
              <span className="font-medium tabular-nums">
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
                {activeUsers} active users exceed the {settings.tier} plan limit
                of {seatLimit}. This preview does not restrict access.
              </p>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm">
              <h3 data-slot="section-title" className="font-medium">
                Storage preview
              </h3>
              <span className="font-medium tabular-nums">
                1.2 / {storageLimit} GB
              </span>
            </div>
            <Progress
              aria-label="Illustrative storage value"
              aria-valuetext={`1.2 of ${storageLimit} GB shown for illustration; workspace storage is not measured`}
              value={1.2}
              max={storageLimit}
            />
            <p className="text-muted-foreground text-sm">
              User usage comes from Access. Storage is illustrative and is not
              measured.
            </p>
          </div>
        </div>

        <div className="border-t pt-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <details className="min-w-0">
              <summary className="border-input bg-background text-foreground hover:bg-accent focus-visible:ring-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md border px-4 py-2 text-sm font-medium transition-colors focus-visible:ring-[3px] focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                <span>Activate license</span>
                <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
              </summary>
              <form
                className="mt-3 flex flex-col gap-3"
                onSubmit={activateLicense}
              >
                <p className="text-muted-foreground text-sm">
                  Choose a bundled sample key. This changes the displayed plan;
                  no payment or license service is contacted.
                </p>
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
                  Continue
                </Button>
              </form>
            </details>

            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={renewLicense}
            >
              <Clock3 data-icon="inline-start" /> Renew license
            </Button>
          </div>
          <p className="text-muted-foreground mt-3 text-sm">
            Renewal changes the displayed expiration only; no purchase or
            payment occurs.
          </p>
        </div>
      </div>
    </section>
  );
}

export function LicenseTierComparison({
  settings,
  setPreview,
}: LicenseTierComparisonProps) {
  return (
    <section className="min-w-0 p-6" aria-labelledby="license-tier-heading">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            data-slot="section-title"
            id="license-tier-heading"
            className="text-xl font-semibold tracking-tight"
          >
            Compare included allowances
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            These example allowances are not published plan terms.
          </p>
        </div>
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
                    These figures are not an offer or a published OpenSlate
                    plan.
                  </p>
                </div>
              ),
            })
          }
        >
          View tier details
        </Button>
      </header>

      <Table className="mt-4 table-fixed" aria-label="Included tier allowances">
        <TableCaption className="sr-only">
          User and storage allowances for Team and Business tiers.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[44%]" scope="col">
              Allowance
            </TableHead>
            <TableHead scope="col">
              <span className="flex flex-wrap items-center gap-2">
                Team
                {settings.tier === "Team" ? (
                  <Badge variant="success">Current</Badge>
                ) : null}
              </span>
            </TableHead>
            <TableHead scope="col">
              <span className="flex flex-wrap items-center gap-2">
                Business
                {settings.tier === "Business" ? (
                  <Badge variant="success">Current</Badge>
                ) : null}
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableHead className="whitespace-normal" scope="row">
              Users
            </TableHead>
            <TableCell className="whitespace-normal">25</TableCell>
            <TableCell className="whitespace-normal">100</TableCell>
          </TableRow>
          <TableRow>
            <TableHead className="whitespace-normal" scope="row">
              Storage allowance
            </TableHead>
            <TableCell className="whitespace-normal">10 GB</TableCell>
            <TableCell className="whitespace-normal">100 GB</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </section>
  );
}
