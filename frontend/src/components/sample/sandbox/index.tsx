"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Redo2, Undo2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSampleStorage } from "@/components/sample/sample-state";
import { useSampleResource } from "@/components/sample/sample-async";
import type { SandboxCanvasLayout } from "@/components/sandbox/sandbox-canvas";
import {
  counts,
  initialDesign,
  initialSandboxHistory,
  type Design,
  type DesignUpdate,
  type Version,
} from "./model";
import { normalizeSandboxHistory } from "./controller";
import {
  validateSandboxDesign,
  type SandboxValidationIssue,
} from "./validation";
import type { SandboxFileV1 } from "./file-format";
import { canvasFieldId } from "./bridge";
import { Designer } from "./designer";
import {
  emptySandboxSimulation,
  initialSandboxVersions,
  initialRuntimeSandboxHistory,
  readSandboxState,
  SANDBOX_RUNTIME_KEYS,
  useSandboxCommands,
  type SandboxCommandResult,
  type SandboxSnapshot,
} from "./async";
import {
  SandboxControls,
  type SandboxCreateKind,
  type SandboxCreateRequest,
} from "./sandbox-controls";
import {
  clearSandboxViewPreferences,
  loadSandboxViewPreferences,
  saveSandboxViewPreferences,
  type SandboxViewPreferences,
} from "./view-preferences";
import { Workflows } from "./workflows";

type ClearBackup = {
  history: SandboxSnapshot["history"];
  versions: Version[];
  simulation: unknown;
  viewPreferences: SandboxViewPreferences;
};

