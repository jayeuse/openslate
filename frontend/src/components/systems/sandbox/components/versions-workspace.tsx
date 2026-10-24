"use client";

import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import { getSandboxVersionMetadata } from "../state/api";
import {
  invalidateSandboxHistoryVersion,
  useSandboxHistoryAccess,
} from "../state/sandbox-history-access";
import {
  sandboxKeys,
  sandboxVersionPageOptions,
} from "../state/sandbox-queries";
import { VersionCompare } from "./version-comparison";
import {
  VersionList,
  type VersionFilter,
  type VersionListBody,
} from "./version-list";
import { VersionDetail, type CheckpointLabelEdit } from "./version-detail";
import type { VersionCapacityActions } from "./version-capacity-banner";
import {
  DialogFrameFooter,
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { changesFrom } from "../domain/model";
import { projectSandboxDocument } from "../domain/document-bridge";
import { defaultComparePair, isAutomaticSave } from "../domain/version-history";
import type { SandboxDocumentV4 } from "../domain/document";
import type { SandboxCommandResult } from "../state/commands";
import type {
  SandboxDocumentResponse,
  SandboxVersion,
  SandboxVersionPage,
  SandboxVersionDetail,
} from "../state/api";

// History (docs/specs/sandbox-relayout.md S8 to S10): the version list and
// one version's detail. The detail holds Restore in its head, the facts as
// label-left rows, Compare (Older, then Newer), and Advanced. This component
// owns the selection, the compare pair, the retained off-page targets, and
// the confirmations; the list and Compare only render them.

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

/** Each viewer's choice to list automatic saves (S9), per account. */
function automaticSavesKey(viewerId: string): string {
  return `openslate:sandbox.history.automatic-saves:${viewerId}`;
}

function readShowAutomatic(viewerId: string): boolean {
  try {
    return window.localStorage.getItem(automaticSavesKey(viewerId)) === "shown";
  } catch {
    return false;
  }
}

function writeShowAutomatic(viewerId: string, show: boolean): void {
  try {
    const key = automaticSavesKey(viewerId);
    if (show) window.localStorage.setItem(key, "shown");
    else window.localStorage.removeItem(key);
  } catch {
    // Private windows and blocked storage keep the default (folded).
  }
}

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
  const viewerId = useVerifiedWorkspaceUserId();
  const rootRef = useRef<HTMLDivElement>(null);
  // Phones show the list or one version's detail, with Back (as Triggers).
  const [phone, setPhone] = useState(false);
  const [phoneView, setPhoneView] = useState<"list" | "detail">("list");
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    let wasPhone = false;
    const observer = new ResizeObserver(([entry]) => {
      const nextPhone = entry.contentRect.width < 640;
      // A window that narrows to a phone starts on the list, with the open
      // version marked; nothing is being edited that it would hide.
      if (nextPhone && !wasPhone) setPhoneView("list");
      wasPhone = nextPhone;
      setPhone(nextPhone);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [showAutomatic, setShowAutomatic] = useState(() =>
    readShowAutomatic(viewerId),
  );
  // An empty choice means the default pair of the inspected version.
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
  // A search lists every automatic save it finds, so the open version
  // always has a visible row.
  const listsAutomatic = showAutomatic || appliedSearch !== "";
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
  // With automatic saves folded, the page opens on the newest listed row.
  const selectedVersion =
    knownVersions.find((version) => version.id === selectedVersionId) ??
    (listsAutomatic
      ? undefined
      : versions.find((version) => !isAutomaticSave(version))) ??
    versions[0] ??
    knownVersions[0];
  const defaultPair = defaultComparePair(
    knownVersions,
    selectedVersion?.id ?? "",
  );
  const known = (id: string) =>
    knownVersions.some((version) => version.id === id);
  const selectedCompareA = known(compareA) ? compareA : defaultPair.older;
  const selectedCompareB = known(compareB) ? compareB : defaultPair.newer;
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
  const comparisonShown =
    comparing &&
    comparison !== null &&
    !comparisonUnavailable &&
    comparison.first.id === selectedCompareA &&
    comparison.second.id === selectedCompareB;
  async function compare(firstId: string, secondId: string) {
    // The compared pair stays chosen while another version is inspected.
    setCompareA(firstId);
    setCompareB(secondId);
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
    // Below xl the detail scrolls with the page: bring the result or the
    // error into view.
    requestAnimationFrame(() => {
      const heading = comparisonHeading.current;
      if (!heading || window.matchMedia("(min-width: 80rem)").matches) return;
      heading.scrollIntoView({ block: "start" });
      heading.focus({ preventScroll: true });
    });
  }
  const versionActionReturnFocus = useRef<HTMLElement | null>(null);
  const versionsHeading = useRef<HTMLHeadingElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const confirmVersion = confirm
    ? knownVersions.find((version) => version.id === confirm.id)
    : undefined;

  function openVersion(id: string) {
    setSelectedVersionId(id);
    // Another version preselects its own pair, unless a result shows: the
    // result stays tied to the versions it compared.
    if (!comparisonShown) {
      setCompareA("");
      setCompareB("");
      setCompareError("");
    }
    if (!phone) return;
    setPhoneView("detail");
    // From the page top: a short detail cannot scroll far enough to sit
    // under the app bar, which left the title cut in half (S25).
    requestAnimationFrame(() => {
      rootRef.current
        ?.closest("[data-sandbox-page]")
        ?.scrollIntoView({ block: "start" });
      detailHeading.current?.focus({ preventScroll: true });
    });
  }

  function backToList() {
    setPhoneView("list");
    requestAnimationFrame(() =>
      (
        listRef.current?.querySelector<HTMLElement>("[aria-current=true]") ??
        versionsHeading.current
      )?.focus(),
    );
  }

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
      // The version that opens next gets its own default pair (S26).
      setCompareA("");
      setCompareB("");
      setComparison(null);
      setPhoneView("list");
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
    // The dialog's finalFocus returns focus as it closes. A second move a
    // frame later would pull focus from wherever the person went next.
  }

  const listBody: VersionListBody =
    denied || (!displayedPage && (history.isPending || history.isError))
      ? "none"
      : versions.length === 0 &&
          displayedPage?.total === 0 &&
          !appliedSearch &&
          filter === "all"
        ? "empty"
        : versions.length
          ? "rows"
          : displayedPage && displayedPage.total > 0
            ? "no-rows-on-page"
            : "no-match";

  return (
    <div
      ref={rootRef}
      className="@container/history flex h-full min-w-0 flex-col"
    >
      <div className="grid min-w-0 gap-4 xl:min-h-0 xl:flex-1 @min-[900px]/history:grid-cols-[minmax(20rem,28rem)_minmax(0,1fr)]">
        <VersionList
          listRef={listRef}
          headingRef={versionsHeading}
          hidden={phone && phoneView === "detail"}
          phone={phone}
          total={displayedPage?.total ?? 0}
          versions={versions}
          body={listBody}
          selectedId={selectedVersion?.id}
          rowsDisabled={pending || checkpointLabelEdit !== null}
          loading={history.isFetching}
          failure={
            denied
              ? "denied"
              : history.isError || targetReads.some((read) => read.isError)
                ? "unavailable"
                : null
          }
          onRetry={() => {
            void history.refetch();
            void historyTotal.refetch();
            for (const read of targetReads) void read.refetch();
          }}
          canCheckpoint={canCheckpoint}
          pending={pending}
          onSaveCheckpoint={onSaveCheckpoint}
          versionCapacity={versionCapacity}
          search={search}
          onSearch={(value) => {
            retainTargets();
            const next = value.slice(0, 100);
            setSearch(next);
            setAppliedSearch(next.trim());
            setOffset(0);
          }}
          filter={filter}
          onFilter={(next) => {
            retainTargets();
            setFilter(next);
            setOffset(0);
          }}
          showAutomatic={showAutomatic}
          searching={appliedSearch !== ""}
          onShowAutomatic={(show) => {
            setShowAutomatic(show);
            writeShowAutomatic(viewerId, show);
          }}
          paging={
            displayedPage &&
            !denied &&
            (displayedPage.total > pageSize || displayedPage.offset > 0)
              ? {
                  offset: displayedPage.offset,
                  pageSize,
                  disabled:
                    history.isFetching ||
                    pending ||
                    checkpointLabelEdit !== null,
                  onPageIndexChange: (index) => {
                    retainTargets();
                    setOffset(index * pageSize);
                  },
                  onPageSizeChange: (size) => {
                    retainTargets();
                    setPageSize(size);
                    setOffset(0);
                  },
                }
              : null
          }
          onOpen={openVersion}
        />

        <VersionDetail
          version={selectedVersion}
          hidden={phone && phoneView === "list"}
          phone={phone}
          headingRef={detailHeading}
          viewerId={viewerId}
          pending={pending}
          onBack={backToList}
          onRestore={(button) => {
            if (!selectedVersion) return;
            versionActionReturnFocus.current = button;
            setActionError("");
            setConfirm({ kind: "restore", id: selectedVersion.id });
          }}
          onDelete={(button) => {
            if (!selectedVersion) return;
            versionActionReturnFocus.current = button;
            setActionError("");
            setConfirm({ kind: "delete", id: selectedVersion.id });
          }}
          deleteReason={
            selectedVersion?.kind === "published"
              ? "Published versions are kept."
              : historyTotal.data !== undefined && historyTotal.data <= 1
                ? "The only version is kept."
                : null
          }
          deleteBlocked={
            selectedVersion?.kind === "published" ||
            historyTotal.data === undefined ||
            historyTotal.data <= 1
          }
          labelEdit={checkpointLabelEdit}
          onLabelEdit={setCheckpointLabelEdit}
          updateVersion={updateVersion}
          onLabelSaved={(saved) =>
            setRetainedVersions((items) =>
              items.map((item) => (item.id === saved.id ? saved : item)),
            )
          }
        >
          <VersionCompare
            headingRef={comparisonHeading}
            versions={knownVersions}
            older={selectedCompareA}
            newer={selectedCompareB}
            onOlderChange={(value) => {
              setCompareA(value);
              setCompareB(selectedCompareB);
              clearComparison();
            }}
            onNewerChange={(value) => {
              setCompareA(selectedCompareA);
              setCompareB(value);
              clearComparison();
            }}
            onCompare={() => void compare(selectedCompareA, selectedCompareB)}
            disabled={pending}
            comparing={comparePending}
            error={compareError}
            result={
              comparisonShown && comparison
                ? {
                    older: comparison.first,
                    newer: comparison.second,
                    changes: canonicalVersionChanges(
                      comparison.first.document,
                      comparison.second.document,
                    ),
                  }
                : null
            }
            hint={versionCompareHint(
              knownVersions,
              selectedCompareA,
              selectedCompareB,
            )}
          />
        </VersionDetail>
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
            className={`${dialogFrameContentClass} max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11`}
          >
            <DialogFrameHeader
              title={
                <AlertDialogTitle className="[overflow-wrap:anywhere]">
                  {confirm.kind === "delete"
                    ? `Delete ${confirmVersion.label}?`
                    : `Restore ${confirmVersion.label}?`}
                </AlertDialogTitle>
              }
              closeLabel={
                confirm.kind === "delete"
                  ? "Close without deleting"
                  : "Close without restoring"
              }
              closeDisabled={pending}
              onClose={closeVersionConfirm}
            />
            <AlertDialogDescription>
              {confirm.kind === "delete"
                ? "This can't be undone. Your draft and live data stay as they are."
                : "Your current draft is saved as a checkpoint first. Live data stays as it is."}
            </AlertDialogDescription>
            {actionError ? (
              <Alert variant="destructive">{actionError}</Alert>
            ) : null}
            <DialogFrameFooter>
              <AlertDialogFooter className="mt-0">
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={closeVersionConfirm}
                >
                  Cancel
                </Button>
                <Button
                  variant={
                    confirm.kind === "delete" ? "destructive" : "default"
                  }
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
            </DialogFrameFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}
