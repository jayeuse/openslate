"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { Redo2, Undo2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  migrateSandboxFileV1,
  type SandboxDocumentV2,
} from "./domain/document";
import type { SandboxOrganizationTemplate } from "./domain/templates";
import { openingModuleId } from "./domain/opening-module";
import { canvasFieldId } from "./helpers/bridge";
import { clearSandboxViewPreferences } from "./helpers/view-preferences";
import { Designer } from "./components/designer";
import type {
  SandboxCommandFailure,
  SandboxCommandResult,
} from "./state/commands";
import {
  createSandboxVersion,
  deleteSandboxVersion,
  getSandboxVersion,
  importSandboxBundle,
  listAllSandboxVersions,
  listSandboxAutomationRuns,
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
  type SandboxAutomationRun,
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
  AutomationStudio,
  automationPublicationBlockers,
} from "./components/automation-studio";
import { TestWorkspace } from "./components/test-workspace";
import { ReviewPublishDialog } from "./components/review-publish-dialog";
import { SandboxHeaderActions } from "./components/sandbox-header-actions";

const SANDBOX_SECTIONS = {
  build: "Build",
  automations: "Automations",
  test: "Test",
  history: "History",
} as const;
const LEGACY_SECTION_ALIASES: Readonly<Record<string, SandboxSection>> = {
  designer: "Build",
  automation: "Automations",
  simulation: "Test",
  preview: "Test",
  versions: "History",
};
type SandboxSection = (typeof SANDBOX_SECTIONS)[keyof typeof SANDBOX_SECTIONS];
type Conflict = {
  proposedDocument: SandboxDocumentV2;
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
  return requestedRule ? "Automations" : "Build";
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
  params.set("section", slug ?? "build");
  return `/sandbox?${params.toString()}`;
}

