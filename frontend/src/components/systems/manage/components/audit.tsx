"use client";

import { Download, FileSearch, Search } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";

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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import type { ManageActivityEntry } from "../state/model";
import type { CompleteCollection } from "../../shared/helpers/sample-collections";
import {
  buildActivityCsv,
  initialActivityFilters,
  MANAGE_ACTIVITY_PAGE_SIZE as PAGE_SIZE,
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

type ManageAuditProps = {
  entries: CompleteCollection<ManageActivityEntry>;
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
  return source === "manage" ? "Manage change" : "Recorded activity";
}

function sourceVariant(
  source: ManageActivityEntry["source"],
): "secondary" | "outline" {
  return source === "manage" ? "secondary" : "outline";
}

export default function ManageAudit({ entries: source }: ManageAuditProps) {
  const entries = source.items;
  const [filters, setFilters] = useState<ActivityFilters>(
    initialActivityFilters,
  );
  const [pageIndex, setPageIndex] = useState(0);
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
  const result = queryManageActivity(source, filters, pageIndex * PAGE_SIZE);
  const sorted = result.complete.items;
  const pageCount = Math.max(
    1,
    Math.ceil(result.page.total / result.page.limit),
  );
  const safePageIndex = result.page.offset / result.page.limit;
  const visibleEntries = result.page.items;
  const firstVisible = result.page.total === 0 ? 0 : result.page.offset + 1;
  const lastVisible = Math.min(
    result.page.offset + result.page.limit,
    result.page.total,
  );

  function openDetails(entry: ManageActivityEntry, trigger: HTMLButtonElement) {
    detailTrigger.current = trigger;
    setSelected(entry);
  }

  const columns: DataTableColumn<ManageActivityEntry>[] = [
    {
      id: "date",
      header: "Date",
      cell: ({ row }) => (
        <time dateTime={row.original.date}>{row.original.date}</time>
      ),
    },
    {
      id: "user",
      header: "User",
      cell: ({ row }) => (
        <span className="font-medium">{row.original.user}</span>
      ),
    },
    {
      id: "activity",
      header: "Activity",
      cell: ({ row }) => (
        <>
          <span className="font-medium">{row.original.action}</span>
          <span className="text-muted-foreground">
            {" "}
            · {row.original.entity}
          </span>
        </>
      ),
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
            variant="ghost"
            className="min-h-11 px-2.5 md:h-8 md:min-h-8"
            onClick={(event) => openDetails(row.original, event.currentTarget)}
            aria-label={`View audit ${row.original.target}`}
          >
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

  function handleSearch(event: ChangeEvent<HTMLInputElement>) {
    updateFilter("query", event.target.value);
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
      aria-labelledby="audit-heading"
      className="flex min-w-0 flex-col gap-3"
    >
      <header>
        <h2 id="audit-heading" className="text-xl font-semibold tracking-tight">
          Activity history
        </h2>
        <p className="text-muted-foreground mt-1 text-sm md:sr-only">
          Review workspace activity. Filters apply to the CSV export as well as
          the table.
        </p>
      </header>

      <Card aria-label="Activity filters" className="w-full min-w-0">
        <CardContent className="p-3">
          <h3 className="sr-only">Filter activity</h3>
          <FieldGroup className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-[minmax(14rem,2fr)_repeat(6,minmax(7rem,1fr))]">
            <Field className="gap-1.5 sm:col-span-2 lg:col-span-2 xl:col-span-1">
              <FieldLabel className="md:sr-only" htmlFor="search-activity">
                Search activity
              </FieldLabel>
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
                />
                <Input
                  id="search-activity"
                  type="search"
                  value={filters.query}
                  onChange={handleSearch}
                  placeholder="Search activity"
                  className="min-h-11 pl-8 md:h-8 md:min-h-8"
                />
              </div>
              <FieldDescription className="sr-only">
                Matches users, entities, actions, targets, and before/after
                details.
              </FieldDescription>
            </Field>

            <Field className="gap-1.5">
              <FieldLabel className="md:sr-only" htmlFor="audit-user">
                Audit user
              </FieldLabel>
              <NativeSelect
                id="audit-user"
                value={filters.user}
                className="w-full [&>select]:min-h-11 md:[&>select]:h-8 md:[&>select]:min-h-8"
                onChange={(event) => updateFilter("user", event.target.value)}
              >
                <NativeSelectOption value="All users">
                  All users
                </NativeSelectOption>
                {users.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {value}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>

            <Field className="gap-1.5">
              <FieldLabel className="md:sr-only" htmlFor="audit-entity">
                Audit entity
              </FieldLabel>
              <NativeSelect
                id="audit-entity"
                value={filters.entity}
                className="w-full [&>select]:min-h-11 md:[&>select]:h-8 md:[&>select]:min-h-8"
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

            <Field className="gap-1.5">
              <FieldLabel className="md:sr-only" htmlFor="audit-action">
                Audit action
              </FieldLabel>
              <NativeSelect
                id="audit-action"
                value={filters.action}
                className="w-full [&>select]:min-h-11 md:[&>select]:h-8 md:[&>select]:min-h-8"
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

            <Field className="gap-1.5" data-invalid={Boolean(dateRangeError)}>
              <FieldLabel className="md:sr-only" htmlFor="from-date">
                From date
              </FieldLabel>
              <Input
                id="from-date"
                type="date"
                value={filters.from}
                aria-invalid={Boolean(dateRangeError) || undefined}
                onChange={(event) => updateFilter("from", event.target.value)}
                className="min-h-11 md:h-8 md:min-h-8"
              />
            </Field>

            <Field className="gap-1.5" data-invalid={Boolean(dateRangeError)}>
              <FieldLabel className="md:sr-only" htmlFor="to-date">
                To date
              </FieldLabel>
              <Input
                id="to-date"
                type="date"
                min={filters.from || undefined}
                value={filters.to}
                aria-invalid={Boolean(dateRangeError) || undefined}
                onChange={(event) => updateFilter("to", event.target.value)}
                className="min-h-11 md:h-8 md:min-h-8"
              />
              <FieldError>{dateRangeError}</FieldError>
            </Field>

            <Field className="gap-1.5">
              <FieldLabel className="md:sr-only" htmlFor="activity-order">
                Activity order
              </FieldLabel>
              <NativeSelect
                id="activity-order"
                value={filters.order}
                className="w-full [&>select]:min-h-11 md:[&>select]:h-8 md:[&>select]:min-h-8"
                onChange={(event) =>
                  updateFilter("order", event.target.value as ActivityOrder)
                }
              >
                <NativeSelectOption value="newest">
                  Newest first
                </NativeSelectOption>
                <NativeSelectOption value="oldest">
                  Oldest first
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          </FieldGroup>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
            <p className="text-muted-foreground text-xs">
              {sorted.length === 0
                ? "No matching entries"
                : `Showing ${firstVisible}–${lastVisible} of ${sorted.length} ${
                    sorted.length === 1 ? "entry" : "entries"
                  }`}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="ghost"
                className="min-h-11 px-2.5 md:h-8 md:min-h-8"
                onClick={clearFilters}
                disabled={
                  filters.query === "" &&
                  filters.user === "All users" &&
                  filters.entity === "All entities" &&
                  filters.action === "All actions" &&
                  filters.from === "" &&
                  filters.to === "" &&
                  filters.order === "newest"
                }
              >
                Clear filters
              </Button>
              <Button
                ref={exportTrigger}
                variant="outline"
                aria-label="Export audit preview"
                className="min-h-11 px-2.5 md:h-8 md:min-h-8"
                onClick={openExport}
                disabled={Boolean(dateRangeError)}
              >
                <Download data-icon="inline-start" /> Export
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {dateRangeError ? (
        <Alert role="alert" variant="destructive">
          {dateRangeError}
        </Alert>
      ) : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}

      {sorted.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileSearch aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No audit entries match these filters</EmptyTitle>
            <EmptyDescription>
              Clear a filter or search for another activity entry.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card aria-label="Activity history" className="w-full min-w-0">
          <CardContent className="p-0">
            <div className="divide-border divide-y md:hidden">
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
                      <dt className="text-muted-foreground text-xs">User</dt>
                      <dd className="mt-0.5 break-words">{entry.user}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground text-xs">Action</dt>
                      <dd className="mt-0.5 font-medium break-words">
                        {entry.action}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground text-xs">Entity</dt>
                      <dd className="mt-0.5 break-words">{entry.entity}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground text-xs">Time</dt>
                      <dd className="mt-0.5 break-words">
                        <time dateTime={entry.date}>{entry.date}</time>
                      </dd>
                    </div>
                  </dl>

                  <Button
                    variant="outline"
                    className="min-h-11 w-full"
                    onClick={(event) => openDetails(entry, event.currentTarget)}
                    aria-label={`View audit ${entry.target}`}
                  >
                    View details
                  </Button>
                </article>
              ))}
            </div>
            <div className="hidden md:block">
              <DataTable
                ariaLabel="Activity history table"
                cellClassName="py-1.5"
                columns={columns}
                data={[...visibleEntries]}
                getRowId={(entry) => entry.id}
              />
            </div>
          </CardContent>
          <CardFooter className="flex-wrap justify-between gap-2 p-2.5">
            <p className="text-muted-foreground text-xs">
              Page {safePageIndex + 1} of {pageCount}
            </p>
            <PaginationControls
              ariaLabel="Activity pages"
              className="w-auto sm:justify-end"
              pageCount={pageCount}
              pageIndex={safePageIndex}
              onPageIndexChange={setPageIndex}
            />
          </CardFooter>
        </Card>
      )}

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
