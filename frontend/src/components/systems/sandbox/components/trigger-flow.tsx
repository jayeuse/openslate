"use client";

import {
  ArrowDown,
  CalendarClock,
  FilePlus2,
  Filter,
  Pencil,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
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
  "=": "equals",
  "!=": "does not equal",
  ">": "is greater than",
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
const symbol = {
  "=": "=",
  "!=": "≠",
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
} as const;
const triggerOperators = [">", ">=", "<", "<=", "=", "!="] as const;

/** The operator choices for conditions and thresholds, in display order. */
export const triggerOperatorOptions = triggerOperators.map((operator) => ({
  value: operator,
  label: `${comparison[operator]} (${symbol[operator]})`,
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
  if (value.value === "") return '"" (empty text)';
  const config = findField(design, field)?.config;
  if (config?.kind === "select")
    return (
      config.options.find((option) => option.id === value.value)?.label ??
      String(value.value)
    );
  return String(value.value);
}
export function triggerEventLabel(recordTrigger: SandboxTrigger): string {
  return {
    "record-created": "Item added",
    "field-changed": "Field changed",
    "threshold-crossed": "Threshold crossed",
    schedule: "Schedule",
  }[recordTrigger.trigger.kind];
}
function triggerText(
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
      : "Choose a module";
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
    : `Unsupported action: ${action.kind}`;
}
function Connector() {
  return (
    <div
      aria-hidden="true"
      className="text-muted-foreground flex h-10 justify-center"
    >
      <ArrowDown className="h-full w-5" strokeWidth={1.25} />
    </div>
  );
}
function FlowNode({
  label,
  title,
  description,
  icon,
  selected,
  onClick,
}: {
  label: string;
  title: string;
  description: string;
  icon: ReactNode;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "bg-card hover:bg-accent focus-visible:outline-ring grid w-full grid-cols-[1.25rem_minmax(0,1fr)] gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 motion-reduce:transition-none",
        selected ? "border-primary bg-accent" : "border-border",
      )}
    >
      <span
        className="text-muted-foreground mt-1 [&_svg]:size-5"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="text-muted-foreground mb-1 block text-xs font-medium">
          {title}
        </span>
        <span className="block text-sm leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap">
          {description}
        </span>
      </span>
    </button>
  );
}

export function TriggerFlow({
  trigger: recordTrigger,
  design,
  selectedStep,
  onSelect,
  summaryOnly = false,
}: {
  trigger: SandboxTrigger;
  design: SandboxDocumentDesign;
  selectedStep: string;
  onSelect: (step: string) => void;
  /** Phones read the summary at the top of the detail, without the graph. */
  summaryOnly?: boolean;
}) {
  const conditions = recordTrigger.conditionGroup.conditions;
  const any = recordTrigger.conditionGroup.operator === "any";
  const trigger = triggerText(design, recordTrigger);
  return (
    <>
      <section
        aria-label="Flow preview"
        className="min-w-0"
        hidden={summaryOnly}
      >
        <h3 data-slot="section-title" className="font-semibold">
          Flow preview
        </h3>
        {!recordTrigger.enabled && (
          <p className="text-muted-foreground mt-1 text-sm">
            Off · won&apos;t run after publish
          </p>
        )}
        <div className="mx-auto my-7 w-full max-w-md">
          <FlowNode
            label="Edit trigger"
            title={`When · ${triggerEventLabel(recordTrigger)}`}
            description={trigger}
            icon={
              recordTrigger.trigger.kind === "schedule" ? (
                <CalendarClock />
              ) : recordTrigger.trigger.kind === "record-created" ? (
                <FilePlus2 />
              ) : (
                <Zap />
              )
            }
            selected={selectedStep === "trigger"}
            onClick={() => onSelect("trigger")}
          />
          <Connector />
          <div className="border-border rounded-xl border border-dashed p-3">
            <button
              type="button"
              onClick={() => onSelect("conditions")}
              className="text-muted-foreground focus-visible:outline-ring mb-3 flex min-h-11 w-full items-center gap-2 text-left text-sm font-medium focus-visible:outline-2"
            >
              <Filter className="size-4 shrink-0" aria-hidden="true" />
              If ·{" "}
              {conditions.length
                ? any
                  ? "Any condition matches"
                  : "All conditions match"
                : "Always"}
            </button>
            <div className="grid gap-2">
              {conditions.map((condition, index) => (
                <FlowNode
                  key={condition.id}
                  label={`Edit condition ${index + 1}`}
                  title={`Condition ${index + 1}${index ? (any ? " · OR" : " · AND") : ""}`}
                  description={conditionText(design, condition)}
                  icon={<Filter />}
                  selected={selectedStep === `condition:${condition.id}`}
                  onClick={() => onSelect(`condition:${condition.id}`)}
                />
              ))}
            </div>
          </div>
          <Connector />
          <div className="grid gap-3">
            {recordTrigger.actions.map((action, index) => (
              <FlowNode
                key={action.id}
                label={`Edit action ${index + 1}`}
                title={`Then · Action ${index + 1}`}
                description={actionText(design, action)}
                icon={<Pencil />}
                selected={selectedStep === `action:${action.id}`}
                onClick={() => onSelect(`action:${action.id}`)}
              />
            ))}
            {!recordTrigger.actions.length && (
              <button
                type="button"
                onClick={() => onSelect("actions")}
                className="border-border text-muted-foreground focus-visible:outline-ring rounded-xl border border-dashed p-5 text-sm focus-visible:outline-2"
              >
                Add an action to define what changes.
              </button>
            )}
          </div>
        </div>
      </section>
      <section
        aria-label="Trigger summary"
        className={cn("border-border min-w-0", !summaryOnly && "border-t pt-5")}
      >
        <h3 data-slot="section-title" className="font-semibold">
          Trigger summary
        </h3>
        {summaryOnly && !recordTrigger.enabled ? (
          <p className="text-muted-foreground mt-1 text-sm">
            Off · won&apos;t run after publish
          </p>
        ) : null}
        <div className="mt-3 space-y-2 text-sm leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap">
          <p>
            {recordTrigger.trigger.kind === "schedule"
              ? "On a schedule: "
              : "When "}
            {trigger}.
          </p>
          {conditions.length ? (
            <>
              <p>
                Continue when{" "}
                {any ? "any condition matches" : "all conditions match"}:
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {conditions.map((condition) => (
                  <li key={condition.id}>{conditionText(design, condition)}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>Always continues.</p>
          )}
          {recordTrigger.actions.length ? (
            <>
              <p>Then:</p>
              <ul className="list-disc space-y-1 pl-5">
                {recordTrigger.actions.map((action) => (
                  <li key={action.id}>{actionText(design, action)}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>No actions are configured.</p>
          )}
        </div>
      </section>
    </>
  );
}
