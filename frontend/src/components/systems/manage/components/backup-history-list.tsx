"use client";

import { useId, type Ref } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { TablePagination } from "@/components/ui/table-pagination";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import {
  AccessToolbar,
  FilterSelect,
  type FilterChip,
} from "../../access/components/access-toolbar";
import {
  backupStateLabels,
  type ManageBackupRun,
  type ManageBackupsRequest,
} from "../adapters/backup-api";
import { backupRunStatus } from "../domain/backup-rules";
import { StatusWord } from "./status-word";
import { formatBackupTime, useWorkspaceRegion } from "./backup-time";

// The list pane of Backup history (MD8), after Sandbox History: the total in
// the head, the search with Filters (Source, Installation) and Sort, the
// status quick filters, the active filter chips, then 40px rows of a status dot and word, the name and
// the requested time. Paging stays server-side.

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name" },
] as const;
type BackupOrder = (typeof SORT_OPTIONS)[number]["value"];

const STATUS_FILTERS: readonly {
  value: ManageBackupsRequest["state"];
  label: string;
}[] = [
  { value: "all", label: "All" },
  ...(Object.keys(backupStateLabels) as ManageBackupRun["state"][]).map(
    (state) => ({ value: state, label: backupStateLabels[state] }),
  ),
];

const SOURCE_OPTIONS = [
  { value: "all", label: "Any source" },
  { value: "manual", label: "Manual" },
  { value: "scheduled", label: "Scheduled" },
] as const;
const INSTALLATION_OPTIONS = [
  { value: "all", label: "Any installation" },
  { value: "current", label: "Current" },
  { value: "previous", label: "Previous" },
] as const;

export type BackupListBody = "none" | "rows" | "empty" | "no-match" | "no-page";

