import type { SandboxTestEvent, SandboxTestRun } from "../state/api";
import type {
  SandboxDocumentDesign,
  SandboxDocumentField,
  SandboxFieldValue,
  SandboxTrigger,
  SandboxTriggerEvent,
} from "./document";

// The Test setup rules (docs/specs/sandbox-relayout.md S11): which stored
// result belongs to the current setup, which values a run needs before it is
// sent, and which inputs are relevant to the module's triggers.

/** The open fields of a module, in their order. */
export function testModuleFields(
  design: SandboxDocumentDesign,
  moduleId: string,
): SandboxDocumentField[] {
  return (
    design.modules
      .find((item) => item.id === moduleId)
      ?.fields.filter((field) => !field.closed) ?? []
  );
}

/** Each open field's default, the value a new test starts from. */
export function defaultTestValues(
  design: SandboxDocumentDesign,
  moduleId: string,
): Record<string, SandboxFieldValue> {
  return Object.fromEntries(
    testModuleFields(design, moduleId).map((field) => [
      field.id,
      field.config.kind === "user" ? null : field.config.defaultValue,
    ]),
  );
}

/** The event part of the setup as its controls hold it. */
export type TestEventDraft = {
  kind: SandboxTestEvent["kind"];
  /** The watched field; empty means the first that fits. */
  fieldId: string;
  frequency: "daily" | "weekly";
  time: string;
  /** 1 (Monday) to 7, as text. */
  weekday: string;
  /** The Previous value input as typed. */
  previousValue: string;
};

const blankEventDraft: TestEventDraft = {
  kind: "record-created",
  fieldId: "",
  frequency: "daily",
  time: "09:00",
  weekday: "1",
  previousValue: "",
};

/**
 * The setup for a trigger's event or a stored run's event. The schedule
 * settings of the previous draft stay unless the new event is a schedule.
 */
export function testEventDraft(
  source: SandboxTestEvent | SandboxTriggerEvent | null,
  previous: TestEventDraft = blankEventDraft,
): TestEventDraft {
  return {
    ...previous,
    kind: source?.kind ?? "record-created",
    fieldId: source && "fieldId" in source ? source.fieldId : "",
    previousValue:
      source?.kind === "threshold-crossed" && "previousValue" in source
        ? String(source.previousValue)
        : "",
    ...(source?.kind === "schedule"
      ? {
          frequency: source.frequency,
          time: source.time,
          weekday: source.weekday ? String(source.weekday) : previous.weekday,
        }
      : {}),
  };
}

/** The event Run test sends; an empty field means the first that fits. */
export function testEventOf(
  draft: TestEventDraft,
  fields: readonly SandboxDocumentField[],
): SandboxTestEvent {
  if (draft.kind === "record-created") return { kind: draft.kind };
  if (draft.kind === "schedule")
    return {
      kind: draft.kind,
      frequency: draft.frequency,
      time: draft.time,
      ...(draft.frequency === "weekly"
        ? { weekday: Number(draft.weekday) }
        : {}),
    };
  if (draft.kind === "field-changed")
    return { kind: draft.kind, fieldId: draft.fieldId || fields[0]?.id || "" };
  return {
    kind: draft.kind,
    fieldId:
      draft.fieldId ||
      fields.find(
        (field) =>
          field.config.kind === "number" || field.config.kind === "integer",
      )?.id ||
      "",
    previousValue: Number(draft.previousValue),
  };
}

/**
 * Whether two events ask the same question: the same kind and, for a field
 * event, the same field. The previous value and the schedule are settings of
 * that question, so a change to them reads as changed inputs, not as a
 * different test.
 */
export function sameTestEvent(a: SandboxTestEvent, b: SandboxTestEvent) {
  if (a.kind !== b.kind) return false;
  if (
    (a.kind === "field-changed" || a.kind === "threshold-crossed") &&
    (b.kind === "field-changed" || b.kind === "threshold-crossed")
  )
    return a.fieldId === b.fieldId;
  return true;
}

/**
 * The result the Test page shows: the chosen run when it was made with the
 * current module and event, else the newest run that was. Runs come newest
 * first. A run for another module or event is never shown (F3).
 */
export function matchingTestRun(
  runs: readonly SandboxTestRun[],
  setup: { moduleId: string; event: SandboxTestEvent },
  selectedRunId: string | null,
): SandboxTestRun | undefined {
  const matches = (run: SandboxTestRun) =>
    run.input.moduleId === setup.moduleId &&
    sameTestEvent(run.event, setup.event);
  const selected = runs.find((run) => run.id === selectedRunId);
  return selected && matches(selected) ? selected : runs.find(matches);
}

