"use client";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
import { formatDateTime } from "../helpers/people";

import {
  Info,
  KeyRound,
  Monitor,
  Smartphone,
  UsersRound,
  X,
} from "lucide-react";
import { type MouseEvent, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { LoadingRegion } from "@/components/ui/loading-region";
import { AccessToolbar, FilterSelect } from "./access-toolbar";
import { TableSkeleton } from "./table-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { tintRowClassName } from "./row-open-button";
import type { PageResult } from "../../shared/helpers/page-collections";
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

const SESSION_STATUS_OPTIONS: readonly {
  value: AccessSessionsRequest["status"];
  label: string;
}[] = [
  { value: "all", label: "Any status" },
  { value: "current", label: "Current session" },
  { value: "remote", label: "Other device" },
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
  /**
   * What this administrator may change. The organization owner changes the
   * organization's settings; the installation owner also changes the
   * installation-wide password, session, retention, and sign-in rules.
   */
  editable: { organization: boolean; installation: boolean };
};

export function SecurityPanel({
  sessions,
  request,
  onRequestChange,
  onRetry,
  actions,
}: SecurityPanelProps) {
  const region = useWorkspaceDisplayRegion();
  const response = sessions.status === "loading" ? undefined : sessions.page;
  // A row's End waits for a current list (the Four Moments Rule).
  const endReason =
    sessions.status === "ready"
      ? null
      : sessions.status === "loading"
        ? "Loading sessions…"
        : "Retry sessions first.";
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
  const filterChips = [
    ...(request.status === "all"
      ? []
      : [
          {
            key: "status",
            label: "Status",
            value:
              SESSION_STATUS_OPTIONS.find(
                (option) => option.value === request.status,
              )?.label ?? request.status,
            onRemove: () => changeRequest({ status: "all" }),
          },
        ]),
    ...(request.device === "all"
      ? []
      : [
          {
            key: "device",
            label: "Device",
            value: request.device,
            onRemove: () => changeRequest({ device: "all" }),
          },
        ]),
  ];
  function changeRequest(change: Partial<AccessSessionsRequest>) {
    onRequestChange({ ...request, ...change, offset: 0 });
  }
  function clearFilters() {
    onRequestChange({ ...defaultAccessSessionsRequest, limit: request.limit });
  }
  function refreshedAt(value: string) {
    return formatDateTime(value, region);
  }

  // The session row grammar: one 40px line from 1280px, with the person,
  // device and sign-in address together, a dot and a word for status, and a
  // ghost verb for the row action.
  const columns: {
    id: string;
    header: string;
    width?: string;
    cell: (session: AccessAdminSession) => ReactNode;
  }[] = [
    {
      id: "person-device",
      header: "Person & device",
      cell: (session) => {
        const DeviceIcon = session.device === "Mobile" ? Smartphone : Monitor;
        const detail = `${session.device} · ${session.browser} · Sign-in IP: ${session.ip_address ?? "Unknown"}`;
        return (
          <span className="flex min-w-0 items-center gap-2.5">
            <DeviceIcon
              aria-hidden="true"
              className="text-muted-foreground size-4 shrink-0"
            />
            <span className="max-w-[45%] shrink-0 truncate font-medium">
              {session.person_name}
            </span>
            <span className="text-muted-foreground truncate" title={detail}>
              {detail}
            </span>
          </span>
        );
      },
    },
    {
      id: "last-refreshed",
      header: "Last refreshed",
      width: "w-52",
      cell: (session) => (
        <time
          dateTime={session.refreshed_at}
          className="text-muted-foreground tabular-nums"
        >
          {refreshedAt(session.refreshed_at)}
        </time>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "w-40",
      cell: (session) => (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={
              session.current
                ? "size-2 shrink-0 rounded-full bg-[var(--flow)]"
                : "size-2 shrink-0 rounded-full bg-[var(--rule-strong)]"
            }
          />
          {session.current ? "Current session" : "Other device"}
        </span>
      ),
    },
    {
      id: "action",
      header: "Action",
      width: "w-24",
      cell: (session) =>
        session.current ? (
          <span
            className="text-muted-foreground"
            aria-label="Current session is protected"
          >
            —
          </span>
        ) : (
          <DisabledReason reason={endReason}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="relative z-10 min-h-11 px-2 xl:min-h-7"
              aria-label={`End session for ${session.person_name}`}
              onClick={(event) => actions.endSession(session, event)}
            >
              End
            </Button>
          </DisabledReason>
        ),
    },
  ];

  return (
    <section
      className="access-fill flex min-w-0 flex-col gap-4"
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
        <DisabledReason
          reason={
            hasRemoteSessions
              ? null
              : (endReason ?? "No remote sessions to end.")
          }
        >
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={actions.endAllRemoteSessions}
          >
            <UsersRound data-icon="inline-start" /> End all remote sessions
          </Button>
        </DisabledReason>
      </div>

      <AccessToolbar
        searchLabel="Search sessions"
        placeholder="Person, device or browser"
        query={request.search}
        onQueryChange={(value) => {
          changeRequest({ search: value });
        }}
        sortLabel="Sort sessions"
        sortInFiltersBelowMd
        sort={sort}
        sortOptions={SESSION_SORT_OPTIONS}
        onSortChange={(value) => {
          changeRequest({
            sort_by: value === "activity" ? "refreshed_at" : "person_name",
            sort_order: value === "person-asc" ? "asc" : "desc",
          });
        }}
        chips={filterChips}
        onClearFilters={() => changeRequest({ status: "all", device: "all" })}
      >
        <FilterSelect
          id="session-status-filter"
          label="Status"
          ariaLabel="Session status"
          value={request.status}
          options={SESSION_STATUS_OPTIONS}
          onChange={(status) => changeRequest({ status })}
        />
        <FilterSelect
          id="session-device-filter"
          label="Device"
          ariaLabel="Session device"
          value={request.device}
          options={[
            { value: "all", label: "Any device" },
            ...sessionDeviceSchema.options.map((device) => ({
              value: device,
              label: device,
            })),
          ]}
          onChange={(device) => changeRequest({ device })}
        />
      </AccessToolbar>

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
        skeleton={<TableSkeleton columns={4} rows={4} />}
        className="access-fill"
      >
        {page ? (
          <Card
            aria-label="Active sessions"
            className="access-fill w-full min-w-0 overflow-hidden"
          >
            <CardContent className="access-fill min-w-0 p-0">
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
                  <ul
                    aria-label="Sessions"
                    className="divide-border min-w-0 divide-y md:hidden"
                  >
                    {page.items.map((session) => {
                      const DeviceIcon =
                        session.device === "Mobile" ? Smartphone : Monitor;
                      return (
                        <li
                          key={session.id}
                          title={`Last refreshed ${refreshedAt(session.refreshed_at)}`}
                          className="flex min-h-14 min-w-0 items-center gap-3 py-1.5 pr-1 pl-3"
                        >
                          <DeviceIcon
                            aria-hidden="true"
                            className="text-muted-foreground size-6 shrink-0"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              {session.person_name}
                            </span>
                            <span className="text-muted-foreground block truncate text-xs">
                              {session.device} · {session.browser} · Sign-in IP:{" "}
                              {session.ip_address ?? "Unknown"}
                            </span>
                            <span className="sr-only">
                              Last refreshed{" "}
                              <time dateTime={session.refreshed_at}>
                                {refreshedAt(session.refreshed_at)}
                              </time>
                            </span>
                          </span>
                          <span className="inline-flex shrink-0 items-center gap-1.5 text-sm">
                            <span
                              aria-hidden="true"
                              className={
                                session.current
                                  ? "size-2 shrink-0 rounded-full bg-[var(--flow)]"
                                  : "size-2 shrink-0 rounded-full bg-[var(--rule-strong)]"
                              }
                            />
                            {session.current
                              ? "Current session"
                              : "Other device"}
                          </span>
                          {session.current ? (
                            <span
                              aria-hidden="true"
                              className="inline-block size-11 shrink-0"
                            />
                          ) : (
                            <DisabledReason reason={endReason}>
                              <Button
                                type="button"
                                variant="ghost"
                                className="min-h-11 min-w-11 shrink-0 px-2"
                                aria-label={`End session for ${session.person_name}`}
                                onClick={(event) =>
                                  actions.endSession(session, event)
                                }
                              >
                                End
                              </Button>
                            </DisabledReason>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="access-fill access-scroll-table hidden min-w-0 md:block">
                    <Table aria-label="Sessions" className="table-fixed">
                      <colgroup>
                        {columns.map((column) => (
                          <col key={column.id} className={column.width} />
                        ))}
                      </colgroup>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          {columns.map((column) => (
                            <TableHead
                              key={column.id}
                              className="text-muted-foreground h-9 px-3 text-xs"
                            >
                              {column.header}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {page.items.map((session) => (
                          <TableRow
                            key={session.id}
                            className={cn(tintRowClassName, "h-10")}
                          >
                            {columns.map((column) => (
                              <TableCell
                                key={column.id}
                                className="h-10 overflow-hidden px-3 py-0 align-middle whitespace-nowrap"
                              >
                                {column.cell(session)}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </CardContent>
            <CardFooter className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-3 py-2">
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
  editable,
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
    // Only the enrollment grace belongs to the organization; the rest are installation-wide.
    const disabled =
      key === "mfaGrace" ? !editable.organization : !editable.installation;
    return (
      <Field data-invalid={Boolean(error)} disabled={disabled}>
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
          disabled={disabled}
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
      {!editable.organization ? (
        <Alert role="note">
          Only the organization owner can change these settings.
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
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
              <Field key={key} disabled={!editable.organization}>
                <FieldLabel
                  htmlFor={`mfa-${role}`}
                  className="flex min-h-11 items-center gap-3 font-normal"
                >
                  <Checkbox
                    id={`mfa-${role}`}
                    disabled={!editable.organization}
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
          disabled={!editable.organization}
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
          <Field
            data-invalid={Boolean(errors.ipEntry)}
            disabled={!editable.organization}
          >
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
        <div className="min-w-0 space-y-3 border-t pt-4 sm:col-span-2">
          <h3 className="text-sm font-semibold">Installation-wide rules</h3>
          {editable.organization && !editable.installation ? (
            <Alert role="note">
              These rules apply to every organization in this installation. Only
              the installation owner can change them.
            </Alert>
          ) : null}
        </div>
        <fieldset
          disabled={!editable.installation}
          className="min-w-0 space-y-3 sm:col-span-2"
          aria-describedby="password-rules-description"
        >
          <legend className="text-sm font-medium">Password requirements</legend>
          <div className="grid min-w-0 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-start">
            <Field
              data-invalid={Boolean(errors.minimumLength)}
              disabled={!editable.installation}
            >
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
              <Field disabled={!editable.installation}>
                <FieldLabel
                  htmlFor="password-mixed-case"
                  className="flex min-h-11 items-center gap-3 font-normal"
                >
                  <Checkbox
                    id="password-mixed-case"
                    disabled={!editable.installation}
                    checked={current.requireMixedCase}
                    onCheckedChange={(value) =>
                      changeSetting("requireMixedCase", value)
                    }
                  />
                  <span>Require uppercase and lowercase letters</span>
                </FieldLabel>
              </Field>
              <Field disabled={!editable.installation}>
                <FieldLabel
                  htmlFor="password-number"
                  className="flex min-h-11 items-center gap-3 font-normal"
                >
                  <Checkbox
                    id="password-number"
                    disabled={!editable.installation}
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
        <fieldset
          disabled={!editable.installation}
          className="min-w-0 space-y-3 sm:col-span-2"
        >
          <legend className="text-sm font-medium">Session limits</legend>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="min-w-0 sm:col-span-2 lg:col-span-1">
              <SettingSelect
                disabled={!editable.installation}
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
                disabled={!editable.installation}
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
                disabled={!editable.installation}
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
          disabled={!editable.installation}
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
          disabled={!editable.installation}
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
      </div>
      {/* The dialog scrolls; the actions stay in reach at its bottom edge.
          -bottom-5 also covers the dialog's padding so fields don't show below. */}
      {editable.organization ? (
        <div className="bg-card sticky -bottom-5 z-10 -mx-5 -mb-5 border-t px-5 pb-8">
          <SettingActions
            dirty={dirty}
            onDiscard={() => clearDraft()}
            onSave={() => void saveSection()}
          />
        </div>
      ) : null}
    </form>
  );
}
