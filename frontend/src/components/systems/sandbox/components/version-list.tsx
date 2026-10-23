"use client";

import { useId, type Ref } from "react";
import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  FileDown,
  RotateCcw,
  Search,
  Upload,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { TablePagination } from "@/components/ui/table-pagination";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { versionListGroups } from "../domain/version-history";
import type { SandboxVersion } from "../state/api";
import {
  VersionCapacityBanner,
  type VersionCapacityActions,
} from "./version-capacity-banner";

// The list pane of History (docs/specs/sandbox-relayout.md S8, S9): the
// total and Save checkpoint in the head, a search and the kind quick filters,
// then 40px rows under sticky day headings, with each day's automatic saves
// folded into one row.

export type VersionFilter = "all" | "checkpoint" | "published" | "imported";

const filters: { value: VersionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "checkpoint", label: "Checkpoints" },
  { value: "published", label: "Published" },
  { value: "imported", label: "Imported" },
];

/** The kind word: "Automatic" for a save the system made (S9). */
export function versionKindWord(
  version: SandboxVersion,
  automatic: boolean,
): string {
  if (automatic) return "Automatic";
  switch (version.kind) {
    case "checkpoint":
      return "Checkpoint";
    case "published":
      return "Published";
    case "imported":
      return "Imported";
  }
}

function KindIcon({
  version,
  automatic,
  className,
}: {
  version: SandboxVersion;
  automatic: boolean;
  className: string;
}) {
  const props = { "aria-hidden": true, className } as const;
  if (automatic) return <RotateCcw {...props} />;
  switch (version.kind) {
    case "checkpoint":
      return <Bookmark {...props} />;
    case "published":
      return <Upload {...props} />;
    case "imported":
      return <FileDown {...props} />;
  }
}

export function formatVersionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatVersionDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/** Labels that more than one listed version shares. */
function sharedLabels(versions: readonly SandboxVersion[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const version of versions) {
    if (seen.has(version.label)) shared.add(version.label);
    seen.add(version.label);
  }
  return shared;
}

export type VersionListBody =
  /** Refused or not loaded yet: the alert or loading line says why. */
  "none" | "empty" | "no-match" | "no-rows-on-page" | "rows";