/** The event settings a run used, in one comparable shape. */
function eventKey(event: SandboxTestEvent): string {
  if (event.kind === "record-created") return event.kind;
  if (event.kind === "schedule")
    return JSON.stringify([
      event.kind,
      event.frequency,
      event.time,
      // A daily schedule has no day; the server may send null for it.
      event.frequency === "weekly" ? (event.weekday ?? null) : null,
    ]);
  if (event.kind === "field-changed")
    return JSON.stringify([event.kind, event.fieldId]);
  return JSON.stringify([event.kind, event.fieldId, event.previousValue]);
}

/**
 * Whether the setup differs from the inputs the shown run used: a value,
 * any event setting (previous value, schedule), or the triggers to run. It
 * reads the run itself, so asking another question and coming back keeps
 * the answer. A field that exists on only one side was added or removed in
 * the draft, which the "Draft changed" cue covers.
 */
export function testInputsChanged(
  run: SandboxTestRun,
  setup: {
    values: Readonly<Record<string, SandboxFieldValue>>;
    event: SandboxTestEvent;
    /** Null runs every enabled trigger. */
    triggerIds: readonly string[] | null;
  },
): boolean {
  for (const [id, value] of Object.entries(run.input.values))
    if (id in setup.values && !Object.is(value, setup.values[id])) return true;
  if (eventKey(run.event) !== eventKey(setup.event)) return true;
  const ranIds = run.triggerIds ? [...run.triggerIds].sort() : null;
  const setupIds = setup.triggerIds ? [...setup.triggerIds].sort() : null;
  return JSON.stringify(ranIds) !== JSON.stringify(setupIds);
}

export type TestSetupTarget =
  | { kind: "event-field" }
  | { kind: "previous-value" }
  | { kind: "field"; fieldId: string };

export type TestSetupProblem = { target: TestSetupTarget; message: string };

export const REQUIRED_TEST_VALUE_MESSAGE =
  "Enter a value for this required field.";

/**
 * What Run test needs before it sends a run, in the order the setup shows
 * them: the field the event watches, its previous number, then each required
 * field with no value. False and 0 are values; null and blank text are not.
 */
export function missingTestSetupValues({
  fields,
  values,
  event,
  previousValue,
}: {
  fields: readonly SandboxDocumentField[];
  values: Readonly<Record<string, SandboxFieldValue>>;
  event: SandboxTestEvent;
  /** The Previous value input as typed. */
  previousValue: string;
}): TestSetupProblem[] {
  const problems: TestSetupProblem[] = [];
  if (
    (event.kind === "field-changed" || event.kind === "threshold-crossed") &&
    !event.fieldId
  )
    problems.push({
      target: { kind: "event-field" },
      message:
        event.kind === "threshold-crossed"
          ? "Add a number field before testing a threshold."
          : "Add a field before testing a field change.",
    });
  if (
    event.kind === "threshold-crossed" &&
    (previousValue.trim() === "" || !Number.isFinite(Number(previousValue)))
  )
    problems.push({
      target: { kind: "previous-value" },
      message: "Enter the previous number.",
    });
  for (const field of fields) {
    const value = values[field.id];
    // The server refuses text made only of spaces as well as no value.
    if (
      field.required &&
      (typeof value === "string" ? value.trim() === "" : value == null)
    )
      problems.push({
        target: { kind: "field", fieldId: field.id },
        message: REQUIRED_TEST_VALUE_MESSAGE,
      });
  }
  return problems;
}

/**
 * The inputs a test is about: required fields, the field the event watches,
 * and every field of this module that the triggers to run or the module's
 * relationship mappings read or write.
 */
export function relevantTestFieldIds({
  design,
  triggers,
  moduleId,
  eventFieldId,
  triggerIds,
}: {
  design: SandboxDocumentDesign;
  triggers: readonly SandboxTrigger[];
  moduleId: string;
  /** The watched field of a field event, else null. */
  eventFieldId: string | null;
  /** The chosen triggers, or "enabled" for every enabled trigger. */
  triggerIds: readonly string[] | "enabled";
}): Set<string> {
  const relevant = new Set(
    testModuleFields(design, moduleId)
      .filter((field) => field.required)
      .map((field) => field.id),
  );
  if (eventFieldId !== null) relevant.add(eventFieldId);
  function addReference(reference: { moduleId: string; fieldId: string }) {
    if (reference.moduleId === moduleId) relevant.add(reference.fieldId);
  }
  for (const recordTrigger of triggers.filter(
    (item) =>
      item.trigger.moduleId === moduleId &&
      (triggerIds === "enabled" ? item.enabled : triggerIds.includes(item.id)),
  )) {
    if ("fieldId" in recordTrigger.trigger)
      relevant.add(recordTrigger.trigger.fieldId);
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
        relevant.add(mapping.sourceFieldId);
  }
  return relevant;
}
