"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type {
  SandboxDocumentDesign,
  SandboxFieldValue,
  SandboxTrigger,
  SandboxTriggerEvent,
} from "../domain/document";
import {
  defaultTestTrigger,
  summarizeTestRun,
} from "../domain/test-run-summary";
import {
  defaultTestValues,
  matchingTestRun,
  missingTestSetupValues,
  relevantTestFieldIds,
  sameTestEvent,
  testEventDraft,
  testEventOf,
  testInputsChanged,
  testModuleFields,
  type TestEventDraft,
  type TestSetupTarget,
} from "../domain/test-setup";
import type { SandboxTestEvent, SandboxTestRun } from "../state/api";
import { TestEventRows } from "./test-event-rows";
import {
  TEST_OUTCOME_HEADLINE_ID,
  TEST_RESULT_HEADING_ID,
  TestResult,
} from "./test-run-result";
import { TestSetupAdvanced } from "./test-setup-advanced";
import { SetupRow } from "./test-setup-rows";
import { TestValues } from "./test-values";

// Test (docs/specs/sandbox-relayout.md S11): two panes, Setup and Result.
// This component owns the setup, the chosen result, and the pending run;
// the domain rules live in `domain/test-setup.ts`, the rows in
// `test-setup-rows.tsx`, and the result in `test-run-result.tsx`.

type Props = {
  design: SandboxDocumentDesign;
  triggers: readonly SandboxTrigger[];
  runs: readonly SandboxTestRun[];
  /** Sends the run; resolves with the stored run. */
  onRun: (input: {
    moduleId: string;
    values: Record<string, SandboxFieldValue>;
    event: SandboxTestEvent;
    triggerIds?: string[];
  }) => Promise<SandboxTestRun>;
  onClear: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  /** The draft's current revision, to tell results from older drafts. */
  draftRevision: number;
  /** A result to open on, such as the one "Back to result" returns to. */
  initialRunId?: string | null;
  onShowOnCanvas: (run: SandboxTestRun) => void;
};

function savedValuesKey(moduleId: string) {
  return `openslate.sandbox.test-values:${moduleId}`;
}

