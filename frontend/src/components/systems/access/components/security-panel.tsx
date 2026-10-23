"use client";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
import { formatDateTime } from "../helpers/people";

import { Monitor, Smartphone, UsersRound } from "lucide-react";
import { type MouseEvent, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { LoadingRegion } from "@/components/ui/loading-region";
import { AccessToolbar, FilterSelect } from "./access-toolbar";
import { TableSkeleton } from "./table-skeleton";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { TABLE_PAGE_SIZE_OPTIONS } from "@/components/ui/table-pagination";
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
} from "../adapters/security-api";

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

// The same page sizes as People and Groups.
const SESSION_PAGE_SIZES = TABLE_PAGE_SIZE_OPTIONS;

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
          {/* Incident response: a quiet button in danger ink, whose
              confirmation states the count. */}
          <Button
            type="button"
            variant="outline"
            className="text-danger-text border-danger-rule min-h-11"
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
    </section>
  );
}