export function VersionList({
  listRef,
  headingRef,
  hidden,
  phone,
  total,
  versions,
  body,
  selectedId,
  rowsDisabled,
  loading,
  failure,
  onRetry,
  canCheckpoint,
  pending,
  onSaveCheckpoint,
  versionCapacity,
  search,
  onSearch,
  filter,
  onFilter,
  showAutomatic,
  searching,
  onShowAutomatic,
  paging,
  onOpen,
}: {
  listRef: Ref<HTMLDivElement>;
  headingRef: Ref<HTMLHeadingElement>;
  /** On phones the list hides while a version's detail shows. */
  hidden: boolean;
  phone: boolean;
  /** The server total for the current search and filter. */
  total: number;
  /** The current page, newest first. */
  versions: readonly SandboxVersion[];
  body: VersionListBody;
  selectedId: string | undefined;
  rowsDisabled: boolean;
  loading: boolean;
  failure: "denied" | "unavailable" | null;
  onRetry: () => void;
  canCheckpoint: boolean;
  pending: boolean;
  onSaveCheckpoint: () => void;
  versionCapacity: VersionCapacityActions;
  search: string;
  onSearch: (value: string) => void;
  filter: VersionFilter;
  onFilter: (value: VersionFilter) => void;
  showAutomatic: boolean;
  /** A search lists the automatic saves it finds, with no fold rows. */
  searching: boolean;
  onShowAutomatic: (show: boolean) => void;
  paging: {
    offset: number;
    pageSize: number;
    disabled: boolean;
    onPageIndexChange: (index: number) => void;
    onPageSizeChange: (size: number) => void;
  } | null;
  onOpen: (id: string) => void;
}) {
  const idPrefix = useId();
  const shared = sharedLabels(versions);
  const groups = versionListGroups(versions, {
    showAutomatic: showAutomatic || searching,
    dayOf: formatVersionDay,
  }).map((group) =>
    searching
      ? {
          ...group,
          entries: group.entries.filter((entry) => entry.kind === "version"),
        }
      : group,
  );
  return (
    <section
      aria-label="Version timeline"
      className={cn(
        "bg-card border-border flex min-w-0 flex-col overflow-clip rounded-xl border xl:h-full xl:min-h-0",
        hidden && "hidden",
      )}
    >
      <div className="border-border flex min-h-14 items-center gap-2.5 border-b px-4 py-2">
        <h2
          ref={headingRef}
          tabIndex={-1}
          data-slot="section-title"
          className="focus-visible:outline-ring font-semibold focus-visible:outline-2"
        >
          Versions
        </h2>
        <span className="text-muted-foreground text-sm tabular-nums">
          {total}
          <span className="sr-only">
            {" "}
            saved version{total === 1 ? "" : "s"}
          </span>
        </span>
        <DisabledReason
          reason={canCheckpoint ? null : "Add a department or module first."}
        >
          <Button
            variant="ghost"
            className="ml-auto min-h-11 xl:min-h-8"
            disabled={pending || !canCheckpoint}
            onClick={onSaveCheckpoint}
          >
            <Bookmark aria-hidden="true" />
            Save checkpoint
          </Button>
        </DisabledReason>
      </div>
      <div className="border-border grid gap-3 border-b p-3">
        <VersionCapacityBanner {...versionCapacity} />
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-40 flex-1">
            <Search
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <Input
              type="search"
              aria-label="Find a version"
              placeholder="Search labels and notes"
              autoComplete="off"
              maxLength={100}
              className="min-h-11 pl-9"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
            />
          </div>
          <ToggleGroup
            aria-label="Filter versions"
            variant="segmented"
            multiple={false}
            value={[filter]}
            className="w-fit flex-nowrap [&>*]:shrink-0"
            onValueChange={(selection) => {
              const next = filters.find((item) => item.value === selection[0]);
              if (next) onFilter(next.value);
            }}
          >
            {filters.map((item) => (
              <ToggleGroupItem
                key={item.value}
                value={item.value}
                className="flex-none px-2 text-sm whitespace-nowrap"
              >
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      <div
        ref={listRef}
        className={cn(
          "min-h-0 xl:flex-1 xl:overflow-y-auto",
          !phone && "max-h-80 overflow-y-auto xl:max-h-none",
        )}
      >
        {loading ? (
          <p role="status" className="text-muted-foreground px-4 pt-3 text-sm">
            Loading versions…
          </p>
        ) : null}
        {failure ? (
          <Alert variant="destructive" className="m-3">
            <p>
              {failure === "denied"
                ? "History unavailable. Check your access or retry."
                : "Versions could not be loaded. Retry."}
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-2 min-h-11"
              onClick={onRetry}
            >
              Retry versions
            </Button>
          </Alert>
        ) : null}
        {body === "empty" ? (
          <Empty className="border-0 py-10">
            <EmptyHeader>
              <EmptyTitle>No saved versions yet</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : body === "no-match" || body === "no-rows-on-page" ? (
          <Empty className="border-0 py-8">
            <EmptyHeader>
              <EmptyTitle>
                {body === "no-rows-on-page"
                  ? "No versions on this page"
                  : "No matching versions"}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : body === "rows" ? (
          groups.map((group, groupIndex) => {
            const dayId = `${idPrefix}-day-${groupIndex}`;
            return (
              <div key={`${group.day}-${groupIndex}`}>
                <h3
                  id={dayId}
                  className="bg-card border-border text-muted-foreground sticky top-0 z-10 border-b px-3 py-1.5 text-xs font-medium"
                >
                  {group.day}
                </h3>
                <ol aria-labelledby={dayId}>
                  {group.entries.map((entry) =>
                    entry.kind === "automatic" ? (
                      <li
                        key="automatic"
                        className="border-border text-muted-foreground flex min-h-10 items-center gap-2 border-b px-3 text-sm"
                      >
                        {entry.shown ? (
                          <ChevronDown
                            aria-hidden="true"
                            className="size-3.5 shrink-0"
                          />
                        ) : (
                          <ChevronRight
                            aria-hidden="true"
                            className="size-3.5 shrink-0"
                          />
                        )}
                        <span>
                          {entry.count} automatic save
                          {entry.count === 1 ? "" : "s"}
                          {entry.shown ? "" : " hidden"}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-action-text min-h-11 px-2 text-sm xl:min-h-8"
                          onClick={() => onShowAutomatic(!entry.shown)}
                        >
                          {entry.shown ? "Hide" : "Show"}
                          <span className="sr-only"> automatic saves</span>
                        </Button>
                      </li>
                    ) : (
                      <li key={entry.version.id}>
                        <VersionRow
                          version={entry.version}
                          automatic={entry.automatic}
                          sharedLabel={shared.has(entry.version.label)}
                          selected={selectedId === entry.version.id}
                          disabled={rowsDisabled}
                          phone={phone}
                          onOpen={onOpen}
                        />
                      </li>
                    ),
                  )}
                </ol>
              </div>
            );
          })
        ) : null}
      </div>
      {/* Paging shows only when it has somewhere to go. */}
      {paging ? (
        <TablePagination
          ariaLabel="History pages"
          total={total}
          offset={paging.offset}
          rowCount={versions.length}
          pageSize={paging.pageSize}
          disabled={paging.disabled}
          onPageIndexChange={paging.onPageIndexChange}
          onPageSizeChange={paging.onPageSizeChange}
          className="border-border border-t px-3 py-2"
        />
      ) : null}
    </section>
  );
}

function VersionRow({
  version,
  automatic,
  sharedLabel,
  selected,
  disabled,
  phone,
  onOpen,
}: {
  version: SandboxVersion;
  automatic: boolean;
  /** Another listed version has this label: the name adds the number. */
  sharedLabel: boolean;
  selected: boolean;
  disabled: boolean;
  phone: boolean;
  onOpen: (id: string) => void;
}) {
  const metaId = useId();
  const kind = versionKindWord(version, automatic);
  const time = formatVersionTime(version.createdAt);
  const meta = `${kind} · ${time} · v${version.sequence}`;
  return (
    <Button
      type="button"
      variant="ghost"
      data-version-row
      aria-label={
        sharedLabel
          ? `View ${version.label}, version ${version.sequence}`
          : `View ${version.label}`
      }
      aria-describedby={metaId}
      // The shown version is current, as in the trigger list.
      aria-current={selected ? "true" : undefined}
      disabled={disabled}
      className={cn(
        // One line per row, 40px from 1280px (DESIGN "Access rows"); two
        // lines on a phone. Hover and open tints come from the look's ink;
        // the open row also takes an action edge.
        "border-border grid h-auto w-full min-w-0 items-center justify-normal gap-x-2.5 rounded-none border-b px-3 text-left font-normal whitespace-nowrap",
        "hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] aria-[current=true]:bg-[color-mix(in_oklab,var(--ink)_14%,transparent)] aria-[current=true]:shadow-[inset_2px_0_0_var(--action)]",
        phone
          ? "min-h-13 grid-cols-[1rem_minmax(0,1fr)] py-2"
          : "min-h-11 grid-cols-[1rem_minmax(0,1fr)_auto_2.75rem] py-0 xl:h-10 xl:min-h-10",
      )}
      onClick={() => onOpen(version.id)}
    >
      <KindIcon
        version={version}
        automatic={automatic}
        className={cn(
          "text-muted-foreground size-3.5 shrink-0",
          phone && "row-span-2",
        )}
      />
      <span className="flex min-w-0 items-baseline gap-2">
        <span
          title={version.label}
          className={cn(
            "truncate",
            automatic ? "text-muted-foreground" : "font-medium",
          )}
        >
          {version.label}
        </span>
        {phone ? null : (
          <span className="text-muted-foreground shrink-0 text-xs">{kind}</span>
        )}
      </span>
      {phone ? (
        <span
          id={metaId}
          className="text-muted-foreground col-start-2 truncate text-xs"
        >
          {meta}
        </span>
      ) : (
        <>
          <time
            dateTime={version.createdAt}
            className="text-muted-foreground text-sm tabular-nums"
          >
            {time}
          </time>
          <span className="text-muted-foreground text-right text-sm tabular-nums">
            v{version.sequence}
          </span>
          <span id={metaId} className="sr-only">
            {meta}
          </span>
        </>
      )}
    </Button>
  );
}
