"use client";

import {
  ArrowRight,
  Building2,
  CircleAlert,
  Clock3,
  KeyRound,
  ShieldCheck,
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
import type { AccessController } from "../state/controller";

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
      value: state.identities.length,
      detail: `${state.identities.filter((item) => item.status === "active").length} active`,
      icon: UsersRound,
      destination: "identities" as const,
    },
    {
      label: "Roles",
      value: state.roles.length,
      detail: "What each identity can do",
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
      value: state.rules.length,
      detail: "Allow and deny conditions",
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

  return (
    <div className="space-y-1.5">
      <section
        aria-labelledby="access-snapshot-heading"
        className="space-y-1.5"
      >
        <div>
          <h2 id="access-snapshot-heading" className="text-lg font-semibold">
            Access overview
          </h2>
          <p className="text-muted-foreground text-sm">
            Identities are people and services. Roles set what they can do,
            groups organize them, and rules handle specific access.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          {counts.map(({ label, value, detail, icon: Icon, destination }) => (
            <Card key={label} className="w-full">
              <CardContent className="flex items-start justify-between gap-2 p-2.5">
                <div>
                  <p className="text-muted-foreground text-sm">{label}</p>
                  <p className="mt-0.5 text-xl font-semibold tabular-nums">
                    {value}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {detail}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={`Open ${label.toLowerCase()}`}
                  disabled={!onNavigate}
                  onClick={() => onNavigate?.(destination)}
                >
                  <Icon className="size-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <div className="grid items-start gap-3 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.35fr)_minmax(15rem,0.65fr)_minmax(15rem,0.65fr)]">
        <Card className="w-full">
          <CardHeader className="flex-row items-start justify-between gap-3 py-3">
            <div>
              <CardTitle>Needs attention</CardTitle>
              <CardDescription className="text-xs">
                Conditions worth reviewing before granting more access.
              </CardDescription>
            </div>
            {findings.length > 0 && (
              <Badge variant="outline">{findings.length} open</Badge>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {findings.length === 0 ? (
              <div className="flex items-start gap-3 p-5">
                <ShieldCheck className="text-muted-foreground mt-0.5 size-4" />
                <div>
                  <p className="text-sm font-medium">No immediate findings</p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Invitations, expiry, and service metadata look consistent.
                  </p>
                </div>
              </div>
            ) : (
              <ul className="divide-y">
                {findings.map((finding) => (
                  <li
                    key={finding.id}
                    className="flex items-start gap-3 px-3 py-2"
                  >
                    <CircleAlert
                      className={
                        finding.severity === "critical"
                          ? "text-destructive mt-1 size-4 shrink-0"
                          : "text-muted-foreground mt-1 size-4 shrink-0"
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{finding.label}</p>
                      <p className="text-muted-foreground mt-0.5 text-xs leading-tight">
                        {finding.detail}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      className="min-h-11 shrink-0 gap-1 px-2.5"
                      aria-label={`Review ${finding.label}`}
                      disabled={!onNavigate}
                      onClick={() => onNavigate?.(finding.destination)}
                    >
                      Review
                      <ArrowRight className="size-4" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="w-full">
          <CardHeader className="py-3">
            <CardTitle>Workspace defaults</CardTitle>
            <CardDescription className="text-xs">
              Applied when a new identity is created.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pb-3">
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Default role</dt>
              <dd className="font-medium">{defaultRole}</dd>
              <dt className="text-muted-foreground">Invitation expiry</dt>
              <dd>{state.defaults.invitationExpiryDays} days</dd>
              <dt className="text-muted-foreground">Guest duration</dt>
              <dd>{state.defaults.guestDurationDays} days</dd>
              <dt className="text-muted-foreground">Service duration</dt>
              <dd>{state.defaults.serviceDurationDays} days</dd>
              <dt className="text-muted-foreground">Fallback</dt>
              <dd>Default deny</dd>
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
              <ArrowRight className="size-4" />
            </Button>
          </CardContent>
        </Card>

        <Card className="w-full">
          <CardHeader className="py-3">
            <CardTitle>Recent changes</CardTitle>
            <CardDescription className="text-xs">
              Latest access-management activity.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {recentHistory.length === 0 ? (
              <p className="text-muted-foreground p-4 text-sm">
                Changes will appear here after you edit access.
              </p>
            ) : (
              <ol className="divide-y">
                {recentHistory.map((entry) => (
                  <li key={entry.id} className="flex gap-3 px-4 py-3">
                    <Clock3 className="text-muted-foreground mt-0.5 size-4 shrink-0" />
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
  );
}
