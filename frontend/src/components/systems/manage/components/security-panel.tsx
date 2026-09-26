"use client";

import { Info, KeyRound, Monitor, Smartphone, UsersRound } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { AccessSearchToolbar } from "../../access/components/access-search-toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  completeCollection,
  pageCollection,
  type CompleteCollection,
} from "../../shared/helpers/sample-collections";
import type { ManageSession } from "../state/sessions";
import {
  SettingActions,
  SettingInput,
  SettingSelect,
  type SettingsPanelForm,
} from "./panel-ui";

type SessionStatusFilter = "all" | "current" | "remote";
type SessionSort = "activity" | "person-asc" | "person-desc";

const SESSION_SORT_OPTIONS: readonly {
  value: SessionSort;
  label: string;
}[] = [
  { value: "activity", label: "Last seen (newest)" },
  { value: "person-asc", label: "Person (A–Z)" },
  { value: "person-desc", label: "Person (Z–A)" },
];

const SESSION_PAGE_SIZES = [4, 10, 25] as const;

type SecurityPanelProps = {
  sessions: CompleteCollection<ManageSession>;
  actions: {
    endAllRemoteSessions: (event: MouseEvent<HTMLElement>) => void;
    endSession: (
      session: ManageSession,
      event: MouseEvent<HTMLElement>,
    ) => void;
  };
};

type SecurityPolicyFormProps = {
  form: SettingsPanelForm;
  onPreviewMfa: (event?: MouseEvent<HTMLButtonElement>) => void;
};

