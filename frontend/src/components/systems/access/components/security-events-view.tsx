"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import { RefreshCw, X } from "lucide-react";
import { z } from "zod";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LoadingRegion } from "@/components/ui/loading-region";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { SearchFilterToolbar } from "@/components/ui/search-filter-toolbar";
import { SearchSelect } from "@/components/ui/search-select";
import { usePeopleSearch } from "../hooks/use-people-search";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";
import { workspaceCalendarQueryOptions } from "../../manage/adapters/workspace-api";
import {
  accessKeys,
  accessSecurityEventsOptions,
  isAccessSecurityDenied,
  readAccessSecurityEvent,
  setAccessSecurityDenied,
} from "../adapters/access-queries";
import {
  defaultSecurityEventsRequest,
  type AccessSecurityEvent,
  type AccessSecurityEventOutcome,
} from "../adapters/security-events-api";

const eventLabels: Record<string, string> = {
  "identity.sign_in": "Sign-in",
  "identity.sign_in_failure": "Sign-in failure",
  "identity.lockout": "Sign-in lockout",
  "identity.ip_blocked": "Address blocked",
  "identity.password_change": "Password change",
  "identity.recovery_request": "Recovery request",
  "identity.recovery_complete": "Recovery completion",
  "identity.mfa.enrolled": "Two-step verification enrollment",
  "identity.mfa.verified": "Two-step verification",
  "identity.mfa.removed": "Two-step verification removal",
  "identity.mfa.cancelled": "Two-step verification setup cancellation",
  "identity.mfa.removal_incomplete": "Incomplete two-step verification removal",
  "identity.recovery": "Person recovery request",
  "identity.mfa_reset": "Two-step verification reset",
  "identity.session_revocation": "Session ending",
  "identity.local_admin_recovery": "Local administrator recovery",
  "identity.local_security_recovery": "Local security recovery",
  "user.invitation": "Invitation",
  "user.invitation_resend": "Invitation resend",
  "user.invitation_revocation": "Invitation revocation",
  "user.invitation_acceptance": "Invitation acceptance",
  "user.authentication_activation": "Authentication activation",
  "user.authentication_disable": "Authentication disablement",
  "user.authentication_restore": "Authentication restoration",
  "workspace.security_policy_change": "Account policy change",
  "security.retention": "Session retention",
  "backup.export.download": "Backup export download",
  "file.download": "File download",
  "records.export.authorized": "Record export authorization",
  "records.aggregate_snapshot.authorized": "Aggregate snapshot authorization",
  "records.aggregate_snapshots.authorized": "Aggregate snapshots authorization",
  "lifecycle.record_purge": "Permanent record deletion",
  "job.retry": "Job retry",
};
const outcomes = {
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
};
const reasonLabels: Record<string, string> = {
  request_accepted: "Recovery request accepted",
  credentials_rejected: "Sign-in was not accepted",
  source_not_allowed: "Address is outside the allowed list",
  failed_attempt_limit: "Failed-attempt limit reached",
};
const policyLabels: Record<string, string> = {
  session_timeout_minutes: "Session timeout",
  session_absolute_lifetime_minutes: "Session lifetime",
  session_concurrent_limit: "Maximum sessions",
  session_retention_days: "Session retention",
  security_event_retention_days: "Security event retention",
  password_min_length: "Minimum password length",
  password_require_mixed_case: "Mixed-case password requirement",
  password_require_number: "Password number requirement",
  mfa_require_admin: "Two-step verification for administrators",
  mfa_require_member: "Two-step verification for members",
  mfa_require_guest: "Two-step verification for guests",
  mfa_grace_days: "Two-step verification setup time",
  login_failed_attempt_threshold: "Failed-attempt threshold",
  login_window_minutes: "Attempt window",
  login_cooldown_minutes: "Lockout duration",
  ip_allow_list: "Allowed addresses",
};
const sorts = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "event", label: "Event name" },
  { value: "outcome", label: "Outcome" },
] as const;
type EventSort = (typeof sorts)[number]["value"];
type Filters = {
  search: string;
  type: string;
  exactType: string;
  outcome: AccessSecurityEventOutcome | "";
  person: string;
  from: string;
  through: string;
  sort: EventSort;
};
const initialFilters: Filters = {
  search: "",
  type: "",
  exactType: "",
  outcome: "",
  person: "",
  from: "",
  through: "",
  sort: "newest",
};
type Detail =
  | { id: string; status: "loading" | "error" }
  | { id: string; status: "ready"; event: AccessSecurityEvent };
