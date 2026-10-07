"use client";

import {
  Info,
  KeyRound,
  Monitor,
  Smartphone,
  UsersRound,
  X,
} from "lucide-react";
import { type MouseEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { AccessSearchToolbar } from "../../access/components/access-search-toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import type { PageResult } from "../../shared/helpers/sample-collections";
import {
  defaultAccessSessionsRequest,
  sessionDeviceSchema,
  type AccessAdminSession,
  type AccessAdminSessions,
  type AccessSessionsRequest,
  type SecuritySettingsChange,
  type SecuritySettingsFormFields,
  type SecuritySettingsFormErrors,
} from "../adapters/security-api";
import {
  SettingActions,
  SettingSelect,
} from "../../manage/components/panel-ui";

type SessionSort = "activity" | "person-asc" | "person-desc";

const SESSION_SORT_OPTIONS: readonly {
  value: SessionSort;
  label: string;
}[] = [
  { value: "activity", label: "Last refreshed (newest)" },
  { value: "person-asc", label: "Person (A–Z)" },
  { value: "person-desc", label: "Person (Z–A)" },
];

const SESSION_PAGE_SIZES = [4, 10, 25] as const;
const hideNumberSpinners =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

type SecurityPanelProps = {
  sessions:
    | { status: "loading" }
    | { status: "error"; message: string; page?: AccessAdminSessions }
    | { status: "ready"; page: AccessAdminSessions };
  request: AccessSessionsRequest;
  onRequestChange: (request: AccessSessionsRequest) => void;
  onRetry: () => void;
  actions: {
    endAllRemoteSessions: (event: MouseEvent<HTMLElement>) => void;
    endSession: (
      session: AccessAdminSession,
      event: MouseEvent<HTMLElement>,
    ) => void;
  };
};

type SecurityPolicyFormProps = {
  form: {
    dirty: boolean;
    saved: SecuritySettingsFormFields;
    current: SecuritySettingsFormFields;
    errors: SecuritySettingsFormErrors;
    changeSetting: SecuritySettingsChange;
    addAddress: () => void;
    addMyAddress: () => Promise<void>;
    addressNotice: string;
    saveSection: () => Promise<void>;
    clearDraft: () => void;
  };
  onManageMfa: (event?: MouseEvent<HTMLButtonElement>) => void;
};

export function SecurityPanel({
  sessions,
  request,
  onRequestChange,
  onRetry,
  actions,
}: SecurityPanelProps) {
  const response = sessions.status === "loading" ? undefined : sessions.page;
  const page: PageResult<AccessAdminSession> | undefined = response
    ? {
        kind: "page",
        queryKey: JSON.stringify(request),
        items: response.items,
        ...response.pagination,
      }
    : undefined;
  const sort: SessionSort =
    request.sort_by === "refreshed_at"
      ? "activity"
      : request.sort_order === "asc"
        ? "person-asc"
        : "person-desc";
  const pageCount = Math.max(1, Math.ceil((page?.total ?? 0) / request.limit));
  const firstVisible = page && page.items.length ? page.offset + 1 : 0;
  const lastVisible =
    page && page.items.length ? page.offset + page.items.length : 0;
  const filtered =
    request.search.trim() !== "" ||
    request.status !== "all" ||
    request.device !== "all";
  const hasRemoteSessions =
    sessions.status === "ready" &&
    Boolean(
      page &&
      (filtered ||
        page.total > page.items.filter((session) => session.current).length),
    );
  const activeFilterCount =
    Number(request.status !== "all") + Number(request.device !== "all");
  function changeRequest(change: Partial<AccessSessionsRequest>) {
    onRequestChange({ ...request, ...change, offset: 0 });
  }
  function clearFilters() {
    onRequestChange({ ...defaultAccessSessionsRequest, limit: request.limit });
  }
  function refreshedAt(value: string) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  const columns: DataTableColumn<AccessAdminSession>[] = [
    {
      id: "person-device",
      header: "Person & device",
      cell: ({ row }) => {
        const session = row.original;
        const DeviceIcon = session.device === "Mobile" ? Smartphone : Monitor;

        return (
          <div className="flex min-w-0 items-center gap-3">
            <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
              <DeviceIcon aria-hidden="true" className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium break-words">
                {session.person_name}
              </span>
              <span className="text-muted-foreground mt-0.5 block text-sm break-words">
                {session.device} · {session.browser}
              </span>
              <span className="text-muted-foreground mt-1 block text-xs break-all">
                Sign-in IP: {session.ip_address ?? "Unknown"}
              </span>
            </span>
          </div>
        );
      },
    },
    {
      id: "last-refreshed",
      header: "Last refreshed",
      cell: ({ row }) => (
        <span className="block min-w-0 break-words tabular-nums">
          <time dateTime={row.original.refreshed_at}>
            {refreshedAt(row.original.refreshed_at)}
          </time>
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.current ? (
          <Badge variant="success">Current session</Badge>
        ) : (
          <Badge variant="outline">Other device</Badge>
        ),
    },
    {
      id: "action",
      header: "Action",
      cell: ({ row }) =>
        row.original.current ? (
          <span
            className="text-muted-foreground"
            aria-label="Current session is protected"
          >
            —
          </span>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            aria-label={`End session for ${row.original.person_name}`}
            disabled={sessions.status !== "ready"}
            onClick={(event) => actions.endSession(row.original, event)}
          >
            End
          </Button>
        ),
    },
  ];

  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      aria-labelledby="manage-sessions-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            data-slot="section-title"
            id="manage-sessions-heading"
            className="text-xl font-semibold tracking-tight"
          >
            Sessions
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Review signed-in devices across your organization.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={!hasRemoteSessions}
          onClick={actions.endAllRemoteSessions}
        >
          <UsersRound data-icon="inline-start" /> End all remote sessions
        </Button>
      </div>

      <AccessSearchToolbar
        searchLabel="Search sessions"
        placeholder="Person, device or browser"
        query={request.search}
        onQueryChange={(value) => {
          changeRequest({ search: value });
        }}
        sortLabel="Sort sessions"
        sort={sort}
        sortOptions={SESSION_SORT_OPTIONS}
        onSortChange={(value) => {
          changeRequest({
            sort_by: value === "activity" ? "refreshed_at" : "person_name",
            sort_order: value === "person-asc" ? "asc" : "desc",
          });
        }}
        activeFilterCount={activeFilterCount}
        filtersClassName="sm:grid-cols-2"
      >
        <Field className="min-w-0">
          <FieldLabel htmlFor="session-status-filter">Status</FieldLabel>
          <NativeSelect
            id="session-status-filter"
            aria-label="Session status"
            className="w-full [&_select]:min-h-11"
            value={request.status}
            onChange={(event) => {
              changeRequest({
                status: event.target.value as AccessSessionsRequest["status"],
              });
            }}
          >
            <NativeSelectOption value="all">All statuses</NativeSelectOption>
            <NativeSelectOption value="current">
              Current session
            </NativeSelectOption>
            <NativeSelectOption value="remote">Other device</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field className="min-w-0">
          <FieldLabel htmlFor="session-device-filter">Device</FieldLabel>
          <NativeSelect
            id="session-device-filter"
            aria-label="Session device"
            className="w-full [&_select]:min-h-11"
            value={request.device}
            onChange={(event) => {
              changeRequest({
                device: event.target.value as AccessSessionsRequest["device"],
              });
            }}
          >
            <NativeSelectOption value="all">All devices</NativeSelectOption>
            {sessionDeviceSchema.options.map((device) => (
              <NativeSelectOption key={device} value={device}>
                {device}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </AccessSearchToolbar>

      {sessions.status === "error" ? (
        <Alert role="alert" variant="destructive">
          <p>{sessions.message}</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            Retry sessions
          </Button>
        </Alert>
      ) : null}
      <LoadingRegion
        loading={sessions.status === "loading"}
        label="Loading sessions…"
        skeleton={<Skeleton className="h-80 w-full" />}
      >
        {page ? (
          <Card aria-label="Active sessions" className="w-full min-w-0">
            <CardContent className="min-w-0 p-0">
              {page.total === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <UsersRound aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>No sessions match these filters</EmptyTitle>
                    <EmptyDescription>
                      Try another name, device, or status.
                    </EmptyDescription>
                  </EmptyHeader>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={clearFilters}
                  >
                    Clear filters
                  </Button>
                </Empty>
              ) : (
                <>
                  <div className="divide-border divide-y lg:hidden">
                    {page.items.map((session) => {
                      const DeviceIcon =
                        session.device === "Mobile" ? Smartphone : Monitor;

                      return (
                        <article
                          key={session.id}
                          className="flex min-w-0 flex-col gap-3 p-4"
                        >
                          <div className="flex min-w-0 items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-3">
                              <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
                                <DeviceIcon
                                  aria-hidden="true"
                                  className="size-5"
                                />
                              </span>
                              <div className="min-w-0">
                                <p className="font-medium break-words">
                                  {session.person_name}
                                </p>
                                <p className="text-muted-foreground mt-0.5 text-sm break-words">
                                  {session.device} · {session.browser}
                                </p>
                                <p className="text-muted-foreground mt-1 text-xs break-all">
                                  Sign-in IP: {session.ip_address ?? "Unknown"}
                                </p>
                              </div>
                            </div>
                            {session.current ? (
                              <Badge className="shrink-0" variant="success">
                                Current session
                              </Badge>
                            ) : (
                              <Badge className="shrink-0" variant="outline">
                                Other device
                              </Badge>
                            )}
                          </div>

                          <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 text-sm">
                            <div className="min-w-0">
                              <dt className="text-muted-foreground text-xs">
                                Last refreshed
                              </dt>
                              <dd className="mt-0.5 break-words tabular-nums">
                                <time dateTime={session.refreshed_at}>
                                  {refreshedAt(session.refreshed_at)}
                                </time>
                              </dd>
                            </div>
                          </dl>

                          {!session.current ? (
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11 w-full"
                              aria-label={`End session for ${session.person_name}`}
                              disabled={sessions.status !== "ready"}
                              onClick={(event) =>
                                actions.endSession(session, event)
                              }
                            >
                              End session
                            </Button>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                  <div className="hidden min-w-0 lg:block">
                    <DataTable
                      ariaLabel="Sessions"
                      cellClassName="px-3 py-3 whitespace-normal break-words sm:px-4"
                      className="table-fixed"
                      columns={columns}
                      data={[...page.items]}
                      getRowId={(session) => session.id}
                    />
                  </div>
                </>
              )}
            </CardContent>
            <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t p-3">
              <p
                className="text-muted-foreground text-sm tabular-nums"
                role="status"
              >
                Showing {firstVisible}–{lastVisible} of {page.total}
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-3 sm:justify-end">
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="session-page-size"
                    className="text-muted-foreground text-sm"
                  >
                    Rows per page
                  </label>
                  <NativeSelect
                    id="session-page-size"
                    className="w-20 [&_select]:min-h-11"
                    value={String(request.limit)}
                    onChange={(event) => {
                      const nextPageSize = SESSION_PAGE_SIZES.find(
                        (size) => String(size) === event.currentTarget.value,
                      );
                      if (nextPageSize === undefined) return;
                      changeRequest({ limit: nextPageSize });
                    }}
                  >
                    {SESSION_PAGE_SIZES.map((size) => (
                      <NativeSelectOption key={size} value={String(size)}>
                        {size}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                {page.total > 0 ? (
                  <PaginationControls
                    ariaLabel="Session pages"
                    className="w-auto sm:justify-end"
                    pageCount={pageCount}
                    pageIndex={page.offset / request.limit}
                    onPageIndexChange={(index) =>
                      onRequestChange({
                        ...request,
                        offset: index * request.limit,
                      })
                    }
                  />
                ) : null}
              </div>
            </CardFooter>
          </Card>
        ) : null}
      </LoadingRegion>

      <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
        <Info aria-hidden="true" className="size-4 shrink-0" />
        <span>
          Ending remote sessions signs those devices out. Your current session
          stays active.
        </span>
      </p>
    </section>
  );
}

export function SecurityPolicyForm({
  form,
  onManageMfa,
}: SecurityPolicyFormProps) {
  const {
    dirty,
    saved,
    saveSection,
    current,
    errors,
    changeSetting,
    clearDraft,
    addAddress,
    addMyAddress,
    addressNotice,
  } = form;

  const shorter = (key: "sessionRetention" | "eventRetention") =>
    current[key].trim() !== "" && Number(current[key]) < Number(saved[key]);
  const retentionShortened =
    shorter("sessionRetention") || shorter("eventRetention");

  function numberField(
    key:
      | "absoluteLifetime"
      | "concurrentLimit"
      | "sessionRetention"
      | "eventRetention"
      | "mfaGrace"
      | "loginThreshold"
      | "loginWindow"
      | "loginCooldown",
    id: string,
    label: string,
    minimum: number,
    maximum: number,
  ) {
    const error = errors[key];
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={minimum}
          max={maximum}
          step={1}
          className={`min-h-11 ${hideNumberSpinners}`}
          value={current[key]}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => changeSetting(key, event.target.value)}
        />
        <FieldError id={`${id}-error`}>{error}</FieldError>
      </Field>
    );
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void saveSection();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset
          className="min-w-0 space-y-3 sm:col-span-2"
          aria-describedby="password-rules-description"
        >
          <legend className="text-sm font-medium">Password requirements</legend>
          <div className="grid min-w-0 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-start">
            <Field data-invalid={Boolean(errors.minimumLength)}>
              <FieldLabel htmlFor="password-minimum">
                Minimum password length
              </FieldLabel>
              <Input
                id="password-minimum"
                type="number"
                inputMode="numeric"
                min={12}
                max={128}
                step={1}
                className={`min-h-11 ${hideNumberSpinners}`}
                value={current.minimumLength}
                aria-invalid={Boolean(errors.minimumLength)}
                aria-describedby={
                  errors.minimumLength
                    ? "password-minimum-error password-rules-description"
                    : "password-rules-description"
                }
                onChange={(event) =>
                  changeSetting("minimumLength", event.target.value)
                }
              />
              <FieldError id="password-minimum-error">
                {errors.minimumLength}
              </FieldError>
            </Field>
            <div className="min-w-0 space-y-1">
              <Field>
                <FieldLabel
                  htmlFor="password-mixed-case"
                  className="flex min-h-11 items-center gap-3 font-normal"
                >
                  <Checkbox
                    id="password-mixed-case"
                    checked={current.requireMixedCase}
                    onCheckedChange={(value) =>
                      changeSetting("requireMixedCase", value)
                    }
                  />
                  <span>Require uppercase and lowercase letters</span>
                </FieldLabel>
              </Field>
              <Field>
                <FieldLabel
                  htmlFor="password-number"
                  className="flex min-h-11 items-center gap-3 font-normal"
                >
                  <Checkbox
                    id="password-number"
                    checked={current.requireNumber}
                    onCheckedChange={(value) =>
                      changeSetting("requireNumber", value)
                    }
                  />
                  <span>Require a number</span>
                </FieldLabel>
              </Field>
            </div>
          </div>
          <p
            id="password-rules-description"
            className="text-muted-foreground text-sm"
          >
            Use 12–128 characters. Common passwords are rejected. These rules
            apply when a password is next set or changed; existing passwords
            stay unchanged.
          </p>
        </fieldset>
        <fieldset className="min-w-0 space-y-3 sm:col-span-2">
          <legend className="text-sm font-medium">Session limits</legend>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="min-w-0 sm:col-span-2 lg:col-span-1">
              <SettingSelect
                id="session-timeout"
                label="Session timeout"
                value={current.timeout}
                error={errors.timeout}
                options={["15 minutes", "30 minutes", "60 minutes", "8 hours"]}
                onChange={(value) =>
                  changeSetting(
                    "timeout",
                    value as SecuritySettingsFormFields["timeout"],
                  )
                }
              />
            </div>
            <div className="min-w-0 space-y-3">
              <SettingSelect
                id="session-absolute-mode"
                label="Total session lifetime"
                value={current.absoluteLifetime === "Off" ? "Off" : "Limited"}
                options={["Off", "Limited"]}
                onChange={(value) =>
                  changeSetting(
                    "absoluteLifetime",
                    value === "Off" ? "Off" : "",
                  )
                }
              />
              {current.absoluteLifetime !== "Off" &&
                numberField(
                  "absoluteLifetime",
                  "session-absolute-minutes",
                  "Lifetime (minutes)",
                  1,
                  43200,
                )}
              <p className="text-muted-foreground text-sm">
                Limit the total time from sign-in, even while the session stays
                active.
              </p>
            </div>
            <div className="min-w-0 space-y-3">
              <SettingSelect
                id="session-cap-mode"
                label="Concurrent session limit"
                value={current.concurrentLimit === "Off" ? "Off" : "Limited"}
                options={["Off", "Limited"]}
                onChange={(value) =>
                  changeSetting("concurrentLimit", value === "Off" ? "Off" : "")
                }
              />
              {current.concurrentLimit !== "Off" &&
                numberField(
                  "concurrentLimit",
                  "session-cap",
                  "Maximum sessions",
                  1,
                  100,
                )}
              <p className="text-muted-foreground text-sm">
                Applies when sign-in completes.
              </p>
            </div>
          </div>
        </fieldset>
        <fieldset
          className="min-w-0 space-y-3 sm:col-span-2"
          aria-describedby={
            retentionShortened ? "security-retention-description" : undefined
          }
        >
          <legend className="text-sm font-medium">Retention</legend>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {numberField(
              "sessionRetention",
              "session-retention-days",
              "Session retention (days)",
              1,
              3650,
            )}
            {numberField(
              "eventRetention",
              "security-event-retention-days",
              "Security event retention (days)",
              1,
              3650,
            )}
          </div>
          {retentionShortened ? (
            <Alert
              id="security-retention-description"
              variant="warning"
              role="note"
            >
              Shortening a period can make older sessions or security events
              eligible for deletion at the next cleanup.
            </Alert>
          ) : null}
        </fieldset>
        <fieldset
          className="min-w-0 space-y-3 sm:col-span-2"
          aria-describedby="mfa-policy-description"
        >
          <legend className="text-sm font-medium">Two-step verification</legend>
          <p
            id="mfa-policy-description"
            className="text-muted-foreground text-sm"
          >
            Choose which roles must set up an authenticator app. People who
            already use one still enter a code when they sign in.
          </p>
          <div className="grid min-w-0 gap-1 sm:grid-cols-3">
            {(
              [
                ["requireMfaAdmin", "administrators"],
                ["requireMfaMember", "members"],
                ["requireMfaGuest", "guests"],
              ] as const
            ).map(([key, role]) => (
              <Field key={key}>
                <FieldLabel
                  htmlFor={`mfa-${role}`}
                  className="flex min-h-11 items-center gap-3 font-normal"
                >
                  <Checkbox
                    id={`mfa-${role}`}
                    checked={current[key]}
                    onCheckedChange={(value) => changeSetting(key, value)}
                  />
                  <span>Require two-step verification for {role}</span>
                </FieldLabel>
              </Field>
            ))}
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            {numberField(
              "mfaGrace",
              "mfa-grace",
              "Enrollment grace (days)",
              0,
              30,
            )}
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onManageMfa}
            >
              <KeyRound data-icon="inline-start" /> Manage two-step verification
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">
            Newly required accounts can enroll during the grace period. Zero
            days requires enrollment immediately.
          </p>
        </fieldset>
        <fieldset
          className="min-w-0 space-y-3 sm:col-span-2"
          aria-describedby="login-policy-description"
        >
          <legend className="text-sm font-medium">Sign-in attempts</legend>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {numberField(
              "loginThreshold",
              "login-threshold",
              "Failed attempts before lockout",
              1,
              100,
            )}
            {numberField(
              "loginWindow",
              "login-window",
              "Attempt window (minutes)",
              1,
              1440,
            )}
            {numberField(
              "loginCooldown",
              "login-cooldown",
              "Lockout duration (minutes)",
              1,
              1440,
            )}
          </div>
          <p
            id="login-policy-description"
            className="text-muted-foreground text-sm"
          >
            Too many failed attempts within the window temporarily block further
            attempts. Existing lockouts keep their remaining time.
          </p>
        </fieldset>
        <fieldset
          className="min-w-0 space-y-3 sm:col-span-2"
          aria-describedby="ip-allow-list-description"
        >
          <legend className="text-sm font-medium">IP allow list</legend>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p
              id="ip-allow-list-description"
              className="text-muted-foreground min-w-0 flex-1 basis-64 text-sm"
            >
              An empty list allows all addresses. Include your current address
              to keep access. You can add up to 100 addresses or ranges.
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => void addMyAddress()}
            >
              Use my address
            </Button>
          </div>
          {current.ips.length ? (
            <ul
              aria-label="Allowed addresses"
              className="flex min-w-0 flex-wrap gap-2"
            >
              {Array.from(new Set(current.ips)).map((address) => (
                <li key={address} className="max-w-full min-w-0">
                  <Badge
                    variant="outline"
                    className="min-h-11 max-w-full gap-2 rounded-md py-0 pr-0 pl-3 font-normal"
                  >
                    <span className="min-w-0 break-all">{address}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="min-h-11 min-w-11 shrink-0"
                      aria-label={`Remove ${address}`}
                      onClick={() =>
                        changeSetting(
                          "ips",
                          current.ips.filter((value) => value !== address),
                        )
                      }
                    >
                      <X aria-hidden="true" className="size-4" />
                    </Button>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">
              All addresses are allowed.
            </p>
          )}
          {errors.ips ? (
            <p role="alert" className="text-destructive text-sm">
              {errors.ips}
            </p>
          ) : null}
          <Field data-invalid={Boolean(errors.ipEntry)}>
            <FieldLabel htmlFor="ip-entry">IP address or CIDR</FieldLabel>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Input
                id="ip-entry"
                className="min-h-11 min-w-0 flex-1 basis-48"
                value={current.ipEntry}
                maxLength={64}
                placeholder="192.0.2.0/24 or 2001:db8::/64"
                aria-invalid={Boolean(errors.ipEntry)}
                aria-describedby={
                  errors.ipEntry
                    ? "ip-entry-error ip-allow-list-description"
                    : "ip-allow-list-description"
                }
                onChange={(event) =>
                  changeSetting("ipEntry", event.target.value)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addAddress();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={!current.ipEntry.trim()}
                onClick={addAddress}
              >
                Add address
              </Button>
            </div>
            <FieldError id="ip-entry-error">{errors.ipEntry}</FieldError>
          </Field>
          {addressNotice ? (
            <p role="status" className="text-muted-foreground text-sm">
              {addressNotice}
            </p>
          ) : null}
        </fieldset>
      </div>
      {/* The dialog scrolls; the actions stay in reach at its bottom edge.
          -bottom-5 also covers the dialog's padding so fields don't show below. */}
      <div className="bg-card sticky -bottom-5 z-10 -mx-5 -mb-5 border-t px-5 pb-8">
        <SettingActions
          dirty={dirty}
          onDiscard={() => clearDraft()}
          onSave={() => void saveSection()}
        />
      </div>
    </form>
  );
}