function commandFailure(error: unknown): SandboxCommandFailure {
  return {
    ok: false,
    error:
      error instanceof Error
        ? error.message
        : "This Sandbox change could not be saved. Try again.",
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

function emptyDocument(): SandboxDocumentV2 {
  return migrateSandboxFileV1({
    kind: "openslate-sandbox",
    schemaVersion: 1,
    design: initialDesign,
  });
}

export default function SandboxPage() {
  const search = useSearchParams();
  const router = useRouter();
  const [session, setSession] = useState<SandboxDocumentSession | null>(null);
  const [versions, setVersions] = useState<SandboxVersion[]>([]);
  const [testRuns, setTestRuns] = useState<SandboxTestRun[]>([]);
  const [automationRuns, setAutomationRuns] = useState<SandboxAutomationRun[]>(
    [],
  );
  const [automationActivity, setAutomationActivity] = useState({
    loading: false,
    error: "",
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [automationDraft, setAutomationDraft] = useState({
    dirty: false,
    pending: false,
  });
  const [publicationPending, setPublicationPending] = useState(false);
  const [testPending, setTestPending] = useState(false);
  const [sandboxGeneration, setSandboxGeneration] = useState(0);
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
    setVersions(await listAllSandboxVersions());
  }, []);
  const refreshAutomationActivity = useCallback(async () => {
    setAutomationActivity({ loading: true, error: "" });
    try {
      const runPage = await listSandboxAutomationRuns({ limit: 20 });
      setAutomationRuns(runPage.items);
    } catch {
      setAutomationActivity((current) => ({
        ...current,
        error: "Recent activity could not be loaded.",
      }));
    } finally {
      setAutomationActivity((current) => ({ ...current, loading: false }));
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
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [document, versionItems, testPage] = await Promise.all([
        loadSandboxDocument(),
        listAllSandboxVersions(),
        listSandboxTests({ limit: 50 }),
      ]);
      setSession(openSandboxDocumentSession(document));
      setVersions(versionItems);
      setTestRuns(testPage.items);
    } catch (error) {
      setLoadError(commandFailure(error).error);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (section === "Automations") void refreshAutomationActivity();
  }, [refreshAutomationActivity, section]);

  const navigate = useCallback(
    (target: string, replace = false, bypassPending = false) => {
      const next = Object.values(SANDBOX_SECTIONS).includes(
        target as SandboxSection,
      )
        ? (target as SandboxSection)
        : "Build";
      if (
        !bypassPending &&
        (pending ||
          publicationPending ||
          testPending ||
          conflict !== null ||
          automationDraft.dirty ||
          automationDraft.pending)
      )
        return;
      const href = sectionHref(next, new URLSearchParams(search.toString()));
      if (replace) router.replace(href as Route, { scroll: false });
      else router.push(href as Route, { scroll: false });
    },
    [
      automationDraft.dirty,
      automationDraft.pending,
      conflict,
      pending,
      publicationPending,
      router,
      search,
      testPending,
    ],
  );
  useWorkspaceNavigationGuard(
    useCallback(
      () =>
        !pending &&
        !publicationPending &&
        !testPending &&
        !conflict &&
        !automationDraft.dirty &&
        !automationDraft.pending,
      [
        automationDraft.dirty,
        automationDraft.pending,
        conflict,
        pending,
        publicationPending,
        testPending,
      ],
    ),
  );
  useEffect(() => {
    if (
      !pending &&
      !publicationPending &&
      !testPending &&
      !conflict &&
      !automationDraft.dirty &&
      !automationDraft.pending
    )
      return;
    const guardBrowserExit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guardBrowserExit);
    return () => window.removeEventListener("beforeunload", guardBrowserExit);
  }, [
    automationDraft.dirty,
    automationDraft.pending,
    conflict,
    pending,
    publicationPending,
    testPending,
  ]);

  const persist = useCallback(
    async (
      next: SandboxDocumentSession,
      document = proposedSandboxDocument(next),
    ): Promise<SandboxCommandResult<Design>> => {
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
        return { ok: true, value: confirmed.projected };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setConflict({ proposedDocument: document, reason: "conflict" });
          setMessage(
            "The shared Sandbox changed elsewhere. Reload it, then reapply your proposed document before saving.",
          );
        } else {
          setConflict({ proposedDocument: document, reason: "save-failed" });
          setMessage(
            "Your change was not saved. It remains local until you reapply it successfully.",
          );
        }
        return commandFailure(error);
      } finally {
        setPending(false);
      }
    },
    [],
  );
  const saveDocument = useCallback(
    async (document: SandboxDocumentV2) => {
      if (!session) throw new Error("Sandbox is still loading.");
      const result = await persist({ ...session, document }, document);
      if (!result.ok) throw new Error(result.error);
    },
    [persist, session],
  );

  const change = useCallback(
    async (update: DesignUpdate): Promise<SandboxCommandResult<Design>> => {
      if (!session) return sandboxStillLoading();
      if (pending)
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
    [pending, persist, session],
  );
  const undo = useCallback(async () => {
    if (!session || pending) return;
    return persist({
      ...session,
      history: undoSandboxCommand(session.history),
    });
  }, [pending, persist, session]);
  const redo = useCallback(async () => {
    if (!session || pending) return;
    return persist({
      ...session,
      history: redoSandboxCommand(session.history),
    });
  }, [pending, persist, session]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (section !== "Build" || pending) return;
      if (
        (!event.metaKey && !event.ctrlKey) ||
        !["z", "y"].includes(event.key.toLowerCase())
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
      void (event.key.toLowerCase() === "y" || event.shiftKey
        ? redo()
        : undo());
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [pending, redo, section, undo]);

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
      bundle: SandboxDocumentV2,
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
        setMessage("Shared Sandbox replaced from the v2 JSON bundle.");
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
      pending ||
      publicationPending ||
      testPending ||
      conflict !== null ||
      automationDraft.dirty ||
      automationDraft.pending
    ) {
      setMessage(
        "Wait for the current action to finish, or save or discard your automation changes.",
      );
      return;
    }
    if (issue.code.startsWith("scenario.")) return navigate("Test");
    if (issue.code.startsWith("automation.")) {
      const params = new URLSearchParams(search.toString());
      if (issue.targetId) params.set("rule", issue.targetId);
      params.set("section", "automations");
      router.replace(`/sandbox?${params.toString()}`, { scroll: false });
      return;
    }
    if (!issue.targetId) return navigate("Build");
    const params = new URLSearchParams(search.toString());
    if (design.rules.some((rule) => rule.id === issue.targetId)) {
      params.set("rule", issue.targetId);
      params.set("section", "automations");
    } else {
      params.set(
        "inspect",
        issue.moduleId
          ? canvasFieldId(issue.moduleId, issue.targetId)
          : issue.targetId,
      );
      params.set("section", "build");
    }
    router.replace(`/sandbox?${params.toString()}`, { scroll: false });
  }
  const reloadConflict = useCallback(async () => {
    setPending(true);
    try {
      const response = await loadSandboxDocument();
      setSession(openSandboxDocumentSession(response));
      setConflict(null);
      setMessage(
        "Shared Sandbox reloaded. Your local unsaved changes were discarded.",
      );
    } catch (error) {
      setMessage(commandFailure(error).error);
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
      setMessage(commandFailure(error).error);
    } finally {
      setPending(false);
    }
  }, [conflict, persist]);

  if (loading)
    return (
      <section data-sandbox-page aria-busy="true">
        <p role="status">Opening Sandbox…</p>
      </section>
    );
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
  return (
    <section
      data-sandbox-page
      aria-busy={pending || publicationPending || testPending || undefined}
      className={`space-y-5 ${section === "Build" ? "xl:flex xl:h-[calc(100dvh-7rem)] xl:min-h-[640px] xl:flex-col xl:gap-5 xl:space-y-0" : ""}`}
    >
      {conflict ? (
        <Alert role="alert" variant="warning" className="flex flex-wrap gap-2">
          <span>
            {conflict.reason === "conflict"
              ? "Save conflict: your proposed document is still local."
              : "Save did not complete: your proposed document is still local."}
          </span>
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
      <header className="xl:flex xl:flex-wrap xl:items-end xl:justify-between xl:gap-4">
        <div className="flex flex-col gap-3 xl:contents">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h1
              data-slot="page-title"
              className="text-xl font-semibold tracking-tight sm:text-2xl"
            >
              Organization builder
            </h1>
            <Badge variant="outline">{status.label}</Badge>
          </div>
          <div className="flex shrink-0 gap-2">
            {section === "Build" ? (
              <>
                <Button
                  variant="outline"
                  aria-label="Undo"
                  className="max-xl:size-11 max-xl:p-0"
                  disabled={!session?.history.past.length || pending}
                  onClick={() => void undo()}
                >
                  <Undo2 data-icon="inline-start" />
                  <span className="max-xl:sr-only">Undo</span>
                </Button>
                <Button
                  variant="outline"
                  aria-label="Redo"
                  className="max-xl:size-11 max-xl:p-0"
                  disabled={!session?.history.future.length || pending}
                  onClick={() => void redo()}
                >
                  <Redo2 data-icon="inline-start" />
                  <span className="max-xl:sr-only">Redo</span>
                </Button>
              </>
            ) : null}
            <Button
              disabled={
                pending ||
                testPending ||
                !status.publishable ||
                automationDraft.dirty ||
                automationDraft.pending
              }
              onClick={() => setReviewOpen(true)}
            >
              Review &amp; Publish
            </Button>
            <SandboxHeaderActions
              pending={
                pending ||
                testPending ||
                automationDraft.dirty ||
                automationDraft.pending
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
      {message ? <Alert role="status">{message}</Alert> : null}
      {issues.length ? (
        <Alert variant="warning" role="status">
          <p>
            {issues.length} item{issues.length === 1 ? "" : "s"} need attention.
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
          onBackToTest={() => navigate("Test")}
          design={design}
          change={change}
          initializeLayout={initializeLayout}
          notify={setMessage}
          onViewPreferenceChange={() => undefined}
          createRequest={null}
          onCreateRequestHandled={() => undefined}
          onStartFromTemplate={() => setTemplatesOpen(true)}
          pending={pending}
        />
      ) : null}
      {section === "Automations" && session ? (
        <AutomationStudio
          design={session.document.design}
          automations={session.document.automations}
          runs={automationRuns}
          activity={automationActivity}
          initialSelectedId={search.get("rule") ?? undefined}
          onRefreshActivity={refreshAutomationActivity}
          onChange={(automations) =>
            saveDocument({ ...session.document, automations })
          }
          onStateChange={setAutomationDraft}
        />
      ) : null}
      {section === "Test" && session ? (
        <TestWorkspace
          design={session.document.design}
          automations={session.document.automations}
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
          onShowOnCanvas={(moduleId) => {
            const params = new URLSearchParams(search.toString());
            for (const key of ["inspect", "module", "department", "rule"])
              params.delete(key);
            params.set("trace", moduleId);
            params.set("section", "build");
            router.push(`/sandbox?${params.toString()}`, { scroll: false });
          }}
        />
      ) : null}
      {section === "History" ? (
        <VersionsWorkspace
          versions={versions}
          getVersion={async (id) => {
            try {
              return { ok: true as const, value: await getSandboxVersion(id) };
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
          notify={setMessage}
          pending={pending}
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
            pending ||
            Boolean(conflict) ||
            automationDraft.dirty ||
            automationDraft.pending
          }
          localBlockers={automationPublicationBlockers(
            session.document.automations,
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
            if (section === "Automations") await refreshAutomationActivity();
            setMessage("Your changes are now published to the live workspace.");
          }}
        />
      ) : null}
    </section>
  );
}