type SecurityEventsViewProps = {
  active: boolean;
  admitted: boolean;
  pending: boolean;
  onReadChange: () => void;
};

function eventName(event: AccessSecurityEvent) {
  if (event.event_type === "identity.sign_in" && event.outcome === "success")
    return "Sign-in accepted";
  return Object.hasOwn(eventLabels, event.event_type)
    ? eventLabels[event.event_type]
    : "Other security event";
}
/** Workspace-local time; this device's zone until the workspace region loads. */
function localTime(value: string, region: WorkspaceRegion | undefined) {
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
function EventTime({
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
/** The instant a calendar day starts in the workspace (or this device's) zone. */
function dayStart(day: string, region: WorkspaceRegion | undefined, add = 0) {
  const timeZone =
    region?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Temporal.PlainDate.from(day)
    .add({ days: add })
    .toZonedDateTime({ timeZone })
    .toInstant()
    .toString();
}
function address(event: AccessSecurityEvent) {
  const parsed = z
    .union([z.ipv4(), z.ipv6()])
    .safeParse(event.metadata.ip_address);
  return parsed.success ? parsed.data : "Address unknown";
}
function recordedPerson(event: AccessSecurityEvent) {
  return event.subject_id ?? event.actor_id;
}
type PersonNames = ReadonlyMap<string, string>;
function personName(names: PersonNames, id: string | null) {
  return (id && names.get(id)) || "Unknown person";
}

/** Only emitter-recorded facts become text; attempts never imply completion. */
function securityEventSentence(
  event: AccessSecurityEvent,
  names: PersonNames,
): string {
  const actor = personName(names, event.actor_id);
  const subject = personName(names, event.subject_id);
  const person = personName(names, recordedPerson(event));
  const network =
    address(event) === "Address unknown"
      ? "an unknown address"
      : address(event);
  const count = (key: string) => {
    const value = event.metadata[key];
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : null;
  };
  const result = (completed: string, action: string) => {
    if (event.outcome === "success") return completed;
    const endings = {
      attempt: "was attempted",
      partial: "was only partly completed",
      denied: "was denied",
      failure: "failed",
    };
    return `${action} ${endings[event.outcome]}.`;
  };
  switch (event.event_type) {
    case "identity.sign_in":
      return result(
        `${actor}'s sign-in was accepted from ${network}.`,
        `Sign-in for ${actor}`,
      );
    case "identity.sign_in_failure":
      return `Failed sign-in attempts were recorded from ${network}.`;
    case "identity.ip_blocked":
      return `Sign-in was blocked from ${network}.`;
    case "identity.lockout":
      return `Sign-in was temporarily locked from ${network}.`;
    case "identity.password_change":
      return result(
        `${actor} changed their password.`,
        `Password change for ${actor}`,
      );
    case "identity.recovery_request":
      return result(
        "A password recovery request was accepted.",
        "A password recovery request",
      );
    case "identity.recovery_complete":
      return result(
        `${person} completed password recovery.`,
        `Password recovery for ${person}`,
      );
    case "identity.mfa.enrolled":
      return result(
        `${person} enrolled a two-step verification factor.`,
        `Two-step verification enrollment for ${person}`,
      );
    case "identity.mfa.verified":
      return result(
        `${person} completed two-step verification.`,
        `Two-step verification for ${person}`,
      );
    case "identity.mfa.removed":
      return result(
        `${person} removed a two-step verification factor.`,
        `Two-step verification removal for ${person}`,
      );
    case "identity.mfa.cancelled":
      return result(
        `${person} cancelled two-step verification setup.`,
        `Two-step verification setup cancellation for ${person}`,
      );
    case "identity.mfa.removal_incomplete":
      return result(
        `Incomplete two-step verification removal was recorded for ${person}.`,
        `Two-step verification removal for ${person}`,
      );
    case "identity.recovery":
      return result(
        `${actor} requested password recovery for ${subject}.`,
        `Password recovery request by ${actor} for ${subject}`,
      );
    case "identity.mfa_reset":
      return result(
        `${actor} reset two-step verification for ${subject}.`,
        `Two-step verification reset by ${actor} for ${subject}`,
      );
    case "identity.session_revocation": {
      const scope = event.labels.scope;
      const completed =
        scope === "one"
          ? `${actor} ended a session for ${subject}.`
          : scope === "others"
            ? `${actor} ended ${subject}'s other sessions.`
            : scope === "all"
              ? `${actor} ended all sessions for ${subject}.`
              : `${actor} ended sessions for ${subject}.`;
      return result(completed, `Session ending by ${actor} for ${subject}`);
    }
    case "identity.local_admin_recovery":
      return result(
        `Local administrator recovery was requested for ${subject}.`,
        `Local administrator recovery for ${subject}`,
      );
    case "identity.local_security_recovery":
      return result(
        `Local security recovery completed for ${subject}.`,
        `Local security recovery for ${subject}`,
      );
    case "user.invitation":
      return result(
        `${actor} invited ${subject}.`,
        `An invitation from ${actor} to ${subject}`,
      );
    case "user.invitation_resend":
      return result(
        `${actor} resent an invitation for ${subject}.`,
        `Invitation resend by ${actor} for ${subject}`,
      );
    case "user.invitation_revocation":
      return result(
        `${actor} revoked ${subject}'s invitation.`,
        `Invitation revocation by ${actor} for ${subject}`,
      );
    case "user.invitation_acceptance":
      return result(
        `${person} accepted an invitation.`,
        `Invitation acceptance by ${person}`,
      );
    case "user.authentication_activation":
      return result(
        `${actor} activated authentication for ${subject}.`,
        `Authentication activation by ${actor} for ${subject}`,
      );
    case "user.authentication_disable":
      return result(
        `${actor} disabled authentication for ${subject}.`,
        `Authentication disablement by ${actor} for ${subject}`,
      );
    case "user.authentication_restore":
      return result(
        `${actor} restored authentication for ${subject}.`,
        `Authentication restoration by ${actor} for ${subject}`,
      );
    case "workspace.security_policy_change":
      return result(
        `${actor} changed the account security policy.`,
        `Account security policy change by ${actor}`,
      );
    case "security.retention": {
      const removed = count("deleted_sessions");
      return result(
        `Session retention removed ${removed === null ? "session records" : `${removed} session record${removed === 1 ? "" : "s"}`}.`,
        "Session retention cleanup",
      );
    }
    case "backup.export.download":
      return result(
        `Backup export download was authorized for ${actor}.`,
        `Backup export download by ${actor}`,
      );
    case "file.download":
      return result(
        `File download was authorized for ${actor}.`,
        `File download by ${actor}`,
      );
    case "records.export.authorized": {
      const rows = count("row_count");
      const records =
        rows === null ? "records" : `${rows} record${rows === 1 ? "" : "s"}`;
      const format =
        event.metadata.format === "xlsx"
          ? "Excel"
          : event.metadata.format === "csv"
            ? "CSV"
            : null;
      return result(
        `${actor} was authorized to export ${records}${format ? ` as ${format}` : ""}.`,
        `Record export by ${actor}`,
      );
    }
    case "records.aggregate_snapshot.authorized": {
      const buckets = count("bucket_count");
      return result(
        `${actor} was authorized to create an aggregate snapshot${buckets === null ? "" : ` with ${buckets} bucket${buckets === 1 ? "" : "s"}`}.`,
        `Aggregate snapshot by ${actor}`,
      );
    }
    case "records.aggregate_snapshots.authorized": {
      const queries = count("query_count");
      const buckets = count("bucket_count");
      const snapshots =
        queries === null
          ? "aggregate snapshots"
          : `${queries} aggregate snapshot${queries === 1 ? "" : "s"}`;
      return result(
        `${actor} was authorized to create ${snapshots}${buckets === null ? "" : ` with ${buckets} bucket${buckets === 1 ? "" : "s"}`}.`,
        `Aggregate snapshots by ${actor}`,
      );
    }
    case "lifecycle.record_purge":
      return result(
        `${actor} permanently deleted a record.`,
        `Permanent record deletion by ${actor}`,
      );
    case "job.retry": {
      const kinds: Record<string, string> = {
        "report-run": "report run",
        "post-publish": "post publication",
        "event-reminder": "event reminder",
        backup: "backup",
      };
      const kind =
        typeof event.metadata.kind === "string" &&
        Object.hasOwn(kinds, event.metadata.kind)
          ? kinds[event.metadata.kind]
          : null;
      return result(
        `${actor} queued a retry for a ${kind ? `${kind} ` : ""}job.`,
        `Job retry by ${actor}`,
      );
    }
    default:
      return "Other security event";
  }
}
function Outcome({ outcome }: { outcome: AccessSecurityEventOutcome }) {
  const style = outcomes[outcome];
  return <Badge variant={style.variant}>{style.label}</Badge>;
}

/** Read-only child: the Audit host retains admission and refusal ownership. */
export function SecurityEventsView({
  active,
  admitted,
  pending,
  onReadChange,
}: SecurityEventsViewProps) {
  const client = useQueryClient();
  const id = useId();
  const [filters, setFilters] = useState(initialFilters);
  const [offset, setOffset] = useState(0);
  const [personMode, setPersonMode] = useState<"directory" | "id">("directory");
  const [directoryRequested, setDirectoryRequested] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const detailOpener = useRef<HTMLElement | null>(null);
  const fallbackFocus = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);
  const refreshOwner = useRef<{
    queryKey: ReturnType<typeof accessKeys.securityEventList>;
  } | null>(null);
  const notifiedDenied = useRef(false);
  const authority = useRef({ active, admitted });
  const denied = isAccessSecurityDenied(client, "events");
  const region = useQuery({
    ...workspaceCalendarQueryOptions(),
    enabled: active && admitted,
  }).data;
  const uuidError =
    filters.person && !z.uuid().safeParse(filters.person).success
      ? "Enter a valid person ID."
      : "";
  const typeError =
    filters.type === "other" && !filters.exactType.trim()
      ? "Enter an exact event type."
      : "";
  const dayError =
    (filters.from && !z.iso.date().safeParse(filters.from).success) ||
    (filters.through && !z.iso.date().safeParse(filters.through).success)
      ? "Enter a valid date."
      : filters.from && filters.through && filters.from > filters.through
        ? "Through must be on or after From."
        : "";
  const invalid = Boolean(uuidError || typeError || dayError);
  const nextDay =
    filters.through && !dayError ? dayStart(filters.through, region, 1) : "";
  const request = {
    ...defaultSecurityEventsRequest,
    offset,
    search: filters.search.trim(),
    event_type:
      filters.type === "other" ? filters.exactType.trim() : filters.type,
    outcome: filters.outcome,
    person_id: filters.person,
    occurred_after:
      filters.from && !dayError ? dayStart(filters.from, region) : "",
    occurred_before: nextDay,
    sort_by:
      filters.sort === "event"
        ? ("event_type" as const)
        : filters.sort === "outcome"
          ? ("outcome" as const)
          : ("occurred_at" as const),
    sort_order:
      filters.sort === "oldest" ||
      filters.sort === "event" ||
      filters.sort === "outcome"
        ? ("asc" as const)
        : ("desc" as const),
  };
  const stamp = JSON.stringify(request);
  const currentStamp = useRef(stamp);
  const events = useQuery({
    ...accessSecurityEventsOptions(client, request),
    enabled: active && admitted && !denied && !invalid,
  });
  const labelIds = (events.data?.items ?? [])
    .flatMap((event) => [event.actor_id, event.subject_id])
    .filter((value): value is string => Boolean(value));
  if (filters.person && !uuidError) labelIds.push(filters.person);
  const people = usePeopleSearch({
    selectedIds: labelIds,
    enabled: active && admitted && !denied,
  });
  const names: PersonNames = useMemo(
    () =>
      new Map(
        [...people.items, ...people.selectedItems].map((person) => [
          person.id,
          person.display_name || person.username,
        ]),
      ),
    [people.items, people.selectedItems],
  );
  const page = denied || invalid ? undefined : events.data;
  const narrowed = Boolean(
    filters.search.trim() ||
    filters.type ||
    filters.outcome ||
    filters.person ||
    filters.from ||
    filters.through,
  );
  const filterCount = [
    filters.type,
    filters.outcome,
    filters.person,
    filters.from,
    filters.through,
  ].filter(Boolean).length;
  const personOptions = [
    { value: "", label: "All people" },
    ...people.items.map((person) => ({
      value: person.id,
      label: person.display_name || person.username,
    })),
  ];
  const selectedPerson = people.selectedItems.find(
    (person) => person.id === filters.person,
  );
  const selectedPersonOption =
    filters.person && !uuidError
      ? {
          value: filters.person,
          label: selectedPerson
            ? selectedPerson.display_name || selectedPerson.username
            : people.selectedLoading
              ? "Loading person…"
              : "Unknown person",
        }
      : undefined;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshOwner.current = null;
      detailController.current?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    authority.current = { active, admitted };
    currentStamp.current = stamp;
    if (pending && refreshOwner.current) {
      const owner = refreshOwner.current;
      refreshOwner.current = null;
      setRefreshing(false);
      void client.cancelQueries({ queryKey: owner.queryKey, exact: true });
    }
    if (!active || !admitted || denied) {
      detailController.current?.abort();
      detailController.current = null;
      setDetail(null);
    }
  }, [active, admitted, client, denied, pending, stamp]);
  useEffect(() => {
    if (!denied) {
      notifiedDenied.current = false;
      return;
    }
    if (!active || !admitted || notifiedDenied.current) return;
    if (
      events.error instanceof ApiError &&
      (events.error.status === 401 || events.error.status === 403)
    ) {
      notifiedDenied.current = true;
      onReadChange();
    }
  }, [active, admitted, denied, events.error, onReadChange]);

  function changeFilters(patch: Partial<Filters>) {
    if (pending) return;
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  }
  function closeDetail() {
    detailController.current?.abort();
    detailController.current = null;
    setDetail(null);
  }
  const loadDetail = useCallback(
    async (eventId: string, opener?: MouseEvent<HTMLElement>) => {
      if (pending || denied || !active || !admitted) return;
      detailController.current?.abort();
      const controller = new AbortController();
      detailController.current = controller;
      if (opener) detailOpener.current = opener.currentTarget;
      setDetail({ id: eventId, status: "loading" });
      const owns = () =>
        mounted.current &&
        detailController.current === controller &&
        authority.current.active &&
        authority.current.admitted &&
        !controller.signal.aborted;
      try {
        const event = await readAccessSecurityEvent(
          client,
          eventId,
          controller.signal,
        );
        if (owns()) setDetail({ id: eventId, status: "ready", event });
      } catch (error) {
        if (!owns()) return;
        setDetail({ id: eventId, status: "error" });
        if (
          isAccessSecurityDenied(client, "events") &&
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        )
          onReadChange();
      }
    },
    [active, admitted, client, denied, onReadChange, pending],
  );
  async function refresh(retry: boolean) {
    if (pending || refreshing || invalid || !active || !admitted) return;
    const options = accessSecurityEventsOptions(client, request);
    const owner = { queryKey: options.queryKey };
    refreshOwner.current = owner;
    const readStamp = stamp;
    setRefreshing(true);
    try {
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      await client.fetchQuery({ ...options, staleTime: 0 });
      if (
        mounted.current &&
        refreshOwner.current === owner &&
        authority.current.active &&
        authority.current.admitted &&
        currentStamp.current === readStamp &&
        retry
      ) {
        setAccessSecurityDenied(client, "events", false);
        onReadChange();
      }
    } catch {
      // The query owns the safe same-key failure state. No raw server text.
    } finally {
      if (mounted.current && refreshOwner.current === owner) {
        refreshOwner.current = null;
        setRefreshing(false);
      }
    }
  }
  if (!active || !admitted) return null;
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="min-w-0 space-y-4"
      ref={fallbackFocus}
      tabIndex={-1}
    >
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3 border-b">
          <div className="min-w-0 space-y-1">
            <CardTitle id={`${id}-heading`}>Security events</CardTitle>
            <CardDescription>
              Review recorded security activity across your organization.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            aria-label="Refresh security events"
            disabled={pending || refreshing || invalid || denied}
            onClick={() => void refresh(false)}
          >
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="min-w-0 space-y-4 pt-5">
          <fieldset disabled={pending} className="min-w-0">
            <SearchFilterToolbar
              searchLabel="Search security events"
              placeholder="Search recorded events"
              searchMaxLength={200}
              query={filters.search}
              onQueryChange={(search) => changeFilters({ search })}
              sortLabel="Sort security events"
              sort={filters.sort}
              sortOptions={sorts}
              onSortChange={(sort) => changeFilters({ sort })}
              activeFilterCount={filterCount}
              sortInFiltersBelowMd
            >
              <Field>
                <FieldLabel htmlFor={`${id}-type`}>Event type</FieldLabel>
                <NativeSelect
                  id={`${id}-type`}
                  value={filters.type}
                  className="w-full [&_select]:min-h-11"
                  onChange={(event) =>
                    changeFilters({ type: event.target.value })
                  }
                >
                  <NativeSelectOption value="">
                    All event types
                  </NativeSelectOption>
                  {Object.entries(eventLabels).map(([value, label]) => (
                    <NativeSelectOption key={value} value={value}>
                      {label}
                    </NativeSelectOption>
                  ))}
                  <NativeSelectOption value="other">
                    Other event type
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-outcome`}>Outcome</FieldLabel>
                <NativeSelect
                  id={`${id}-outcome`}
                  value={filters.outcome}
                  className="w-full [&_select]:min-h-11"
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "" || value in outcomes)
                      changeFilters({ outcome: value as Filters["outcome"] });
                  }}
                >
                  <NativeSelectOption value="">All outcomes</NativeSelectOption>
                  {Object.entries(outcomes).map(([value, item]) => (
                    <NativeSelectOption key={value} value={value}>
                      {item.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              {filters.type === "other" ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-exact-type`}>
                    Exact event type
                  </FieldLabel>
                  <Input
                    id={`${id}-exact-type`}
                    value={filters.exactType}
                    maxLength={100}
                    className="min-h-11"
                    aria-invalid={Boolean(typeError)}
                    aria-describedby={
                      typeError ? `${id}-type-error` : undefined
                    }
                    onChange={(event) =>
                      changeFilters({ exactType: event.target.value })
                    }
                  />
                  {typeError ? (
                    <FieldError id={`${id}-type-error`}>{typeError}</FieldError>
                  ) : null}
                </Field>
              ) : null}
              <div
                className="min-w-0 space-y-2"
                onFocusCapture={() => setDirectoryRequested(true)}
              >
                {personMode === "directory" ? (
                  <SearchSelect
                    label="Person"
                    value={filters.person}
                    options={personOptions}
                    onValueChange={(person) => changeFilters({ person })}
                    search={people.search}
                    onSearchChange={people.onSearchChange}
                    selectedOption={selectedPersonOption}
                    loading={people.loading}
                    error={people.error}
                    onRetry={people.retry}
                    hasMore={people.hasMore}
                    onLoadMore={() => void people.loadMore()}
                    loadingMore={people.loadingMore}
                    disabled={pending || denied}
                    placeholder="All people"
                    emptyMessage={
                      people.loading ? "Loading people…" : "No one matches."
                    }
                  />
                ) : (
                  <Field>
                    <FieldLabel htmlFor={`${id}-person-id`}>
                      Person ID
                    </FieldLabel>
                    <Input
                      id={`${id}-person-id`}
                      value={filters.person}
                      maxLength={36}
                      className="min-h-11"
                      aria-invalid={Boolean(uuidError)}
                      aria-describedby={`${id}-person-help${uuidError ? ` ${id}-person-error` : ""}`}
                      onChange={(event) =>
                        changeFilters({ person: event.target.value })
                      }
                    />
                    <p
                      id={`${id}-person-help`}
                      className="text-muted-foreground text-xs"
                    >
                      Use the ID shown in an event&apos;s details. This also
                      finds people no longer in the directory.
                    </p>
                    {uuidError ? (
                      <FieldError id={`${id}-person-error`}>
                        {uuidError}
                      </FieldError>
                    ) : null}
                  </Field>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  className="text-primary min-h-11 w-fit justify-start px-0 text-sm underline underline-offset-4 hover:bg-transparent"
                  onClick={() =>
                    setPersonMode(
                      personMode === "directory" ? "id" : "directory",
                    )
                  }
                >
                  {personMode === "directory"
                    ? "Enter a person ID"
                    : "Choose from directory"}
                </Button>
                {people.error && directoryRequested ? (
                  <Alert
                    role="alert"
                    variant="destructive"
                    className="space-y-2 text-sm"
                  >
                    <p>
                      The person list could not load. Enter a person ID, or try
                      again.
                    </p>
                    <Button
                      variant="ghost"
                      className="min-h-11 px-0"
                      onClick={people.retry}
                    >
                      Retry person list
                    </Button>
                  </Alert>
                ) : null}
              </div>
              <div className="grid min-w-0 grid-cols-2 gap-3">
                <Field className="min-w-0">
                  <FieldLabel htmlFor={`${id}-from`}>From</FieldLabel>
                  <Input
                    id={`${id}-from`}
                    type="date"
                    value={filters.from}
                    className="min-h-11"
                    aria-invalid={Boolean(dayError)}
                    aria-describedby={dayError ? `${id}-day-error` : undefined}
                    onChange={(event) =>
                      changeFilters({ from: event.target.value })
                    }
                  />
                </Field>
                <Field className="min-w-0">
                  <FieldLabel htmlFor={`${id}-through`}>Through</FieldLabel>
                  <Input
                    id={`${id}-through`}
                    type="date"
                    value={filters.through}
                    className="min-h-11"
                    aria-invalid={Boolean(dayError)}
                    aria-describedby={dayError ? `${id}-day-error` : undefined}
                    onChange={(event) =>
                      changeFilters({ through: event.target.value })
                    }
                  />
                </Field>
                {dayError ? (
                  <p
                    id={`${id}-day-error`}
                    role="alert"
                    className="text-destructive col-span-2 text-sm"
                  >
                    {dayError}
                  </p>
                ) : null}
              </div>
            </SearchFilterToolbar>
          </fieldset>
          {narrowed ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={() => {
                setFilters(initialFilters);
                setOffset(0);
              }}
              aria-label="Clear event filters"
            >
              Clear filters
            </Button>
          ) : null}
          {denied || events.isError ? (
            <Alert role="alert" variant="destructive" className="space-y-3">
              <p>
                {denied
                  ? "Only administrators can review security events. Check your access, then retry."
                  : page
                    ? "Security events could not be refreshed. The previous results for these filters are still shown."
                    : "Security events could not be loaded. Try again."}
              </p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending || refreshing || invalid}
                onClick={() => void refresh(true)}
                aria-label="Retry security events"
              >
                Retry
              </Button>
            </Alert>
          ) : null}
          {invalid ? (
            <p className="text-muted-foreground text-sm">
              Check the filter values to review security events.
            </p>
          ) : (
            <LoadingRegion
              loading={!denied && events.isPending}
              label="Loading security events…"
              skeleton={
                <div className="space-y-3">
                  {[0, 1, 2, 3].map((row) => (
                    <Skeleton key={row} className="h-16 w-full" />
                  ))}
                </div>
              }
            >
              {page && page.items.length === 0 ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyTitle>
                      {narrowed
                        ? "No security events match these filters"
                        : "No security events recorded"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {narrowed
                        ? "Change or clear the filters to review other recorded events."
                        : "Recorded security activity will appear here. Use Refresh to check for new events."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : page ? (
                <>
                  <ul
                    aria-label="Security events"
                    className="divide-y rounded-lg border"
                  >
                    {page.items.map((event) => (
                      <li
                        key={event.id}
                        className="flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
                      >
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex flex-wrap items-start gap-2">
                            <p className="min-w-0 font-medium break-words">
                              {securityEventSentence(event, names)}
                            </p>
                            <Outcome outcome={event.outcome} />
                          </div>
                          <EventTime
                            className="text-muted-foreground block text-sm"
                            value={event.occurred_at}
                            region={region}
                          />
                        </div>
                        <Button
                          variant="outline"
                          className="min-h-11 w-full shrink-0 sm:w-auto"
                          aria-label={`Details for ${eventName(event)} at ${localTime(event.occurred_at, region)}`}
                          onClick={(opener) =>
                            void loadDetail(event.id, opener)
                          }
                        >
                          Details
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-muted-foreground text-sm" role="status">
                      {page.pagination.total} events · Showing{" "}
                      {page.pagination.offset + 1}–
                      {page.pagination.offset + page.pagination.count}
                    </p>
                    <PaginationControls
                      ariaLabel="Security event pages"
                      pageIndex={Math.floor(
                        page.pagination.offset / page.pagination.limit,
                      )}
                      pageCount={Math.ceil(
                        page.pagination.total / page.pagination.limit,
                      )}
                      onPageIndexChange={(index) => {
                        if (!pending) setOffset(index * page.pagination.limit);
                      }}
                    />
                  </div>
                </>
              ) : null}
            </LoadingRegion>
          )}
        </CardContent>
      </Card>
      <Dialog
        open={Boolean(detail) && !denied}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
      >
        <DialogContent
          className="max-h-[85dvh] max-w-2xl overflow-y-auto"
          finalFocus={() =>
            detailOpener.current?.isConnected
              ? detailOpener.current
              : fallbackFocus.current
          }
        >
          <DialogHeader>
            <div className="flex items-start justify-between gap-3">
              <DialogTitle>Security event details</DialogTitle>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11"
                aria-label="Close security event details"
                onClick={closeDetail}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <DialogDescription>
              What happened, when, and who it involved.
            </DialogDescription>
          </DialogHeader>
          {detail?.status === "error" ? (
            <Alert role="alert" variant="destructive" className="space-y-3">
              <p>Details could not be loaded. Try again.</p>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={pending}
                onClick={() => void loadDetail(detail.id)}
                aria-label="Retry event details"
              >
                Retry
              </Button>
            </Alert>
          ) : (
            <LoadingRegion
              loading={detail?.status === "loading"}
              label="Loading event details…"
              skeleton={
                <div className="space-y-3">
                  <Skeleton className="h-8 w-2/3" />
                  <Skeleton className="h-36 w-full" />
                </div>
              }
            >
              {detail?.status === "ready" ? (
                <SecurityEventFacts
                  event={detail.event}
                  names={names}
                  region={region}
                  disabled={pending}
                  onPersonFilter={(person) => {
                    if (pending) return;
                    closeDetail();
                    setPersonMode("id");
                    changeFilters({ person });
                  }}
                />
              ) : null}
            </LoadingRegion>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={closeDetail}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
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

function SecurityEventFacts({
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
