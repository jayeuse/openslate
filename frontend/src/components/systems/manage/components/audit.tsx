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
import { useRef, useState, type ReactNode } from "react";

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
import { ScrollArea } from "@/components/ui/scroll-area";
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
import type { ManageActivityEntry } from "../state/model";
import type { CompleteCollection } from "../../shared/helpers/sample-collections";
import {
  buildActivityCsv,
  initialActivityFilters,
  queryManageActivity,
  uniqueValues,
} from "./audit-data";
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
  entries: CompleteCollection<ManageActivityEntry>;
  renderHeader: (actions: ReactNode) => ReactNode;
};

function downloadActivityCsv(entries: readonly ManageActivityEntry[]): void {
  const blob = new Blob([buildActivityCsv(entries)], {
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

function sourceLabel(source: ManageActivityEntry["source"]): string {
  return source === "manage" ? "Your change" : "Preloaded";
}

function sourceVariant(
  source: ManageActivityEntry["source"],
): "secondary" | "outline" {
  return source === "manage" ? "secondary" : "outline";
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

const activityDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatActivityDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime())
    ? activityDateFormatter.format(date)
    : value;
}

export default function ManageAudit({
  entries: source,
  renderHeader,
}: ManageAuditProps) {
  const entries = source.items;
  const [filters, setFilters] = useState<ActivityFilters>(
    initialActivityFilters,
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TABLE_PAGE_SIZE);
  const [selected, setSelected] = useState<ManageActivityEntry | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const exportTrigger = useRef<HTMLButtonElement | null>(null);

  const users = uniqueValues(entries, "user");
  const entities = uniqueValues(entries, "entity");
  const actions = uniqueValues(entries, "action");
  const dateRangeError =
    filters.from && filters.to && filters.from > filters.to
      ? "The end date must be on or after the start date."
      : "";
  const result = queryManageActivity(source, filters, 0);
  const sorted = result.complete.items;
  const total = sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const pageOffset = safePageIndex * pageSize;
  const visibleEntries = sorted.slice(pageOffset, pageOffset + pageSize);
  const firstVisible = total === 0 ? 0 : pageOffset + 1;
  const lastVisible = Math.min(pageOffset + visibleEntries.length, total);

  const activeFilterLabels: string[] = [];
  if (filters.user !== initialActivityFilters.user)
    activeFilterLabels.push(`Person: ${filters.user}`);
  if (filters.entity !== initialActivityFilters.entity)
    activeFilterLabels.push(`Entity: ${filters.entity}`);
  if (filters.action !== initialActivityFilters.action)
    activeFilterLabels.push(`Action: ${filters.action}`);
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

  function openDetails(entry: ManageActivityEntry, trigger: HTMLButtonElement) {
    detailTrigger.current = trigger;
    setSelected(entry);
  }

  const columns: DataTableColumn<ManageActivityEntry>[] = [
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
      id: "source",
      header: "Source",
      cell: ({ row }) => (
        <Badge variant={sourceVariant(row.original.source)}>
          {sourceLabel(row.original.source)}
        </Badge>
      ),
    },
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

  function updateFilter<Key extends keyof ActivityFilters>(
    key: Key,
    value: ActivityFilters[Key],
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPageIndex(0);
    setNotice("");
  }

  function clearFilters() {
    setFilters(initialActivityFilters);
    setPageIndex(0);
    setNotice("");
  }

  function openExport() {
    if (dateRangeError) return;
    setExportOpen(true);
  }

  function downloadFilteredCsv() {
    if (dateRangeError) return;
    downloadActivityCsv(sorted);
    setExportOpen(false);
    setNotice(
      `Downloaded ${sorted.length} filtered audit ${sorted.length === 1 ? "entry" : "entries"}.`,
    );
  }

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
        query={filters.query}
        onQueryChange={(value) => updateFilter("query", value)}
        sortLabel="Sort activity"
        sort={filters.order}
        sortOptions={ACTIVITY_SORT_OPTIONS}
        onSortChange={(value) => updateFilter("order", value)}
        activeFilterCount={activeFilterLabels.length}
        filtersClassName="xl:grid-cols-5"
      >
        <Field>
          <FieldLabel htmlFor="audit-user">Person</FieldLabel>
          <NativeSelect
            id="audit-user"
            value={filters.user}
            className="w-full [&_select]:min-h-11"
            onChange={(event) => updateFilter("user", event.target.value)}
          >
            <NativeSelectOption value="All users">
              All people
            </NativeSelectOption>
            {users.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="audit-entity">Entity</FieldLabel>
          <NativeSelect
            id="audit-entity"
            value={filters.entity}
            className="w-full [&_select]:min-h-11"
            onChange={(event) => updateFilter("entity", event.target.value)}
          >
            <NativeSelectOption value="All entities">
              All entities
            </NativeSelectOption>
            {entities.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
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
            {actions.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
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

      {dateRangeError ? (
        <Alert role="alert" variant="destructive">
          {dateRangeError}
        </Alert>
      ) : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}

      <Card aria-label="Activity history" className="w-full min-w-0">
        <CardContent className="p-0">
          {total === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileSearch aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No audit entries match these filters</EmptyTitle>
                <EmptyDescription>
                  Clear filters or search for another activity entry.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="divide-border divide-y lg:hidden">
                {visibleEntries.map((entry) => (
                  <article key={entry.id} className="flex flex-col gap-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                          Target
                        </p>
                        <p className="mt-1 font-medium break-words">
                          {entry.target}
                        </p>
                      </div>
                      <Badge
                        className="shrink-0"
                        variant={sourceVariant(entry.source)}
                      >
                        {sourceLabel(entry.source)}
                      </Badge>
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
                        <dd className="mt-0.5 break-words">{entry.entity}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted-foreground text-xs">Date</dt>
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
                  data={[...visibleEntries]}
                  getRowId={(entry) => entry.id}
                />
              </div>
            </>
          )}
        </CardContent>
        <CardFooter className="bg-card flex flex-wrap items-center justify-between gap-3 border-t p-3">
          <p
            className="text-muted-foreground text-sm tabular-nums"
            role="status"
          >
            {total === 0
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
            {total > 0 ? (
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
            <DialogTitle>Audit entry detail</DialogTitle>
            <DialogDescription>
              {selected
                ? `${selected.user} · ${selected.date} · ${selected.action} · ${sourceLabel(selected.source)}`
                : "Review the recorded activity change."}
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="flex flex-col gap-5">
              <div>
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Target
                </p>
                <p className="mt-1 text-lg font-semibold">{selected.target}</p>
                <p className="text-muted-foreground mt-1 text-sm">
                  {selected.action} · {selected.entity}
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Card className="w-full min-w-0">
                  <CardHeader className="p-4">
                    <CardTitle className="text-sm">Before</CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 pt-0 text-sm whitespace-pre-wrap">
                    {selected.before}
                  </CardContent>
                </Card>
                <Card className="w-full min-w-0">
                  <CardHeader className="p-4">
                    <CardTitle className="text-sm">After</CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 pt-0 text-sm whitespace-pre-wrap">
                    {selected.after}
                  </CardContent>
                </Card>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={sourceVariant(selected.source)}>
                  {sourceLabel(selected.source)}
                </Badge>
              </div>
            </div>
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
              {sorted.length} filtered{" "}
              {sorted.length === 1 ? "entry" : "entries"} · the download
              includes every filtered entry across all pages.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea
            className="max-h-[50dvh] rounded-md"
            viewportProps={{
              className: "max-h-[50dvh]",
              tabIndex: 0,
              "aria-label": "CSV preview",
            }}
          >
            <pre className="bg-muted rounded-md p-4 text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap">
              {buildActivityCsv(sorted)}
            </pre>
          </ScrollArea>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setExportOpen(false)}
            >
              Close preview
            </Button>
            <Button className="min-h-11" onClick={downloadFilteredCsv}>
              <Download data-icon="inline-start" /> Download CSV
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
