import type { SandboxTestEvent, SandboxTestRun } from "../state/api";
import type {
  SandboxTrigger,
  SandboxTriggerEvent,
  SandboxDocumentDesign,
  SandboxFieldValue,
} from "./document";

/**
 * Why a stored Test result may no longer describe the draft: the draft has
 * changed since the run, or the module it tested is gone or closed.
 */
export type TestRunStaleness = "older-draft" | "module-gone" | null;

export type TestIssueSubject = {
  kind: "trigger" | "field" | "module";
  id: string;
  name: string;
};

export type TestIssueGroup = {
  key: string;
  code: string;
  message: string;
  count: number;
  subject: TestIssueSubject | null;
};

export type TestRunSummary = {
  stale: TestRunStaleness;
  issues: TestIssueGroup[];
};

/**
 * The Test engine reports each issue with a code, a message, and one target
 * id. The same message can repeat for every action it touches, so repeats
 * collapse into one line with a count, and the target id is resolved to the
 * trigger, field (in the tested module), or module it names.
 */
export function summarizeTestRun(
  run: SandboxTestRun,
  design: SandboxDocumentDesign,
  triggers: readonly SandboxTrigger[],
  draftRevision: number,
): TestRunSummary {
  // Field names resolve even when the module is closed; only staleness
  // cares whether it is still open.
  const testedModule = design.modules.find(
    (item) => item.id === run.input.moduleId,
  );
  const stale: TestRunStaleness =
    !testedModule || testedModule.closed
      ? "module-gone"
      : run.documentRevision !== draftRevision
        ? "older-draft"
        : null;

  const subjectOf = (targetId: string | null): TestIssueSubject | null => {
    if (targetId === null) return null;
    const recordTrigger = triggers.find((item) => item.id === targetId);
    if (recordTrigger)
      return { kind: "trigger", id: targetId, name: recordTrigger.name };
    const field = testedModule?.fields.find((item) => item.id === targetId);
    if (field) return { kind: "field", id: targetId, name: field.name };
    const named = design.modules.find((item) => item.id === targetId);
    if (named) return { kind: "module", id: targetId, name: named.name };
    return null;
  };

  const groups = new Map<string, TestIssueGroup>();
  for (const issue of run.result.issues) {
    // Issues about the same named thing stay apart per target; issues whose
    // target no longer resolves read the same, so they collapse by message.
    const subject = subjectOf(issue.targetId);
    const key = `${issue.code}\u0000${subject?.id ?? ""}\u0000${issue.message}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else
      groups.set(key, {
        key,
        code: issue.code,
        message: issue.message,
        count: 1,
        subject,
      });
  }
  // The engine reports an empty required field twice (the value does not
  // match, and a value is required). One issue per field is enough.
  const required = new Set(
    [...groups.values()]
      .filter((item) => item.code === "value_required" && item.subject)
      .map((item) => item.subject?.id),
  );
  const issues = [...groups.values()].filter(
    (item) =>
      !(
        item.code === "value_invalid" &&
        item.subject?.kind === "field" &&
        required.has(item.subject.id)
      ),
  );
  return { stale, issues };
}

function fieldLabel(
  design: SandboxDocumentDesign,
  moduleId: string | undefined,
  fieldId: string,
): string {
  return (
    design.modules
      .find((item) => item.id === moduleId)
      ?.fields.find((item) => item.id === fieldId)?.name ?? "a field"
  );
}

/**
 * The event that runs a trigger, in plain words. Names the module when
 * it is not the tested one, so the reason never reads as a contradiction.
 */
export function describeTrigger(
  trigger: SandboxTriggerEvent,
  design: SandboxDocumentDesign,
  testedModuleId?: string,
): string {
  const where =
    testedModuleId && trigger.moduleId && trigger.moduleId !== testedModuleId
      ? ` in ${design.modules.find((item) => item.id === trigger.moduleId)?.name ?? "another module"}`
      : "";
  if (trigger.kind === "record-created") {
    const target = design.modules.find((item) => item.id === trigger.moduleId);
    return `Runs when an item is added to ${target?.name ?? "its module"}.`;
  }
  if (trigger.kind === "field-changed")
    return `Runs when ${fieldLabel(design, trigger.moduleId, trigger.fieldId)} changes${where}.`;
  if (trigger.kind === "threshold-crossed")
    return `Runs when ${fieldLabel(design, trigger.moduleId, trigger.fieldId)} crosses a limit${where}.`;
  return `Runs on a ${trigger.frequency} schedule at ${trigger.time}.`;
}

/**
 * The event a new test should start with: the trigger of the first enabled
 * trigger on the module, so the first run exercises something. Null when
 * no enabled trigger runs on the module.
 */
export function defaultTestTrigger(
  triggers: readonly SandboxTrigger[],
  moduleId: string,
): SandboxTriggerEvent | null {
  return (
    triggers.find((item) => item.enabled && item.trigger.moduleId === moduleId)
      ?.trigger ?? null
  );
}

/* Shared wording for a stored Test run, used by the result panel and by the
   canvas trace. */

export function fieldName(
  design: SandboxDocumentDesign,
  moduleId: string,
  fieldId: string,
) {
  return (
    design.modules
      .find((item) => item.id === moduleId)
      ?.fields.find((field) => field.id === fieldId)?.name ??
    "Unavailable field"
  );
}
export function moduleName(design: SandboxDocumentDesign, moduleId: string) {
  return (
    design.modules.find((item) => item.id === moduleId)?.name ??
    "Unavailable module"
  );
}
export function displayValue(
  value: SandboxFieldValue | undefined,
  missing: string,
): string {
  if (value === undefined) return missing;
  if (value === null) return "No value";
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === "") return "Empty text";
  return String(value);
}

export function comparisonRows(run: SandboxTestRun) {
  return Array.from(
    new Set([
      ...Object.keys(run.input.values),
      ...Object.keys(run.result.values),
    ]),
  ).map((id) => {
    const before = run.input.values[id];
    const after = run.result.values[id];
    return {
      id,
      before,
      after,
      changed: after !== undefined && !Object.is(before, after),
    };
  });
}

export function eventDescription(
  design: SandboxDocumentDesign,
  run: SandboxTestRun,
): string {
  const event: SandboxTestEvent = run.event;
  if (event.kind === "record-created") return "An item is added";
  if (event.kind === "field-changed")
    return `${fieldName(design, run.input.moduleId, event.fieldId)} changes`;
  if (event.kind === "threshold-crossed")
    return `${fieldName(design, run.input.moduleId, event.fieldId)} crosses a limit from ${displayValue(event.previousValue, "Not provided")}`;
  const days = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  return event.frequency === "daily"
    ? `Daily schedule at ${event.time}`
    : `Weekly schedule: ${days[(event.weekday ?? 0) - 1] ?? "day not specified"}, ${event.time}`;
}

/** "trigger", "changed", or both ("trigger changed"). */
export type TestTraceMark = "trigger" | "changed" | "trigger changed";

export type TestTraceStep = {
  title: string;
  lines: string[];
  /** Field id to mark on the tested module's table. */
  marks: Record<string, TestTraceMark>;
};

/**
 * A stored run as three still steps for the canvas: what happened (the
 * trigger field), which triggers ran, and which values changed. Each
 * step keeps the earlier marks, so the last step shows the whole run.
 */
export function testTraceSteps(
  run: SandboxTestRun,
  design: SandboxDocumentDesign,
  summary?: TestRunSummary,
): TestTraceStep[] {
  // The strip repeats what the result panel says about trust, so the canvas
  // never looks cleaner than the result.
  const caveats = [
    ...(summary?.stale ? ["From an older draft."] : []),
    ...(summary?.issues.length
      ? [
          `This test needs attention: ${summary.issues.length} issue${summary.issues.length === 1 ? "" : "s"}. Go back to the result to fix ${summary.issues.length === 1 ? "it" : "them"}.`,
        ]
      : []),
  ];
  const trigger: Record<string, TestTraceMark> =
    run.event.kind === "field-changed" || run.event.kind === "threshold-crossed"
      ? { [run.event.fieldId]: "trigger" }
      : {};
  const changed = comparisonRows(run).filter((row) => row.changed);
  const traces = run.result.triggerTraces;
  return [
    {
      title: "What happened",
      lines: [...caveats, eventDescription(design, run)],
      marks: trigger,
    },
    {
      title: "Triggers",
      lines: traces.length
        ? traces.map(
            (trace) =>
              `${trace.label}: ${trace.outcome === "Applied" ? "applied" : trace.outcome.toLowerCase()}`,
          )
        : ["No triggers ran."],
      marks: trigger,
    },
    {
      title: "Result",
      lines: changed.length
        ? changed.map(
            (row) =>
              `${fieldName(design, run.input.moduleId, row.id)}: ${displayValue(row.before, "Not provided")} → ${displayValue(row.after, "No value")}`,
          )
        : [...caveats, "No field values changed."],
      marks: {
        ...trigger,
        ...Object.fromEntries(
          changed.map((row) => [
            row.id,
            trigger[row.id]
              ? ("trigger changed" as const)
              : ("changed" as const),
          ]),
        ),
      },
    },
  ];
}