/** Saved test values for a module, kept only for fields that still exist. */
function readSavedValues(
  design: SandboxDocumentDesign,
  moduleId: string,
): Record<string, SandboxFieldValue> | null {
  try {
    const raw = sessionStorage.getItem(savedValuesKey(moduleId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const defaults = defaultTestValues(design, moduleId);
    for (const [id, value] of Object.entries(parsed)) {
      if (
        id in defaults &&
        (value === null ||
          ["string", "number", "boolean"].includes(typeof value))
      )
        defaults[id] = value as SandboxFieldValue;
    }
    return defaults;
  } catch {
    return null;
  }
}

function valueControlId(fieldId: string) {
  return `sandbox-test-${fieldId}`;
}

export function TestWorkspace({
  design,
  triggers,
  runs,
  onRun,
  onClear,
  onPendingChange,
  draftRevision,
  initialRunId = null,
  onShowOnCanvas,
}: Props) {
  // Returning from the canvas reopens the traced result on its module.
  const initialRun = runs.find((item) => item.id === initialRunId);
  const initialModule =
    initialRun &&
    design.modules.some(
      (item) => item.id === initialRun.input.moduleId && !item.closed,
    )
      ? initialRun.input.moduleId
      : (design.modules.find((item) => !item.closed)?.id ?? "");
  const [moduleId, setModuleId] = useState(initialModule);
  const [values, setValues] = useState<Record<string, SandboxFieldValue>>(
    () =>
      readSavedValues(design, initialModule) ??
      defaultTestValues(design, initialModule),
  );
  // Typed test values last for the browser tab, like the draft they test.
  useEffect(() => {
    if (!moduleId) return;
    try {
      sessionStorage.setItem(savedValuesKey(moduleId), JSON.stringify(values));
    } catch {
      // Storage can be unavailable; the values still work for this page.
    }
  }, [moduleId, values]);
  // Start on the reopened result's event, or else on the event that runs the
  // module's first enabled trigger, so the first test exercises something.
  // Both shapes carry kind, fieldId, and the schedule fields read below.
  const initialTrigger: SandboxTestEvent | SandboxTriggerEvent | null =
    initialRun && initialModule === initialRun.input.moduleId
      ? initialRun.event
      : defaultTestTrigger(triggers, initialModule);
  const [eventDraft, setEventDraft] = useState(() =>
    testEventDraft(initialTrigger),
  );
  const [triggerMode, setTriggerMode] = useState<"all" | "selected">("all");
  const [triggerIds, setTriggerIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const workspaceRef = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  // Phones switch between Setup and Result; a run moves to the result.
  const [phone, setPhone] = useState(false);
  const [phoneView, setPhoneView] = useState<"setup" | "result">(
    initialRun ? "result" : "setup",
  );
  // After a run on a phone, the result heading takes focus once it renders.
  const [focusResult, setFocusResult] = useState(false);
  const [filter, setFilter] = useState<"relevant" | "all" | "edited">(
    "relevant",
  );
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(12);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    initialRun?.id ?? null,
  );
  // The control that takes focus once it renders (an error or a shown input).
  const [focusControlId, setFocusControlId] = useState<string | null>(null);
  // What Run test found missing, by control id, until that control changes.
  const [setupErrors, setSetupErrors] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  // The run made on this page: only its issues mark the setup's fields, and
  // only until the field changes. A loaded result never marks the setup.
  const [ownRunId, setOwnRunId] = useState<string | null>(null);
  const [editedSinceRun, setEditedSinceRun] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const moduleLabelId = useId();
  const changedFieldLabelId = useId();
  const previousValueLabelId = useId();

  const fields = testModuleFields(design, moduleId);
  const moduleTriggers = triggers.filter(
    (recordTrigger) => recordTrigger.trigger.moduleId === moduleId,
  );
  const event = testEventOf(eventDraft, fields);
  const relevantIds = relevantTestFieldIds({
    design,
    triggers,
    moduleId,
    eventFieldId: "fieldId" in event ? event.fieldId : null,
    triggerIds: triggerMode === "all" ? "enabled" : triggerIds,
  });
  const editedFields = fields.filter(
    (field) =>
      !Object.is(
        values[field.id],
        field.config.kind === "user" ? null : field.config.defaultValue,
      ),
  );
  const matchingFields = fields.filter((field) =>
    search.trim()
      ? field.name
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase())
      : filter === "all" ||
        (filter === "relevant"
          ? relevantIds.has(field.id)
          : editedFields.includes(field)),
  );

  // A result shows only for the setup it was run with (S11).
  const shownRun = matchingTestRun(runs, { moduleId, event }, selectedRunId);
  const shownSummary = shownRun
    ? summarizeTestRun(shownRun, design, triggers, draftRevision)
    : null;
  const fieldIssues = new Map(
    shownRun && shownSummary?.stale === null && shownRun.id === ownRunId
      ? shownSummary.issues.flatMap((issue) =>
          issue.subject?.kind === "field" &&
          !editedSinceRun.has(issue.subject.id)
            ? [[issue.subject.id, issue.message] as const]
            : [],
        )
      : [],
  );

  // The shown result goes stale as soon as the setup differs from the inputs
  // it ran with (TST-2), read from the run itself.
  const inputsChanged =
    shownRun !== undefined &&
    testInputsChanged(shownRun, {
      values,
      event,
      triggerIds: triggerMode === "all" ? null : triggerIds,
    });

  function clearSetupError(controlId: string) {
    if (!setupErrors.has(controlId)) return;
    const next = new Map(setupErrors);
    next.delete(controlId);
    setSetupErrors(next);
  }

  function setValue(id: string, value: SandboxFieldValue) {
    setValues({ ...values, [id]: value });
    clearSetupError(valueControlId(id));
    if (!editedSinceRun.has(id))
      setEditedSinceRun(new Set([...editedSinceRun, id]));
  }

  function chooseModule(
    nextModuleId: string,
    trigger: SandboxTestEvent | SandboxTriggerEvent | null,
  ) {
    if (nextModuleId !== moduleId) {
      setModuleId(nextModuleId);
      setValues(
        readSavedValues(design, nextModuleId) ??
          defaultTestValues(design, nextModuleId),
      );
      setTriggerIds([]);
      setSearch("");
      setFilter("relevant");
      setLimit(12);
    }
    setSetupErrors(new Map());
    setEventDraft(testEventDraft(trigger, eventDraft));
  }

  /** A changed When clears every setup error; a setting clears its own. */
  function changeEvent(next: TestEventDraft) {
    if (next.kind !== eventDraft.kind) setSetupErrors(new Map());
    else {
      if (next.fieldId !== eventDraft.fieldId)
        clearSetupError(changedFieldLabelId);
      if (next.previousValue !== eventDraft.previousValue)
        clearSetupError(previousValueLabelId);
    }
    setEventDraft(next);
  }

  /** Shows a field that the filter, search, or limit hides. */
  function revealField(id: string, viaAll: boolean) {
    if (matchingFields.slice(0, limit).some((field) => field.id === id)) return;
    setSearch("");
    if (viaAll) {
      setFilter("all");
      setLimit(Math.max(limit, fields.findIndex((f) => f.id === id) + 1));
      return;
    }
    // Required fields are always relevant.
    setFilter("relevant");
    setLimit(
      Math.max(
        12,
        fields
          .filter((field) => relevantIds.has(field.id))
          .findIndex((field) => field.id === id) + 1,
      ),
    );
  }

  useEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWide(entry.contentRect.width >= 900);
      setPhone(entry.contentRect.width < 640);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!focusResult) return;
    const heading = document.getElementById(TEST_RESULT_HEADING_ID);
    const headline = document.getElementById(TEST_OUTCOME_HEADLINE_ID);
    if (!heading || !headline) return;
    // Show the whole result header, then read the outcome first.
    heading.scrollIntoView({ block: "start" });
    headline.focus({ preventScroll: true });
    setFocusResult(false);
  }, [focusResult, phoneView, shownRun?.id]);
  useEffect(() => {
    if (!focusControlId) return;
    document.getElementById(focusControlId)?.focus();
    setFocusControlId(null);
  }, [focusControlId]);
  useEffect(
    () => onPendingChange?.(pending || clearing),
    [clearing, onPendingChange, pending],
  );
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  useEffect(() => {
    if (
      moduleId &&
      design.modules.some((item) => item.id === moduleId && !item.closed)
    )
      return;
    const next = design.modules.find((item) => !item.closed)?.id ?? "";
    setModuleId(next);
    setValues(defaultTestValues(design, next));
  }, [design, moduleId]);

  function controlIdOf(target: TestSetupTarget) {
    return target.kind === "event-field"
      ? changedFieldLabelId
      : target.kind === "previous-value"
        ? previousValueLabelId
        : valueControlId(target.fieldId);
  }

  async function run() {
    if (!moduleId) {
      setError("Add a module with fields before running a test.");
      return;
    }
    // Missing values show beside their fields; nothing is sent or stored.
    const problems = missingTestSetupValues({
      fields,
      values,
      event,
      previousValue: eventDraft.previousValue,
    });
    setSetupErrors(
      new Map(
        problems.map((problem) => [
          controlIdOf(problem.target),
          problem.message,
        ]),
      ),
    );
    const first = problems[0];
    if (first) {
      if (first.target.kind === "field")
        revealField(first.target.fieldId, false);
      setPhoneView("setup");
      setFocusControlId(controlIdOf(first.target));
      return;
    }
    await submit({
      moduleId,
      values,
      event,
      ...(triggerMode === "selected" ? { triggerIds } : {}),
    });
  }

  async function submit(input: Parameters<Props["onRun"]>[0]) {
    setPending(true);
    setError("");
    try {
      const stored = await onRun(input);
      setSelectedRunId(stored.id);
      setOwnRunId(stored.id);
      setEditedSinceRun(new Set());
      if (phone) {
        setPhoneView("result");
        setFocusResult(true);
      }
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The test could not run. Try again.",
      );
      return false;
    } finally {
      setPending(false);
    }
  }

  async function clear() {
    if (clearing) return;
    setClearing(true);
    setError("");
    try {
      await onClear();
      setSelectedRunId(null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Test results could not be cleared. Try again.",
      );
    } finally {
      setClearing(false);
    }
  }

  /** Opens a recent result, with its module and event in the setup. */
  function openRun(item: SandboxTestRun) {
    setSelectedRunId(item.id);
    if (item.input.moduleId !== moduleId || !sameTestEvent(item.event, event))
      chooseModule(item.input.moduleId, item.event);
  }

  const busy = pending || clearing;

  return (
    <section
      ref={workspaceRef}
      aria-label="Sandbox test"
      className="@container/test flex h-full min-w-0 flex-col gap-4"
    >
      {error ? (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      ) : null}
      {phone ? (
        <ToggleGroup
          aria-label="Test view"
          variant="segmented"
          multiple={false}
          value={[phoneView]}
          onValueChange={(selection) => {
            const next = selection[0];
            if (next === "setup" || next === "result") setPhoneView(next);
          }}
        >
          <ToggleGroupItem value="setup">Setup</ToggleGroupItem>
          <ToggleGroupItem value="result">Result</ToggleGroupItem>
        </ToggleGroup>
      ) : null}
      <div className="bg-card border-border min-w-0 shrink-0 rounded-xl border @min-[900px]/test:h-[calc(100dvh-15rem)] @min-[900px]/test:overflow-clip xl:@min-[900px]/test:h-auto xl:@min-[900px]/test:min-h-0 xl:@min-[900px]/test:flex-1 xl:@min-[900px]/test:shrink">
        <ResizablePanelGroup
          orientation="horizontal"
          disabled={!wide}
          className="block! h-auto! overflow-visible! @min-[900px]/test:flex! @min-[900px]/test:h-full! @min-[900px]/test:overflow-hidden!"
        >
          <ResizablePanel
            id="sandbox-test-setup"
            defaultSize="38%"
            minSize={wide ? "20rem" : 0}
            className={cn(
              "min-w-0 overflow-visible! @min-[900px]/test:h-full @min-[900px]/test:overflow-hidden!",
              phone && phoneView === "result" && "hidden",
            )}
          >
            <section
              aria-label="Test setup"
              data-test-setup
              className="border-border @container/setup flex min-w-0 flex-col border-b @min-[900px]/test:h-full @min-[900px]/test:border-b-0"
            >
              <div className="border-border flex min-h-14 items-center border-b px-4 py-2">
                <h3
                  aria-label="Test setup"
                  data-slot="section-title"
                  className="font-semibold"
                >
                  Setup
                </h3>
              </div>
              <fieldset
                disabled={busy}
                className="flex min-w-0 flex-col @min-[900px]/test:min-h-0 @min-[900px]/test:flex-1"
              >
                {/* A control scrolled into view keeps clear of the Run test
                    bar, which stays over the setup on phones (F12). */}
                <div className="grid min-w-0 content-start gap-5 p-4 @min-[900px]/test:min-h-0 @min-[900px]/test:flex-1 @min-[900px]/test:overflow-y-auto [&_:is(input,select,button)]:scroll-mb-24 [&_[data-slot=native-select-wrapper]]:w-full [&_select]:w-full">
                  <div className="grid gap-3 xl:gap-2">
                    <SetupRow id={moduleLabelId} label="Module">
                      <NativeSelect
                        id={moduleLabelId}
                        value={moduleId}
                        onChange={(change) =>
                          chooseModule(
                            change.target.value,
                            defaultTestTrigger(triggers, change.target.value),
                          )
                        }
                      >
                        {design.modules
                          .filter((item) => !item.closed)
                          .map((item) => (
                            <NativeSelectOption key={item.id} value={item.id}>
                              {item.name}
                            </NativeSelectOption>
                          ))}
                      </NativeSelect>
                    </SetupRow>
                    <TestEventRows
                      draft={eventDraft}
                      fields={fields}
                      changedFieldId={changedFieldLabelId}
                      previousValueId={previousValueLabelId}
                      errors={setupErrors}
                      onChange={changeEvent}
                    />
                  </div>
                  <TestValues
                    fields={fields}
                    shownFields={matchingFields}
                    values={values}
                    relevantCount={
                      fields.filter((field) => relevantIds.has(field.id)).length
                    }
                    editedCount={editedFields.length}
                    filter={filter}
                    search={search}
                    limit={limit}
                    busy={busy}
                    errorFor={(id) =>
                      setupErrors.get(valueControlId(id)) ?? fieldIssues.get(id)
                    }
                    onFilter={setFilter}
                    onSearch={setSearch}
                    onLimit={setLimit}
                    onValue={setValue}
                  />
                  <TestSetupAdvanced
                    design={design}
                    moduleTriggers={moduleTriggers}
                    triggerMode={triggerMode}
                    triggerIds={triggerIds}
                    runs={runs}
                    shownRunId={shownRun?.id}
                    busy={busy}
                    clearing={clearing}
                    onTriggerMode={setTriggerMode}
                    onTriggerIds={setTriggerIds}
                    onOpenRun={openRun}
                    onClear={() => void clear()}
                  />
                </div>
                <div className="bg-card border-border sticky bottom-0 z-10 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] @min-[900px]/test:static">
                  <DisabledReason
                    reason={moduleId ? null : "Add a module first."}
                  >
                    <Button
                      className="min-h-11 w-full"
                      disabled={clearing || !moduleId}
                      pending={pending}
                      pendingLabel="Running…"
                      onClick={() => void run()}
                    >
                      Run test
                    </Button>
                  </DisabledReason>
                </div>
              </fieldset>
            </section>
          </ResizablePanel>
          {wide && (
            <ResizableHandle withHandle aria-label="Resize test setup" />
          )}
          <ResizablePanel
            id="sandbox-test-outcome"
            minSize={wide ? "24rem" : 0}
            className={cn(
              "min-w-0 overflow-visible! @min-[900px]/test:h-full @min-[900px]/test:overflow-hidden!",
              phone && phoneView === "setup" && "hidden",
            )}
          >
            <TestResult
              design={design}
              run={shownRun}
              summary={shownSummary}
              running={pending}
              pending={busy}
              onRunAgain={(previous) =>
                void submit({
                  moduleId: previous.input.moduleId,
                  values: previous.input.values,
                  event: previous.event,
                  ...(previous.triggerIds
                    ? { triggerIds: previous.triggerIds }
                    : {}),
                })
              }
              onShowOnCanvas={onShowOnCanvas}
              triggers={triggers}
              onTryTrigger={(trigger) => {
                chooseModule(trigger.moduleId ?? moduleId, trigger);
                // On a phone the setup it changed is the other tab.
                setPhoneView("setup");
                setFocusControlId(moduleLabelId);
              }}
              inputsChanged={inputsChanged}
              onRunCurrent={() => void run()}
              onShowField={(id) => {
                revealField(id, true);
                setPhoneView("setup");
                setFocusControlId(valueControlId(id));
              }}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </section>
  );
}
