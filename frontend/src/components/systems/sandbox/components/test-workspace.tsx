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
import { summarizeTestRun } from "../domain/test-run-summary";
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
import type { SandboxAutomation } from "../domain/document";
import type { SandboxTestEvent, SandboxTestRun } from "../state/api";

type Props = {
  design: SandboxDocumentDesign;
  automations: readonly SandboxAutomation[];
  runs: readonly SandboxTestRun[];
  onRun: (input: {
    moduleId: string;
    values: Record<string, SandboxFieldValue>;
    event: SandboxTestEvent;
    automationIds?: string[];
  }) => Promise<void>;
  onClear: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  /** The draft's current revision, to tell results from older drafts. */
  draftRevision: number;
  onShowOnCanvas: (moduleId: string) => void;
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
      field.config.defaultValue,
    ]),
  );
}

export function TestWorkspace({
  design,
  automations,
  runs,
  onRun,
  onClear,
  onPendingChange,
  draftRevision,
  onShowOnCanvas,
}: Props) {
  const initialModule = design.modules.find((item) => !item.closed)?.id ?? "";
  const [moduleId, setModuleId] = useState(initialModule);
  const [values, setValues] = useState<Record<string, SandboxFieldValue>>(() =>
    defaultValues(design, initialModule),
  );
  const [eventKind, setEventKind] =
    useState<SandboxTestEvent["kind"]>("record-created");
  const [fieldId, setFieldId] = useState("");
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("1");
  const [previousValue, setPreviousValue] = useState("");
  const [automationMode, setAutomationMode] = useState<"all" | "selected">(
    "all",
  );
  const [automationIds, setAutomationIds] = useState<string[]>([]);
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
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [focusFieldId, setFocusFieldId] = useState<string | null>(null);
  const selectedRun = runs.find((item) => item.id === selectedRunId) ?? runs[0];
  const selectedSummary = selectedRun
    ? summarizeTestRun(selectedRun, design, automations, draftRevision)
    : null;
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
  const automationModeLabelId = useId();

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
  const moduleAutomations = automations.filter(
    (automation) => automation.trigger.moduleId === moduleId,
  );
  const relevantIds = new Set(
    fields.filter((field) => field.required).map((field) => field.id),
  );
  if (eventKind === "field-changed" || eventKind === "threshold-crossed")
    relevantIds.add(fieldId || eventFields[0]?.id || "");
  function addReference(reference: { moduleId: string; fieldId: string }) {
    if (reference.moduleId === moduleId) relevantIds.add(reference.fieldId);
  }
  for (const automation of moduleAutomations.filter((item) =>
    automationMode === "all" ? item.enabled : automationIds.includes(item.id),
  )) {
    if ("fieldId" in automation.trigger)
      relevantIds.add(automation.trigger.fieldId);
    if (
      automation.trigger.kind === "threshold-crossed" &&
      automation.trigger.value.kind === "field-reference"
    )
      addReference(automation.trigger.value);
    for (const condition of automation.conditionGroup.conditions) {
      addReference(condition.field);
      if (condition.value.kind === "field-reference")
        addReference(condition.value);
    }
    for (const action of automation.actions) {
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
    (field) => !Object.is(values[field.id], field.config.defaultValue),
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
      ...(automationMode === "selected" ? { automationIds } : {}),
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
              <h3 className="font-semibold">Test setup</h3>
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
                    onChange={(event) => {
                      setModuleId(event.target.value);
                      setValues(defaultValues(design, event.target.value));
                      setFieldId("");
                      setAutomationIds([]);
                      setSearch("");
                      setFilter("relevant");
                      setLimit(12);
                    }}
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
                            {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                              <NativeSelectOption key={day} value={String(day)}>
                                Day {day}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </Field>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <fieldset className="grid gap-2">
                  <legend className="text-sm font-medium">Automations</legend>
                  <Field>
                    <FieldLabel htmlFor={automationModeLabelId}>
                      Choose which to run
                    </FieldLabel>
                    <NativeSelect
                      id={automationModeLabelId}
                      value={automationMode}
                      onChange={(event) =>
                        setAutomationMode(
                          event.target.value as "all" | "selected",
                        )
                      }
                    >
                      <NativeSelectOption value="all">
                        All enabled automations
                      </NativeSelectOption>
                      <NativeSelectOption value="selected">
                        Choose automations
                      </NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  {automationMode === "selected"
                    ? moduleAutomations.map((automation) => (
                        <label
                          key={automation.id}
                          htmlFor={`sandbox-test-automation-${automation.id}`}
                          className="flex min-h-11 items-center gap-2 text-sm"
                        >
                          <Checkbox
                            id={`sandbox-test-automation-${automation.id}`}
                            checked={automationIds.includes(automation.id)}
                            onCheckedChange={(checked) =>
                              setAutomationIds(
                                checked
                                  ? [...automationIds, automation.id]
                                  : automationIds.filter(
                                      (id) => id !== automation.id,
                                    ),
                              )
                            }
                          />
                          {automation.name}
                        </label>
                      ))
                    : null}
                </fieldset>
                <fieldset className="grid gap-3">
                  <legend className="text-sm font-medium">
                    Temporary field values
                  </legend>
                  <p className="text-muted-foreground mb-2 text-xs">
                    Relevant: required fields and fields your automations use.
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
                        className="aria-pressed:bg-secondary aria-pressed:text-secondary-foreground h-auto min-h-11 min-w-0 flex-1 px-2 text-xs whitespace-normal"
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
                    return (
                      <Field key={field.id}>
                        <FieldLabel htmlFor={fieldControlId}>
                          {field.name}
                        </FieldLabel>
                        {field.config.kind === "checkbox" ? (
                          <NativeSelect
                            id={fieldControlId}
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
                        ) : field.config.kind === "select" ? (
                          <NativeSelect
                            id={fieldControlId}
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
                              <NativeSelectOption key={option} value={option}>
                                {option}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        ) : (
                          <Input
                            id={fieldControlId}
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
                    ...(previous.automationIds
                      ? { automationIds: previous.automationIds }
                      : {}),
                  })
                }
                onShowOnCanvas={onShowOnCanvas}
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
                  <h3 className="text-sm font-semibold">Recent results</h3>
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
