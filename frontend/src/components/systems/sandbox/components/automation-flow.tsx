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
  SandboxAutomation,
  SandboxAutomationAction,
  SandboxAutomationCondition,
  SandboxDocumentDesign,
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

function fieldName(
  design: SandboxDocumentDesign,
  reference: SandboxFieldReference,
): string {
  const field = design.modules
    .find((module) => module.id === reference.moduleId)
    ?.fields.find((field) => field.id === reference.fieldId);
  return field
    ? `${field.name}${field.closed ? " (closed)" : ""}`
    : reference.fieldId
      ? "Unavailable field"
      : "Choose a field";
}
function valueName(
  design: SandboxDocumentDesign,
  value: SandboxValueSource,
): string {
  if (value.kind === "field-reference")
    return `the value of ${fieldName(design, value)}`;
  if (value.value === true) return "Checked";
  if (value.value === false) return "Unchecked";
  if (value.value === null) return "empty";
  if (value.value === "") return '"" (empty text)';
  return String(value.value);
}
export function automationTriggerLabel(automation: SandboxAutomation): string {
  return {
    "record-created": "Item added",
    "field-changed": "Field changed",
    "threshold-crossed": "Threshold crossed",
    schedule: "Schedule",
  }[automation.trigger.kind];
}
function triggerText(
  design: SandboxDocumentDesign,
  automation: SandboxAutomation,
): string {
  const trigger = automation.trigger;
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
  const name = fieldName(design, {
    moduleId: trigger.moduleId,
    fieldId: trigger.fieldId,
  });
  if (trigger.kind === "field-changed")
    return `${name} changes in ${moduleName}`;
  return `${name} crosses the threshold: ${comparison[trigger.operator]} ${valueName(design, trigger.value)} in ${moduleName}`;
}
function conditionText(
  design: SandboxDocumentDesign,
  condition: SandboxAutomationCondition,
): string {
  return `${fieldName(design, condition.field)} ${comparison[condition.operator]} ${valueName(design, condition.value)}`;
}
function actionText(
  design: SandboxDocumentDesign,
  action: SandboxAutomationAction,
): string {
  return action.kind === "set-field"
    ? `Set ${fieldName(design, action.target)} to ${valueName(design, action.value)}`
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

export function AutomationFlow({
  automation,
  design,
  selectedStep,
  onSelect,
}: {
  automation: SandboxAutomation;
  design: SandboxDocumentDesign;
  selectedStep: string;
  onSelect: (step: string) => void;
}) {
  const conditions = automation.conditionGroup.conditions;
  const any = automation.conditionGroup.operator === "any";
  const trigger = triggerText(design, automation);
  return (
    <>
      <section aria-label="Flow preview" className="min-w-0">
        <h3 className="font-semibold">Flow preview</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Select a step to edit its settings.
        </p>
        {!automation.enabled && (
          <p className="text-muted-foreground mt-3 text-sm">
            Disabled in this draft. This automation will not run when published.
          </p>
        )}
        <div className="mx-auto my-7 w-full max-w-md">
          <FlowNode
            label="Edit trigger"
            title={`When · ${automationTriggerLabel(automation)}`}
            description={trigger}
            icon={
              automation.trigger.kind === "schedule" ? (
                <CalendarClock />
              ) : automation.trigger.kind === "record-created" ? (
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
                : "No conditions"}
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
              {!conditions.length && (
                <p className="text-muted-foreground px-1 text-sm">
                  No condition filter is configured.
                </p>
              )}
            </div>
          </div>
          <Connector />
          <div className="grid gap-3">
            {automation.actions.map((action, index) => (
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
            {!automation.actions.length && (
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
        aria-label="Automation summary"
        className="border-border min-w-0 border-t pt-5"
      >
        <h3 className="font-semibold">Automation summary</h3>
        <div className="mt-3 space-y-2 text-sm leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap">
          <p>
            {automation.trigger.kind === "schedule"
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
            <p>No condition filter is configured.</p>
          )}
          {automation.actions.length ? (
            <>
              <p>Then:</p>
              <ul className="list-disc space-y-1 pl-5">
                {automation.actions.map((action) => (
                  <li key={action.id}>{actionText(design, action)}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>No actions are configured.</p>
          )}
        </div>
        <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
          This preview describes your draft, not a completed run. Save your
          changes, then review and publish to apply them.
        </p>
      </section>
    </>
  );
}
