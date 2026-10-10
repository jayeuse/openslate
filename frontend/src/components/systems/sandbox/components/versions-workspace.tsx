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
import { ArrowRight } from "lucide-react";
import { VersionComparison } from "./version-comparison";
import {
  VersionCapacityBanner,
  type VersionCapacityActions,
} from "./version-capacity-banner";
import { SearchField } from "@/components/ui/search-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
          className="w-full [&_select]:min-h-11"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {versions.map((version) => (
            <NativeSelectOption key={version.id} value={version.id}>
              {version.label} · v{version.sequence} ·{" "}
              {formatVersionDate(version.createdAt)}
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
      notifyDone(
        `Draft restored from ${version.label}. Shared history added a recovery checkpoint.`,
      );
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
    <div className="min-w-0">
      <div className="border-border min-w-0 overflow-hidden rounded-xl border xl:h-[calc(100dvh-15rem)]">
        <div className="grid min-w-0 xl:h-full xl:min-h-0 xl:grid-cols-[minmax(14rem,0.85fr)_minmax(30rem,2fr)_minmax(18rem,1.2fr)]">
          <section
            aria-label="Version timeline"
            className="bg-card border-border min-w-0 border-b p-4 xl:h-full xl:min-h-0 xl:overflow-y-auto xl:border-r xl:border-b-0"
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
              <ToggleGroup
                aria-label="Filter versions"
                value={[filter]}
                onValueChange={(values) => {
                  const next = values[0];
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
                className="bg-muted grid w-full grid-cols-2 gap-1 rounded-lg p-1"
              >
                <ToggleGroupItem
                  value="all"
                  aria-label="All versions"
                  className="aria-pressed:bg-secondary aria-pressed:text-secondary-foreground h-auto min-h-9 min-w-0 px-1 py-2 text-xs leading-tight whitespace-normal"
                >
                  All
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="checkpoint"
                  aria-label="Checkpoints"
                  className="aria-pressed:bg-secondary aria-pressed:text-secondary-foreground h-auto min-h-9 min-w-0 px-1 py-2 text-xs leading-tight whitespace-normal"
                >
                  Checkpoints
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="published"
                  aria-label="Published versions"
                  className="aria-pressed:bg-secondary aria-pressed:text-secondary-foreground h-auto min-h-9 min-w-0 px-1 py-2 text-xs leading-tight whitespace-normal"
                >
                  Published
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="imported"
                  aria-label="Imported versions"
                  className="aria-pressed:bg-secondary aria-pressed:text-secondary-foreground h-auto min-h-9 min-w-0 px-1 py-2 text-xs leading-tight whitespace-normal"
                >
                  Imported
                </ToggleGroupItem>
              </ToggleGroup>
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
                        className="bg-border pointer-events-none absolute inset-y-3 left-2 z-20 w-px"
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
                                className={`relative z-10 h-auto min-h-16 w-full justify-start py-3 pr-2 pl-8 text-left whitespace-normal ${selected ? "bg-accent text-accent-foreground" : ""}`}
                                onClick={() => setSelectedVersionId(version.id)}
                              >
                                <span
                                  aria-hidden="true"
                                  className={`border-background absolute top-4 left-2 z-30 size-2 rounded-full border ${selected ? "bg-primary" : "bg-muted-foreground/50"}`}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-1.5">
                                    <span className="min-w-0 flex-1 truncate font-medium">
                                      {version.label}
                                    </span>
                                    {isComparedFirst ? (
                                      <span className="border-primary/30 bg-primary/10 text-primary shrink-0 rounded border px-1 py-0.5 text-xs leading-none font-semibold">
                                        A
                                      </span>
                                    ) : null}
                                    {isComparedSecond ? (
                                      <span className="border-primary/30 bg-primary/10 text-primary shrink-0 rounded border px-1 py-0.5 text-xs leading-none font-semibold">
                                        B
                                      </span>
                                    ) : null}
                                    <Badge
                                      variant="outline"
                                      className="shrink-0 px-1 py-0 text-xs"
                                    >
                                      {versionKindLabel(version)}
                                    </Badge>
                                  </span>
                                  <span
                                    id={detailId}
                                    className="text-muted-foreground mt-1 block text-xs"
                                    title={version.createdAt}
                                  >
                                    <time dateTime={version.createdAt}>
                                      {formatVersionDate(version.createdAt)}
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
            className="bg-background border-border min-w-0 border-b p-4 xl:h-full xl:min-h-0 xl:overflow-y-auto xl:border-r xl:border-b-0"
          >
            <div>
              <h2 data-slot="section-title" className="font-semibold">
                Compare versions
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                See how two saved versions differ.
              </p>
            </div>

            {knownVersions.length ? (
              <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] sm:items-end">
                <VersionChoice
                  label="Compare first version"
                  value={selectedCompareA}
                  versions={knownVersions}
                  onChange={setCompareA}
                />
                <span
                  aria-hidden="true"
                  className="text-muted-foreground hidden items-center justify-center pb-3 sm:flex"
                >
                  <ArrowRight size={16} />
                </span>
                <VersionChoice
                  label="Compare second version"
                  value={selectedCompareB}
                  versions={knownVersions}
                  onChange={setCompareB}
                />
                <Button
                  disabled={pending || !selectedCompareA || !selectedCompareB}
                  onClick={async () => {
                    const [first, second] = await Promise.all([
                      getVersion(selectedCompareA),
                      getVersion(selectedCompareB),
                    ]);
                    if (!first.ok) {
                      notifyError(first.error);
                      return;
                    }
                    if (!second.ok) {
                      notifyError(second.error);
                      return;
                    }
                    setComparison({ first: first.value, second: second.value });
                    setComparing(true);
                  }}
                >
                  Compare versions
                </Button>
              </div>
            ) : null}

            {comparing && comparison && !comparisonUnavailable ? (
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
            className="bg-card min-w-0 p-4 xl:h-full xl:min-h-0 xl:overflow-y-auto"
          >
            {selectedVersion ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
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
                        Version {selectedVersion.sequence}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Note</dt>
                    <dd className="mt-1 break-words">
                      {selectedVersion.note || "No version note provided."}
                    </dd>
                  </div>
                </dl>

                {checkpointLabelEdit?.id === selectedVersion.id ? (
                  <form
                    aria-label={`Edit checkpoint label ${selectedVersion.label}`}
                    className="border-border mt-5 grid gap-3 border-b pb-5"
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
                      setCheckpointLabelEdit(null);
                      notifyDone("Checkpoint label updated in shared history.");
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
                      <Button size="sm" type="submit" disabled={pending}>
                        Save label
                      </Button>
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => setCheckpointLabelEdit(null)}
                      >
                        Cancel label edit
                      </Button>
                    </div>
                  </form>
                ) : null}

                {selectedVersion.kind === "checkpoint" &&
                checkpointLabelEdit?.id !== selectedVersion.id ? (
                  <div className="border-border mt-5 border-b pb-5">
                    <h3 data-slot="section-title" className="font-medium">
                      Version label
                    </h3>
                    <Button
                      className="mt-3"
                      variant="outline"
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
                  </div>
                ) : null}

                <div className="mt-5">
                  <h3 data-slot="section-title" className="font-medium">
                    Restore this version
                  </h3>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Restore it to the draft. A recovery checkpoint is added to
                    history.
                  </p>
                  <Button
                    className="mt-3 w-full"
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
                </div>
                <div className="border-border mt-5 border-t pt-4">
                  <Button
                    variant="ghost"
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
                  {selectedVersion.kind === "published" ? (
                    <p className="text-muted-foreground mt-1 text-xs">
                      Published versions are kept in history.
                    </p>
                  ) : null}
                </div>
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
                  ? `Delete ${confirmVersion.label} from shared history?`
                  : `Restore the draft from ${confirmVersion.label}? Shared history will add a recovery checkpoint.`}
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
                Cancel {confirm.kind === "delete" ? "deletion" : "restore"}
              </Button>
              <Button
                variant={confirm.kind === "delete" ? "destructive" : "default"}
                disabled={pending}
                onClick={() => void apply()}
              >
                {confirm.kind === "delete"
                  ? `Delete ${confirmVersion.label}`
                  : `Restore ${confirmVersion.label}`}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}
