"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TestComparison, TestOutcome } from "./test-run-result";
import { weekdayOptions } from "./trigger-flow";
import {
  defaultTestTrigger,
  summarizeTestRun,
} from "../domain/test-run-summary";
import type { SandboxTriggerEvent } from "../domain/document";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import type {
  SandboxDocumentDesign,
  SandboxFieldValue,
} from "../domain/document";
import type { SandboxTrigger } from "../domain/document";
import type { SandboxTestEvent, SandboxTestRun } from "../state/api";

type Props = {
  design: SandboxDocumentDesign;
  triggers: readonly SandboxTrigger[];
  runs: readonly SandboxTestRun[];
  onRun: (input: {
    moduleId: string;
    values: Record<string, SandboxFieldValue>;
    event: SandboxTestEvent;
    triggerIds?: string[];
  }) => Promise<void>;
  onClear: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  /** The draft's current revision, to tell results from older drafts. */
  draftRevision: number;
  /** A result to open on, such as the one "Back to result" returns to. */
  initialRunId?: string | null;
  onShowOnCanvas: (run: SandboxTestRun) => void;
};

function moduleFields(design: SandboxDocumentDesign, moduleId: string) {
  return (
    design.modules
      .find((item) => item.id === moduleId)
      ?.fields.filter((field) => !field.closed) ?? []
  );
}