export function BackupHistoryList({
  listRef,
  headingRef,
  hidden,
  phone,
  runs,
  total,
  body,
  loading,
  failure,
  onRetry,
  selectedId,
  request,
  onRequestChange,
  paged,
  onOpen,
}: {
  listRef: Ref<HTMLOListElement>;
  headingRef: Ref<HTMLHeadingElement>;
  /** On phones the list hides while a backup's detail shows. */
  hidden: boolean;
  phone: boolean;
  runs: readonly ManageBackupRun[];
  total: number;
  body: BackupListBody;
  loading: boolean;
  failure: "denied" | "unavailable" | null;
  onRetry: () => void;
  selectedId: string | undefined;
  request: ManageBackupsRequest;
  onRequestChange: (next: Partial<ManageBackupsRequest>) => void;
  /** The page footer shows once a page has been read. */
  paged: boolean;
  onOpen: (id: string) => void;
}) {
  const id = useId();
  const region = useWorkspaceRegion();
  const order: BackupOrder =
    request.sort_by === "name"
      ? "name"
      : request.sort_order === "asc"
        ? "oldest"
        : "newest";
  const chips: FilterChip[] = [];
  if (request.provenance !== "all")
    chips.push({
      key: "source",
      label: "Source",
      value:
        SOURCE_OPTIONS.find((option) => option.value === request.provenance)
          ?.label ?? request.provenance,
      onRemove: () => onRequestChange({ provenance: "all" }),
    });
  if (request.installation !== "all")
    chips.push({
      key: "installation",
      label: "Installation",
      value:
        INSTALLATION_OPTIONS.find(
          (option) => option.value === request.installation,
        )?.label ?? request.installation,
      onRemove: () => onRequestChange({ installation: "all" }),
    });
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        "bg-card border-border flex min-w-0 flex-col overflow-clip rounded-[var(--radius)] border xl:min-h-0",
        hidden && "hidden",
      )}
    >
      <div className="border-border flex min-h-12 items-center gap-2.5 border-b px-4 py-2">
        <h2
          ref={headingRef}
          id={`${id}-title`}
          tabIndex={-1}
          data-slot="section-title"
          className="focus-visible:outline-ring font-semibold focus-visible:outline-2"
        >
          History
        </h2>
        {paged ? (
          <span className="text-muted-foreground text-sm tabular-nums">
            {total}
            <span className="sr-only"> backup{total === 1 ? "" : "s"}</span>
          </span>
        ) : null}
      </div>
      <div className="border-border grid min-w-0 gap-2 border-b p-3">
        <AccessToolbar
          searchLabel="Search backups"
          placeholder="Search backup history..."
          query={request.search}
          onQueryChange={(search) => onRequestChange({ search })}
          sortLabel="Sort backups"
          sort={order}
          sortOptions={SORT_OPTIONS}
          onSortChange={(value) =>
            onRequestChange({
              sort_by: value === "name" ? "name" : "requested_at",
              sort_order:
                value === "oldest" || value === "name" ? "asc" : "desc",
            })
          }
          chips={chips}
          onClearFilters={() =>
            onRequestChange({ provenance: "all", installation: "all" })
          }
          sortInFiltersBelowMd
          quickFiltersBelow
          quickFilters={
            <ToggleGroup
              aria-label="Status"
              variant="segmented"
              multiple={false}
              value={[request.state]}
              className="w-full max-w-full flex-nowrap overflow-x-auto max-md:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] max-md:pr-8 md:w-fit [&>*]:shrink-0"
              onValueChange={(selection) => {
                const next = STATUS_FILTERS.find(
                  (option) => option.value === selection[0],
                );
                if (next) onRequestChange({ state: next.value });
              }}
            >
              {STATUS_FILTERS.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  className="flex-none px-2 text-sm whitespace-nowrap"
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          }
        >
          <FilterSelect
            id={`${id}-source`}
            label="Source"
            ariaLabel="Request source"
            value={request.provenance}
            options={SOURCE_OPTIONS}
            onChange={(provenance) => onRequestChange({ provenance })}
          />
          <FilterSelect
            id={`${id}-installation`}
            label="Installation"
            value={request.installation}
            options={INSTALLATION_OPTIONS}
            onChange={(installation) => onRequestChange({ installation })}
          />
        </AccessToolbar>
      </div>

      <div className="relative min-h-0 min-w-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
        {loading ? (
          <p role="status" className="text-muted-foreground px-4 py-3 text-sm">
            Loading backup history…
          </p>
        ) : null}
        {failure ? (
          <Alert role="alert" variant="destructive" className="m-3">
            <p>
              {failure === "denied"
                ? "Only administrators can review backups."
                : "Backup history could not be loaded."}
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-2 min-h-11"
              onClick={onRetry}
            >
              Retry backup history
            </Button>
          </Alert>
        ) : null}
        {body === "rows" ? (
          <ol ref={listRef} aria-label="Backup history">
            {runs.map((run) => (
              <li key={run.id}>
                <BackupRow
                  run={run}
                  time={formatBackupTime(run.requested_at, region)}
                  selected={run.id === selectedId}
                  phone={phone}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ol>
        ) : body === "none" ? null : (
          <Empty className="border-0 py-10">
            <EmptyHeader>
              <EmptyTitle>
                {body === "no-match"
                  ? "No backups match these filters"
                  : body === "no-page"
                    ? "No backups on this page"
                    : "No backup requests yet"}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </div>
      {paged ? (
        <TablePagination
          ariaLabel="Backup pages"
          total={total}
          offset={request.offset}
          rowCount={runs.length}
          pageSize={request.limit}
          onPageIndexChange={(index) =>
            onRequestChange({ offset: index * request.limit })
          }
          onPageSizeChange={(limit) => onRequestChange({ limit })}
          className="shrink-0 px-3 py-2"
        />
      ) : null}
    </section>
  );
}

function BackupRow({
  run,
  time,
  selected,
  phone,
  onOpen,
}: {
  run: ManageBackupRun;
  time: string;
  selected: boolean;
  phone: boolean;
  onOpen: (id: string) => void;
}) {
  const metaId = useId();
  const { word } = backupRunStatus(run);
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={`Inspect ${run.name}`}
      aria-describedby={metaId}
      // The open backup is current, as in Sandbox History.
      aria-current={selected ? "true" : undefined}
      className={cn(
        // One line per row, 40px from 1280px (DESIGN "Access rows"); two
        // lines on a phone. The open row is the tint only.
        "border-border grid h-auto w-full min-w-0 items-center justify-normal gap-x-3 rounded-none border-b px-3 text-left font-normal whitespace-nowrap",
        "hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] aria-[current=true]:bg-[color-mix(in_oklab,var(--ink)_14%,transparent)]",
        phone
          ? "min-h-14 grid-cols-[minmax(0,1fr)_auto] py-2"
          : "min-h-11 grid-cols-[7rem_minmax(0,1fr)_auto] py-0 xl:h-10 xl:min-h-10",
      )}
      onClick={() => onOpen(run.id)}
    >
      {phone ? (
        <>
          <span title={run.name} className="truncate font-medium">
            {run.name}
          </span>
          <StatusWord
            {...backupRunStatus(run)}
            className="text-sm font-normal"
          />
          <time
            dateTime={run.requested_at}
            className="text-muted-foreground col-span-2 truncate text-xs font-normal tabular-nums"
          >
            {time}
          </time>
        </>
      ) : (
        <>
          <StatusWord
            {...backupRunStatus(run)}
            className="text-sm font-normal"
          />
          <span title={run.name} className="truncate font-medium">
            {run.name}
          </span>
          <time
            dateTime={run.requested_at}
            className="text-muted-foreground text-sm font-normal tabular-nums"
          >
            {time}
          </time>
        </>
      )}
      <span id={metaId} className="sr-only">
        {`${word} · ${time}`}
      </span>
    </Button>
  );
}
