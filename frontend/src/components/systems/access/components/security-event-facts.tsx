"use client";

import { z } from "zod";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";

import type {
  AccessSecurityEvent,
  AccessSecurityEventOutcome,
} from "../adapters/security-events-api";
import {
  address,
  eventLabels,
  personName,
  type PersonNames,
} from "../helpers/security-event-sentences";

// The facts of one security event, shown in the Security events sheet in
// Manage › Audit. Policy setting names use the Access glossary words (MD11,
// docs/specs/manage-relayout.md), as Access › Security shows them.

export const outcomes = {
  attempt: { label: "Attempt", variant: "outline" },
  success: { label: "Success", variant: "success" },
  denied: { label: "Denied", variant: "warning" },
  failure: { label: "Failure", variant: "destructive" },
  partial: { label: "Partial", variant: "warning" },
} as const;
const stageLabels: Record<string, string> = {
  provider_update: "Password update",
  provider_request: "Request sent",
  provider_accepted: "Request accepted",
  provider_request_unconfirmed: "Request not confirmed",
  event_commit: "Saving the event",
  local_commit: "Saving the change",
  password_verification: "Checking the current password",
  local_admission: "Saving the confirmed email during sign-in",
};
const reasonLabels: Record<string, string> = {
  request_accepted: "Recovery request accepted",
  credentials_rejected: "Sign-in was not accepted",
  source_not_allowed: "Address is outside the allowed list",
  failed_attempt_limit: "Failed-attempt limit reached",
};
const policyLabels: Record<string, string> = {
  session_timeout_minutes: "Session timeout",
  session_absolute_lifetime_minutes: "Longest session",
  session_concurrent_limit: "Sessions per person",
  session_retention_days: "Keep session history",
  security_event_retention_days: "Keep security events",
  password_min_length: "Minimum password length",
  password_require_mixed_case: "Require uppercase and lowercase",
  password_require_number: "Require a number",
  mfa_require_admin: "Two-step verification for administrators",
  mfa_require_member: "Two-step verification for members",
  mfa_require_guest: "Two-step verification for guests",
  mfa_grace_days: "Days to set up two-step",
  login_failed_attempt_threshold: "Failed attempts before lockout",
  login_window_minutes: "Within",
  login_cooldown_minutes: "Lock for",
  ip_allow_list: "Allowed addresses",
};
export function eventName(event: AccessSecurityEvent) {
  if (event.event_type === "identity.sign_in" && event.outcome === "success")
    return "Sign-in accepted";
  return Object.hasOwn(eventLabels, event.event_type)
    ? eventLabels[event.event_type]
    : "Other security event";
}
/** Workspace-local time; this device's zone until the workspace region loads. */
export function localTime(value: string, region: WorkspaceRegion | undefined) {
  if (region)
    return formatWorkspaceDateTime(value, region, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
function utcTitle(value: string) {
  return `${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}
export function EventTime({
  value,
  region,
  className,
}: {
  value: string;
  region: WorkspaceRegion | undefined;
  className?: string;
}) {
  return (
    <time className={className} dateTime={value} title={utcTitle(value)}>
      {localTime(value, region)}
    </time>
  );
}
export function Outcome({ outcome }: { outcome: AccessSecurityEventOutcome }) {
  const style = outcomes[outcome];
  return <Badge variant={style.variant}>{style.label}</Badge>;
}

function PersonFact({
  id,
  label,
  names,
  disabled,
  onPersonFilter,
}: {
  id: string | null;
  label: string;
  names: PersonNames;
  disabled: boolean;
  onPersonFilter: (personId: string) => void;
}) {
  if (!id) return <dd>No person recorded</dd>;
  return (
    <dd className="min-w-0 space-y-1">
      <span className="block break-words">{personName(names, id)}</span>
      <span className="text-muted-foreground block font-mono text-xs break-all">
        {id}
      </span>
      <Button
        type="button"
        variant="outline"
        className="mt-1 flex min-h-11 w-fit"
        disabled={disabled}
        onClick={() => onPersonFilter(id)}
      >
        {label}
      </Button>
    </dd>
  );
}

export function SecurityEventFacts({
  event,
  names,
  region,
  disabled,
  onPersonFilter,
}: {
  event: AccessSecurityEvent;
  names: PersonNames;
  region: WorkspaceRegion | undefined;
  disabled: boolean;
  onPersonFilter: (personId: string) => void;
}) {
  const start = z.iso
    .datetime({ offset: true })
    .safeParse(event.metadata.bucket_start);
  const end = z.iso
    .datetime({ offset: true })
    .safeParse(event.metadata.bucket_end);
  const representative =
    event.fingerprint !== null &&
    start.success &&
    end.success &&
    Date.parse(start.data) < Date.parse(end.data) &&
    (event.event_type === "identity.sign_in_failure" ||
      event.event_type === "identity.ip_blocked");
  const stage =
    typeof event.metadata.stage === "string" &&
    Object.hasOwn(stageLabels, event.metadata.stage)
      ? stageLabels[event.metadata.stage]
      : undefined;
  const changed = Array.isArray(event.metadata.changed_fields)
    ? event.metadata.changed_fields.flatMap((field) =>
        typeof field === "string" && Object.hasOwn(policyLabels, field)
          ? [policyLabels[field]]
          : [],
      )
    : [];
  return (
    <div className="min-w-0 space-y-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 font-semibold break-words">
          {eventName(event)}
        </h3>
        <Outcome outcome={event.outcome} />
      </div>
      {event.outcome === "partial" ? (
        <Alert variant="warning" role="note">
          This change may be only partly saved. Check the person&apos;s
          settings.
        </Alert>
      ) : null}
      {event.outcome === "attempt" ? (
        <p className="text-muted-foreground text-sm">
          An attempt was recorded. This does not confirm completion.
        </p>
      ) : null}
      {event.event_type === "identity.sign_in" &&
      event.outcome === "success" ? (
        <p className="text-muted-foreground text-sm">
          The password was accepted. Two-step verification is recorded as a
          separate event.
        </p>
      ) : null}
      {event.event_type === "identity.recovery_request" &&
      event.outcome === "success" ? (
        <p className="text-muted-foreground text-sm">
          We sent the recovery request. We cannot confirm the account exists or
          the email arrived.
        </p>
      ) : null}
      {representative ? (
        <div className="bg-muted space-y-2 rounded-lg p-4 text-sm">
          <p className="font-medium">
            {event.event_type === "identity.sign_in_failure"
              ? "Sign-in failures from this address during this hour"
              : "Blocked attempts from this address during this hour"}
          </p>
          <p>Repeated attempts are grouped. The time shows the first one.</p>
          <p>
            <EventTime value={start.data} region={region} /> –{" "}
            <EventTime value={end.data} region={region} />
          </p>
        </div>
      ) : null}
      <dl className="grid min-w-0 gap-x-3 gap-y-1 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-y-3">
        <dt className="text-muted-foreground">Time</dt>
        <dd className="break-words">
          <EventTime value={event.occurred_at} region={region} />
        </dd>
        <dt className="text-muted-foreground mt-2 sm:mt-0">Network address</dt>
        <dd className="break-all">{address(event)}</dd>
        <dt className="text-muted-foreground mt-2 sm:mt-0">Done by</dt>
        <PersonFact
          id={event.actor_id}
          label="Filter by who did it"
          names={names}
          disabled={disabled}
          onPersonFilter={onPersonFilter}
        />
        <dt className="text-muted-foreground mt-2 sm:mt-0">Affects</dt>
        <PersonFact
          id={event.subject_id}
          label="Filter by who it affects"
          names={names}
          disabled={disabled}
          onPersonFilter={onPersonFilter}
        />
        <dt className="text-muted-foreground mt-2 sm:mt-0">Reference</dt>
        <dd className="min-w-0">
          <span className="font-mono text-xs break-all">
            {event.operation_id}
          </span>
        </dd>
        {event.request_id ? (
          <>
            <dt className="text-muted-foreground mt-2 sm:mt-0">Request ID</dt>
            <dd className="min-w-0">
              <span className="font-mono text-xs break-all">
                {event.request_id}
              </span>
            </dd>
          </>
        ) : null}
        {stage ? (
          <>
            <dt className="text-muted-foreground mt-2 sm:mt-0">Stage</dt>
            <dd>{stage}</dd>
          </>
        ) : null}
        {event.reason && Object.hasOwn(reasonLabels, event.reason) ? (
          <>
            <dt className="text-muted-foreground mt-2 sm:mt-0">Reason</dt>
            <dd>{reasonLabels[event.reason]}</dd>
          </>
        ) : null}
        {event.event_type === "workspace.security_policy_change" &&
        changed.length ? (
          <>
            <dt className="text-muted-foreground mt-2 sm:mt-0">
              Changed settings
            </dt>
            <dd>
              <ul className="list-inside list-disc space-y-1">
                {changed.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
