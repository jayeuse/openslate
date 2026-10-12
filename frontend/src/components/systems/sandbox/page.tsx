"use client";

import { SANDBOX_SHORTCUTS } from "@/lib/shortcuts";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { Redo2, Undo2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  subscribeWorkspaceLifecycleSettings,
  workspaceLifecycleQueryOptions,
} from "../manage/adapters/workspace-api";
import { ApiContractError, ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { reportDone, reportError } from "@/lib/feedback";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
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
import { openingModuleId } from "./domain/opening-module";
import { sandboxIssueDestination } from "./domain/issue-destination";
import { summarizeTestRun, testTraceSteps } from "./domain/test-run-summary";
import {
  SANDBOX_WORKBENCH_DEFAULT_WIDTH,
  clearSandboxViewPreferences,
} from "./helpers/view-preferences";
import { sandboxWorkInProgress } from "./helpers/work-in-progress";
import { Designer } from "./components/designer";
import type {
  SandboxCommandFailure,
  SandboxCommandResult,
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
import {
  TriggerStudio,
  triggerPublicationBlockers,
} from "./components/trigger-studio";
import { TestWorkspace } from "./components/test-workspace";
import { ReviewPublishDialog } from "./components/review-publish-dialog";
import { SandboxHeaderActions } from "./components/sandbox-header-actions";
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
  return { label: "Draft saved", publishable: true };
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

// LoadingRegion wraps its content in one unstyled element, so the section's
// spacing and the Build section's wide-screen column carry through `*:`.
const sandboxRegionClass = "*:space-y-5";
const sandboxBuildRegionClass =
  "*:space-y-5 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:*:flex xl:*:min-h-0 xl:*:flex-1 xl:*:flex-col xl:*:gap-5 xl:*:space-y-0";

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
        <div className="border-card-edge bg-card shadow-card flex flex-col gap-4 rounded-xl border p-4">
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
  const [message, setMessage] = useState("");
  const [feedbackError, setFeedbackError] = useState("");
  // Bumped by each successful Publish; the look's title signature plays once.
  const [publishCount, setPublishCount] = useState(0);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [triggerDraft, setTriggerDraft] = useState({
    dirty: false,
    pending: false,
  });
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
  const issues = Array.from(
    new Map(
      [...validateSandboxDesign(design), ...(session?.issues ?? [])].map(
        (issue) => [
          `${issue.code}:${issue.targetId ?? ""}:${issue.message}`,
          issue,
        ],
      ),
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
  // With no link, open on the first module of the busiest department, the
  // same department the canvas opens on.
  const requestedSelection = linkedSelection ?? openingModuleId(design) ?? "";
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
      setMessage(
        `${result.deletedCount} old version${result.deletedCount === 1 ? "" : "s"} deleted.`,
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
    } finally {
      setLoading(false);
    }
  }, [queryClient]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (section === "Triggers") void refreshTriggerActivity();
  }, [refreshTriggerActivity, section]);

  const navigate = useCallback(
    (target: string, replace = false, bypassPending = false) => {
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
          triggerDraftDirty: triggerDraft.dirty,
          triggerDraftPending: triggerDraft.pending,
          designerDraftDirty,
        })
      )
        return;
      const href = sectionHref(next, new URLSearchParams(search.toString()));
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
      testPending,
    ],
  );
  useWorkspaceNavigationGuard(
    useCallback(
      () =>
        !sandboxWorkInProgress({
          commandBusy,
          publicationPending,
          testPending,
          conflict: conflict !== null,
          triggerDraftDirty: triggerDraft.dirty,
          triggerDraftPending: triggerDraft.pending,
          designerDraftDirty,
        }),
      [
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
          setFeedbackError(
            "The shared Sandbox changed elsewhere. Reload it, then reapply your proposed document before saving.",
          );
        } else {
          setConflict({ proposedDocument: document, reason: "save-failed" });
          setFeedbackError(
            "Your change was not saved. It remains local until you reapply it successfully.",
          );
        }
        return commandFailure(error);
      } finally {
        commandPending.current = false;
        setPending(false);
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
      const nextDesign =
        typeof update === "function" ? update(session.history.present) : update;
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
      setMessage("");
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
        setMessage(
          "Live change confirmed. The current design has been refreshed.",
        );
        lifecycleLock.current = false;
      } catch {
        setLifecycleRecovery(true);
        setMessage("");
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
        setMessage("Checkpoint created.");
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
        setMessage("Shared Sandbox replaced from the v4 JSON bundle.");
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
        setMessage(`${template.name} template applied to the shared Sandbox.`);
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
        label: "Before discard",
        note: "Saved automatically before discarding draft changes.",
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
        setMessage(
          "Draft restored to the latest published version. Live workspace data was not changed.",
        );
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
        setMessage(
          "Draft changes discarded. Live workspace data was not changed.",
        );
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
      commandBusy ||
      publicationPending ||
      testPending ||
      conflict !== null ||
      triggerDraft.dirty ||
      triggerDraft.pending
    ) {
      setMessage(
        "Wait for the current action to finish, or save or discard your trigger changes.",
      );
      return;
    }
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
      setMessage(
        "Shared Sandbox reloaded. Your local unsaved changes were discarded.",
      );
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
      if (result.ok)
        setMessage("Your local draft was reapplied to the shared Sandbox.");
    } catch (error) {
      setFeedbackError(commandFailure(error).error);
    } finally {
      setPending(false);
    }
  }, [conflict, persist]);

  if (loadError && !session)
    return (
      <section data-sandbox-page>
        <Alert role="alert" variant="destructive">
          <p>{loadError}</p>
          <Button className="mt-3" onClick={() => void refresh()}>
            Retry
          </Button>
        </Alert>
      </section>
    );
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
  return (
    <section
      data-sandbox-page
      aria-busy={commandBusy || publicationPending || testPending || undefined}
      className={`space-y-5 ${section === "Build" ? "xl:flex xl:h-[calc(100dvh-7rem)] xl:min-h-[640px] xl:flex-col xl:gap-5 xl:space-y-0" : ""}`}
    >
      {conflict ? (
        <Alert
          role="alert"
          variant="destructive"
          className="flex flex-wrap gap-2"
        >
          <div className="space-y-1">
            <p>
              {conflict.reason === "conflict"
                ? "Save conflict: your proposed document is still local."
                : "Save did not complete: your proposed document is still local."}
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
          className="flex flex-wrap items-center gap-2"
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
      <header className="xl:flex xl:flex-wrap xl:items-end xl:justify-between xl:gap-4">
        <div className="flex flex-col gap-3 xl:contents">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h1
              key={publishCount}
              data-slot="page-title"
              data-signature={publishCount > 0 ? "play" : undefined}
              className="text-xl font-semibold tracking-tight sm:text-2xl"
            >
              Sandbox
            </h1>
            {loading ? null : <Badge variant="outline">{status.label}</Badge>}
          </div>
          <div className="flex shrink-0 gap-2">
            {section === "Build" ? (
              <>
                <Button
                  variant="outline"
                  aria-label="Undo"
                  className="max-xl:size-11 max-xl:p-0"
                  disabled={
                    loading ||
                    !session?.history.past.length ||
                    commandBusy ||
                    Boolean(conflict) ||
                    designerDraftDirty
                  }
                  onClick={() => void undo()}
                >
                  <Undo2 data-icon="inline-start" />
                  <span className="max-xl:sr-only">Undo</span>
                </Button>
                <Button
                  variant="outline"
                  aria-label="Redo"
                  className="max-xl:size-11 max-xl:p-0"
                  disabled={
                    loading ||
                    !session?.history.future.length ||
                    commandBusy ||
                    Boolean(conflict) ||
                    designerDraftDirty
                  }
                  onClick={() => void redo()}
                >
                  <Redo2 data-icon="inline-start" />
                  <span className="max-xl:sr-only">Redo</span>
                </Button>
              </>
            ) : null}
            <Button
              disabled={
                loading ||
                commandBusy ||
                testPending ||
                !status.publishable ||
                triggerDraft.dirty ||
                triggerDraft.pending ||
                designerDraftDirty
              }
              onClick={() => setReviewOpen(true)}
            >
              Review &amp; Publish
            </Button>
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
                triggerDraft.pending
              }
              templatesOpen={templatesOpen}
              onTemplatesOpenChange={setTemplatesOpen}
              canCheckpoint={
                design.departments.length > 0 || design.modules.length > 0
              }
              canDiscard={status.publishable}
              onCreateCheckpoint={checkpoint}
              onImport={importFile}
              onApplyTemplate={applyTemplate}
              onDiscard={discardDraftChanges}
            />
          </div>
        </div>
      </header>
      <LoadingRegion
        // Only the first load shows the skeleton; a refresh (after Publish,
        // Retry, or a restore) keeps the builder on screen.
        loading={loading && session === null}
        label="Opening Sandbox"
        skeleton={<SandboxSkeleton build={section === "Build"} />}
        className={
          section === "Build" ? sandboxBuildRegionClass : sandboxRegionClass
        }
      >
        {feedbackError && !conflict ? (
          <Alert variant="destructive">{feedbackError}</Alert>
        ) : null}
        {message ? <Alert role="status">{message}</Alert> : null}
        {issues.length ? (
          <Alert variant="warning" role="status">
            <p>
              {issues.length} item{issues.length === 1 ? "" : "s"} need
              attention.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {issues.slice(0, 3).map((issue) => (
                <Button
                  key={`${issue.code}-${issue.targetId ?? ""}`}
                  variant="outline"
                  size="sm"
                  onClick={() => selectIssue(issue)}
                >
                  Review: {issue.message}
                </Button>
              ))}
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
            notify={setMessage}
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
            onDraftStateChange={setDesignerDraftDirty}
          />
        ) : null}
        {section === "Triggers" && session ? (
          <TriggerStudio
            design={session.document.design}
            triggers={session.document.triggers}
            runs={triggerRuns}
            activity={triggerActivity}
            initialSelectedId={search.get("rule") ?? undefined}
            onRefreshActivity={refreshTriggerActivity}
            onChange={(triggers) =>
              saveDocument({ ...session.document, triggers })
            }
            onStateChange={setTriggerDraft}
          />
        ) : null}
        {section === "Test" && session ? (
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
        ) : null}
        {section === "History" ? (
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
          />
        ) : null}
        <footer className="border-border text-muted-foreground flex flex-wrap justify-between gap-2 border-t pt-3 text-xs">
          <span>{counts(design)}</span>
          <span>
            Draft
            {session?.history.past.length
              ? ` · ${session.history.past.length} ${session.history.past.length === 1 ? "change" : "changes"} you can undo`
              : ""}
          </span>
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
            localBlockers={triggerPublicationBlockers(
              session.document.triggers,
              session.document.design,
            )}
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
              setMessage(
                "Your changes are now published to the live workspace.",
              );
              setPublishCount((count) => count + 1);
            }}
          />
        ) : null}
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