function defaultValues(
  design: SandboxDocumentDesign,
  moduleId: string,
): Record<string, SandboxFieldValue> {
  return Object.fromEntries(
    moduleFields(design, moduleId).map((field) => [
      field.id,
      field.config.kind === "user" ? null : field.config.defaultValue,
    ]),
  );
}

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
    const defaults = defaultValues(design, moduleId);
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
      defaultValues(design, initialModule),
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
  const [eventKind, setEventKind] = useState<SandboxTestEvent["kind"]>(
    initialTrigger?.kind ?? "record-created",
  );
  const [fieldId, setFieldId] = useState(
    initialTrigger && "fieldId" in initialTrigger ? initialTrigger.fieldId : "",
  );
  const [frequency, setFrequency] = useState<"daily" | "weekly">(
    initialTrigger?.kind === "schedule" ? initialTrigger.frequency : "daily",
  );
  const [time, setTime] = useState(
    initialTrigger?.kind === "schedule" ? initialTrigger.time : "09:00",
  );
  const [weekday, setWeekday] = useState(
    initialTrigger?.kind === "schedule" && initialTrigger.weekday
      ? String(initialTrigger.weekday)
      : "1",
  );
  const [previousValue, setPreviousValue] = useState("");
  const [triggerMode, setTriggerMode] = useState<"all" | "selected">("all");
  const [triggerIds, setTriggerIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const workspaceRef = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  const [filter, setFilter] = useState<"relevant" | "all" | "edited">(
    "relevant",
  );
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(12);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    initialRun?.id ?? null,
  );
  const [focusFieldId, setFocusFieldId] = useState<string | null>(null);
  const selectedRun = runs.find((item) => item.id === selectedRunId) ?? runs[0];
  const selectedSummary = selectedRun
    ? summarizeTestRun(selectedRun, design, triggers, draftRevision)
    : null;
  // Issues from the shown result, on the inputs they are about, while the
  // setup shows that result's module and the result is current.
  const fieldIssues = new Map(
    selectedRun &&
      selectedSummary &&
      selectedSummary.stale === null &&
      selectedRun.input.moduleId === moduleId
      ? selectedSummary.issues.flatMap((issue) =>
          issue.subject?.kind === "field"
            ? [[issue.subject.id, issue.message] as const]
            : [],
        )
      : [],
  );

  function chooseModule(
    nextModuleId: string,
    trigger: SandboxTriggerEvent | null,
  ) {
    if (nextModuleId !== moduleId) {
      setModuleId(nextModuleId);
      setValues(
        readSavedValues(design, nextModuleId) ??
          defaultValues(design, nextModuleId),
      );
      setTriggerIds([]);
      setSearch("");
      setFilter("relevant");
      setLimit(12);
    }
    setEventKind(trigger?.kind ?? "record-created");
    setFieldId(trigger && "fieldId" in trigger ? trigger.fieldId : "");
    setPreviousValue("");
    if (trigger?.kind === "schedule") {
      setFrequency(trigger.frequency);
      setTime(trigger.time);
      if (trigger.weekday) setWeekday(String(trigger.weekday));
    }
  }
  useEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWide(entry.contentRect.width >= 1100),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!focusFieldId) return;
    document.getElementById(`sandbox-test-${focusFieldId}`)?.focus();
    setFocusFieldId(null);
  }, [focusFieldId]);
  const moduleLabelId = useId();
  const eventLabelId = useId();
  const changedFieldLabelId = useId();
  const previousValueLabelId = useId();
  const frequencyLabelId = useId();
  const timeLabelId = useId();
  const weekdayLabelId = useId();
  const triggerModeLabelId = useId();

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
    setValues(defaultValues(design, next));
  }, [design, moduleId]);

  const fields = moduleFields(design, moduleId);
  const numericFields = fields.filter(
    (field) =>
      field.config.kind === "number" || field.config.kind === "integer",
  );
  const eventFields =
    eventKind === "threshold-crossed" ? numericFields : fields;
  const moduleTriggers = triggers.filter(
    (recordTrigger) => recordTrigger.trigger.moduleId === moduleId,
  );
  const relevantIds = new Set(
    fields.filter((field) => field.required).map((field) => field.id),
  );
  if (eventKind === "field-changed" || eventKind === "threshold-crossed")
    relevantIds.add(fieldId || eventFields[0]?.id || "");
  function addReference(reference: { moduleId: string; fieldId: string }) {
    if (reference.moduleId === moduleId) relevantIds.add(reference.fieldId);
  }
  for (const recordTrigger of moduleTriggers.filter((item) =>
    triggerMode === "all" ? item.enabled : triggerIds.includes(item.id),
  )) {
    if ("fieldId" in recordTrigger.trigger)
      relevantIds.add(recordTrigger.trigger.fieldId);
    if (
      recordTrigger.trigger.kind === "threshold-crossed" &&
      recordTrigger.trigger.value.kind === "field-reference"
    )
      addReference(recordTrigger.trigger.value);
    for (const condition of recordTrigger.conditionGroup.conditions) {
      addReference(condition.field);
      if (condition.value.kind === "field-reference")
        addReference(condition.value);
    }
    for (const action of recordTrigger.actions) {
      if (action.kind === "set-field") {
        addReference(action.target);
        if (action.value.kind === "field-reference") addReference(action.value);
      }
      if (action.kind === "create-record")
        for (const value of action.values) {
          if (value.value.kind === "field-reference") addReference(value.value);
        }
    }
  }
  for (const relationship of design.relationships) {
    if (relationship.sourceModuleId === moduleId)
      for (const mapping of relationship.fieldMappings)
        relevantIds.add(mapping.sourceFieldId);
  }
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
  const event: SandboxTestEvent =
    eventKind === "record-created"
      ? { kind: eventKind }
      : eventKind === "schedule"
        ? {
            kind: eventKind,
            frequency,
            time,
            ...(frequency === "weekly" ? { weekday: Number(weekday) } : {}),
          }
        : eventKind === "field-changed"
          ? { kind: eventKind, fieldId: fieldId || fields[0]?.id || "" }
          : {
              kind: eventKind,
              fieldId: fieldId || numericFields[0]?.id || "",
              previousValue: Number(previousValue),
            };

  async function run() {
    if (!moduleId) {
      setError("Add a module with fields before running a test.");
      return;
    }
    if (
      (event.kind === "field-changed" || event.kind === "threshold-crossed") &&
      !event.fieldId
    ) {
      setError(
        event.kind === "threshold-crossed"
          ? "Add a number field before testing a threshold."
          : "Choose the field that changes.",
      );
      return;
    }
    if (
      event.kind === "threshold-crossed" &&
      (previousValue.trim() === "" || !Number.isFinite(Number(previousValue)))
    ) {
      setError("Enter the previous number before running this test.");
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
      await onRun(input);
      setSelectedRunId(null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The test could not run. Try again.",
      );
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

  return (
    <section
      ref={workspaceRef}
      aria-label="Sandbox test"
      className="@container/test grid min-w-0 gap-5"
    >
      {error ? (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      ) : null}
      <div className="border-border min-w-0 overflow-hidden rounded-xl border @min-[1100px]/test:h-[calc(100dvh-15rem)]">
        <ResizablePanelGroup
          orientation="horizontal"
          disabled={!wide}
          className="block! h-auto! @min-[1100px]/test:flex! @min-[1100px]/test:h-full!"
        >
          <ResizablePanel
            defaultSize="18%"
            minSize={wide ? "20rem" : 0}
            className="min-w-0 overflow-visible! @min-[1100px]/test:h-full @min-[1100px]/test:overflow-hidden!"
          >
            <section
              aria-label="Test setup"
              className="bg-card border-border border-b p-4 @min-[1100px]/test:h-full @min-[1100px]/test:overflow-y-auto @min-[1100px]/test:border-b-0"
            >
              <h3 data-slot="section-title" className="font-semibold">
                Test setup
              </h3>
              <p className="text-muted-foreground mt-2 mb-5 text-sm">
                Choose what happens, then set the values to try.
              </p>
              <fieldset
                disabled={pending || clearing}
                className="grid min-w-0 gap-5 [&_[data-slot=native-select-wrapper]]:w-full [&_select]:w-full"
              >
                <Field>
                  <FieldLabel htmlFor={moduleLabelId}>Module</FieldLabel>
                  <NativeSelect
                    id={moduleLabelId}
                    value={moduleId}
                    onChange={(event) =>
                      chooseModule(
                        event.target.value,
                        defaultTestTrigger(triggers, event.target.value),
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
                </Field>
                <div className="grid gap-3">
                  <Field>
                    <FieldLabel htmlFor={eventLabelId}>When</FieldLabel>
                    <NativeSelect
                      id={eventLabelId}
                      value={eventKind}
                      onChange={(event) => {
                        setEventKind(
                          event.target.value as SandboxTestEvent["kind"],
                        );
                        setFieldId("");
                        setPreviousValue("");
                      }}
                    >
                      <NativeSelectOption value="record-created">
                        An item is added
                      </NativeSelectOption>
                      <NativeSelectOption value="field-changed">
                        A field changes
                      </NativeSelectOption>
                      <NativeSelectOption value="threshold-crossed">
                        A number crosses a threshold
                      </NativeSelectOption>
                      <NativeSelectOption value="schedule">
                        A schedule runs
                      </NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  {eventKind === "field-changed" ||
                  eventKind === "threshold-crossed" ? (
                    <Field>
                      <FieldLabel htmlFor={changedFieldLabelId}>
                        Changed field
                      </FieldLabel>
                      <NativeSelect
                        id={changedFieldLabelId}
                        value={fieldId || eventFields[0]?.id || ""}
                        onChange={(event) => setFieldId(event.target.value)}
                      >
                        {eventFields.map((field) => (
                          <NativeSelectOption key={field.id} value={field.id}>
                            {field.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                  ) : null}
                  {eventKind === "threshold-crossed" ? (
                    <Field>
                      <FieldLabel htmlFor={previousValueLabelId}>
                        Previous value
                      </FieldLabel>
                      <Input
                        id={previousValueLabelId}
                        type="number"
                        value={previousValue}
                        onChange={(event) =>
                          setPreviousValue(event.target.value)
                        }
                      />
                    </Field>
                  ) : null}
                  {eventKind === "schedule" ? (
                    <>
                      <Field>
                        <FieldLabel htmlFor={frequencyLabelId}>
                          Frequency
                        </FieldLabel>
                        <NativeSelect
                          id={frequencyLabelId}
                          value={frequency}
                          onChange={(event) =>
                            setFrequency(
                              event.target.value as "daily" | "weekly",
                            )
                          }
                        >
                          <NativeSelectOption value="daily">
                            Daily
                          </NativeSelectOption>
                          <NativeSelectOption value="weekly">
                            Weekly
                          </NativeSelectOption>
                        </NativeSelect>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={timeLabelId}>Time</FieldLabel>
                        <Input
                          id={timeLabelId}
                          type="time"
                          value={time}
                          onChange={(event) => setTime(event.target.value)}
                        />
                      </Field>
                      {frequency === "weekly" ? (
                        <Field>
                          <FieldLabel htmlFor={weekdayLabelId}>Day</FieldLabel>
                          <NativeSelect
                            id={weekdayLabelId}
                            value={weekday}
                            onChange={(event) => setWeekday(event.target.value)}
                          >
                            {weekdayOptions.map((day) => (
                              <NativeSelectOption
                                key={day.value}
                                value={day.value}
                              >
                                {day.label}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </Field>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <fieldset className="grid gap-2">
                  <legend className="text-sm font-medium">Triggers</legend>
                  <Field>
                    <FieldLabel htmlFor={triggerModeLabelId}>
                      Choose which to run
                    </FieldLabel>
                    <NativeSelect
                      id={triggerModeLabelId}
                      value={triggerMode}
                      onChange={(event) =>
                        setTriggerMode(event.target.value as "all" | "selected")
                      }
                    >
                      <NativeSelectOption value="all">
                        All enabled triggers
                      </NativeSelectOption>
                      <NativeSelectOption value="selected">
                        Choose triggers
                      </NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  {triggerMode === "selected"
                    ? moduleTriggers.map((recordTrigger) => (
                        <label
                          key={recordTrigger.id}
                          htmlFor={`sandbox-test-trigger-${recordTrigger.id}`}
                          className="flex min-h-11 items-center gap-2 text-sm"
                        >
                          <Checkbox
                            id={`sandbox-test-trigger-${recordTrigger.id}`}
                            checked={triggerIds.includes(recordTrigger.id)}
                            onCheckedChange={(checked) =>
                              setTriggerIds(
                                checked
                                  ? [...triggerIds, recordTrigger.id]
                                  : triggerIds.filter(
                                      (id) => id !== recordTrigger.id,
                                    ),
                              )
                            }
                          />
                          {recordTrigger.name}
                        </label>
                      ))
                    : null}
                </fieldset>
                <fieldset className="grid gap-3">
                  <legend className="text-sm font-medium">
                    Temporary field values
                  </legend>
                  <p className="text-muted-foreground mb-2 text-xs">
                    Relevant: required fields and fields your triggers use.
                    Hidden fields keep their values.
                  </p>
                  <SearchField
                    label="Find a field"
                    placeholder="Find a field…"
                    value={search}
                    onValueChange={(value) => {
                      setSearch(value);
                      setLimit(12);
                    }}
                    className="w-full"
                  />
                  <ToggleGroup
                    aria-label="Input fields"
                    multiple={false}
                    disabled={pending || clearing}
                    value={[filter]}
                    onValueChange={(selection) => {
                      const selected = selection[0];
                      if (
                        selected === "relevant" ||
                        selected === "all" ||
                        selected === "edited"
                      ) {
                        setFilter(selected);
                      }
                      setSearch("");
                      setLimit(12);
                    }}
                    className="bg-muted flex w-full flex-wrap gap-1 rounded-lg p-1"
                  >
                    {(["relevant", "all", "edited"] as const).map((item) => (
                      <ToggleGroupItem
                        key={item}
                        value={item}
                        aria-label={
                          item === "all"
                            ? "All input fields"
                            : item === "edited"
                              ? "Edited fields"
                              : "Relevant fields"
                        }
                        className="aria-pressed:text-action-text h-auto min-h-11 min-w-0 flex-1 px-2 text-xs whitespace-normal aria-pressed:bg-[var(--surface-raised)] aria-pressed:font-semibold aria-pressed:shadow-[var(--lift),inset_0_0_0_1px_var(--rule)]"
                      >
                        {item === "relevant"
                          ? "Relevant"
                          : item === "all"
                            ? "All"
                            : "Edited"}{" "}
                        (
                        {item === "all"
                          ? fields.length
                          : item === "edited"
                            ? editedFields.length
                            : fields.filter((field) =>
                                relevantIds.has(field.id),
                              ).length}
                        )
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  {matchingFields.length === 0 && (
                    <p className="text-muted-foreground text-sm">
                      {search
                        ? "No fields match your search."
                        : filter === "edited"
                          ? "No inputs have been edited."
                          : "No fields are required for this selection. Use All to enter other values."}
                    </p>
                  )}
                  {matchingFields.slice(0, limit).map((field) => {
                    const fieldControlId = `sandbox-test-${field.id}`;
                    const value = values[field.id] ?? null;
                    const issue = fieldIssues.get(field.id);
                    const issueProps = issue
                      ? {
                          "aria-invalid": true as const,
                          "aria-describedby": `${fieldControlId}-issue`,
                        }
                      : {};
                    const userHelpId = `${fieldControlId}-simulation-help`;
                    return (
                      <Field key={field.id}>
                        <FieldLabel htmlFor={fieldControlId}>
                          {field.name}
                        </FieldLabel>
                        {field.config.kind === "checkbox" ? (
                          <NativeSelect
                            id={fieldControlId}
                            {...issueProps}
                            value={String(value === true)}
                            onChange={(event) =>
                              setValues({
                                ...values,
                                [field.id]: event.target.value === "true",
                              })
                            }
                          >
                            <NativeSelectOption value="true">
                              Yes
                            </NativeSelectOption>
                            <NativeSelectOption value="false">
                              No
                            </NativeSelectOption>
                          </NativeSelect>
                        ) : field.config.kind === "user" ? (
                          <>
                            <Input
                              id={fieldControlId}
                              placeholder="Enter a simulated user UUID"
                              aria-invalid={issue ? true : undefined}
                              aria-describedby={
                                issue
                                  ? `${userHelpId} ${fieldControlId}-issue`
                                  : userHelpId
                              }
                              value={typeof value === "string" ? value : ""}
                              onChange={(event) =>
                                setValues({
                                  ...values,
                                  [field.id]: event.target.value || null,
                                })
                              }
                            />
                            <p
                              id={userHelpId}
                              className="text-muted-foreground text-xs"
                            >
                              Test values are simulated UUIDs. Sandbox does not
                              check live user eligibility.
                            </p>
                          </>
                        ) : field.config.kind === "select" ? (
                          <NativeSelect
                            id={fieldControlId}
                            {...issueProps}
                            value={typeof value === "string" ? value : ""}
                            onChange={(event) =>
                              setValues({
                                ...values,
                                [field.id]: event.target.value || null,
                              })
                            }
                          >
                            <NativeSelectOption value="">
                              Choose a value
                            </NativeSelectOption>
                            {field.config.options.map((option) => (
                              <NativeSelectOption
                                key={option.id}
                                value={option.id}
                              >
                                {option.label}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        ) : (
                          <Input
                            id={fieldControlId}
                            {...issueProps}
                            type={
                              field.config.kind === "number" ||
                              field.config.kind === "integer"
                                ? "number"
                                : field.config.kind === "date"
                                  ? "date"
                                  : field.config.kind === "datetime"
                                    ? "datetime-local"
                                    : "text"
                            }
                            value={value === null ? "" : String(value)}
                            onChange={(event) =>
                              setValues({
                                ...values,
                                [field.id]:
                                  field.config.kind === "number" ||
                                  field.config.kind === "integer"
                                    ? event.target.value === ""
                                      ? null
                                      : Number(event.target.value)
                                    : event.target.value,
                              })
                            }
                          />
                        )}
                        {issue ? (
                          <p
                            id={`${fieldControlId}-issue`}
                            className="text-destructive text-xs"
                          >
                            Last test: {issue}
                          </p>
                        ) : null}
                      </Field>
                    );
                  })}
                  {matchingFields.length > limit && (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      onClick={() => setLimit(limit + 12)}
                    >
                      Show more fields
                    </Button>
                  )}
                  <p className="text-muted-foreground text-xs">
                    Showing {Math.min(limit, matchingFields.length)} of{" "}
                    {matchingFields.length} matching fields · {fields.length}{" "}
                    total
                  </p>
                </fieldset>
                <Button
                  className="min-h-11"
                  disabled={pending || clearing || !moduleId}
                  onClick={() => void run()}
                >
                  Run test
                </Button>
              </fieldset>
            </section>
          </ResizablePanel>
          {wide && (
            <ResizableHandle withHandle aria-label="Resize test setup" />
          )}
          <ResizablePanel
            minSize={wide ? "18rem" : 0}
            className="min-w-0 overflow-visible! @min-[1100px]/test:h-full @min-[1100px]/test:overflow-hidden!"
          >
            <div className="border-border min-w-0 border-b p-5 @min-[1100px]/test:h-full @min-[1100px]/test:overflow-y-auto @min-[1100px]/test:border-b-0">
              <TestOutcome
                design={design}
                run={selectedRun}
                summary={selectedSummary}
                pending={pending || clearing}
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
                  document.getElementById(moduleLabelId)?.focus();
                }}
                currentModuleId={moduleId}
                onShowField={(id) => {
                  setSearch(
                    fields.find((field) => field.id === id)?.name ?? "",
                  );
                  setFilter("all");
                  setLimit(fields.length);
                  setFocusFieldId(id);
                }}
              />
              <section
                aria-label="Recent test results"
                className="border-border mt-6 border-t pt-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3
                    data-slot="section-title"
                    className="text-sm font-semibold"
                  >
                    Recent results
                  </h3>
                  {runs.length > 0 && (
                    <Button
                      variant="ghost"
                      className="min-h-11"
                      disabled={pending || clearing}
                      onClick={() => void clear()}
                    >
                      {clearing ? "Clearing results…" : "Clear results"}
                    </Button>
                  )}
                </div>
                {runs.length ? (
                  <div className="mt-3 grid max-h-64 gap-2 overflow-y-auto">
                    {runs.map((item, index) => (
                      <Button
                        key={item.id}
                        aria-label={`View test ${index + 1}`}
                        aria-pressed={selectedRun?.id === item.id}
                        variant={
                          selectedRun?.id === item.id ? "secondary" : "ghost"
                        }
                        className="h-auto min-h-11 justify-start px-3 py-2 text-left whitespace-normal"
                        onClick={() => setSelectedRunId(item.id)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate">
                            {design.modules.find(
                              (entry) => entry.id === item.input.moduleId,
                            )?.name ?? "Unavailable module"}
                          </span>
                          <span className="text-muted-foreground block text-xs">
                            {new Date(item.createdAt).toLocaleString()} ·{" "}
                            {item.result.issues.length
                              ? "Needs attention"
                              : "Test complete"}
                          </span>
                        </span>
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground mt-3 text-sm">
                    No saved test results yet.
                  </p>
                )}
              </section>
            </div>
          </ResizablePanel>
          {wide && (
            <ResizableHandle withHandle aria-label="Resize field comparison" />
          )}
          <ResizablePanel
            defaultSize="26%"
            minSize={wide ? "18rem" : 0}
            className="min-w-0 overflow-visible! @min-[1100px]/test:h-full @min-[1100px]/test:overflow-hidden!"
          >
            <div className="bg-card min-w-0 p-4 @min-[1100px]/test:h-full @min-[1100px]/test:overflow-y-auto">
              <TestComparison
                key={selectedRun?.id ?? "empty"}
                design={design}
                run={selectedRun}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </section>
  );
}
