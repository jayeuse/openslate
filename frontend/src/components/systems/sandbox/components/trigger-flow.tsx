// The words and marks of a trigger: the one-line summary of each When, If,
// and Then step, the event word and its icon, and the operator and weekday
// choices. The list pane and the rail both read them from here.

import { CalendarClock, Flag, PencilLine, Plus } from "lucide-react";
import type {
  SandboxTrigger,
  SandboxTriggerAction,
  SandboxTriggerCondition,
  SandboxDocumentDesign,
  SandboxDocumentField,
  SandboxFieldReference,
  SandboxValueSource,
} from "../domain/document";

const comparison = {
  "=": "is",
  "!=": "is not",
  ">": "is more than",
  ">=": "is at least",
  "<": "is less than",
  "<=": "is at most",
} as const;
const weekdays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const triggerOperators = ["=", "!=", ">", ">=", "<", "<="] as const;

/** The operator choices for conditions and thresholds, in display order. */
export const triggerOperatorOptions = triggerOperators.map((operator) => ({
  value: operator,
  label: comparison[operator],
}));

/** The weekday choices for a weekly schedule; stored values are 1 to 7. */
export const weekdayOptions = weekdays.map((name, index) => ({
  value: String(index + 1),
  label: name,
}));

function findField(
  design: SandboxDocumentDesign,
  reference: SandboxFieldReference,
): SandboxDocumentField | undefined {
  return design.modules
    .find((module) => module.id === reference.moduleId)
    ?.fields.find((field) => field.id === reference.fieldId);
}
function fieldName(
  design: SandboxDocumentDesign,
  reference: SandboxFieldReference,
): string {
  const field = findField(design, reference);
  return field
    ? `${field.name}${field.closed ? " (closed)" : ""}`
    : reference.fieldId
      ? "Unavailable field"
      : "Choose a field";
}
/** Names a value for the field it belongs to; a select choice shows its label. */
function valueName(
  design: SandboxDocumentDesign,
  field: SandboxFieldReference,
  value: SandboxValueSource,
): string {
  if (value.kind === "field-reference")
    return `the value of ${fieldName(design, value)}`;
  if (value.value === true) return "Checked";
  if (value.value === false) return "Unchecked";
  if (value.value === null) return "empty";
  if (value.value === "") return "(empty)";
  const config = findField(design, field)?.config;
  if (config?.kind === "select")
    return (
      config.options.find((option) => option.id === value.value)?.label ??
      String(value.value)
    );
  return String(value.value);
}
/** A trigger's state, the same word in its list row and its Status row. */
export function triggerStatusWord(enabled: boolean): "On" | "Off" {
  return enabled ? "On" : "Off";
}
export function triggerEventLabel(recordTrigger: SandboxTrigger): string {
  return {
    "record-created": "Item added",
    "field-changed": "Field changed",
    "threshold-crossed": "Threshold crossed",
    schedule: "Schedule",
  }[recordTrigger.trigger.kind];
}
/** The When step's summary: the event, its settings, and the module. */
export function triggerText(
  design: SandboxDocumentDesign,
  recordTrigger: SandboxTrigger,
): string {
  const trigger = recordTrigger.trigger;
  const triggerModule = design.modules.find(
    (module) => module.id === trigger.moduleId,
  );
  const moduleName = triggerModule
    ? `${triggerModule.name}${triggerModule.closed ? " (closed)" : ""}`
    : trigger.moduleId
      ? "Unavailable module"
      : "[choose a module]";
  if (trigger.kind === "schedule") {
    const cadence =
      trigger.frequency === "daily"
        ? "Daily"
        : `Every ${weekdays[(trigger.weekday ?? 0) - 1] ?? "[choose a weekday]"}`;
    return `${cadence} at ${trigger.time || "[choose a time]"} in ${moduleName}`;
  }
  if (trigger.kind === "record-created")
    return `An item is added in ${moduleName}`;
  const field = { moduleId: trigger.moduleId, fieldId: trigger.fieldId };
  const name = fieldName(design, field);
  if (trigger.kind === "field-changed")
    return `${name} changes in ${moduleName}`;
  return `${name} crosses the threshold: ${comparison[trigger.operator]} ${valueName(design, field, trigger.value)} in ${moduleName}`;
}
function conditionText(
  design: SandboxDocumentDesign,
  condition: SandboxTriggerCondition,
): string {
  return `${fieldName(design, condition.field)} ${comparison[condition.operator]} ${valueName(design, condition.field, condition.value)}`;
}
function actionText(
  design: SandboxDocumentDesign,
  action: SandboxTriggerAction,
): string {
  return action.kind === "set-field"
    ? `Set ${fieldName(design, action.target)} to ${valueName(design, action.target, action.value)}`
    : `${action.kind.charAt(0).toUpperCase()}${action.kind.slice(1)} · can't publish yet`;
}
/** The If step's summary: "Always", or every condition joined by and/or. */
export function conditionsText(
  design: SandboxDocumentDesign,
  recordTrigger: SandboxTrigger,
): string {
  const { conditions, operator } = recordTrigger.conditionGroup;
  if (!conditions.length) return "Always";
  return conditions
    .map((condition) => conditionText(design, condition))
    .join(operator === "any" ? " or " : " and ");
}

/** The Then step's summary: every action, in order. */
export function actionsText(
  design: SandboxDocumentDesign,
  recordTrigger: SandboxTrigger,
): string {
  if (!recordTrigger.actions.length) return "No actions yet";
  return recordTrigger.actions
    .map((action) => actionText(design, action))
    .join(" · ");
}

/** The mark of a trigger's event, beside its word in the list and the rail. */
export function TriggerEventIcon({
  kind,
  className,
}: {
  kind: SandboxTrigger["trigger"]["kind"];
  className?: string;
}) {
  const Icon = {
    "record-created": Plus,
    "field-changed": PencilLine,
    "threshold-crossed": Flag,
    schedule: CalendarClock,
  }[kind];
  return <Icon aria-hidden="true" className={className} />;
}