export function SecurityPanel({ sessions, actions }: SecurityPanelProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SessionSort>("activity");
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>("all");
  const [deviceFilter, setDeviceFilter] = useState("all");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] =
    useState<(typeof SESSION_PAGE_SIZES)[number]>(4);

  const devices = Array.from(
    new Set(sessions.items.map((session) => session.device)),
  ).sort((left, right) => left.localeCompare(right));
  const activeDeviceFilter =
    deviceFilter === "all" || devices.includes(deviceFilter)
      ? deviceFilter
      : "all";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingSessions = sessions.items.filter((session) => {
    const matchesQuery =
      !normalizedQuery ||
      [
        session.personName,
        session.device,
        session.browser,
        session.location,
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "current" && session.current) ||
      (statusFilter === "remote" && !session.current);
    const matchesDevice =
      activeDeviceFilter === "all" || session.device === activeDeviceFilter;

    return matchesQuery && matchesStatus && matchesDevice;
  });

  const orderedSessions = [...matchingSessions];
  if (sort === "person-asc") {
    orderedSessions.sort((left, right) =>
      left.personName.localeCompare(right.personName, undefined, {
        sensitivity: "base",
      }),
    );
  } else if (sort === "person-desc") {
    orderedSessions.sort((left, right) =>
      right.personName.localeCompare(left.personName, undefined, {
        sensitivity: "base",
      }),
    );
  }

  const filteredSessions = completeCollection(
    orderedSessions,
    `manage:sessions:${sessions.queryKey}:${normalizedQuery}:${statusFilter}:${activeDeviceFilter}:${sort}`,
  );
  const page = pageCollection(filteredSessions, pageIndex * pageSize, pageSize);
  const pageCount = Math.max(1, Math.ceil(page.total / pageSize));
  const safePageIndex = page.offset / pageSize;
  const firstVisible = page.total === 0 ? 0 : page.offset + 1;
  const lastVisible = page.offset + page.items.length;
  const hasRemoteSessions = sessions.items.some((session) => !session.current);
  const activeFilterCount =
    Number(statusFilter !== "all") + Number(activeDeviceFilter !== "all");

  function clearFilters() {
    setQuery("");
    setSort("activity");
    setStatusFilter("all");
    setDeviceFilter("all");
    setPageIndex(0);
  }

  const columns: DataTableColumn<ManageSession>[] = [
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
                {session.personName}
              </span>
              <span className="text-muted-foreground mt-0.5 block text-sm break-words">
                {session.device} · {session.browser}
              </span>
            </span>
          </div>
        );
      },
    },
    {
      id: "location",
      header: "Location",
      cell: ({ row }) => (
        <span className="block min-w-0 break-words">
          {row.original.location}
        </span>
      ),
    },
    {
      id: "last-seen",
      header: "Last seen",
      cell: ({ row }) => (
        <span className="block min-w-0 break-words tabular-nums">
          {row.original.lastSeen}
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
          <Badge variant="outline">Remote</Badge>
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
            aria-label={`End session for ${row.original.personName}`}
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
            id="manage-sessions-heading"
            className="text-xl font-semibold tracking-tight"
          >
            Sessions
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Review devices in this preview.
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
        placeholder="Person, device or location"
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setPageIndex(0);
        }}
        sortLabel="Sort sessions"
        sort={sort}
        sortOptions={SESSION_SORT_OPTIONS}
        onSortChange={(value) => {
          setSort(value);
          setPageIndex(0);
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
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as SessionStatusFilter);
              setPageIndex(0);
            }}
          >
            <NativeSelectOption value="all">All statuses</NativeSelectOption>
            <NativeSelectOption value="current">
              Current session
            </NativeSelectOption>
            <NativeSelectOption value="remote">Remote</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field className="min-w-0">
          <FieldLabel htmlFor="session-device-filter">Device</FieldLabel>
          <NativeSelect
            id="session-device-filter"
            aria-label="Session device"
            className="w-full [&_select]:min-h-11"
            value={activeDeviceFilter}
            onChange={(event) => {
              setDeviceFilter(event.target.value);
              setPageIndex(0);
            }}
          >
            <NativeSelectOption value="all">All devices</NativeSelectOption>
            {devices.map((device) => (
              <NativeSelectOption key={device} value={device}>
                {device}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </AccessSearchToolbar>

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
                            <DeviceIcon aria-hidden="true" className="size-5" />
                          </span>
                          <div className="min-w-0">
                            <p className="font-medium break-words">
                              {session.personName}
                            </p>
                            <p className="text-muted-foreground mt-0.5 text-sm break-words">
                              {session.device} · {session.browser}
                            </p>
                          </div>
                        </div>
                        {session.current ? (
                          <Badge className="shrink-0" variant="success">
                            Current session
                          </Badge>
                        ) : (
                          <Badge className="shrink-0" variant="outline">
                            Remote
                          </Badge>
                        )}
                      </div>

                      <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 text-sm">
                        <div className="min-w-0">
                          <dt className="text-muted-foreground text-xs">
                            Location
                          </dt>
                          <dd className="mt-0.5 break-words">
                            {session.location}
                          </dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="text-muted-foreground text-xs">
                            Last seen
                          </dt>
                          <dd className="mt-0.5 break-words tabular-nums">
                            {session.lastSeen}
                          </dd>
                        </div>
                      </dl>

                      {!session.current ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11 w-full"
                          aria-label={`End session for ${session.personName}`}
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
                value={String(pageSize)}
                onChange={(event) => {
                  const nextPageSize = SESSION_PAGE_SIZES.find(
                    (size) => String(size) === event.currentTarget.value,
                  );
                  if (nextPageSize === undefined) return;
                  setPageSize(nextPageSize);
                  setPageIndex(0);
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
                pageIndex={safePageIndex}
                onPageIndexChange={setPageIndex}
              />
            ) : null}
          </div>
        </CardFooter>
      </Card>

      <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
        <Info aria-hidden="true" className="size-4 shrink-0" />
        <span>
          Your current session is kept. Session actions here only update the
          preview.
        </span>
      </p>
    </section>
  );
}

export function SecurityPolicyForm({
  form,
  onPreviewMfa,
}: SecurityPolicyFormProps) {
  const { dirty, saveSection, current, errors, changeSetting, clearDraft } =
    form;

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        saveSection("security");
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingSelect
          id="password-policy"
          label="Password policy"
          value={current.password}
          error={errors.password}
          options={[
            "12 characters + mixed case",
            "16 characters + mixed case + number",
            "20-character passphrase",
          ]}
          onChange={(value) => changeSetting("security", "password", value)}
        />
        <SettingSelect
          id="session-timeout"
          label="Session timeout"
          value={current.timeout}
          error={errors.timeout}
          options={["15 minutes", "30 minutes", "60 minutes", "8 hours"]}
          onChange={(value) => changeSetting("security", "timeout", value)}
        />
        <div className="grid min-w-0 gap-3 sm:col-span-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <SettingSelect
            id="mfa-policy"
            label="Two-factor authentication"
            value={current.mfa}
            error={errors.mfa}
            options={[
              "Optional",
              "Required for administrators",
              "Required for everyone",
            ]}
            onChange={(value) => changeSetting("security", "mfa", value)}
            description="Review the enrollment steps before changing this setting."
          />
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onPreviewMfa}
          >
            <KeyRound data-icon="inline-start" /> Preview MFA setup
          </Button>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <SettingInput
            id="sample-ip-allow-list"
            label="IP allow list"
            value={current.ips}
            onChange={(value) => changeSetting("security", "ips", value)}
            placeholder="192.0.2.0/24"
            error={errors.ips ?? null}
            description="Separate IP addresses with commas. An empty list allows all addresses here; this setting does not restrict real network access."
          />
        </div>
      </div>
      <SettingActions
        dirty={dirty}
        onDiscard={() => clearDraft("security")}
        onSave={() => saveSection("security")}
      />
    </form>
  );
}
