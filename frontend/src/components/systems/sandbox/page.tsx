"use client";

import { SANDBOX_SHORTCUTS } from "@/lib/shortcuts";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  subscribeWorkspaceLifecycleSettings,
  workspaceLifecycleQueryOptions,
} from "../manage/adapters/workspace-api";
import { ApiContractError, ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { reportDone, reportError, reportUndoable } from "@/lib/feedback";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import {
  accessNavigationFor,
  getWorkspaceNavigation,
} from "@/components/workspace-navigation";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import type { SandboxCanvasLayout } from "@/lib/sandbox/model";
import {
  counts,
  initialDesign,
  type Design,
  type DesignUpdate,
} from "./domain/model";
import { redoSandboxCommand, undoSandboxCommand } from "./state/controller";
import {
  validateSandboxDesign,
  type SandboxValidationIssue,
} from "./domain/validation";
import {
  SANDBOX_DOCUMENT_SCHEMA_VERSION,
  type SandboxDocumentV4,
} from "./domain/document";
import type { SandboxOrganizationTemplate } from "./domain/templates";
import { sandboxIssueDestination } from "./domain/issue-destination";
import { summarizeTestRun, testTraceSteps } from "./domain/test-run-summary";
import {
  SANDBOX_WORKBENCH_DEFAULT_WIDTH,
  clearSandboxViewPreferences,
} from "./helpers/view-preferences";
import {
  sandboxWorkInProgress,
  triggerEditsHoldMove,
} from "./helpers/work-in-progress";
import { Designer } from "./components/designer";
import {
  SandboxCommandError,
  type SandboxCommandFailure,
  type SandboxCommandResult,
} from "./state/commands";
import {
  createSandboxVersion,
  pruneSandboxVersions,
  deleteSandboxVersion,
  getSandboxVersion,
  importSandboxBundle,
  listSandboxTriggerRuns,
  loadSandboxDocument,
  replaceSandboxDocument,
  restoreSandboxVersion,
  updateSandboxVersion,
  clearSandboxTests,
  createSandboxPublicationPreview,
  createSandboxTest,
  listSandboxTests,
  publishSandbox,
  type SandboxVersion,
  type SandboxTriggerRun,
  type SandboxTestRun,
} from "./state/api";
import {
  openSandboxDocumentSession,
  proposedSandboxDocument,
  reapplySandboxDocument,
  synchronizeSandboxHistoryRules,
  syncSandboxDocumentMetadata,
  updateSandboxDocumentSession,
  type SandboxDocumentSession,
} from "./state/document-session";
import { VersionsWorkspace } from "./components/versions-workspace";
import { DISCARD_CHECKPOINT } from "./domain/version-history";
import { TriggerStudio } from "./components/trigger-studio";
import type { TriggerStatusFilter } from "./components/trigger-list";
import { triggerPublicationBlockers } from "./domain/trigger-rules";
import { useTriggerDraft } from "./components/use-trigger-draft";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import { currentOrganizationId } from "@/lib/organization-context";
import { TriggerLeaveDialog } from "./components/trigger-leave-dialog";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { TestWorkspace } from "./components/test-workspace";
import { ReviewPublishDialog } from "./components/review-publish-dialog";
import { SandboxHeaderActions } from "./components/sandbox-header-actions";
import {
  SandboxHistoryButtons,
  SandboxPageHeader,
} from "./components/sandbox-page-header";
import { SandboxLifecycleDialog } from "./components/lifecycle-dialog";
import {
  sandboxBindingsOptions,
  sandboxKeys,
  sandboxVersionPageOptions,
} from "./state/sandbox-queries";
import { useSandboxHistoryAccess } from "./state/sandbox-history-access";
import type { VersionCapacityActions } from "./components/version-capacity-banner";
import {
  confirmSandboxLifecycle,
  getSandboxBindings,
  type SandboxLifecycleBinding,
  type SandboxLifecycleOperation,
  type SandboxLifecycleRequest,
} from "./state/lifecycle-api";
import type { LifecyclePurgeInput } from "@/lib/lifecycle";

const SANDBOX_SECTIONS = {
  build: "Build",
  triggers: "Triggers",
  test: "Test",
  history: "History",
} as const;
const LEGACY_SECTION_ALIASES: Readonly<Record<string, SandboxSection>> = {
  designer: "Build",
  trigger: "Triggers",
  simulation: "Test",
  preview: "Test",
  versions: "History",
};
type SandboxSection = (typeof SANDBOX_SECTIONS)[keyof typeof SANDBOX_SECTIONS];
type Conflict = {
  proposedDocument: SandboxDocumentV4;
  reason: "conflict" | "save-failed";
};

export function sectionFromSearch(
  requestedSection: string | null,
  requestedRule: string | null,
): SandboxSection {
  if (requestedSection !== null) {
    const normalized = requestedSection.toLowerCase();
    return Object.hasOwn(SANDBOX_SECTIONS, normalized)
      ? SANDBOX_SECTIONS[normalized as keyof typeof SANDBOX_SECTIONS]
      : (LEGACY_SECTION_ALIASES[normalized] ?? "Build");
  }
  return requestedRule ? "Triggers" : "Build";
}

/** The Triggers quick filter a link asks for ("status=off"), if any. */
function triggerStatusFromSearch(
  value: string | null,
): TriggerStatusFilter | undefined {
  return value === "on" || value === "off" ? value : undefined;
}

function sectionHref(
  section: SandboxSection,
  current: URLSearchParams,
): string {
  const slug = Object.entries(SANDBOX_SECTIONS).find(
    ([, label]) => label === section,
  )?.[0];
  const params = new URLSearchParams(current);
  // A trace is a one-time "Show on canvas" request, not part of the view.
  params.delete("trace");
  params.delete("run");
  params.set("section", slug ?? "build");
  return `/sandbox?${params.toString()}`;
}

function commandFailure(error: unknown): SandboxCommandFailure {
  return {
    ok: false,
    error: apiErrorMessage(
      error,
      "This Sandbox change could not be saved. Try again.",
    ),
  };
}

function sandboxStillLoading(): SandboxCommandFailure {
  return { ok: false, error: "Sandbox is still loading." };
}

type PublishStatus = { label: string; publishable: boolean };

// The header status names the draft's real state, and Review & Publish is
// available only when publishing would change something.
function publishStatus(
  session: SandboxDocumentSession | null,
  design: Design,
  conflict: boolean,
): PublishStatus {
  if (conflict) return { label: "Unsaved changes", publishable: false };
  const published = session?.publishedHash !== undefined;
  if (
    !published &&
    design.departments.length === 0 &&
    design.modules.length === 0
  )
    return { label: "Nothing to publish yet", publishable: false };
  if (
    session?.hasUnpublishedChanges === true ||
    (published && session.contentHash !== session.publishedHash)
  )
    return { label: "Unpublished changes", publishable: true };
  if (published) return { label: "Published", publishable: false };
  return { label: "Not published yet", publishable: true };
}

function emptyDocument(): SandboxDocumentV4 {
  return {
    kind: "openslate-sandbox",
    schemaVersion: SANDBOX_DOCUMENT_SCHEMA_VERSION,
    design: { departments: [], modules: [], relationships: [], layout: {} },
    triggers: [],
    scenarios: [],
  };
}

// On desktop the page fills the viewport and never scrolls; its panels do.
// Phones and tablets scroll the page. LoadingRegion wraps its content in one
// unstyled element, so the column carries through `*:`.
const sandboxRegionClass =
  "flex flex-col *:flex *:flex-col *:gap-5 xl:min-h-0 xl:flex-1 xl:*:min-h-0 xl:*:flex-1";
// On desktop, one scroll panel for a section whose own layout does not fill
// the height. `relative` keeps screen-reader text inside it.
const sandboxPanelClass =
  "slim-ui relative xl:min-h-0 xl:flex-1 xl:overflow-y-auto";

/**
 * The Build canvas and its properties panel (phones and tablets: the pane
 * tabs over the canvas), or one panel for the other sections, then the
 * footer line.
 */
function SandboxSkeleton({ build }: { build: boolean }) {
  return (
    <>
      {build ? (
        <div className="flex flex-col gap-3 xl:min-h-0 xl:flex-1">
          <Skeleton className="h-13 w-full xl:hidden" />
          <div className="sandbox-ui border-card-edge bg-card shadow-card flex overflow-hidden rounded-xl border xl:min-h-0 xl:flex-1">
            <div className="border-border flex min-w-0 flex-1 flex-col xl:border-r">
              <div className="flex items-center gap-2 border-b px-4 py-1">
                <Skeleton className="hidden h-4 w-24 sm:block" />
                <div className="flex flex-1 items-center gap-1 py-1">
                  <Skeleton className="size-11" />
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="size-11" />
                  <Skeleton className="h-11 w-16" />
                  <Skeleton className="h-11 w-16" />
                </div>
              </div>
              <div className="flex h-[420px] flex-wrap content-start gap-6 overflow-hidden p-6 xl:h-auto xl:min-h-0 xl:flex-1">
                <Skeleton className="h-36 w-56 rounded-xl" />
                <Skeleton className="h-36 w-56 rounded-xl" />
                <Skeleton className="h-36 w-56 rounded-xl" />
              </div>
            </div>
            <div className="bg-border hidden w-px shrink-0 xl:block" />
            <div
              className="hidden shrink-0 flex-col gap-4 p-4 xl:flex"
              style={{ width: SANDBOX_WORKBENCH_DEFAULT_WIDTH }}
            >
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
        </div>
      ) : (
        <div className="border-card-edge bg-card shadow-card flex flex-col gap-4 overflow-hidden rounded-xl border p-4 xl:min-h-0 xl:flex-1">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-3/4" />
        </div>
      )}
      <div className="border-border flex justify-between gap-2 border-t pt-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-12" />
      </div>
    </>
  );
}

/**
 * What an account that is not an administrator sees on a Sandbox link: one
 * calm line and a way to its first workspace. Retry would only send the same
 * refused requests again.
 */
function SandboxUnavailable() {
  const identity = useQuery(authMeOptions());
  const home = getWorkspaceNavigation(
    "/sandbox",
    new URLSearchParams(),
    accessNavigationFor(identity.data),
  ).find((group) => group.id !== "sandbox");
  return (
    <section data-sandbox-page className="flex flex-col gap-5">
      <h1
        data-slot="page-title"
        className="text-xl font-semibold tracking-tight sm:text-2xl"
      >
        Sandbox
      </h1>
      <Alert className="flex flex-wrap items-center justify-between gap-3">
        <p>Sandbox is not available to your account.</p>
        {home ? (
          <Link
            href={home.href as Route}
            className="text-action-text inline-flex min-h-11 items-center font-medium underline underline-offset-4"
          >
            Go to {home.label}
          </Link>
        ) : null}
      </Alert>
    </section>
  );
}

export default function SandboxPage() {
  const search = useSearchParams();
  const router = useRouter();
  const [session, setSession] = useState<SandboxDocumentSession | null>(null);
  const queryClient = useQueryClient();
  const workspace = useQuery(workspaceLifecycleQueryOptions());
  const purgeEnabled = workspace.isSuccess && workspace.data.purge_enabled;
  useEffect(
    () => subscribeWorkspaceLifecycleSettings(queryClient),
    [queryClient],
  );
  const bindingsQuery = useQuery(
    sandboxBindingsOptions(session?.revision ?? 0),
  );
  const [lifecycleRequest, setLifecycleRequest] =
    useState<SandboxLifecycleRequest | null>(null);
  const [lifecycleRecovery, setLifecycleRecovery] = useState(false);
  const [designerDraftDirty, setDesignerDraftDirty] = useState(false);
  const lifecycleLock = useRef(false);
  const commandPending = useRef(false);
  useEffect(() => {
    if (
      !purgeEnabled &&
      lifecycleRequest?.operation === "purge" &&
      !commandPending.current
    ) {
      setLifecycleRequest(null);
      lifecycleLock.current = false;
      setLifecycleRecovery(false);
    }
  }, [purgeEnabled, lifecycleRequest]);
  const [versionsRefreshKey, setVersionsRefreshKey] = useState(0);
  const [testRuns, setTestRuns] = useState<SandboxTestRun[]>([]);
  const [triggerRuns, setTriggerRuns] = useState<SandboxTriggerRun[]>([]);
  const [triggerActivity, setTriggerActivity] = useState({
    loading: false,
    error: "",
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // Every Sandbox API refuses anyone but an administrator (403).
  const [loadDenied, setLoadDenied] = useState(false);
  const [pending, setPending] = useState(false);
  const [versionRecovery, setVersionRecovery] = useState(false);
  const historyAccess = useSandboxHistoryAccess();
  const capacityRead = useQuery({
    ...sandboxVersionPageOptions(
      { limit: 25, offset: 0, search: undefined, kind: undefined },
      versionsRefreshKey,
    ),
    enabled: session !== null && !historyAccess.denied,
  });
  // A design save in flight, for the header's save-state chip.
  const [saving, setSaving] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  // Bumped by each successful Publish; the look's title signature plays once.
  const [publishCount, setPublishCount] = useState(0);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  // The page owns unsaved trigger edits, so moving between sections (a
  // link, Back, Forward) keeps them; a reload offers them back.
  const saveTriggersRef = useRef<
    (triggers: SandboxDocumentV4["triggers"]) => Promise<void>
  >(async () => {
    throw new Error("Sandbox is still loading.");
  });
  const triggerDraft = useTriggerDraft({
    document: session?.document ?? null,
    persist: useCallback(
      (triggers: SandboxDocumentV4["triggers"]) =>
        saveTriggersRef.current(triggers),
      [],
    ),
    userId: useVerifiedWorkspaceUserId(),
    orgId: currentOrganizationId(),
    confirmed: conflict === null,
  });
  // A navigation held back by unsaved triggers, resumed after Save or Discard.
  const [leaveRequest, setLeaveRequest] = useState<(() => void) | null>(null);
  const [publicationPending, setPublicationPending] = useState(false);
  const [testPending, setTestPending] = useState(false);
  const [sandboxGeneration, setSandboxGeneration] = useState(0);
  const commandBusy =
    pending ||
    lifecycleRequest !== null ||
    lifecycleRecovery ||
    versionRecovery;
  const bindingMismatch = Boolean(
    session &&
    bindingsQuery.data &&
    bindingsQuery.data.document_revision !== session.revision,
  );
  const bindingsReady = Boolean(
    session &&
    bindingsQuery.data &&
    !bindingsQuery.error &&
    !bindingsQuery.isFetching &&
    !bindingMismatch &&
    !lifecycleRecovery,
  );
  const skipNextLayoutInitialization = useRef(false);
  const section = sectionFromSearch(search.get("section"), search.get("rule"));
  const design = session?.history.present ?? initialDesign;
  // Trigger settings that block publishing show here too, so nobody first
  // meets them inside the review.
  const publicationBlockers = session
    ? triggerPublicationBlockers(
        session.document.triggers,
        session.document.design,
      )
    : [];
  const issues = Array.from(
    new Map(
      [
        ...validateSandboxDesign(design),
        ...(session?.issues ?? []),
        ...publicationBlockers,
      ].map((issue) => [
        `${issue.code}:${issue.targetId ?? ""}:${issue.message}`,
        issue,
      ]),
    ).values(),
  );
  const requestedFocusTarget = search.get("inspect");
  const traceTarget = search.get("trace");
  const traceRun = testRuns.find((item) => item.id === search.get("run"));
  const traceSteps =
    traceTarget && traceRun && session
      ? testTraceSteps(
          traceRun,
          session.document.design,
          summarizeTestRun(
            traceRun,
            session.document.design,
            session.document.triggers,
            session.revision,
          ),
        )
      : null;
  const linkedSelection =
    requestedFocusTarget ??
    traceTarget ??
    search.get("module") ??
    search.get("department");
  // With no link, Build opens on the whole design with nothing selected, so
  // Properties shows the summary (F8).
  const requestedSelection = linkedSelection ?? "";
  const status = publishStatus(session, design, Boolean(conflict));

  const refreshVersions = useCallback(async () => {
    setVersionsRefreshKey((value) => value + 1);
  }, []);
  const refreshTriggerActivity = useCallback(async () => {
    setTriggerActivity({ loading: true, error: "" });
    try {
      const runPage = await listSandboxTriggerRuns({ limit: 20 });
      setTriggerRuns(runPage.items);
    } catch {
      setTriggerActivity((current) => ({
        ...current,
        error: "Recent activity could not be loaded.",
      }));
    } finally {
      setTriggerActivity((current) => ({ ...current, loading: false }));
    }
  }, []);
  const syncVersionMetadata = useCallback(async () => {
    const response = await loadSandboxDocument();
    setSession((current) =>
      current
        ? syncSandboxDocumentMetadata(current, response)
        : openSandboxDocumentSession(response),
    );
    await refreshVersions();
  }, [refreshVersions]);
  const refreshCapacity = useCallback(async () => {
    const nextKey = versionsRefreshKey + 1;
    const [response] = await Promise.all([
      loadSandboxDocument(),
      queryClient.fetchQuery({
        ...sandboxVersionPageOptions(
          { limit: 25, offset: 0, search: undefined, kind: undefined },
          nextKey,
        ),
        staleTime: 0,
      }),
      queryClient.refetchQueries(
        { queryKey: ["sandbox", "versions"], type: "active" },
        { throwOnError: true },
      ),
    ]);
    setSession((current) =>
      current
        ? syncSandboxDocumentMetadata(current, response)
        : openSandboxDocumentSession(response),
    );
    setVersionsRefreshKey(nextKey);
  }, [queryClient, versionsRefreshKey]);
  const retryCapacity = useCallback(async () => {
    if (
      commandPending.current ||
      lifecycleLock.current ||
      testPending ||
      publicationPending
    )
      return;
    commandPending.current = true;
    setPending(true);
    try {
      await refreshCapacity();
      setVersionRecovery(false);
      setFeedbackError("");
    } catch (error) {
      setVersionRecovery(true);
      setFeedbackError(commandFailure(error).error);
    } finally {
      commandPending.current = false;
      setPending(false);
    }
  }, [refreshCapacity, testPending, publicationPending]);
  const pruneVersions = useCallback(async (): Promise<
    SandboxCommandResult<number>
  > => {
    if (!session) return sandboxStillLoading();
    if (
      commandPending.current ||
      lifecycleLock.current ||
      commandBusy ||
      designerDraftDirty ||
      triggerDraft.dirty ||
      triggerDraft.pending ||
      testPending ||
      publicationPending ||
      conflict ||
      historyAccess.denied ||
      !capacityRead.isSuccess ||
      capacityRead.isFetching ||
      capacityRead.error ||
      capacityRead.data.mutableCount < 45
    )
      return {
        ok: false,
        error:
          "Load current version capacity and finish the current Sandbox action before deleting checkpoints.",
      };
    commandPending.current = true;
    setPending(true);
    try {
      const result = await pruneSandboxVersions({
        expectedRevision: session.revision,
      });
      await refreshCapacity();
      setVersionRecovery(false);
      reportDone(
        `${result.deletedCount} old version${result.deletedCount === 1 ? "" : "s"} deleted`,
      );
      return { ok: true, value: result.deletedCount };
    } catch (error) {
      // A response or readback failure can follow a committed mutation. Hold
      // writes until explicit Retry reloads both revision and capacity.
      setVersionRecovery(true);
      return commandFailure(error);
    } finally {
      commandPending.current = false;
      setPending(false);
    }
  }, [
    session,
    commandBusy,
    designerDraftDirty,
    triggerDraft,
    testPending,
    publicationPending,
    conflict,
    historyAccess.denied,
    capacityRead.isSuccess,
    capacityRead.isFetching,
    capacityRead.error,
    capacityRead.data,
    refreshCapacity,
  ]);
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setLoadDenied(false);
    void queryClient.invalidateQueries({ queryKey: sandboxKeys.bindings });
    try {
      const [document, testPage] = await Promise.all([
        loadSandboxDocument(),
        listSandboxTests({ limit: 50 }),
      ]);
      setSession(openSandboxDocumentSession(document));
      setVersionsRefreshKey((value) => value + 1);
      setTestRuns(testPage.items);
    } catch (error) {
      setLoadError(commandFailure(error).error);
      setLoadDenied(error instanceof ApiError && error.status === 403);
    } finally {
      setLoading(false);
    }
  }, [queryClient]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // An account refused here that becomes an administrator reads the Sandbox
  // again; only the change itself does, so a refusal never loops.
  const viewer = useQuery(authMeOptions());
  const administrator = accessNavigationFor(viewer.data) === "all";
  const wasAdministrator = useRef(administrator);
  useEffect(() => {
    const promoted = administrator && !wasAdministrator.current;
    wasAdministrator.current = administrator;
    if (promoted && loadDenied) void refresh();
  }, [administrator, loadDenied, refresh]);
  useEffect(() => {
    if (section === "Triggers") void refreshTriggerActivity();
  }, [refreshTriggerActivity, section]);
  // Triggers reads a requested quick filter ("status=off") once, as it
  // opens; the address then drops it, so the sidebar links that copy the
  // page's parameters never bring it back.
  const requestedStatus = search.get("status");
  useEffect(() => {
    if (section !== "Triggers" || requestedStatus === null) return;
    const params = new URLSearchParams(search.toString());
    params.delete("status");
    router.replace(`/sandbox?${params.toString()}` as Route, { scroll: false });
  }, [requestedStatus, router, search, section]);

  const navigate = useCallback(
    (
      target: string,
      replace = false,
      bypassPending = false,
      adjust?: (params: URLSearchParams) => void,
    ) => {
      const next = Object.values(SANDBOX_SECTIONS).includes(
        target as SandboxSection,
      )
        ? (target as SandboxSection)
        : "Build";
      if (
        !bypassPending &&
        sandboxWorkInProgress({
          commandBusy,
          publicationPending,
          testPending,
          conflict: conflict !== null,
          triggerDraftDirty:
            triggerDraft.dirty && triggerEditsHoldMove(section, next),
          triggerDraftPending: triggerDraft.pending,
          designerDraftDirty,
        })
      )
        return;
      const params = new URLSearchParams(search.toString());
      // The Triggers quick filter is a one-time request; only the move that
      // asks for it carries it.
      params.delete("status");
      adjust?.(params);
      const href = sectionHref(next, params);
      if (replace) router.replace(href as Route, { scroll: false });
      else router.push(href as Route, { scroll: false });
    },
    [
      triggerDraft.dirty,
      triggerDraft.pending,
      conflict,
      commandBusy,
      designerDraftDirty,
      publicationPending,
      router,
      search,
      section,
      testPending,
    ],
  );
  useWorkspaceNavigationGuard(
    useCallback(
      (href: string, resume: () => void) => {
        const otherWork = sandboxWorkInProgress({
          commandBusy,
          publicationPending,
          testPending,
          conflict: conflict !== null,
          triggerDraftDirty: false,
          triggerDraftPending: triggerDraft.pending,
          designerDraftDirty,
        });
        if (otherWork) return false;
        const target = new URL(href, window.location.origin);
        const to =
          target.pathname.replace(/\/$/, "") === "/sandbox"
            ? sectionFromSearch(
                target.searchParams.get("section"),
                target.searchParams.get("rule"),
              )
            : null;
        if (!triggerDraft.dirty || !triggerEditsHoldMove(section, to))
          return true;
        // Only unsaved triggers hold the page: ask Save, Discard, or Stay.
        setLeaveRequest(() => resume);
        return false;
      },
      [
        section,
        triggerDraft.dirty,
        triggerDraft.pending,
        conflict,
        commandBusy,
        designerDraftDirty,
        publicationPending,
        testPending,
      ],
    ),
  );
  useEffect(() => {
    if (
      !sandboxWorkInProgress({
        commandBusy,
        publicationPending,
        testPending,
        conflict: conflict !== null,
        triggerDraftDirty: triggerDraft.dirty,
        triggerDraftPending: triggerDraft.pending,
        designerDraftDirty,
      })
    )
      return;
    const guardBrowserExit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guardBrowserExit);
    return () => window.removeEventListener("beforeunload", guardBrowserExit);
  }, [
    triggerDraft.dirty,
    triggerDraft.pending,
    conflict,
    commandBusy,
    designerDraftDirty,
    publicationPending,
    testPending,
  ]);

  const persist = useCallback(
    async (
      next: SandboxDocumentSession,
      document = proposedSandboxDocument(next),
    ): Promise<SandboxCommandResult<Design>> => {
      if (commandPending.current || lifecycleLock.current)
        return {
          ok: false,
          error: "Wait for the current Sandbox action to finish.",
        };
      commandPending.current = true;
      setSession(next);
      setPending(true);
      setSaving(true);
      try {
        const response = await replaceSandboxDocument({
          expectedRevision: next.revision,
          document,
        });
        const confirmed = openSandboxDocumentSession(response);
        setSession({
          ...confirmed,
          history: synchronizeSandboxHistoryRules(
            next.history,
            confirmed.projected,
          ),
        });
        setConflict(null);
        setFeedbackError("");
        return { ok: true, value: confirmed.projected };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setConflict({ proposedDocument: document, reason: "conflict" });
          setFeedbackError("Reload the shared draft, then reapply your edits.");
        } else {
          setConflict({ proposedDocument: document, reason: "save-failed" });
          setFeedbackError(
            "Your change was not saved. Reapply it to try again.",
          );
        }
        return commandFailure(error);
      } finally {
        commandPending.current = false;
        setPending(false);
        setSaving(false);
      }
    },
    [],
  );
  const saveDocument = useCallback(
    async (document: SandboxDocumentV4) => {
      if (!session) throw new Error("Sandbox is still loading.");
      const result = await persist({ ...session, document }, document);
      if (!result.ok) throw new Error(result.error);
    },
    [persist, session],
  );
  useEffect(() => {
    saveTriggersRef.current = (triggers) =>
      session
        ? saveDocument({ ...session.document, triggers })
        : Promise.reject(new Error("Sandbox is still loading."));
  });

  const change = useCallback(
    async (update: DesignUpdate): Promise<SandboxCommandResult<Design>> => {
      if (!session) return sandboxStillLoading();
      if (
        commandBusy ||
        commandPending.current ||
        lifecycleLock.current ||
        conflict
      )
        return {
          ok: false,
          error: "A Sandbox change is already being saved.",
        };
      let nextDesign: Design;
      try {
        nextDesign =
          typeof update === "function"
            ? update(session.history.present)
            : update;
      } catch (error) {
        // A design rule the update checks refuses it with its own reason.
        if (error instanceof SandboxCommandError)
          return { ok: false, error: error.message };
        throw error;
      }
      if (
        nextDesign === session.history.present ||
        JSON.stringify(nextDesign) === JSON.stringify(session.history.present)
      )
        return { ok: true, value: session.history.present };
      return persist(updateSandboxDocumentSession(session, nextDesign));
    },
    [commandBusy, conflict, persist, session],
  );
  const undo = useCallback(async () => {
    if (!session || commandBusy || conflict) return;
    return persist({
      ...session,
      history: undoSandboxCommand(session.history),
    });
  }, [commandBusy, conflict, persist, session]);
  const redo = useCallback(async () => {
    if (!session || commandBusy || conflict) return;
    return persist({
      ...session,
      history: redoSandboxCommand(session.history),
    });
  }, [commandBusy, conflict, persist, session]);

  async function reloadLiveState() {
    if (
      pending ||
      commandPending.current ||
      lifecycleRequest ||
      conflict ||
      designerDraftDirty ||
      triggerDraft.dirty ||
      triggerDraft.pending
    )
      return;
    commandPending.current = true;
    setPending(true);
    try {
      await queryClient.cancelQueries({ queryKey: sandboxKeys.bindings });
      const document = await loadSandboxDocument();
      const bindings = await getSandboxBindings();
      if (bindings.document_revision !== document.revision)
        throw new ApiContractError();
      queryClient.setQueryData(
        sandboxKeys.bindingsRevision(document.revision),
        bindings,
      );
      setSession(openSandboxDocumentSession(document));
      setFeedbackError("");
      setLifecycleRecovery(false);
      lifecycleLock.current = false;
    } catch {
      setFeedbackError(
        "Live state could not be refreshed. Retry before changing this item.",
      );
    } finally {
      commandPending.current = false;
      setPending(false);
    }
  }

  async function requestLifecycle(
    binding: SandboxLifecycleBinding,
    operation: SandboxLifecycleOperation,
  ): Promise<SandboxCommandResult<Design>> {
    if (operation === "purge" && !purgeEnabled)
      return { ok: false, error: "Permanent deletion is unavailable." };
    if (
      !session ||
      !bindingsReady ||
      lifecycleLock.current ||
      commandPending.current ||
      commandBusy ||
      publicationPending ||
      testPending ||
      conflict ||
      designerDraftDirty ||
      triggerDraft.dirty ||
      triggerDraft.pending
    )
      return {
        ok: false,
        error:
          "Save or cancel your edits and wait for the current action before changing live state.",
      };
    lifecycleLock.current = true;
    setLifecycleRequest({ binding, operation });
    return { ok: true, value: session.history.present };
  }
  function cancelLifecycle() {
    if (commandPending.current) return;
    setLifecycleRequest(null);
    lifecycleLock.current = false;
  }
  async function confirmLifecycle(input?: LifecyclePurgeInput) {
    if (
      !lifecycleRequest ||
      commandPending.current ||
      (lifecycleRequest.operation === "purge" && !purgeEnabled)
    )
      return;
    commandPending.current = true;
    try {
      await confirmSandboxLifecycle(lifecycleRequest, input);
      if (lifecycleRequest.operation === "purge")
        skipNextLayoutInitialization.current = true;
      try {
        await queryClient.cancelQueries({ queryKey: sandboxKeys.bindings });
        const document = await loadSandboxDocument();
        const bindings = await getSandboxBindings();
        if (bindings.document_revision !== document.revision)
          throw new ApiContractError();
        queryClient.setQueryData(
          sandboxKeys.bindingsRevision(document.revision),
          bindings,
        );
        setSession(openSandboxDocumentSession(document));
        setFeedbackError("");
        reportDone("Live change confirmed");
        lifecycleLock.current = false;
      } catch {
        setLifecycleRecovery(true);
        setFeedbackError(
          "The live change was confirmed. Reload live state before making another change.",
        );
      }
      setLifecycleRequest(null);
    } finally {
      commandPending.current = false;
    }
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (section !== "Build" || commandBusy || conflict) return;
      if (
        (!event.metaKey && !event.ctrlKey) ||
        !(
          [
            SANDBOX_SHORTCUTS.undo.key,
            SANDBOX_SHORTCUTS.redo.key,
          ] as readonly string[]
        ).includes(event.key.toLowerCase())
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          "input, textarea, select, [contenteditable='true']",
        )
      )
        return;
      if (document.querySelector("[role='dialog'], [role='alertdialog']"))
        return;
      event.preventDefault();
      void (event.key.toLowerCase() === SANDBOX_SHORTCUTS.redo.key ||
      (event.key.toLowerCase() === SANDBOX_SHORTCUTS.redo.alternate.key &&
        event.shiftKey === SANDBOX_SHORTCUTS.redo.alternate.shift)
        ? redo()
        : undo());
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [commandBusy, conflict, redo, section, undo]);

  const initializeLayout = useCallback(
    (layout: SandboxCanvasLayout) => {
      if (skipNextLayoutInitialization.current) {
        skipNextLayoutInitialization.current = false;
        return;
      }
      void change((current) => {
        const persisted = current.layout ?? {};
        const requiredIds = [
          ...current.departments.map((item) => item.id),
          ...current.modules.map((item) => item.id),
        ];
        return Object.keys(persisted).length === requiredIds.length &&
          requiredIds.every((id) => persisted[id] !== undefined)
          ? current
          : { ...current, layout };
      });
    },
    [change],
  );
  const checkpoint = useCallback(
    async (
      label: string,
      note: string,
    ): Promise<SandboxCommandResult<SandboxVersion>> => {
      if (!session) return sandboxStillLoading();
      setPending(true);
      try {
        const version = await createSandboxVersion({
          expectedRevision: session.revision,
          kind: "checkpoint",
          label,
          ...(note ? { note } : {}),
        });
        await syncVersionMetadata();
        reportDone("Checkpoint saved");
        return { ok: true, value: version };
      } catch (error) {
        return commandFailure(error);
      } finally {
        setPending(false);
      }
    },
    [session, syncVersionMetadata],
  );
  const importFile = useCallback(
    async (
      bundle: SandboxDocumentV4,
    ): Promise<SandboxCommandResult<unknown>> => {
      if (!session) return sandboxStillLoading();
      setPending(true);
      try {
        const response = await importSandboxBundle({
          expectedRevision: session.revision,
          bundle,
        });
        setSession(openSandboxDocumentSession(response));
        await refreshVersions();
        navigate("Build", false, true);
        reportDone("Draft imported");
        return { ok: true, value: response.document };
      } catch (error) {
        return commandFailure(error);
      } finally {
        setPending(false);
      }
    },
    [navigate, refreshVersions, session],
  );
  const applyTemplate = useCallback(
    async (
      template: SandboxOrganizationTemplate,
    ): Promise<SandboxCommandResult<unknown>> => {
      if (!session) return sandboxStillLoading();
      setPending(true);
      try {
        const response = await importSandboxBundle({
          expectedRevision: session.revision,
          bundle: template.createDocument(),
        });
        setSession(openSandboxDocumentSession(response));
        await refreshVersions();
        navigate("Build", false, true);
        reportDone(`${template.name} template applied`);
        return { ok: true, value: response.document };
      } catch (error) {
        return commandFailure(error);
      } finally {
        setPending(false);
      }
    },
    [navigate, refreshVersions, session],
  );
  const discardDraftChanges = useCallback(async () => {
    if (!session) return sandboxStillLoading();
    setPending(true);
    try {
      await createSandboxVersion({
        expectedRevision: session.revision,
        kind: "checkpoint",
        // History folds this checkpoint as an automatic save (S9).
        ...DISCARD_CHECKPOINT,
      });
      await syncVersionMetadata();
      const refreshed = await loadSandboxDocument();
      const published = refreshed.latestPublishedVersion;
      if (published) {
        await getSandboxVersion(published.id);
        const restored = await restoreSandboxVersion({
          versionId: published.id,
          expectedRevision: refreshed.revision,
        });
        setSession(openSandboxDocumentSession(restored));
        await refreshVersions();
        reportDone("Draft reset to the last publish");
        return { ok: true as const, value: restored.document };
      }
      const cleared = openSandboxDocumentSession({
        document: emptyDocument(),
        revision: refreshed.revision,
        contentHash: "0".repeat(64),
        byteCount: 0,
        issues: [],
        latestPublishedVersion: null,
        publishedHash: null,
      });
      const result = await persist(cleared);
      if (result.ok) {
        clearSandboxViewPreferences();
        setSandboxGeneration((value) => value + 1);
        reportDone("Draft changes discarded");
      }
      return result;
    } catch (error) {
      return commandFailure(error);
    } finally {
      setPending(false);
    }
  }, [persist, refreshVersions, session, syncVersionMetadata]);

  function selectIssue(issue: SandboxValidationIssue) {
    if (
      !commandBusy &&
      !publicationPending &&
      !testPending &&
      conflict === null &&
      !triggerDraft.pending &&
      triggerDraft.dirty &&
      triggerEditsHoldMove(section, issueSection(issue))
    ) {
      // Only unsaved triggers hold the page: ask Save, Discard, or Stay.
      setLeaveRequest(() => () => openIssue(issue));
      return;
    }
    if (
      commandBusy ||
      publicationPending ||
      testPending ||
      conflict !== null ||
      triggerDraft.pending
    ) {
      reportError("Finish the current action first.");
      return;
    }
    openIssue(issue);
  }
  /** The section an issue opens. */
  function issueSection(issue: SandboxValidationIssue): string {
    const destination = sandboxIssueDestination(
      issue,
      new Set(design.rules.map((rule) => rule.id)),
      new URLSearchParams(),
    );
    if (destination.kind === "section") return destination.section;
    return sectionFromSearch(destination.params.get("section"), null);
  }
  /** Names where an issue's button goes: Triggers, Test, or Build. */
  function issueActionLabel(issue: SandboxValidationIssue): string {
    const destination = sandboxIssueDestination(
      issue,
      new Set(design.rules.map((rule) => rule.id)),
      new URLSearchParams(),
    );
    if (destination.kind === "section")
      return destination.section === "Test" ? "Open Test" : "Show in Build";
    return destination.params.get("section") === "triggers"
      ? "Open trigger"
      : "Show in Build";
  }
  function openIssue(issue: SandboxValidationIssue) {
    const destination = sandboxIssueDestination(
      issue,
      new Set(design.rules.map((rule) => rule.id)),
      new URLSearchParams(search.toString()),
    );
    if (destination.kind === "section") return navigate(destination.section);
    router.replace(`/sandbox?${destination.params.toString()}`, {
      scroll: false,
    });
  }
  const reloadConflict = useCallback(async () => {
    setPending(true);
    try {
      const response = await loadSandboxDocument();
      setSession(openSandboxDocumentSession(response));
      setConflict(null);
      setFeedbackError("");
      reportDone("Shared draft reloaded");
    } catch (error) {
      setFeedbackError(commandFailure(error).error);
    } finally {
      setPending(false);
    }
  }, []);
  const reapplyConflict = useCallback(async () => {
    if (!conflict) return;
    setPending(true);
    try {
      const response = await loadSandboxDocument();
      const reapplied = reapplySandboxDocument(
        response,
        conflict.proposedDocument,
      );
      const result = await persist(reapplied);
      if (result.ok) reportDone("Your draft was reapplied");
    } catch (error) {
      setFeedbackError(commandFailure(error).error);
    } finally {
      setPending(false);
    }
  }, [conflict, persist]);

  if (loadDenied && !session) return <SandboxUnavailable />;
  if (loadError && !session)
    return (
      <section data-sandbox-page className="slim-ui">
        <Alert role="alert" variant="destructive">
          <p>{loadError}</p>
          <Button className="mt-3" onClick={() => void refresh()}>
            Retry
          </Button>
        </Alert>
      </section>
    );
  // Undo and Redo wait without a reason while something else is running.
  const historyBusy =
    loading || commandBusy || Boolean(conflict) || designerDraftDirty;
  const versionCapacity: VersionCapacityActions = {
    state:
      versionRecovery || historyAccess.denied || capacityRead.error
        ? { status: "unavailable" }
        : capacityRead.isPending || capacityRead.isFetching
          ? { status: "loading" }
          : capacityRead.isSuccess
            ? {
                status: "ready",
                mutableCount: capacityRead.data.mutableCount,
                versionCap: capacityRead.data.versionCap,
              }
            : { status: "unavailable" },
    pending:
      loading ||
      pending ||
      lifecycleRequest !== null ||
      lifecycleRecovery ||
      publicationPending ||
      Boolean(conflict) ||
      designerDraftDirty ||
      testPending ||
      triggerDraft.dirty ||
      triggerDraft.pending,
    onRetry: retryCapacity,
    onPrune: pruneVersions,
  };
  // Why Review & Publish cannot open, when it cannot: the header button
  // and the Build summary's Review row say the same thing.
  const reviewReason =
    loading || commandBusy || testPending || triggerDraft.pending
      ? null
      : triggerDraft.dirty
        ? "Save trigger changes first."
        : triggerDraft.kept
          ? "Restore or discard trigger changes first."
          : designerDraftDirty
            ? "Save or cancel your edits first."
            : !status.publishable
              ? "Nothing to publish yet."
              : null;
  const reviewDisabled =
    loading ||
    commandBusy ||
    testPending ||
    !status.publishable ||
    triggerDraft.dirty ||
    triggerDraft.pending ||
    triggerDraft.kept !== null ||
    designerDraftDirty;
  // What needs attention, as the header list and the Build Summary word it.
  const attentionIssues = issues.map((issue) => ({
    key: `${issue.code}:${issue.targetId ?? ""}:${issue.message}`,
    message: issue.message,
    verb: issueActionLabel(issue),
    issue,
  }));
  const historyButtons =
    section === "Build" ? (
      <SandboxHistoryButtons
        busy={historyBusy}
        canUndo={Boolean(session?.history.past.length)}
        canRedo={Boolean(session?.history.future.length)}
        onUndo={() => void undo()}
        onRedo={() => void redo()}
      />
    ) : null;
  return (
    <section
      data-sandbox-page
      aria-busy={commandBusy || publicationPending || testPending || undefined}
      className="flex flex-col gap-5 xl:min-h-0 xl:flex-1"
    >
      {conflict ? (
        <Alert
          role="alert"
          variant="destructive"
          className="slim-ui flex flex-wrap gap-2"
        >
          <div className="space-y-1">
            <p>
              {conflict.reason === "conflict"
                ? "Not saved: someone else changed this draft. Your edits are still here."
                : "Not saved. Your edits are still here."}
            </p>
            {feedbackError ? <p>{feedbackError}</p> : null}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void reloadConflict()}
          >
            Reload shared draft
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => void reapplyConflict()}
          >
            Reapply my draft
          </Button>
        </Alert>
      ) : null}
      {session &&
      (bindingsQuery.error || bindingMismatch || lifecycleRecovery) ? (
        <Alert
          role="alert"
          variant={
            bindingsQuery.error || lifecycleRecovery ? "destructive" : "warning"
          }
          className="slim-ui flex flex-wrap items-center gap-2"
        >
          <span>
            {lifecycleRecovery
              ? "Live state needs to be reloaded after the confirmed change."
              : bindingMismatch
                ? "Live state and the shared draft changed. Reload before changing this item."
                : "Live state could not be loaded. Retry before changing this item."}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={
              pending ||
              Boolean(conflict) ||
              designerDraftDirty ||
              triggerDraft.dirty ||
              triggerDraft.pending
            }
            onClick={() => {
              if (bindingMismatch || lifecycleRecovery) void reloadLiveState();
              else void bindingsQuery.refetch();
            }}
          >
            {bindingMismatch || lifecycleRecovery
              ? "Reload live state"
              : "Retry live state"}
          </Button>
        </Alert>
      ) : null}
      <SandboxPageHeader
        section={section}
        publishCount={publishCount}
        chip={
          loading
            ? null
            : {
                variant: conflict
                  ? "destructive"
                  : triggerDraft.changes > 0
                    ? "warning"
                    : "outline",
                text: conflict
                  ? "Not saved"
                  : `${status.label} · ${
                      saving
                        ? "Saving…"
                        : triggerDraft.changes > 0
                          ? `${triggerDraft.changes} unsaved trigger ${
                              triggerDraft.changes === 1 ? "change" : "changes"
                            }`
                          : "Saved"
                    }`,
              }
        }
        attention={{ issues: attentionIssues, onOpen: selectIssue }}
        history={historyButtons}
        review={{
          reason: reviewReason,
          disabled: reviewDisabled,
          open: () => setReviewOpen(true),
        }}
        menu={
          <SandboxHeaderActions
            versionsRefreshKey={versionsRefreshKey}
            versionCapacity={versionCapacity}
            pending={
              loading ||
              commandBusy ||
              publicationPending ||
              Boolean(conflict) ||
              designerDraftDirty ||
              testPending ||
              triggerDraft.dirty ||
              triggerDraft.pending ||
              triggerDraft.kept !== null
            }
            templatesOpen={templatesOpen}
            onTemplatesOpenChange={setTemplatesOpen}
            checkpointOpen={checkpointOpen}
            onCheckpointOpenChange={setCheckpointOpen}
            canCheckpoint={
              design.departments.length > 0 || design.modules.length > 0
            }
            canDiscard={status.publishable}
            hasPublish={session?.publishedHash !== undefined}
            onCreateCheckpoint={checkpoint}
            onImport={importFile}
            onApplyTemplate={applyTemplate}
            onDiscard={discardDraftChanges}
          />
        }
      />
      <LoadingRegion
        // Only the first load shows the skeleton; a refresh (after Publish,
        // Retry, or a restore) keeps the builder on screen.
        loading={loading && session === null}
        label="Opening Sandbox"
        skeleton={<SandboxSkeleton build={section === "Build"} />}
        className={sandboxRegionClass}
      >
        {feedbackError && !conflict ? (
          <Alert variant="destructive">{feedbackError}</Alert>
        ) : null}
        {triggerDraft.kept ? (
          // Edits kept from before a reload wait here until the person
          // chooses; nothing is applied on its own.
          <Alert variant="warning" role="status" className="slim-ui">
            <p className="font-medium">Restore unsaved trigger changes?</p>
            {triggerDraft.kept.baseChanged ? (
              <p className="mt-1">
                The saved triggers changed since. Saving yours replaces them.
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {/* Restore would replace edits made since the reload, so it
                  waits until those are saved or discarded. */}
              <DisabledReason
                reason={
                  triggerDraft.dirty
                    ? "Save or discard your current trigger edits first."
                    : null
                }
              >
                <Button
                  size="sm"
                  disabled={triggerDraft.dirty}
                  onClick={() => {
                    triggerDraft.restoreKept();
                    if (section !== "Triggers") navigate("Triggers");
                  }}
                >
                  Restore
                </Button>
              </DisabledReason>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const dropped = triggerDraft.discardKept();
                  // Undo offers them again; it never replaces newer edits.
                  if (dropped)
                    reportUndoable("Unsaved trigger changes discarded", () =>
                      triggerDraft.keepAgain(dropped),
                    );
                }}
              >
                Discard
              </Button>
            </div>
          </Alert>
        ) : null}
        {section === "Build" ? (
          <Designer
            key={`${requestedSelection}-${sandboxGeneration}`}
            initialSelected={requestedSelection}
            inspectOnOpen={linkedSelection !== null && traceTarget === null}
            focusTargetId={requestedFocusTarget}
            traceTargetId={traceTarget}
            traceSteps={traceSteps}
            onBackToTest={() => {
              // Return to the same result: keep the run, drop the trace.
              const params = new URLSearchParams(search.toString());
              params.delete("trace");
              params.set("section", "test");
              router.push(`/sandbox?${params.toString()}`, { scroll: false });
            }}
            design={design}
            change={change}
            initializeLayout={initializeLayout}
            notify={reportDone}
            notifyError={reportError}
            notifyUndoable={(text) => reportUndoable(text, () => void undo())}
            onStartFromTemplate={() => setTemplatesOpen(true)}
            pending={
              commandBusy ||
              publicationPending ||
              testPending ||
              Boolean(conflict)
            }
            bindings={bindingsReady ? bindingsQuery.data!.items : null}
            purgeEnabled={purgeEnabled}
            onLifecycle={requestLifecycle}
            phoneHistory={historyButtons}
            onDraftStateChange={setDesignerDraftDirty}
            attention={{
              unpublished: status.publishable,
              review: {
                reason: reviewReason,
                disabled: reviewDisabled,
                open: () => setReviewOpen(true),
              },
              issues: attentionIssues,
              onOpenIssue: selectIssue,
              onShowOffTriggers: () =>
                navigate("Triggers", false, false, (params) => {
                  params.delete("rule");
                  params.set("status", "off");
                }),
            }}
          />
        ) : null}
        {section === "Triggers" && session ? (
          <div className={sandboxPanelClass}>
            <TriggerStudio
              design={session.document.design}
              triggerDraft={triggerDraft}
              runs={triggerRuns}
              activity={triggerActivity}
              initialSelectedId={search.get("rule") ?? undefined}
              initialStatus={triggerStatusFromSearch(search.get("status"))}
              onRefreshActivity={refreshTriggerActivity}
            />
          </div>
        ) : null}
        {section === "Test" && session ? (
          <div className={sandboxPanelClass}>
            <TestWorkspace
              design={session.document.design}
              triggers={session.document.triggers}
              runs={testRuns}
              onRun={async (input) => {
                const run = await createSandboxTest({
                  expectedRevision: session.revision,
                  ...input,
                });
                setTestRuns((current) => [
                  run,
                  ...current.filter((item) => item.id !== run.id),
                ]);
                return run;
              }}
              onClear={async () => {
                await clearSandboxTests();
                setTestRuns([]);
              }}
              onPendingChange={setTestPending}
              draftRevision={session.revision}
              initialRunId={search.get("run")}
              onShowOnCanvas={(run) => {
                const params = new URLSearchParams(search.toString());
                for (const key of ["inspect", "module", "department", "rule"])
                  params.delete(key);
                params.set("trace", run.input.moduleId);
                params.set("run", run.id);
                params.set("section", "build");
                router.push(`/sandbox?${params.toString()}`, { scroll: false });
              }}
            />
          </div>
        ) : null}
        {section === "History" ? (
          <div className={sandboxPanelClass}>
            <VersionsWorkspace
              versionCapacity={versionCapacity}
              refreshKey={versionsRefreshKey}
              getVersion={async (id) => {
                try {
                  return {
                    ok: true as const,
                    value: await getSandboxVersion(id),
                  };
                } catch (error) {
                  return commandFailure(error);
                }
              }}
              updateVersion={async (id, label) => {
                if (!session) return sandboxStillLoading();
                setPending(true);
                try {
                  const version = await updateSandboxVersion({
                    versionId: id,
                    expectedRevision: session.revision,
                    label,
                  });
                  await syncVersionMetadata();
                  return { ok: true as const, value: version };
                } catch (error) {
                  return commandFailure(error);
                } finally {
                  setPending(false);
                }
              }}
              restoreVersion={async (id) => {
                if (!session) return sandboxStillLoading();
                setPending(true);
                try {
                  const response = await restoreSandboxVersion({
                    versionId: id,
                    expectedRevision: session.revision,
                  });
                  setSession(openSandboxDocumentSession(response));
                  await refreshVersions();
                  return { ok: true as const, value: response };
                } catch (error) {
                  return commandFailure(error);
                } finally {
                  setPending(false);
                }
              }}
              deleteVersion={async (id) => {
                if (!session) return sandboxStillLoading();
                setPending(true);
                try {
                  await deleteSandboxVersion({
                    versionId: id,
                    expectedRevision: session.revision,
                  });
                  await syncVersionMetadata();
                  return { ok: true as const, value: null };
                } catch (error) {
                  return commandFailure(error);
                } finally {
                  setPending(false);
                }
              }}
              notifyError={reportError}
              notifyDone={reportDone}
              pending={commandBusy}
              onSaveCheckpoint={() => setCheckpointOpen(true)}
              canCheckpoint={
                design.departments.length > 0 || design.modules.length > 0
              }
            />
          </div>
        ) : null}
        <footer className="border-border text-muted-foreground flex flex-wrap justify-between gap-2 border-t pt-3 text-xs">
          <span>{counts(design)}</span>
          {session?.history.past.length ? (
            <span>
              {session.history.past.length}{" "}
              {session.history.past.length === 1 ? "change" : "changes"} you can
              undo
            </span>
          ) : null}
        </footer>
        {session ? (
          <ReviewPublishDialog
            open={reviewOpen}
            expectedRevision={session.revision}
            design={session.document.design}
            disabled={
              commandBusy ||
              Boolean(conflict) ||
              triggerDraft.dirty ||
              triggerDraft.pending
            }
            localBlockers={publicationBlockers}
            onOpenBlocker={(blocker) => {
              // The review only reads, and it cannot open over unsaved
              // triggers, so nothing holds this move.
              setReviewOpen(false);
              openIssue({ severity: "error", ...blocker });
            }}
            onOpenChange={setReviewOpen}
            onPendingChange={setPublicationPending}
            onPreview={() =>
              createSandboxPublicationPreview({
                expectedRevision: session.revision,
              })
            }
            onPublish={({ preview, password, note, idempotencyKey }) =>
              publishSandbox({
                expectedRevision: session.revision,
                previewToken: preview.previewToken,
                impactDigest: preview.impactDigest,
                password,
                ...(note ? { note } : {}),
                idempotencyKey,
              })
            }
            onPublished={async () => {
              await refresh();
              if (section === "Triggers") await refreshTriggerActivity();
              reportDone("Changes published");
              setPublishCount((count) => count + 1);
            }}
          />
        ) : null}
        <TriggerLeaveDialog
          open={leaveRequest !== null}
          draft={triggerDraft}
          onStay={() => setLeaveRequest(null)}
          onLeave={() => {
            const resume = leaveRequest;
            setLeaveRequest(null);
            resume?.();
          }}
        />
        <SandboxLifecycleDialog
          request={
            lifecycleRequest?.operation === "purge" && !purgeEnabled
              ? null
              : lifecycleRequest
          }
          onCancel={cancelLifecycle}
          onConfirm={confirmLifecycle}
        />
      </LoadingRegion>
    </section>
  );
}
