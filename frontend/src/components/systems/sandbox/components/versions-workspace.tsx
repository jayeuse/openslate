"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { TablePagination } from "@/components/ui/table-pagination";
import { getSandboxVersionMetadata } from "../state/api";
import {
  invalidateSandboxHistoryVersion,
  useSandboxHistoryAccess,
} from "../state/sandbox-history-access";
import {
  sandboxKeys,
  sandboxVersionPageOptions,
} from "../state/sandbox-queries";
import { VersionComparison } from "./version-comparison";
import {
  VersionCapacityBanner,
  type VersionCapacityActions,
} from "./version-capacity-banner";
import { SearchField } from "@/components/ui/search-field";
import { AdvancedSection } from "@/components/ui/advanced-section";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { changesFrom } from "../domain/model";
import { projectSandboxDocument } from "../domain/document-bridge";
import type { SandboxDocumentV4 } from "../domain/document";
import type { SandboxCommandResult } from "../state/commands";
import type {
  SandboxDocumentResponse,
  SandboxVersion,
  SandboxVersionPage,
  SandboxVersionDetail,
} from "../state/api";

type Props = {
  versionCapacity: VersionCapacityActions;
  refreshKey: number;
  getVersion: (
    id: string,
  ) => Promise<SandboxCommandResult<SandboxVersionDetail>>;
  updateVersion: (
    id: string,
    label: string,
  ) => Promise<SandboxCommandResult<SandboxVersion>>;
  restoreVersion: (
    id: string,
  ) => Promise<SandboxCommandResult<SandboxDocumentResponse>>;
  deleteVersion: (id: string) => Promise<SandboxCommandResult<null>>;
  notifyError: (message: string) => void;
  notifyDone: (message: string) => void;
  pending: boolean;
  /** Opens the page's Save checkpoint dialog. */
  onSaveCheckpoint: () => void;
  /** A checkpoint of an empty design would save nothing. */
  canCheckpoint: boolean;
};

type VersionFilter = "all" | "checkpoint" | "published" | "imported";

type CheckpointLabelEdit = {
  id: string;
  value: string;
  error: string;
};

function canonicalEntityChanges(
  label: "Trigger" | "Scenario",
  before: ReadonlyArray<{ id: string; name: string }>,
  after: ReadonlyArray<{ id: string; name: string }>,
): string[] {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  const changes: string[] = [];
  for (const item of after) {
    const previous = beforeById.get(item.id);
    if (!previous) changes.push(`${label} added: ${item.name}`);
    else if (JSON.stringify(previous) !== JSON.stringify(item))
      changes.push(`${label} changed: ${item.name}`);
  }
  for (const item of before)
    if (!afterById.has(item.id)) changes.push(`${label} removed: ${item.name}`);
  return changes;
}

/**
 * Compares canonical v4 documents without reducing trigger content to
 * Designer rules. The projected design and the canonical triggers can
 * report the same trigger, so identical entries appear once.
 */
export function canonicalVersionChanges(
  before: SandboxDocumentV4,
  after: SandboxDocumentV4,
): string[] {
  return [
    ...new Set([
      ...changesFrom(
        projectSandboxDocument(before),
        projectSandboxDocument(after),
      ),
      ...canonicalEntityChanges("Trigger", before.triggers, after.triggers),
      ...canonicalEntityChanges("Scenario", before.scenarios, after.scenarios),
    ]),
  ];
}

function LabeledField({
  label,
  children,
}: {
  label: string;
  children: (controlId: string) => ReactNode;
}) {
  const controlId = useId();
  return (
    <Field>
      <FieldLabel htmlFor={controlId} className="text-xs">
        {label}
      </FieldLabel>
      {children(controlId)}
    </Field>
  );
}

function formatVersionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** The time alone, for timeline rows under their day heading. */
function formatVersionTime(value: string): string {
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

function versionKindLabel(version: SandboxVersion): string {
  switch (version.kind) {
    case "checkpoint":
      return "Checkpoint";
    case "published":
      return "Published";
    case "imported":
      return "Imported";
  }
}

function VersionChoice({
  label,
  value,
  versions,
  onChange,
}: {
  label: string;
  value: string;
  versions: SandboxVersion[];
  onChange: (value: string) => void;
}) {
  return (
    <LabeledField label={label}>
      {(controlId) => (
        <NativeSelect
          id={controlId}
          className="w-full [&_select]:min-h-11 xl:[&_select]:min-h-9"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {versions.map((version) => (
            <NativeSelectOption key={version.id} value={version.id}>
              v{version.sequence} · {version.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
    </LabeledField>
  );
}

export function validVersionSelection(
  versions: SandboxVersion[],
  selected: string,
  fallback: "first" | "last",
): string {
  if (versions.some((version) => version.id === selected)) return selected;
  return (fallback === "first" ? versions[0] : versions.at(-1))?.id ?? "";
}

export function versionCompareHint(
  versions: SandboxVersion[],
  first: string,
  second: string,
): string {
  if (versions.length < 2) return "Save at least two versions to compare them.";
  const a = versions.find((version) => version.id === first);
  const b = versions.find((version) => version.id === second);
  if (!a || !b || a.id === b.id)
    return "Choose two different versions to compare.";
  return `Ready to compare ${a.label} (v${a.sequence}) with ${b.label} (v${b.sequence}).`;
}

export function VersionsWorkspace({
  versionCapacity,
  refreshKey,
  getVersion,
  updateVersion,
  restoreVersion,
  deleteVersion,
  notifyError,
  notifyDone,
  pending,
  onSaveCheckpoint,
  canCheckpoint,
}: Props) {
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [retainedVersions, setRetainedVersions] = useState<SandboxVersion[]>(
    [],
  );
  const [filter, setFilter] = useState<VersionFilter>("all");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const access = useSandboxHistoryAccess();
  const denied = access.denied;
  const pageScope = JSON.stringify([appliedSearch.trim(), filter, pageSize]);
  const [lastAuthorizedPage, setLastAuthorizedPage] = useState<{
    scope: string;
    page: SandboxVersionPage;
  } | null>(null);
  const history = useQuery({
    ...sandboxVersionPageOptions(
      {
        limit: pageSize,
        offset,
        search: appliedSearch.trim() || undefined,
        kind: filter === "all" ? undefined : filter,
      },
      refreshKey,
    ),
  });
  useEffect(() => {
    if (denied) {
      setLastAuthorizedPage(null);
      setRetainedVersions([]);
      return;
    }
    if (history.isSuccess && history.data)
      setLastAuthorizedPage({ scope: pageScope, page: history.data });
  }, [
    denied,
    history.data,
    history.dataUpdatedAt,
    history.isSuccess,
    pageScope,
  ]);
  const transientPageFailure =
    history.error instanceof TypeError ||
    (history.error instanceof ApiError &&
      (history.error.status >= 500 ||
        history.error.status === 408 ||
        history.error.status === 429));
  const displayedPage = denied
    ? undefined
    : (history.data ??
      (lastAuthorizedPage?.scope === pageScope &&
      (history.isFetching || transientPageFailure)
        ? lastAuthorizedPage.page
        : undefined));
  // This bounded first-page read shares the initial History request. Its total
  // preserves the last-version deletion guard after search or paging.
  const historyTotal = useQuery({
    ...sandboxVersionPageOptions(
      { limit: 25, offset: 0, search: undefined, kind: undefined },
      refreshKey,
    ),
    select: (page) => page.total,
  });
  const targetIds = [
    ...new Set(
      [selectedVersionId, compareA, compareB].filter(
        (id) => id && !history.data?.items.some((version) => version.id === id),
      ),
    ),
  ];
  const targetReads = useQueries({
    queries: targetIds.map((id) => ({
      queryKey: sandboxKeys.version(id, refreshKey),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getSandboxVersionMetadata(id, { signal }),
      enabled: history.isSuccess,
      retry: false,
    })),
  });
  const invalidTargets = new Set([
    ...access.missingVersionIds,
    ...targetIds.filter((_, index) => {
      const read = targetReads[index];
      const transient =
        read.error instanceof TypeError ||
        (read.error instanceof ApiError &&
          (read.error.status >= 500 ||
            read.error.status === 408 ||
            read.error.status === 429));
      return read.isError && !transient;
    }),
  ]);
  const versions = denied
    ? []
    : (displayedPage?.items ?? []).filter(
        (version) => !invalidTargets.has(version.id),
      );
  const newestFirst = versions;
  const knownVersions = denied
    ? []
    : [
        ...new Map(
          [
            ...retainedVersions.filter(
              (version) => !invalidTargets.has(version.id),
            ),
            ...targetReads.flatMap((read) =>
              read.isError ||
              !read.data ||
              read.data.isDeleted ||
              invalidTargets.has(read.data.id)
                ? []
                : [read.data],
            ),
            ...versions,
          ].map((version) => [version.id, version]),
        ).values(),
      ];
  const selectedCompareA = validVersionSelection(
    knownVersions,
    compareA,
    "first",
  );
  const selectedCompareB = validVersionSelection(
    knownVersions,
    compareB,
    "last",
  );
  const selectedVersion =
    knownVersions.find((version) => version.id === selectedVersionId) ??
    newestFirst[0] ??
    knownVersions[0];
  function retainTargets() {
    if (denied) return;
    setSelectedVersionId(selectedVersion?.id ?? "");
    setCompareA(selectedCompareA);
    setCompareB(selectedCompareB);
    setRetainedVersions(
      knownVersions.filter((version) =>
        [selectedVersion?.id, selectedCompareA, selectedCompareB].includes(
          version.id,
        ),
      ),
    );
  }
  const [comparing, setComparing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [checkpointLabelEdit, setCheckpointLabelEdit] =
    useState<CheckpointLabelEdit | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: "restore" | "delete";
    id: string;
  } | null>(null);
  const [comparison, setComparison] = useState<{
    first: SandboxVersionDetail;
    second: SandboxVersionDetail;
  } | null>(null);
  const comparisonUnavailable =
    comparison !== null &&
    (denied ||
      invalidTargets.has(comparison.first.id) ||
      invalidTargets.has(comparison.second.id));
  useEffect(() => {
    if (!comparisonUnavailable) return;
    setComparison(null);
    setComparing(false);
  }, [comparisonUnavailable]);
  /** A changed compare selection hides the result of the earlier pair. */
  function clearComparison() {
    setComparison(null);
    setComparing(false);
    setCompareError("");
  }
  const [comparePending, setComparePending] = useState(false);
  const [compareError, setCompareError] = useState("");
  const comparisonHeading = useRef<HTMLHeadingElement | null>(null);
  async function compare(firstId: string, secondId: string) {
    setComparePending(true);
    setCompareError("");
    const [first, second] = await Promise.all([
      getVersion(firstId),
      getVersion(secondId),
    ]);
    setComparePending(false);
    if (!first.ok) setCompareError(first.error);
    else if (!second.ok) setCompareError(second.error);
    else {
      setComparison({ first: first.value, second: second.value });
      setComparing(true);
    }
    // Below xl the comparison sits under the detail: bring the result or
    // the error into view.
    requestAnimationFrame(() => {
      const heading = comparisonHeading.current;
      if (!heading || window.matchMedia("(min-width: 80rem)").matches) return;
      heading.scrollIntoView({ block: "start" });
      heading.focus({ preventScroll: true });
    });
  }
  const [compareWith, setCompareWith] = useState("");
  const versionActionReturnFocus = useRef<HTMLElement | null>(null);
  const versionsHeading = useRef<HTMLHeadingElement | null>(null);
  const confirmVersion = confirm
    ? knownVersions.find((version) => version.id === confirm.id)
    : undefined;
  const filteredVersions = newestFirst;
  const timelineGroups = filteredVersions.reduce<
    { label: string; versions: SandboxVersion[] }[]
  >((groups, version) => {
    const label = formatVersionDay(version.createdAt);
    const current = groups.at(-1);
    if (current?.label === label) current.versions.push(version);
    else groups.push({ label, versions: [version] });
    return groups;
  }, []);
  const duplicateLabels = new Set(
    versions
      .filter(
        (version, index) =>
          versions.findIndex(
            (candidate) => candidate.label === version.label,
          ) !== index,
      )
      .map((version) => version.label),
  );

  async function apply() {
    if (!confirm || pending) return;
    setActionError("");
    const action = confirm;
    const version = knownVersions.find(
      (candidate) => candidate.id === action.id,
    );
    if (!version) {
      notifyError("This version is no longer available.");
      return;
    }
    if (action.kind === "delete") {
      const result = await deleteVersion(action.id);
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      setRetainedVersions((items) =>
        items.filter((item) => item.id !== action.id),
      );
      invalidateSandboxHistoryVersion(action.id);
      setOffset(0);
      if (selectedVersionId === action.id) setSelectedVersionId("");
      if (compareA === action.id) setCompareA("");
      if (compareB === action.id) setCompareB("");
      setComparison(null);
      notifyDone(`${version.label} deleted from shared history.`);
    } else {
      const result = await restoreVersion(action.id);
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      notifyDone("Draft restored · checkpoint saved");
    }
    const deleted = action.kind === "delete";
    setConfirm(null);
    setActionError("");
    requestAnimationFrame(() => {
      const returnTarget = versionActionReturnFocus.current;
      if (!deleted && returnTarget?.isConnected) returnTarget.focus();
      else versionsHeading.current?.focus();
    });
  }

  function closeVersionConfirm() {
    if (pending) return;
    setConfirm(null);
    setActionError("");
    requestAnimationFrame(() => {
      const returnTarget = versionActionReturnFocus.current;
      if (returnTarget?.isConnected) returnTarget.focus();
      else versionsHeading.current?.focus();
    });
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-border min-w-0 shrink-0 overflow-hidden rounded-xl border xl:min-h-0 xl:flex-1 xl:shrink">
        <div className="grid min-w-0 xl:h-full xl:min-h-0 xl:grid-cols-[minmax(16rem,1fr)_minmax(26rem,1.7fr)_minmax(18rem,1.1fr)]">
          <section
            aria-label="Version timeline"
            className="bg-card border-border relative min-w-0 border-b p-4 xl:h-full xl:min-h-0 xl:overflow-y-auto xl:border-r xl:border-b-0"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2
                  data-slot="section-title"
                  ref={versionsHeading}
                  tabIndex={-1}
                  className="focus-visible:outline-ring font-semibold focus-visible:outline-2"
                >
                  History
                </h2>
                <p className="text-muted-foreground mt-1 text-xs">
                  {displayedPage?.total ?? 0} saved version
                  {displayedPage?.total === 1 ? "" : "s"}
                </p>
              </div>
              <DisabledReason
                reason={
                  canCheckpoint ? null : "Add a department or module first."
                }
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 max-xl:min-h-11"
                  disabled={pending || !canCheckpoint}
                  onClick={onSaveCheckpoint}
                >
                  Save checkpoint
                </Button>
              </DisabledReason>
            </div>

            <div className="grid gap-3">
              <VersionCapacityBanner {...versionCapacity} />
              <SearchField
                label="Find a version"
                value={search}
                onValueChange={(value) => {
                  retainTargets();
                  const next = value.slice(0, 100);
                  setSearch(next);
                  setAppliedSearch(next.trim());
                  setOffset(0);
                }}
                maxLength={100}
                placeholder="Search labels and notes"
                autoComplete="off"
              />
              <NativeSelect
                aria-label="Filter versions"
                className="w-full [&_select]:min-h-11 xl:[&_select]:min-h-9"
                value={filter}
                onChange={(event) => {
                  const next = event.target.value;
                  if (
                    next === "all" ||
                    next === "checkpoint" ||
                    next === "published" ||
                    next === "imported"
                  ) {
                    retainTargets();
                    setFilter(next);
                    setOffset(0);
                  }
                }}
              >
                <NativeSelectOption value="all">
                  All versions
                </NativeSelectOption>
                <NativeSelectOption value="checkpoint">
                  Checkpoints
                </NativeSelectOption>
                <NativeSelectOption value="published">
                  Published
                </NativeSelectOption>
                <NativeSelectOption value="imported">
                  Imported
                </NativeSelectOption>
              </NativeSelect>
            </div>

            {history.isFetching && (
              <p role="status" className="text-muted-foreground mt-4 text-sm">
                Loading versions…
              </p>
            )}
            {denied ||
            history.isError ||
            targetReads.some((read) => read.isError) ? (
              <Alert variant="destructive" className="mt-4">
                <p>
                  {denied
                    ? "History unavailable. Check your access or retry."
                    : "Versions could not be loaded. Retry."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-2 min-h-11"
                  onClick={() => {
                    void history.refetch();
                    void historyTotal.refetch();
                    for (const read of targetReads) void read.refetch();
                  }}
                >
                  Retry versions
                </Button>
              </Alert>
            ) : null}
            {denied ||
            (!displayedPage &&
              (history.isPending ||
                history.isError)) ? null : versions.length === 0 &&
              displayedPage?.total === 0 &&
              !appliedSearch &&
              filter === "all" ? (
              <Empty className="border-0 py-10">
                <EmptyHeader>
                  <EmptyTitle>No saved versions yet</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : filteredVersions.length ? (
              <div className="mt-4 space-y-5">
                {timelineGroups.map((group) => (
                  <div key={group.label}>
                    <h3 className="text-muted-foreground mb-2 px-1 text-xs font-medium">
                      {group.label}
                    </h3>
                    <div className="relative">
                      <span
                        aria-hidden="true"
                        className="bg-border pointer-events-none absolute inset-y-3 left-3 z-20 w-px -translate-x-1/2"
                      />
                      <ol aria-label="Saved versions" className="space-y-1">
                        {group.versions.map((version) => {
                          const selected = selectedVersion?.id === version.id;
                          const detailId = `version-detail-${version.id}`;
                          const accessibleLabel = duplicateLabels.has(
                            version.label,
                          )
                            ? `View ${version.label}, version ${version.sequence}`
                            : `View ${version.label}`;
                          const isComparedFirst =
                            comparison?.first.id === version.id;
                          const isComparedSecond =
                            comparison?.second.id === version.id;
                          return (
                            <li key={version.id} className="relative">
                              <Button
                                type="button"
                                variant="ghost"
                                aria-label={accessibleLabel}
                                aria-describedby={detailId}
                                aria-pressed={selected}
                                disabled={
                                  pending || checkpointLabelEdit !== null
                                }
                                // Hover and selected tint from the look's ink, as
                                // in the trigger list.
                                className="relative z-10 h-auto min-h-16 w-full justify-start py-3 pr-2 pl-8 text-left whitespace-normal hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] aria-pressed:bg-[color-mix(in_oklab,var(--ink)_14%,transparent)]"
                                onClick={() => setSelectedVersionId(version.id)}
                              >
                                <span
                                  aria-hidden="true"
                                  className={`border-background absolute top-4 left-2 z-30 size-2 rounded-full border ${selected ? "bg-primary" : "bg-muted-foreground/50"}`}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-start gap-1.5">
                                    <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
                                      {version.label}
                                    </span>
                                    {isComparedFirst ? (
                                      <span className="border-action-text/30 bg-action-tint text-action-text shrink-0 rounded border px-1 py-0.5 text-xs leading-none font-semibold">
                                        A
                                      </span>
                                    ) : null}
                                    {isComparedSecond ? (
                                      <span className="border-action-text/30 bg-action-tint text-action-text shrink-0 rounded border px-1 py-0.5 text-xs leading-none font-semibold">
                                        B
                                      </span>
                                    ) : null}
                                  </span>
                                  <span
                                    id={detailId}
                                    className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs"
                                    title={version.createdAt}
                                  >
                                    {/* The kind sits with the date, so a long
                                        name keeps the row's full width. */}
                                    <Badge
                                      variant="outline"
                                      className="shrink-0 px-1 py-0 text-xs"
                                    >
                                      {versionKindLabel(version)}
                                    </Badge>
                                    <time dateTime={version.createdAt}>
                                      {formatVersionTime(version.createdAt)}
                                    </time>{" "}
                                    · v{version.sequence}
                                  </span>
                                  {version.note ? (
                                    <span className="text-muted-foreground mt-1 block truncate text-xs">
                                      {version.note}
                                    </span>
                                  ) : null}
                                </span>
                              </Button>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty className="border-0 py-8">
                <EmptyHeader>
                  <EmptyTitle>
                    {displayedPage && displayedPage.total > 0
                      ? "No versions on this page"
                      : "No matching versions"}
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
            {displayedPage && !denied ? (
              <TablePagination
                ariaLabel="History pages"
                total={displayedPage.total}
                offset={displayedPage.offset}
                rowCount={versions.length}
                pageSize={pageSize}
                disabled={
                  history.isFetching || pending || checkpointLabelEdit !== null
                }
                onPageIndexChange={(index) => {
                  retainTargets();
                  setOffset(index * pageSize);
                }}
                onPageSizeChange={(size) => {
                  retainTargets();
                  setPageSize(size);
                  setOffset(0);
                }}
                className="mt-4 px-0"
              />
            ) : null}
          </section>

          <section
            aria-label="Version comparison"
            className="bg-background border-border relative min-w-0 border-t p-4 max-xl:order-last xl:h-full xl:min-h-0 xl:overflow-y-auto xl:border-t-0 xl:border-r"
          >
            <div>
              <h2
                ref={comparisonHeading}
                tabIndex={-1}
                data-slot="section-title"
                className="font-semibold outline-none"
              >
                Compare versions
              </h2>
            </div>

            {knownVersions.length ? (
              <div className="mt-5 grid gap-3">
                <VersionChoice
                  label="Compare first version"
                  value={selectedCompareA}
                  versions={knownVersions}
                  onChange={(value) => {
                    setCompareA(value);
                    clearComparison();
                  }}
                />
                <VersionChoice
                  label="Compare second version"
                  value={selectedCompareB}
                  versions={knownVersions}
                  onChange={(value) => {
                    setCompareB(value);
                    clearComparison();
                  }}
                />
                <Button
                  variant="outline"
                  className="justify-self-start"
                  disabled={pending || !selectedCompareA || !selectedCompareB}
                  pending={comparePending}
                  pendingLabel="Comparing…"
                  onClick={() =>
                    void compare(selectedCompareA, selectedCompareB)
                  }
                >
                  Compare versions
                </Button>
              </div>
            ) : null}
            {compareError ? (
              <Alert variant="destructive" className="mt-3">
                {compareError}
              </Alert>
            ) : null}

            {comparing &&
            comparison &&
            !comparisonUnavailable &&
            comparison.first.id === selectedCompareA &&
            comparison.second.id === selectedCompareB ? (
              <VersionComparison
                first={comparison.first}
                second={comparison.second}
                changes={canonicalVersionChanges(
                  comparison.first.document,
                  comparison.second.document,
                )}
              />
            ) : (
              <Empty className="border-border mt-6 border-t px-2 py-8">
                <EmptyHeader>
                  <EmptyTitle>
                    {versionCompareHint(
                      knownVersions,
                      selectedCompareA,
                      selectedCompareB,
                    )}
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </section>

          <section
            aria-label="Selected version"
            className="bg-card relative min-w-0 p-4 xl:h-full xl:min-h-0 xl:overflow-y-auto"
          >
            {selectedVersion ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-muted-foreground text-xs font-medium">
                      {versionKindLabel(selectedVersion)}
                    </p>
                    <h2
                      data-slot="section-title"
                      className="mt-1 text-lg font-semibold break-words"
                    >
                      {selectedVersion.label}
                    </h2>
                  </div>
                </div>

                <dl className="border-border mt-5 grid gap-3 border-b pb-5 text-sm">
                  <div>
                    <dt className="text-muted-foreground text-xs">Created</dt>
                    <dd className="mt-1" title={selectedVersion.createdAt}>
                      <time dateTime={selectedVersion.createdAt}>
                        {formatVersionDate(selectedVersion.createdAt)}
                      </time>
                      <span className="text-muted-foreground ml-2 text-xs">
                        v{selectedVersion.sequence}
                      </span>
                    </dd>
                  </div>
                  {selectedVersion.note ? (
                    <div>
                      <dt className="text-muted-foreground text-xs">Note</dt>
                      <dd className="mt-1 break-words">
                        {selectedVersion.note}
                      </dd>
                    </div>
                  ) : null}
                </dl>

                {knownVersions.length > 1 ? (
                  <div className="border-border mt-5 grid gap-2 border-b pb-5">
                    <LabeledField label="Compare with">
                      {(controlId) => (
                        <NativeSelect
                          id={controlId}
                          className="w-full [&_select]:min-h-11 xl:[&_select]:min-h-9"
                          value={validVersionSelection(
                            knownVersions.filter(
                              (version) => version.id !== selectedVersion.id,
                            ),
                            compareWith || compareB,
                            "first",
                          )}
                          onChange={(event) =>
                            setCompareWith(event.target.value)
                          }
                        >
                          {knownVersions
                            .filter(
                              (version) => version.id !== selectedVersion.id,
                            )
                            .map((version) => (
                              <NativeSelectOption
                                key={version.id}
                                value={version.id}
                              >
                                v{version.sequence} · {version.label}
                              </NativeSelectOption>
                            ))}
                        </NativeSelect>
                      )}
                    </LabeledField>
                    <Button
                      variant="outline"
                      disabled={pending}
                      pending={comparePending}
                      pendingLabel="Comparing…"
                      onClick={() => {
                        const other = validVersionSelection(
                          knownVersions.filter(
                            (version) => version.id !== selectedVersion.id,
                          ),
                          compareWith || compareB,
                          "first",
                        );
                        setCompareA(selectedVersion.id);
                        setCompareB(other);
                        void compare(selectedVersion.id, other);
                      }}
                    >
                      Compare
                    </Button>
                  </div>
                ) : null}

                <Button
                  className="mt-5 w-full"
                  variant="outline"
                  disabled={pending}
                  onClick={(event) => {
                    versionActionReturnFocus.current = event.currentTarget;
                    setActionError("");
                    setConfirm({ kind: "restore", id: selectedVersion.id });
                  }}
                >
                  Restore version
                </Button>

                <AdvancedSection storageKey="sandbox.version" className="mt-5">
                  {checkpointLabelEdit?.id === selectedVersion.id ? (
                    <form
                      aria-label={`Edit checkpoint label ${selectedVersion.label}`}
                      className="grid gap-3"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        if (pending || !checkpointLabelEdit) return;
                        const label = checkpointLabelEdit.value.trim();
                        if (!label) {
                          setCheckpointLabelEdit({
                            ...checkpointLabelEdit,
                            error: "Checkpoint label is required",
                          });
                          return;
                        }
                        if (checkpointLabelEdit.value.length > 80) {
                          setCheckpointLabelEdit({
                            ...checkpointLabelEdit,
                            error:
                              "Checkpoint label must be 80 characters or fewer",
                          });
                          return;
                        }
                        const result = await updateVersion(
                          selectedVersion.id,
                          label,
                        );
                        if (!result.ok) {
                          setCheckpointLabelEdit({
                            ...checkpointLabelEdit,
                            error: result.error,
                          });
                          return;
                        }
                        setRetainedVersions((items) =>
                          items.map((item) =>
                            item.id === result.value.id ? result.value : item,
                          ),
                        );
                        // The new label shows in place (inline feedback).
                        setCheckpointLabelEdit(null);
                      }}
                    >
                      <LabeledField label="Checkpoint label">
                        {(controlId) => (
                          <Input
                            id={controlId}
                            autoFocus
                            required
                            maxLength={80}
                            disabled={pending}
                            value={checkpointLabelEdit.value}
                            onKeyDown={(event) => {
                              if (event.key !== "Escape" || pending) return;
                              event.preventDefault();
                              setCheckpointLabelEdit(null);
                            }}
                            onChange={(event) =>
                              setCheckpointLabelEdit({
                                ...checkpointLabelEdit,
                                value: event.target.value,
                                error: "",
                              })
                            }
                          />
                        )}
                      </LabeledField>
                      {checkpointLabelEdit.error ? (
                        <Alert variant="destructive" role="alert">
                          {checkpointLabelEdit.error}
                        </Alert>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          type="submit"
                          pending={pending}
                          pendingLabel="Saving…"
                        >
                          Save label
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => setCheckpointLabelEdit(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : null}
                  {selectedVersion.kind === "checkpoint" &&
                  checkpointLabelEdit?.id !== selectedVersion.id ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        setCheckpointLabelEdit({
                          id: selectedVersion.id,
                          value: selectedVersion.label,
                          error: "",
                        })
                      }
                    >
                      Edit checkpoint label
                    </Button>
                  ) : null}
                  <DisabledReason
                    reason={
                      selectedVersion.kind === "published"
                        ? "Published versions are kept."
                        : historyTotal.data !== undefined &&
                            historyTotal.data <= 1
                          ? "The only version is kept."
                          : null
                    }
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger-text"
                      disabled={
                        pending ||
                        selectedVersion.kind === "published" ||
                        historyTotal.data === undefined ||
                        historyTotal.data <= 1
                      }
                      onClick={(event) => {
                        versionActionReturnFocus.current = event.currentTarget;
                        setActionError("");
                        setConfirm({ kind: "delete", id: selectedVersion.id });
                      }}
                    >
                      Delete version
                    </Button>
                  </DisabledReason>
                </AdvancedSection>
              </>
            ) : (
              <Empty className="border-0 py-10">
                <EmptyHeader>
                  <EmptyTitle>Select a version to see its details.</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </section>
        </div>
      </div>

      <AlertDialog
        open={Boolean(confirm && confirmVersion)}
        onOpenChange={(open) => !open && !pending && closeVersionConfirm()}
      >
        {confirm && confirmVersion ? (
          <AlertDialogContent
            finalFocus={() => {
              const returnTarget = versionActionReturnFocus.current;
              return returnTarget?.isConnected
                ? returnTarget
                : versionsHeading.current;
            }}
            className="max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11"
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirm.kind === "delete"
                  ? `Delete ${confirmVersion.label}?`
                  : `Restore ${confirmVersion.label}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirm.kind === "delete"
                  ? "This can't be undone. Your draft and live data stay as they are."
                  : "Your current draft is saved as a checkpoint first. Live data stays as it is."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {actionError ? (
              <Alert variant="destructive">{actionError}</Alert>
            ) : null}
            <AlertDialogFooter>
              <Button
                variant="outline"
                disabled={pending}
                onClick={closeVersionConfirm}
              >
                Cancel
              </Button>
              <Button
                variant={confirm.kind === "delete" ? "destructive" : "default"}
                pending={pending}
                pendingLabel={
                  confirm.kind === "delete" ? "Deleting…" : "Restoring…"
                }
                onClick={() => void apply()}
              >
                {confirm.kind === "delete"
                  ? "Delete version"
                  : "Restore version"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}
