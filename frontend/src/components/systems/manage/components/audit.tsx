"use client";

import {
  Activity,
  CircleCheck,
  CirclePlus,
  Download,
  Eye,
  FileSearch,
  MailPlus,
  PencilLine,
} from "lucide-react";
import { Temporal } from "@js-temporal/polyfill";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
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
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LoadingRegion } from "@/components/ui/loading-region";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { AccessSearchToolbar } from "../../access/components/access-search-toolbar";
import {
  DEFAULT_TABLE_PAGE_SIZE,
  TABLE_PAGE_SIZE_OPTIONS,
} from "@/components/ui/table-pagination";
import { ApiError } from "@/lib/api";
import { serializeCsv } from "@/lib/csv";
import {
  AuditExportLimitError,
  type ManageAuditAction,
  type ManageAuditLog,
  type ManageAuditListRequest,
} from "../adapters/audit-api";
import {
  manageAuditDetailOptions,
  manageAuditExportOptions,
  manageAuditListOptions,
  manageAuditOptionsOptions,
  manageWorkspaceOptions,
} from "../adapters/manage-queries";
import { initialActivityFilters } from "./audit-data";
import type { ActivityFilters, ActivityOrder } from "./audit-data";

export {
  buildActivityCsv,
  initialActivityFilters,
  queryManageActivity,
} from "./audit-data";
export type { ActivityFilters } from "./audit-data";