export default function SampleSandbox() {
  const search = useSearchParams();
  const router = useRouter();
  const sandbox = useSandboxCommands();
  const resource = useSampleResource<SandboxSnapshot>({
    keys: SANDBOX_RUNTIME_KEYS,
    queryKey: "sandbox",
    load: (signal) =>
      sandbox.runtime.load(readSandboxState, {
        keys: SANDBOX_RUNTIME_KEYS,
        signal,
      }),
  });
  const { storageUnavailable } = useSampleStorage();
  const snapshot = resource.data ?? {
    history: normalizeSandboxHistory(initialSandboxHistory, initialDesign),
    versions: initialSandboxVersions,
    simulation: emptySandboxSimulation,
  };
  const initialLoading = !resource.data && resource.status === "loading";
  const initialError = !resource.data && resource.status === "error";
  const history = snapshot.history;
  const versions = snapshot.versions;
  const simulation = snapshot.simulation;
  const [section, setSection] = useState(() =>
    search.get("rule") ? "Automation" : "Designer",
  );
  const [message, setMessage] = useState("");
  const [clearBackup, setClearBackup] = useState<ClearBackup | null>(null);
  const [createRequest, setCreateRequest] =
    useState<SandboxCreateRequest | null>(null);
  const [sandboxGeneration, setSandboxGeneration] = useState(0);
  const nextCreateRequestId = useRef(0);
  const skipNextLayoutInitialization = useRef(false);
  const design = history.present;
  const issues = validateSandboxDesign(design);
  const requestedFocusTarget = search.get("inspect");
  const requestedSelection =
    requestedFocusTarget ??
    search.get("module") ??
    search.get("department") ??
    "sample-requests";

  useEffect(() => {
    function handleHistoryShortcut(event: KeyboardEvent) {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      const redo = key === "y" || (key === "z" && event.shiftKey);
      if (key !== "z" && key !== "y") return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable='true']")
      )
        return;
      if (document.querySelector("[role='dialog'], [role='alertdialog']"))
        return;
      event.preventDefault();
      void (redo ? sandbox.redo() : sandbox.undo()).then((result) => {
        if (!result.ok) setMessage(result.error);
      });
    }
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [sandbox.redo, sandbox.undo]);

  const change = useCallback(
    async (
      update: DesignUpdate,
      commandKey?: string,
    ): Promise<SandboxCommandResult<Design>> => {
      const result = await sandbox.change(update, commandKey);
      if (result.ok) setClearBackup(null);
      if (!result.ok) setMessage(result.error);
      return result;
    },
    [sandbox.change],
  );

  const initializeLayout = useCallback(
    (layout: SandboxCanvasLayout) => {
      if (skipNextLayoutInitialization.current) {
        skipNextLayoutInitialization.current = false;
        return;
      }
      sandbox.runtime.commit((draft) => {
        const current = normalizeSandboxHistory(
          draft.read<unknown>("sandbox.design", initialSandboxHistory),
          initialDesign,
        );
        if (JSON.stringify(current.present.layout) === JSON.stringify(layout))
          return;
        draft.update("sandbox.design", initialRuntimeSandboxHistory, {
          ...current,
          present: { ...current.present, layout },
        });
      });
    },
    [sandbox.runtime],
  );

  const checkpoint = useCallback(
    async (
      label: string,
      note: string,
    ): Promise<SandboxCommandResult<Version>> => {
      const result = await sandbox.checkpoint(label, note);
      if (result.ok) setClearBackup(null);
      setMessage(result.ok ? "Checkpoint created in this tab." : result.error);
      return result;
    },
    [sandbox.checkpoint],
  );

  const createLocalRelease = useCallback(
    async (note: string): Promise<SandboxCommandResult<Version>> => {
      const result = await sandbox.release(note);
      if (!result.ok) {
        setMessage(result.error);
        return result;
      }
      setClearBackup(null);
      setSection("Versions");
      setMessage("Local release created. No live workspace was changed.");
      return result;
    },
    [sandbox.release],
  );

  const importFile = useCallback(
    async (file: SandboxFileV1): Promise<SandboxCommandResult<unknown>> => {
      const result = await sandbox.importFile(file);
      if (!result.ok) return result;
      setClearBackup(null);
      setSection("Designer");
      setMessage(
        "Sandbox replaced from JSON. A recovery checkpoint was created.",
      );
      return result;
    },
    [sandbox.importFile],
  );

  const updateVersions = useCallback(
    async (
      update: (current: Version[]) => Version[],
    ): Promise<SandboxCommandResult<Version[]>> => {
      const result = await sandbox.updateVersions(update);
      if (result.ok) setClearBackup(null);
      return result;
    },
    [sandbox.updateVersions],
  );

  const updateSimulation = useCallback(
    async (
      update: Parameters<typeof sandbox.updateSimulation>[0],
      commandKey?: string,
    ): Promise<SandboxCommandResult<unknown>> => {
      const result = await sandbox.updateSimulation(update, commandKey);
      if (result.ok) setClearBackup(null);
      return result;
    },
    [sandbox.updateSimulation],
  );

  function selectIssue(issue: SandboxValidationIssue) {
    if (sandbox.isPending()) return;
    if (!issue.targetId) {
      setSection("Designer");
      return;
    }
    if (design.rules.some((rule) => rule.id === issue.targetId)) {
      setSection("Automation");
      router.replace(`/sandbox?rule=${encodeURIComponent(issue.targetId)}`);
      return;
    }
    setSection("Designer");
    const selection = issue.moduleId
      ? canvasFieldId(issue.moduleId, issue.targetId)
      : issue.targetId;
    router.replace(`/sandbox?inspect=${encodeURIComponent(selection)}`);
  }

  function requestCreate(kind: SandboxCreateKind) {
    if (sandbox.isPending()) return;
    nextCreateRequestId.current += 1;
    setCreateRequest({ id: nextCreateRequestId.current, kind });
    setSection(kind === "automation-rule" ? "Automation" : "Designer");
  }

  const finishCreateRequest = useCallback(
    (id: number) => {
      setCreateRequest((current) => (current?.id === id ? null : current));
    },
    [setCreateRequest],
  );

  const navigate = useCallback(
    (nextSection: string) => {
      if (!sandbox.isPending()) setSection(nextSection);
    },
    [sandbox.isPending],
  );

  const resetDesign = useCallback(async (): Promise<
    SandboxCommandResult<Design>
  > => {
    const result = await sandbox.resetDesign();
    if (!result.ok) {
      setMessage(result.error);
      return result;
    }
    setClearBackup(null);
    setCreateRequest(null);
    setSection("Designer");
    setMessage(
      "Current Design reset to the initial sample. Undo restores it; Versions, Simulation data, and view preferences were preserved.",
    );
    router.replace("/sandbox");
    return result;
  }, [router, sandbox.resetDesign]);

  const clearSandboxData = useCallback(async (): Promise<
    SandboxCommandResult<null>
  > => {
    setClearBackup({
      history: structuredClone(history),
      versions: structuredClone(versions),
      simulation: structuredClone(simulation),
      viewPreferences: loadSandboxViewPreferences(),
    });
    const result = await sandbox.clear();
    if (!result.ok) {
      setClearBackup(null);
      setMessage(result.error);
      return result;
    }
    clearSandboxViewPreferences();
    skipNextLayoutInitialization.current = true;
    setCreateRequest(null);
    setSandboxGeneration((current) => current + 1);
    setSection("Designer");
    setMessage(
      "Sandbox data cleared in this tab. Defaults are loaded; recovery remains available until reload.",
    );
    router.replace("/sandbox");
    return result;
  }, [history, router, sandbox.clear, simulation, versions]);

  async function undoClear(): Promise<void> {
    if (!clearBackup) return;
    const result = await sandbox.restoreSnapshot({
      history: structuredClone(
        normalizeSandboxHistory(clearBackup.history, initialDesign),
      ),
      versions: structuredClone(clearBackup.versions),
      simulation: structuredClone(clearBackup.simulation),
    });
    if (!result.ok) {
      setMessage(result.error);
      return;
    }
    saveSandboxViewPreferences(clearBackup.viewPreferences);
    skipNextLayoutInitialization.current = true;
    setSandboxGeneration((current) => current + 1);
    setCreateRequest(null);
    setSection("Designer");
    setClearBackup(null);
    setMessage("");
    router.replace("/sandbox");
  }

  if (initialLoading)
    return (
      <section data-sandbox-page aria-busy="true" className="space-y-5">
        <p role="status">Opening Sandbox…</p>
      </section>
    );
  if (initialError)
    return (
      <section data-sandbox-page className="space-y-5">
        <Alert role="alert" variant="destructive">
          <p>{resource.error ?? "Sandbox data could not be loaded."}</p>
          <Button className="mt-3" onClick={resource.reload}>
            Retry
          </Button>
        </Alert>
      </section>
    );
  return (
    <section
      data-sandbox-page
      aria-busy={resource.refreshing || undefined}
      className={`space-y-5 ${section === "Designer" ? "xl:flex xl:h-[calc(100dvh-7rem)] xl:min-h-[640px] xl:flex-col xl:gap-5 xl:space-y-0" : ""}`}
    >
      {resource.error ? (
        <Alert
          role="status"
          variant="warning"
          className="flex flex-wrap items-center gap-2"
        >
          <span>{resource.error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={resource.reload}
            disabled={resource.refreshing}
          >
            Retry
          </Button>
        </Alert>
      ) : null}
      <style jsx global>{`
        @media (max-width: 1279px) {
          [data-sandbox-page] button,
          body:has([data-sandbox-page]) [role="dialog"] button {
            min-width: 44px;
            min-height: 44px;
          }
          [data-sandbox-page] input:not([type="checkbox"]):not([type="radio"]),
          [data-sandbox-page] select,
          [data-sandbox-page] [role="combobox"],
          body:has([data-sandbox-page])
            [role="dialog"]
            input:not([type="checkbox"]):not([type="radio"]),
          body:has([data-sandbox-page]) [role="dialog"] select,
          body:has([data-sandbox-page]) [role="dialog"] [role="combobox"] {
            min-height: 44px;
          }
          body:has([data-sandbox-page])
            [data-sandbox-portal]
            :is(
              [role="menuitem"],
              [role="menuitemcheckbox"],
              [role="menuitemradio"]
            ),
          [data-sandbox-page]
            label:has(input:is([type="checkbox"], [type="radio"])),
          body:has([data-sandbox-page])
            [role="dialog"]
            label:has(input:is([type="checkbox"], [type="radio"])),
          body:has([data-sandbox-page]) [data-sandbox-touch-label] {
            min-width: 44px;
            min-height: 44px;
          }
        }
      `}</style>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Organization designer
          </h1>
          <Badge variant="secondary">Local sandbox</Badge>
          <Badge variant={storageUnavailable ? "warning" : "outline"}>
            {storageUnavailable ? "Storage unavailable" : "Saved in this tab"}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            aria-label="Undo"
            disabled={!history.past.length || sandbox.isPending()}
            onClick={async () => {
              const result = await sandbox.undo();
              if (!result.ok) setMessage(result.error);
            }}
          >
            <Undo2 data-icon="inline-start" />
            Undo
          </Button>
          <Button
            variant="outline"
            aria-label="Redo"
            disabled={!history.future.length || sandbox.isPending()}
            onClick={async () => {
              const result = await sandbox.redo();
              if (!result.ok) setMessage(result.error);
            }}
          >
            <Redo2 data-icon="inline-start" />
            Redo
          </Button>
        </div>
        <SandboxControls
          design={design}
          versions={versions}
          issues={issues}
          onCreateCheckpoint={checkpoint}
          onCreateRelease={createLocalRelease}
          onImport={importFile}
          onCreate={requestCreate}
          onResetDesign={resetDesign}
          onClearData={clearSandboxData}
          onSelectIssue={selectIssue}
          pending={sandbox.isPending()}
        />
      </header>
      <Tabs
        value={section}
        onValueChange={(value) => navigate(String(value))}
        className="contents"
      >
        <nav
          aria-label="Sandbox sections"
          className="border-border flex flex-wrap border-b pb-3"
        >
          <TabsList
            aria-label="Sandbox sections"
            className="grid w-full grid-cols-3 sm:inline-flex sm:w-fit sm:flex-wrap"
          >
            {[
              "Designer",
              "Automation",
              "Simulation",
              "Preview",
              "Versions",
            ].map((tab) => (
              <TabsTrigger
                key={tab}
                value={tab}
                type="button"
                disabled={sandbox.isPending()}
                className="min-h-11 w-full min-w-11 sm:w-auto"
              >
                {tab}
              </TabsTrigger>
            ))}
          </TabsList>
        </nav>
        {message && (
          <Alert role="status" className="flex flex-wrap items-center gap-2">
            <span>{message}</span>
            {clearBackup ? (
              <Button
                variant="outline"
                size="sm"
                onClick={undoClear}
                disabled={sandbox.isPending()}
              >
                Undo clear
              </Button>
            ) : null}
          </Alert>
        )}
        <TabsContent value="Designer" className="contents">
          {section === "Designer" ? (
            <Designer
              key={`${requestedSelection}-${sandboxGeneration}`}
              initialSelected={requestedSelection}
              focusTargetId={requestedFocusTarget}
              design={design}
              change={change}
              initializeLayout={initializeLayout}
              notify={setMessage}
              onViewPreferenceChange={() => setClearBackup(null)}
              createRequest={createRequest}
              onCreateRequestHandled={finishCreateRequest}
              pending={sandbox.isPending()}
            />
          ) : null}
        </TabsContent>
        {section !== "Designer" ? (
          <TabsContent value={section} className="contents">
            <Workflows
              section={section}
              design={design}
              change={change}
              versions={versions}
              simulation={simulation}
              updateVersions={updateVersions}
              updateSimulation={updateSimulation}
              restoreVersion={sandbox.restoreVersion}
              rollbackVersion={sandbox.rollbackVersion}
              deleteVersion={sandbox.deleteVersion}
              restoreDeletedVersion={sandbox.restoreDeletedVersion}
              navigate={navigate}
              notify={setMessage}
              createRequest={createRequest}
              onCreateRequestHandled={finishCreateRequest}
              requestedRuleId={search.get("rule")}
              pending={sandbox.isPending()}
            />
          </TabsContent>
        ) : null}
      </Tabs>
      <footer className="border-border text-muted-foreground flex flex-wrap justify-between gap-2 border-t pt-3 text-xs">
        <span>{counts(design)}</span>
        <span>
          Tab-local draft · {history.past.length} undo steps available
        </span>
      </footer>
    </section>
  );
}
