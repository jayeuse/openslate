"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Redo2, Undo2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useSampleState,
  useSampleStorage,
} from "@/components/sample/sample-state";
import type { SandboxCanvasLayout } from "@/components/sandbox/sandbox-canvas";
import {
  appendVersion,
  counts,
  initialDesign,
  initialSandboxHistory,
  uid,
  type Design,
  type DesignUpdate,
  type Version,
} from "./model";
import {
  applySandboxCommand,
  normalizeSandboxHistory,
  redoSandboxCommand,
  undoSandboxCommand,
  type SandboxHistory,
} from "./controller";
import {
  validateSandboxDesign,
  type SandboxValidationIssue,
} from "./validation";
import type { SandboxFileV1 } from "./file-format";
import { canvasFieldId } from "./bridge";
import { Designer } from "./designer";
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

const initialVersions: Version[] = [
  {
    id: "sample-v1",
    label: "Starting structure",
    design: initialDesign,
    published: true,
    date: "Initial sample",
  },
];

const emptySimulation = { records: [], users: [], trace: [], runs: [] };

type StoredSandboxHistory =
  SandboxHistory | { past: Design[]; present: Design; future: Design[] };

type ClearBackup = {
  history: StoredSandboxHistory;
  versions: Version[];
  simulation: unknown;
  viewPreferences: SandboxViewPreferences;
};

