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
    : `${action.kind.charAt(0).toUpperCase()}${action.kind.slice(1)} · can't publish yet`;
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
  title,
  description,
  icon,
  selected,
  warn = false,
  note,
  onClick,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  selected: boolean;
  /** A step that blocks publishing reads in warning ink. */
  warn?: boolean;
  /** What Save will refuse in this step, shown before Save. */
  note?: string | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "bg-card focus-visible:outline-ring grid w-full grid-cols-[1.25rem_minmax(0,1fr)] gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 motion-reduce:transition-none",
        // The selected step takes the ink tint of the lists, not a blue
        // edge (decision F3); hover is the lighter tint.
        "border-border",
        selected
          ? "bg-[color-mix(in_oklab,var(--ink)_14%,transparent)]"
          : "hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]",
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
        <span
          className={cn(
            "block text-sm leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap",
            warn && "text-warn-text",
          )}
        >
          {description}
        </span>
        {note ? (
          <span className="text-warn-text mt-1 block text-xs">{note}</span>
        ) : null}
      </span>
    </button>
  );
}

const NO_STEP_ERRORS: ReadonlyMap<string, string> = new Map();

/** The phone summary's line for what Save will refuse in a step. */
function StepNote({ note }: { note: string | undefined }) {
  return note ? (
    <span className="text-warn-text block text-xs">{note}</span>
  ) : null;
}

export function TriggerFlow({
  trigger: recordTrigger,
  design,
  stepErrors = NO_STEP_ERRORS,
  selectedStep,
  onSelect,
  summaryOnly = false,
}: {
  trigger: SandboxTrigger;
  design: SandboxDocumentDesign;
  /** Fixed values Save will refuse, by step (see `triggerStepErrors`). */
  stepErrors?: ReadonlyMap<string, string>;
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
            title={`When · ${triggerEventLabel(recordTrigger)}`}
            description={trigger}
            note={stepErrors.get("trigger")}
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
                  title={`Condition ${index + 1}${index ? (any ? " · OR" : " · AND") : ""}`}
                  description={conditionText(design, condition)}
                  note={stepErrors.get(`condition:${condition.id}`)}
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
                title={`Then · Action ${index + 1}`}
                description={actionText(design, action)}
                note={stepErrors.get(`action:${action.id}`)}
                icon={<Pencil />}
                warn={action.kind !== "set-field"}
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
                Add action
              </button>
            )}
          </div>
        </div>
      </section>
      {summaryOnly ? (
        <section
          aria-label="Trigger summary"
          className={cn(
            "border-border min-w-0",
            !summaryOnly && "border-t pt-5",
          )}
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
              {recordTrigger.trigger.kind === "record-created"
                ? trigger.replace(/^An /, "an ")
                : trigger}
              .
              <StepNote note={stepErrors.get("trigger")} />
            </p>
            {conditions.length ? (
              <>
                <p>
                  Continue when{" "}
                  {any ? "any condition matches" : "all conditions match"}:
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  {conditions.map((condition) => (
                    <li key={condition.id}>
                      {conditionText(design, condition)}
                      <StepNote
                        note={stepErrors.get(`condition:${condition.id}`)}
                      />
                    </li>
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
                    <li
                      key={action.id}
                      className={
                        action.kind === "set-field"
                          ? undefined
                          : "text-warn-text"
                      }
                    >
                      {actionText(design, action)}
                      <StepNote note={stepErrors.get(`action:${action.id}`)} />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>No actions yet.</p>
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