const PAGE_SIZE_OPTIONS = TABLE_PAGE_SIZE_OPTIONS;
const ACTIVITY_SORT_OPTIONS: readonly {
  value: ActivityOrder;
  label: string;
}[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

type ManageAuditProps = {
  renderHeader: (actions: ReactNode) => ReactNode;
};

type ManageAuditEntry = {
  id: string;
  user: string;
  date: string;
  entity: string;
  action: string;
  target: string;
  before: string;
  after: string;
};

function displayActor(log: Pick<ManageAuditLog, "actor_name">): string {
  return log.actor_name?.trim() || "Unknown person";
}

function auditTarget(log: ManageAuditLog): string {
  for (const values of [log.after, log.before]) {
    for (const key of ["name", "title"]) {
      const label = values?.[key];
      if (typeof label === "string" && label.trim()) return label.trim();
    }
  }
  return `${formatEntityType(log.entity_type)} · name not recorded`;
}

function formatEntityType(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function formatAuditValues(
  values: Record<string, unknown> | null,
  emptyLabel: string,
): string {
  if (!values || Object.keys(values).length === 0) return emptyLabel;
  return Object.entries(values)
    .map(([key, value]) => {
      const label = formatEntityType(key);
      const formatted =
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
          ? String(value)
          : (JSON.stringify(value) ?? String(value));
      return `${label}: ${formatted}`;
    })
    .join("\n");
}

function auditEntryFromLog(log: ManageAuditLog): ManageAuditEntry {
  return {
    id: log.id,
    user: displayActor(log),
    date: log.created_at,
    entity: formatEntityType(log.entity_type),
    action: log.action[0]!.toUpperCase() + log.action.slice(1),
    target: auditTarget(log),
    before: formatAuditValues(log.before, "No previous values recorded."),
    after: formatAuditValues(log.after, "No updated values recorded."),
  };
}

function auditCsv(entries: readonly ManageAuditEntry[]): string {
  const header = [
    "Date",
    "User",
    "Entity",
    "Action",
    "Target",
    "Before",
    "After",
  ];
  const rows = entries.map((entry) => [
    entry.date,
    entry.user,
    entry.entity,
    entry.action,
    entry.target,
    entry.before,
    entry.after,
  ]);
  return serializeCsv([header, ...rows]);
}

function downloadActivityCsv(entries: readonly ManageAuditEntry[]): void {
  const blob = new Blob([auditCsv(entries)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "openslate-audit.csv";
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

function activityIcon(action: string) {
  switch (action) {
    case "Create":
      return CirclePlus;
    case "Close":
      return CircleCheck;
    case "Invite":
      return MailPlus;
    case "Update":
      return PencilLine;
    default:
      return Activity;
  }
}

function auditRequestFromFilters(
  filters: ActivityFilters,
  limit: number,
  offset: number,
  timezone?: string,
): ManageAuditListRequest {
  const request: ManageAuditListRequest = {
    sortOrder: filters.order === "newest" ? "desc" : "asc",
    limit,
    offset,
  };
  const search = filters.query.trim();
  if (search) request.search = search;
  if (filters.user !== initialActivityFilters.user)
    request.performedBy = filters.user;
  if (filters.entity !== initialActivityFilters.entity)
    request.entityType = filters.entity;
  if (filters.action !== initialActivityFilters.action)
    request.action = filters.action as ManageAuditAction;
  if (timezone && filters.from)
    request.createdAfter = workspaceDayBound(filters.from, timezone, false);
  if (timezone && filters.to)
    request.createdBefore = workspaceDayBound(filters.to, timezone, true);
  return request;
}

function workspaceDayBound(
  value: string,
  timezone: string,
  endOfDay: boolean,
): string {
  const boundaryDate = endOfDay
    ? Temporal.PlainDate.from(value).add({ days: 1 })
    : Temporal.PlainDate.from(value);
  const start = boundaryDate
    .toZonedDateTime({ timeZone: timezone, plainTime: "00:00" })
    .toInstant();
  return (endOfDay ? start.subtract({ milliseconds: 1 }) : start).toString({
    fractionalSecondDigits: 3,
  });
}

function auditFiltersFromRequest(
  request: ManageAuditListRequest,
): Omit<ManageAuditListRequest, "limit" | "offset"> {
  return {
    search: request.search,
    action: request.action,
    entityType: request.entityType,
    performedBy: request.performedBy,
    createdAfter: request.createdAfter,
    createdBefore: request.createdBefore,
    sortOrder: request.sortOrder,
  };
}

function listErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403)
    return "Only administrators can view audit history.";
  return "Audit history could not be loaded. Try again.";
}

function detailErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403)
    return "You do not have permission to view this audit entry.";
  if (error instanceof ApiError && error.status === 404)
    return "This audit entry is no longer available.";
  return "Audit details could not be loaded. Try again.";
}

function entityTypeLabel(value: string): string {
  return formatEntityType(value);
}

export default function ManageAudit({ renderHeader }: ManageAuditProps) {
  const [filters, setFilters] = useState<ActivityFilters>(
    initialActivityFilters,
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [appliedSearch, setAppliedSearch] = useState("");
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TABLE_PAGE_SIZE);
  const [selected, setSelected] = useState<ManageAuditEntry | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportRequest, setExportRequest] = useState<Omit<
    ManageAuditListRequest,
    "limit" | "offset"
  > | null>(null);
  const [notice, setNotice] = useState("");
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const exportTrigger = useRef<HTMLButtonElement | null>(null);
  const workspaceQuery = useQuery(manageWorkspaceOptions());
  const listRequest = auditRequestFromFilters(
    { ...filters, query: appliedSearch },
    pageSize,
    pageIndex * pageSize,
    workspaceQuery.data?.timezone,
  );
  const listQuery = useQuery(manageAuditListOptions(listRequest));
  const optionsQuery = useQuery(manageAuditOptionsOptions());
  const activityDateFormatter = workspaceQuery.data
    ? new Intl.DateTimeFormat(workspaceQuery.data.locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: workspaceQuery.data.timezone,
      })
    : null;
  const formatActivityDate = (value: string) =>
    activityDateFormatter?.format(new Date(value)) ??
    (workspaceQuery.isPending
      ? "Loading date format…"
      : "Date format unavailable");
  const exportQuery = useQuery({
    ...manageAuditExportOptions(exportRequest ?? { sortOrder: "desc" }),
    enabled: exportOpen && exportRequest !== null,
  });
  const detailQuery = useQuery(manageAuditDetailOptions(selected?.id ?? ""));
  const logs = listQuery.data?.items ?? [];
  const entries = logs.map(auditEntryFromLog);
  const actors = optionsQuery.data?.actors ?? [];
  const actorOptions = actors.map((actor) => ({
    id: actor.performed_by,
    label: actor.actor_name ?? actor.actor_label ?? "Unknown person",
  }));
  const entityTypes = optionsQuery.data?.entity_types ?? [];
  const total = listQuery.data?.pagination.total ?? 0;
  const serverOffset =
    listQuery.data?.pagination.offset ?? pageIndex * pageSize;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePageIndex = listQuery.data
    ? Math.min(pageIndex, pageCount - 1)
    : pageIndex;
  const firstVisible = entries.length === 0 ? 0 : serverOffset + 1;
  const lastVisible = Math.min(serverOffset + entries.length, total);
  const exportEntries = exportQuery.data?.map(auditEntryFromLog) ?? [];
  const exportCount = exportQuery.data?.length ?? total;
  const selectedDetail = detailQuery.data
    ? auditEntryFromLog(detailQuery.data)
    : null;
  const actionOptions: readonly { value: ManageAuditAction; label: string }[] =
    [
      { value: "create", label: "Create" },
      { value: "update", label: "Update" },
      { value: "delete", label: "Delete" },
    ];
  const dateRangeError =
    filters.from && filters.to && filters.from > filters.to
      ? "The end date must be on or after the start date."
      : "";
  const dateTimezoneUnavailable =
    Boolean(filters.from || filters.to) && !workspaceQuery.data;
  const canDownloadExport =
    Boolean(exportQuery.data) &&
    exportQuery.isSuccess &&
    !exportQuery.isFetching &&
    !dateRangeError &&
    !dateTimezoneUnavailable;
  useEffect(() => {
    if (filters.query === appliedSearch) return;
    const timer = setTimeout(() => {
      setAppliedSearch(filters.query);
      setPageIndex(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [filters.query, appliedSearch]);

  useEffect(() => {
    if (listQuery.data && safePageIndex !== pageIndex)
      setPageIndex(safePageIndex);
  }, [listQuery.data, pageIndex, safePageIndex]);

  const activeFilterLabels: string[] = [];
  if (filters.user !== initialActivityFilters.user)
    activeFilterLabels.push(
      `Person: ${
        actorOptions.find((actor) => actor.id === filters.user)?.label ??
        "Unknown person"
      }`,
    );
  if (filters.entity !== initialActivityFilters.entity)
    activeFilterLabels.push(`Entity: ${entityTypeLabel(filters.entity)}`);
  if (filters.action !== initialActivityFilters.action)
    activeFilterLabels.push(
      `Action: ${
        actionOptions.find((action) => action.value === filters.action)
          ?.label ?? filters.action
      }`,
    );
  if (filters.from) activeFilterLabels.push(`From: ${filters.from}`);
  if (filters.to) activeFilterLabels.push(`To: ${filters.to}`);
  const hasFilters =
    filters.query !== initialActivityFilters.query ||
    filters.user !== initialActivityFilters.user ||
    filters.entity !== initialActivityFilters.entity ||
    filters.action !== initialActivityFilters.action ||
    filters.from !== initialActivityFilters.from ||
    filters.to !== initialActivityFilters.to ||
    filters.order !== initialActivityFilters.order;

  function openDetails(entry: ManageAuditEntry, trigger: HTMLButtonElement) {
    detailTrigger.current = trigger;
    setSelected(entry);
  }

  function updateFilter<Key extends keyof ActivityFilters>(
    key: Key,
    value: ActivityFilters[Key],
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
    if (key !== "query") setPageIndex(0);
    setNotice("");
  }

  function clearFilters() {
    setFilters(initialActivityFilters);
    setAppliedSearch("");
    setPageIndex(0);
    setNotice("");
  }

  function openExport() {
    if (dateRangeError || dateTimezoneUnavailable) return;
    const request = auditFiltersFromRequest(
      auditRequestFromFilters(
        { ...filters, query: appliedSearch },
        pageSize,
        0,
        workspaceQuery.data?.timezone,
      ),
    );
    const startedAt = new Date().toISOString();
    setExportRequest({
      ...request,
      createdBefore:
        request.createdBefore && request.createdBefore < startedAt
          ? request.createdBefore
          : startedAt,
    });
    setExportOpen(true);
  }

  function downloadFilteredCsv() {
    if (!canDownloadExport) return;
    downloadActivityCsv(exportEntries);
    setExportOpen(false);
    setNotice(
      `Downloaded ${exportEntries.length} filtered audit ${exportEntries.length === 1 ? "entry" : "entries"}.`,
    );
  }

  const columns: DataTableColumn<ManageAuditEntry>[] = [
    {
      id: "date",
      header: "Date",
      cell: ({ row }) => (
        <time
          className="text-muted-foreground tabular-nums"
          dateTime={row.original.date}
        >
          {formatActivityDate(row.original.date)}
        </time>
      ),
    },
    {
      id: "user",
      header: "Person",
      cell: ({ row }) => {
        const initials = row.original.user
          .split(/\s+/)
          .map((part) => part[0])
          .slice(0, 2)
          .join("")
          .toUpperCase();
        return (
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            >
              {initials}
            </span>
            <span className="min-w-0 font-medium break-words">
              {row.original.user}
            </span>
          </div>
        );
      },
    },
    {
      id: "activity",
      header: "Activity",
      cell: ({ row }) => {
        const Icon = activityIcon(row.original.action);
        return (
          <div className="flex min-w-0 items-start gap-3">
            <Icon
              aria-hidden="true"
              className="text-primary mt-0.5 size-4 shrink-0"
            />
            <div className="min-w-0">
              <span className="font-medium">{row.original.action}</span>
              <span className="text-muted-foreground mt-0.5 block text-sm">
                {row.original.entity}
              </span>
            </div>
          </div>
        );
      },
    },
    { id: "target", header: "Target", cell: ({ row }) => row.original.target },
    {
      id: "details",
      header: () => <span className="block text-right">Details</span>,
      cell: ({ row }) => (
        <div className="text-right">
          <Button
            variant="outline"
            className="min-h-11 gap-2 px-3"
            onClick={(event) => openDetails(row.original, event.currentTarget)}
            aria-label={`View audit ${row.original.target}`}
          >
            <Eye aria-hidden="true" />
            View details
          </Button>
        </div>
      ),
    },
  ];

  return (
    <section
      aria-labelledby="audit-region-label"
      className="flex min-w-0 flex-col gap-3"
    >
      <h2 id="audit-region-label" className="sr-only">
        Activity history
      </h2>
      {renderHeader(
        <Button
          ref={exportTrigger}
          variant="outline"
          aria-label="Export audit preview"
          className="min-h-11 gap-2 px-4"
          onClick={openExport}
          disabled={Boolean(dateRangeError)}
        >
          <Download data-icon="inline-start" /> Export
        </Button>,
      )}

      <AccessSearchToolbar
        searchLabel="Search activity"
        placeholder="Search activity, people, or records..."
        searchMaxLength={100}
        query={filters.query}
        onQueryChange={(value) => updateFilter("query", value)}
        sortLabel="Sort activity"
        sort={filters.order}
        sortOptions={ACTIVITY_SORT_OPTIONS}
        onSortChange={(value) => updateFilter("order", value)}
        activeFilterCount={activeFilterLabels.length}
        filtersClassName="xl:grid-cols-5"
        filtersDisabled={optionsQuery.isPending || optionsQuery.isError}
      >
        <Field>
          <FieldLabel htmlFor="audit-user">Person</FieldLabel>
          <LoadingRegion
            loading={optionsQuery.isPending}
            label="Loading people filter options…"
            skeleton={<Skeleton className="h-11 w-full" />}
          >
            <NativeSelect
              id="audit-user"
              value={filters.user}
              className="w-full [&_select]:min-h-11"
              disabled={optionsQuery.isError}
              onChange={(event) => updateFilter("user", event.target.value)}
            >
              <NativeSelectOption value="All users">
                All people
              </NativeSelectOption>
              {actorOptions.map((actor) => (
                <NativeSelectOption key={actor.id} value={actor.id}>
                  {actor.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </LoadingRegion>
        </Field>
        <Field>
          <FieldLabel htmlFor="audit-entity">Entity</FieldLabel>
          <LoadingRegion
            loading={optionsQuery.isPending}
            label="Loading entity filter options…"
            skeleton={<Skeleton className="h-11 w-full" />}
          >
            <NativeSelect
              id="audit-entity"
              value={filters.entity}
              className="w-full [&_select]:min-h-11"
              disabled={optionsQuery.isError}
              onChange={(event) => updateFilter("entity", event.target.value)}
            >
              <NativeSelectOption value="All entities">
                All entities
              </NativeSelectOption>
              {entityTypes.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {entityTypeLabel(value)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </LoadingRegion>
        </Field>
        <Field>
          <FieldLabel htmlFor="audit-action">Action</FieldLabel>
          <NativeSelect
            id="audit-action"
            value={filters.action}
            className="w-full [&_select]:min-h-11"
            onChange={(event) => updateFilter("action", event.target.value)}
          >
            <NativeSelectOption value="All actions">
              All actions
            </NativeSelectOption>
            {actionOptions.map((action) => (
              <NativeSelectOption key={action.value} value={action.value}>
                {action.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field data-invalid={Boolean(dateRangeError)}>
          <FieldLabel htmlFor="from-date">From</FieldLabel>
          <Input
            id="from-date"
            type="date"
            value={filters.from}
            aria-invalid={Boolean(dateRangeError) || undefined}
            onChange={(event) => updateFilter("from", event.target.value)}
            disabled={!workspaceQuery.data}
            className="min-h-11"
          />
        </Field>
        <Field data-invalid={Boolean(dateRangeError)}>
          <FieldLabel htmlFor="to-date">To</FieldLabel>
          <Input
            id="to-date"
            type="date"
            min={filters.from || undefined}
            value={filters.to}
            aria-invalid={Boolean(dateRangeError) || undefined}
            onChange={(event) => updateFilter("to", event.target.value)}
            disabled={!workspaceQuery.data}
            className="min-h-11"
          />
          <FieldError>{dateRangeError}</FieldError>
        </Field>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 xl:col-span-5">
          {activeFilterLabels.map((label) => (
            <Badge key={label} variant="secondary">
              {label}
            </Badge>
          ))}
          <Button
            variant="ghost"
            className="min-h-11 px-3"
            onClick={clearFilters}
            disabled={!hasFilters}
          >
            Clear filters
          </Button>
        </div>
      </AccessSearchToolbar>

      {optionsQuery.isError ? (
        <Alert role="alert" variant="destructive">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              {optionsQuery.error instanceof ApiError &&
              optionsQuery.error.status === 403
                ? "Only administrators can load audit filter options."
                : "Audit filter options could not be loaded. Try again."}
            </p>
            <Button
              variant="outline"
              onClick={() => void optionsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        </Alert>
      ) : null}
      {workspaceQuery.isError ? (
        <Alert role="alert" variant="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              Workspace date settings could not be loaded. Retry to format dates
              in your organization’s locale and timezone.
            </p>
            <Button
              variant="outline"
              onClick={() => void workspaceQuery.refetch()}
            >
              Retry date settings
            </Button>
          </div>
        </Alert>
      ) : null}
      {dateRangeError ? (
        <Alert role="alert" variant="destructive">
          {dateRangeError}
        </Alert>
      ) : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}

      <Card aria-label="Activity history" className="w-full min-w-0">
        <CardContent className="p-0">
          {listQuery.isError ? (
            <Alert className="m-4" role="alert" variant="destructive">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p>{listErrorMessage(listQuery.error)}</p>
                <Button
                  variant="outline"
                  onClick={() => void listQuery.refetch()}
                >
                  Retry
                </Button>
              </div>
            </Alert>
          ) : (
            <LoadingRegion
              loading={listQuery.isPending}
              label="Loading audit entries…"
              skeleton={
                <div className="space-y-3 p-4">
                  {Array.from({ length: 5 }, (_, index) => (
                    <Skeleton key={index} className="h-16 w-full" />
                  ))}
                </div>
              }
            >
              {total === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FileSearch aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>
                      No audit entries match these filters
                    </EmptyTitle>
                    <EmptyDescription>
                      Clear filters or search for another activity entry.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <>
                  <div className="divide-border divide-y lg:hidden">
                    {entries.map((entry) => (
                      <article
                        key={entry.id}
                        className="flex flex-col gap-3 p-4"
                      >
                        <div className="min-w-0">
                          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                            Target
                          </p>
                          <p className="mt-1 font-medium break-words">
                            {entry.target}
                          </p>
                        </div>

                        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                          <div className="min-w-0">
                            <dt className="text-muted-foreground text-xs">
                              Person
                            </dt>
                            <dd className="mt-0.5 break-words">{entry.user}</dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-muted-foreground text-xs">
                              Action
                            </dt>
                            <dd className="mt-0.5 font-medium break-words">
                              {entry.action}
                            </dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-muted-foreground text-xs">
                              Entity
                            </dt>
                            <dd className="mt-0.5 break-words">
                              {entry.entity}
                            </dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-muted-foreground text-xs">
                              Date
                            </dt>
                            <dd className="mt-0.5 break-words tabular-nums">
                              <time dateTime={entry.date}>
                                {formatActivityDate(entry.date)}
                              </time>
                            </dd>
                          </div>
                        </dl>

                        <Button
                          variant="outline"
                          className="min-h-11 w-full gap-2"
                          onClick={(event) =>
                            openDetails(entry, event.currentTarget)
                          }
                          aria-label={`View audit ${entry.target}`}
                        >
                          <Eye aria-hidden="true" /> View details
                        </Button>
                      </article>
                    ))}
                  </div>
                  <div className="hidden lg:block">
                    <DataTable
                      ariaLabel="Activity history table"
                      cellClassName="px-4 py-4 whitespace-normal"
                      columns={columns}
                      data={[...entries]}
                      getRowId={(entry) => entry.id}
                    />
                  </div>
                </>
              )}
            </LoadingRegion>
          )}
        </CardContent>
        {!listQuery.isError ? (
          <CardFooter className="bg-card flex flex-wrap items-center justify-between gap-3 border-t p-3">
            <p
              className="text-muted-foreground text-sm tabular-nums"
              role="status"
            >
              {listQuery.isPending
                ? "Loading audit entries…"
                : total === 0
                  ? "Showing 0–0 of 0"
                  : `Showing ${firstVisible}–${lastVisible} of ${total}`}
            </p>
            <div className="flex min-w-0 flex-wrap items-center gap-3 sm:justify-end">
              <div className="flex items-center gap-2">
                <label
                  htmlFor="audit-page-size"
                  className="text-muted-foreground text-sm"
                >
                  Rows per page
                </label>
                <NativeSelect
                  id="audit-page-size"
                  className="w-20 [&_select]:min-h-11"
                  value={String(pageSize)}
                  onChange={(event) => {
                    const nextPageSize = PAGE_SIZE_OPTIONS.find(
                      (size) => String(size) === event.currentTarget.value,
                    );
                    if (nextPageSize === undefined) return;
                    setPageSize(nextPageSize);
                    setPageIndex(0);
                  }}
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <NativeSelectOption key={size} value={String(size)}>
                      {size}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              {total > 0 && listQuery.data ? (
                <PaginationControls
                  ariaLabel="Activity pages"
                  className="w-auto sm:justify-end"
                  pageCount={pageCount}
                  pageIndex={safePageIndex}
                  onPageIndexChange={setPageIndex}
                />
              ) : null}
            </div>
          </CardFooter>
        ) : null}
      </Card>

      <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
        <FileSearch aria-hidden="true" className="size-4 shrink-0" />
        Open details to compare before and after values.
      </p>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent
          className="sm:max-w-xl"
          finalFocus={() => detailTrigger.current}
        >
          <DialogHeader>
            <DialogTitle>
              {`Audit entry detail · ${selectedDetail?.target ?? selected?.target ?? ""}`}
            </DialogTitle>
            <DialogDescription>
              {selectedDetail
                ? `${selectedDetail.user} · ${formatActivityDate(selectedDetail.date)}`
                : "Review the recorded activity change."}
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <LoadingRegion
              loading={detailQuery.isPending}
              label="Loading audit entry details…"
              skeleton={
                <div className="space-y-4">
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-36 w-full" />
                </div>
              }
            >
              {detailQuery.isError ? (
                <Alert role="alert" variant="destructive">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p>{detailErrorMessage(detailQuery.error)}</p>
                    <Button
                      variant="outline"
                      onClick={() => void detailQuery.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                </Alert>
              ) : selectedDetail ? (
                <div className="flex flex-col gap-5">
                  <div>
                    <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                      Target
                    </p>
                    <p className="mt-1 text-lg font-semibold break-words">
                      {selectedDetail.target}
                    </p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {selectedDetail.action} · {selectedDetail.entity}
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Card className="w-full min-w-0">
                      <CardHeader className="p-4">
                        <CardTitle className="text-sm">Before</CardTitle>
                      </CardHeader>
                      <CardContent className="p-4 pt-0 text-sm whitespace-pre-wrap">
                        {selectedDetail.before}
                      </CardContent>
                    </Card>
                    <Card className="w-full min-w-0">
                      <CardHeader className="p-4">
                        <CardTitle className="text-sm">After</CardTitle>
                      </CardHeader>
                      <CardContent className="p-4 pt-0 text-sm whitespace-pre-wrap">
                        {selectedDetail.after}
                      </CardContent>
                    </Card>
                  </div>
                </div>
              ) : null}
            </LoadingRegion>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setSelected(null)}
            >
              Close detail
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={exportOpen}
        onOpenChange={(open) => {
          if (!open) setExportOpen(false);
        }}
      >
        <DialogContent
          className="sm:max-w-3xl"
          finalFocus={() => exportTrigger.current}
        >
          <DialogHeader>
            <DialogTitle>Audit export preview</DialogTitle>
            <DialogDescription>
              {exportCount} filtered {exportCount === 1 ? "entry" : "entries"} ·
              the download includes every filtered entry across all pages.
            </DialogDescription>
          </DialogHeader>
          {exportQuery.isError ? (
            <Alert role="alert" variant="destructive">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p>
                  {exportQuery.error instanceof AuditExportLimitError
                    ? exportQuery.error.message
                    : "Could not load every filtered audit entry. Try again."}
                </p>
                <Button
                  variant="outline"
                  onClick={() => void exportQuery.refetch()}
                >
                  Retry
                </Button>
              </div>
            </Alert>
          ) : (
            <ScrollArea
              className="max-h-[50dvh] rounded-md"
              viewportProps={{
                className: "max-h-[50dvh]",
                tabIndex: 0,
                "aria-label": "CSV preview",
              }}
            >
              <LoadingRegion
                loading={exportQuery.isPending}
                label="Preparing audit export…"
                skeleton={<Skeleton className="m-4 h-60 w-[calc(100%-2rem)]" />}
              >
                <pre className="bg-muted rounded-md p-4 text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap">
                  {auditCsv(exportEntries.slice(0, 10))}
                </pre>
              </LoadingRegion>
            </ScrollArea>
          )}
          {exportQuery.isSuccess ? (
            <p className="text-muted-foreground text-sm">
              Showing the first {Math.min(10, exportCount)} of {exportCount}{" "}
              entries. The CSV download includes all {exportCount} entries.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setExportOpen(false)}
            >
              Close preview
            </Button>
            <Button
              className="min-h-11"
              onClick={downloadFilteredCsv}
              disabled={!canDownloadExport}
            >
              <Download data-icon="inline-start" /> Download CSV
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