export default function SampleSandbox() {
  const search = useSearchParams();
  const router = useRouter();
  const [storedHistory, setStoredHistory] =
    useSampleState<StoredSandboxHistory>(
      "sandbox.design",
      initialSandboxHistory,
    );
  const history = normalizeSandboxHistory(storedHistory, initialDesign);
  const [versions, setVersions] = useSampleState<Version[]>(
    "sandbox.versions",
    initialVersions,
  );
  const [simulation, setSimulation] = useSampleState<unknown>(
    "sandbox.simulation",
    emptySimulation,
  );
  const { resetKeys, storageUnavailable } = useSampleStorage();
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
  const clearingSandbox = useRef(false);
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
      setStoredHistory((stored) => {
        const current = normalizeSandboxHistory(stored, initialDesign);
        return redo ? redoSandboxCommand(current) : undoSandboxCommand(current);
      });
    }
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [setStoredHistory]);

  useEffect(() => {
    if (!clearBackup) return;
    if (clearingSandbox.current) {
      clearingSandbox.current = false;
      return;
    }
    setClearBackup(null);
  }, [clearBackup, simulation, storedHistory, versions]);

  const change = useCallback(
    (update: DesignUpdate) => {
      setClearBackup(null);
      setStoredHistory((stored) => {
        const current = normalizeSandboxHistory(stored, initialDesign);
        const next =
          typeof update === "function" ? update(current.present) : update;
        return applySandboxCommand(current, {
          type: "replace-design",
          design: next,
        });
      });
    },
    [setStoredHistory, setClearBackup],
  );

  const initializeLayout = useCallback(
    (layout: SandboxCanvasLayout) => {
      if (skipNextLayoutInitialization.current) {
        skipNextLayoutInitialization.current = false;
        return;
      }
      setStoredHistory((stored) => {
        const current = normalizeSandboxHistory(stored, initialDesign);
        return JSON.stringify(current.present.layout) === JSON.stringify(layout)
          ? current
          : { ...current, present: { ...current.present, layout } };
      });
    },
    [setStoredHistory],
  );

  function checkpoint(label: string, note: string) {
    setClearBackup(null);
    setVersions((current) =>
      appendVersion(current, {
        id: uid(),
        label,
        design: structuredClone(design),
        published: false,
        date: new Date().toLocaleString(),
        ...(note ? { note } : {}),
      }),
    );
    setMessage("Checkpoint created in this tab.");
  }

  function createLocalRelease(note: string) {
    if (issues.some((issue) => issue.severity === "error")) {
      setMessage("Resolve validation errors before creating a local release.");
      return;
    }
    setClearBackup(null);
    const releaseNumber = versions.filter(
      (version) => version.published,
    ).length;
    setVersions((current) =>
      appendVersion(current, {
        id: uid(),
        label: `Local release ${releaseNumber + 1}`,
        design: structuredClone(design),
        published: true,
        date: new Date().toLocaleString(),
        ...(note ? { note } : {}),
      }),
    );
    setSection("Versions");
    setMessage("Local release created. No live workspace was changed.");
  }

  function importFile(file: SandboxFileV1) {
    setClearBackup(null);
    const beforeImport: Version = {
      id: uid(),
      label: "Before import",
      design: structuredClone(design),
      published: false,
      date: new Date().toLocaleString(),
      note: "Automatic recovery checkpoint",
    };
    setVersions((current) =>
      appendVersion(file.versions ?? current, beforeImport),
    );
    setStoredHistory((stored) =>
      applySandboxCommand(normalizeSandboxHistory(stored, initialDesign), {
        type: "replace-design",
        design: file.design,
      }),
    );
    setSection("Designer");
    setMessage(
      "Sandbox replaced from JSON. A recovery checkpoint was created.",
    );
  }

  function selectIssue(issue: SandboxValidationIssue) {
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

  function resetDesign() {
    setClearBackup(null);
    setStoredHistory((stored) =>
      applySandboxCommand(normalizeSandboxHistory(stored, initialDesign), {
        type: "replace-design",
        design: structuredClone(initialDesign),
      }),
    );
    setCreateRequest(null);
    setSection("Designer");
    setMessage(
      "Current Design reset to the initial sample. Undo restores it; Versions, Simulation data, and view preferences were preserved.",
    );
    router.replace("/sandbox");
  }

  function clearSandboxData() {
    clearingSandbox.current = true;
    setClearBackup({
      history: structuredClone(storedHistory),
      versions: structuredClone(versions),
      simulation: structuredClone(simulation),
      viewPreferences: loadSandboxViewPreferences(),
    });
    resetKeys(["sandbox.design", "sandbox.versions", "sandbox.simulation"]);
    clearSandboxViewPreferences();
    skipNextLayoutInitialization.current = true;
    setCreateRequest(null);
    setSandboxGeneration((current) => current + 1);
    setSection("Designer");
    setMessage(
      "Sandbox data cleared in this tab. Defaults are loaded; recovery remains available until reload.",
    );
    router.replace("/sandbox");
  }

  function undoClear(): void {
    if (!clearBackup) return;
    setStoredHistory(structuredClone(clearBackup.history));
    setVersions(structuredClone(clearBackup.versions));
    setSimulation(structuredClone(clearBackup.simulation));
    saveSandboxViewPreferences(clearBackup.viewPreferences);
    skipNextLayoutInitialization.current = true;
    setSandboxGeneration((current) => current + 1);
    setCreateRequest(null);
    setSection("Designer");
    setClearBackup(null);
    setMessage("");
    router.replace("/sandbox");
  }

  return (
    <section
      data-sandbox-page
      className={`space-y-5 ${section === "Designer" ? "xl:flex xl:h-[calc(100dvh-7rem)] xl:min-h-[640px] xl:flex-col xl:gap-5 xl:space-y-0" : ""}`}
    >
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
            disabled={!history.past.length}
            onClick={() =>
              setStoredHistory((stored) =>
                undoSandboxCommand(
                  normalizeSandboxHistory(stored, initialDesign),
                ),
              )
            }
          >
            <Undo2 data-icon="inline-start" />
            Undo
          </Button>
          <Button
            variant="outline"
            aria-label="Redo"
            disabled={!history.future.length}
            onClick={() =>
              setStoredHistory((stored) =>
                redoSandboxCommand(
                  normalizeSandboxHistory(stored, initialDesign),
                ),
              )
            }
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
        />
      </header>
      <Tabs
        value={section}
        onValueChange={(value) => setSection(String(value))}
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
              <Button variant="outline" size="sm" onClick={undoClear}>
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
              setVersions={setVersions}
              navigate={setSection}
              notify={setMessage}
              createRequest={createRequest}
              onCreateRequestHandled={finishCreateRequest}
              requestedRuleId={search.get("rule")}
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
