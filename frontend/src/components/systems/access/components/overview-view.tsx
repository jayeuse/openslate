"use client";

import {
  ArrowRight,
  Building2,
  CircleAlert,
  Clock3,
  KeyRound,
  ShieldCheck,
  Settings2,
  TriangleAlert,
  UsersRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import type { AccessController } from "../state/controller";
import { displayIdentityStatus } from "../domain/policy";

export type AccessOverviewDestination =
  | "identities"
  | "roles"
  | "groups"
  | "rules"
  | "defaults"
  | "import"
  | "export";

type OverviewViewProps = {
  controller: AccessController;
  onNavigate?: (destination: AccessOverviewDestination) => void;
};

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Recently"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export function OverviewView({ controller, onNavigate }: OverviewViewProps) {
  const { state } = controller;
  const pendingCount = state.identities.filter(
    (identity) => identity.status === "pending",
  ).length;
  const rotationDueCount = state.services.filter(
    (identity) => identity.credentialState === "rotation-due",
  ).length;
  const findings = [
    ...state.health.map((finding) => ({
      id: finding.id,
      label: finding.title,
      detail: finding.detail,
      severity: finding.severity,
      destination:
        finding.kind === "empty" || finding.kind === "invalid-reference"
          ? ("rules" as const)
          : ("identities" as const),
    })),
    pendingCount > 0
      ? {
          id: "pending-invitations",
          label: `${pendingCount} pending ${pendingCount === 1 ? "invitation" : "invitations"}`,
          detail: "Review or resend invitations that have not been accepted.",
          severity: "warning" as const,
          destination: "identities" as const,
        }
      : null,
    rotationDueCount > 0
      ? {
          id: "service-rotation",
          label: `${rotationDueCount} service ${rotationDueCount === 1 ? "review" : "reviews"} due`,
          detail: "Review metadata only. Credentials are never exposed.",
          severity: "warning" as const,
          destination: "identities" as const,
        }
      : null,
  ].filter(
    (finding): finding is NonNullable<typeof finding> => finding !== null,
  );

  const counts = [
    {
      label: "Identities",
      displayLabel: "People & services",
      value: state.identities.length,
      detail: `${state.identities.filter((item) => displayIdentityStatus(item) === "active").length} active`,
      icon: UsersRound,
      destination: "identities" as const,
    },
    {
      label: "Roles",
      value: state.roles.length,
      detail: "What each role allows",
      icon: ShieldCheck,
      destination: "roles" as const,
    },
    {
      label: "Groups",
      value: state.groups.length,
      detail: "Shared membership",
      icon: Building2,
      destination: "groups" as const,
    },
    {
      label: "Rules",
      displayLabel: "Custom rules",
      value: state.rules.length,
      detail: "Specific allow and deny conditions",
      icon: KeyRound,
      destination: "rules" as const,
    },
  ];
  const recentHistory = [...state.history]
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, 5);
  const defaultRole =
    state.roles.find((role) => role.id === state.defaults.defaultRoleId)
      ?.name ?? "Unknown role";

  const hasCriticalFindings = findings.some(
    (finding) => finding.severity === "critical",
  );

  return (
    <div className="space-y-4">
      <section aria-label="Access areas">
        <Card className="w-full overflow-hidden p-0">
          <div className="divide-border sm:[&>*:nth-child(even)]:border-border xl:[&>*:nth-child(3)]:border-border grid grid-cols-1 divide-y sm:grid-cols-2 xl:grid-cols-4 sm:[&>*:nth-child(2)]:border-t-0 xl:[&>*:nth-child(3)]:border-t-0 xl:[&>*:nth-child(3)]:border-l xl:[&>*:nth-child(4)]:border-t-0 sm:[&>*:nth-child(even)]:border-l">
            {counts.map(
              ({
                label,
                displayLabel = label,
                value,
                detail,
                icon: Icon,
                destination,
              }) => (
                <Button
                  key={label}
                  variant="ghost"
                  className="group h-auto min-h-24 w-full justify-between rounded-none px-3 py-3 text-left whitespace-normal"
                  aria-label={`Open ${displayLabel}: ${value}. ${detail}`}
                  disabled={!onNavigate}
                  onClick={() => onNavigate?.(destination)}
                >
                  <span className="flex min-w-0 items-start gap-3">
                    <Icon
                      className="text-muted-foreground mt-1 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-col gap-1.5">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-2xl leading-none font-semibold tabular-nums">
                          {value}
                        </span>
                        <span className="text-sm font-medium">
                          {displayLabel}
                        </span>
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {detail}
                      </span>
                    </span>
                  </span>
                  <ArrowRight
                    className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </Button>
              ),
            )}
          </div>
        </Card>
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(17rem,1fr)]">
        <div className="min-w-0 space-y-4">
          <Card className="w-full">
            <CardHeader className="flex-row items-start justify-between gap-3 py-3">
              <div className="flex min-w-0 items-start gap-3">
                {findings.length === 0 ? (
                  <ShieldCheck
                    className="text-success mt-0.5 size-5 shrink-0"
                    aria-hidden="true"
                  />
                ) : hasCriticalFindings ? (
                  <CircleAlert
                    className="text-destructive mt-0.5 size-5 shrink-0"
                    aria-hidden="true"
                  />
                ) : (
                  <TriangleAlert
                    className="text-warning mt-0.5 size-5 shrink-0"
                    aria-hidden="true"
                  />
                )}
                <div className="min-w-0">
                  <CardTitle>Needs attention</CardTitle>
                  <CardDescription className="mt-1 text-xs">
                    Review these items to keep access organized.
                  </CardDescription>
                </div>
              </div>
              <Badge
                variant={
                  findings.length === 0
                    ? "success"
                    : hasCriticalFindings
                      ? "destructive"
                      : "warning"
                }
                className="shrink-0"
              >
                {findings.length === 0
                  ? "No findings"
                  : `${findings.length} to review`}
              </Badge>
            </CardHeader>
            <CardContent className="p-4 pt-3">
              {findings.length === 0 ? (
                <div className="border-success/25 bg-success/5 flex items-start gap-3 rounded-[var(--radius)] border p-3">
                  <ShieldCheck
                    className="text-success mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="text-sm font-medium">No immediate findings</p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      Invitations, expiry, and service details look consistent.
                    </p>
                  </div>
                </div>
              ) : (
                <ul className="space-y-2">
                  {findings.map((finding) => {
                    const isCritical = finding.severity === "critical";
                    return (
                      <li
                        key={finding.id}
                        className={
                          isCritical
                            ? "border-destructive/30 bg-destructive/5 flex min-w-0 flex-col gap-2 rounded-[var(--radius)] border p-3 sm:flex-row sm:items-center"
                            : "border-warning/30 bg-warning/5 flex min-w-0 flex-col gap-2 rounded-[var(--radius)] border p-3 sm:flex-row sm:items-center"
                        }
                      >
                        <CircleAlert
                          className={`${isCritical ? "text-destructive" : "text-warning"} mt-0.5 size-4 shrink-0`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium">
                              {finding.label}
                            </p>
                            {isCritical ? (
                              <Badge variant="destructive">Critical</Badge>
                            ) : null}
                          </div>
                          <p className="text-muted-foreground mt-1 text-sm">
                            {finding.detail}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          className="min-h-11 shrink-0 gap-1 self-start px-2.5 sm:self-auto"
                          aria-label={`Review ${finding.label}`}
                          disabled={!onNavigate}
                          onClick={() => onNavigate?.(finding.destination)}
                        >
                          Review
                          <ArrowRight className="size-4" aria-hidden="true" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="w-full">
            <CardHeader className="py-3">
              <CardTitle>Before granting access</CardTitle>
              <CardDescription className="mt-1 text-xs">
                Three questions to help you choose the right level of access.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4 pb-4">
              <ul className="divide-y">
                <li className="flex gap-3 py-3 first:pt-0">
                  <KeyRound
                    className="text-muted-foreground mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <div>
                    <h3 className="text-sm font-medium">
                      What do they need to do?
                    </h3>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                      Choose a role with only the permissions their work
                      requires.
                    </p>
                  </div>
                </li>
                <li className="flex gap-3 py-3">
                  <Clock3
                    className="text-muted-foreground mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <div>
                    <h3 className="text-sm font-medium">
                      How long do they need access?
                    </h3>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                      Review access duration for guests and services.
                    </p>
                  </div>
                </li>
                <li className="flex gap-3 py-3 last:pb-1">
                  <ShieldCheck
                    className="text-muted-foreground mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <div>
                    <h3 className="text-sm font-medium">
                      Are the permissions appropriate?
                    </h3>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                      Review the assigned role and any applicable rules before
                      granting access.
                    </p>
                  </div>
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card className="w-full">
            <CardHeader className="flex-row items-start gap-3 py-3">
              <Settings2
                className="text-muted-foreground mt-0.5 size-5 shrink-0"
                aria-hidden="true"
              />
              <div>
                <CardTitle>Workspace defaults</CardTitle>
                <CardDescription className="mt-1 text-xs">
                  Applied when you add a person or service.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-3 pb-3">
              <dl className="divide-y text-sm">
                <div className="flex items-center justify-between gap-3 py-2 first:pt-0">
                  <dt className="text-muted-foreground">Default role</dt>
                  <dd className="text-right font-medium">{defaultRole}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-2">
                  <dt className="text-muted-foreground">Invitation expiry</dt>
                  <dd className="text-right">
                    {state.defaults.invitationExpiryDays} days
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-2">
                  <dt className="text-muted-foreground">Guest duration</dt>
                  <dd className="text-right">
                    {state.defaults.guestDurationDays} days
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-2">
                  <dt className="text-muted-foreground">Service duration</dt>
                  <dd className="text-right">
                    {state.defaults.serviceDurationDays} days
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-2 last:pb-0">
                  <dt className="text-muted-foreground">Anything not listed</dt>
                  <dd className="text-right font-medium">No access</dd>
                </div>
              </dl>
              <p className="text-muted-foreground text-xs">
                Requests without permission are blocked.
              </p>
              <Button
                variant="outline"
                className="min-h-11 w-full justify-between"
                disabled={!onNavigate}
                onClick={() => onNavigate?.("defaults")}
              >
                Edit defaults
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            </CardContent>
          </Card>

          <Card className="w-full">
            <CardHeader className="flex-row items-start gap-3 py-3">
              <Clock3
                className="text-muted-foreground mt-0.5 size-5 shrink-0"
                aria-hidden="true"
              />
              <div>
                <CardTitle>Recent changes</CardTitle>
                <CardDescription className="mt-1 text-xs">
                  Latest access-management activity.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="pt-4 pb-4">
              {recentHistory.length === 0 ? (
                <div className="bg-muted/50 flex min-h-28 flex-col items-center justify-center rounded-[var(--radius)] px-4 py-5 text-center">
                  <p className="text-sm font-medium">
                    Activity is not shown here.
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Recorded activity is kept in the audit log.
                  </p>
                  <Button asChild variant="outline" className="mt-3 min-h-11">
                    <GuardedWorkspaceLink href="/manage?view=audit">
                      Open audit log
                      <ArrowRight aria-hidden="true" />
                    </GuardedWorkspaceLink>
                  </Button>
                </div>
              ) : (
                <ol className="divide-y">
                  {recentHistory.map((entry) => (
                    <li key={entry.id} className="flex gap-3 py-3 first:pt-0">
                      <Clock3
                        className="text-muted-foreground mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{entry.summary}</p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {entry.target} · {formatWhen(entry.occurredAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
