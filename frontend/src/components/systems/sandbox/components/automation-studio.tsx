"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Switch } from "@/components/ui/switch";
import { MoreHorizontal, Plus, Trash2, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { AutomationFlow, automationTriggerLabel } from "./automation-flow";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import type {
  SandboxAutomation,
  SandboxAutomationAction,
  SandboxAutomationCondition,
  SandboxAutomationTrigger,
  SandboxDocumentDesign,
  SandboxDocumentField,
  SandboxFieldReference,
  SandboxFieldValue,
  SandboxValueSource,
} from "../domain/document";
import type { SandboxAutomationRun } from "../state/api";
import { dateRangeFits, dateValueInRange } from "../domain/date-values";

export type AutomationStudioProps = {
  design: SandboxDocumentDesign;
  automations: SandboxAutomation[];
  runs: readonly SandboxAutomationRun[];
  activity: { loading: boolean; error: string };
  initialSelectedId?: string;
  onRefreshActivity: () => Promise<void>;
  onChange: (automations: SandboxAutomation[]) => Promise<void> | void;
  onStateChange?: (state: { dirty: boolean; pending: boolean }) => void;
};

export async function saveStudioDraft<T>(
  draft: T,
  onChange: (next: T) => Promise<void> | void,
): Promise<{ ok: true } | { ok: false; draft: T }> {
  try {
    await onChange(draft);
    return { ok: true };
  } catch {
    return { ok: false, draft };
  }
}

export function automationRunStatus(run: SandboxAutomationRun): string {
  if (run.details.budgetExhausted === true)
    return "Incomplete — action limit reached";
  if (run.state === "succeeded" && run.details.actionsApplied === 0)
    return "No change needed";
  if (run.state === "succeeded") return "Completed";
  if (run.state === "skipped") return "No change needed";
  if (run.state === "suspended") return "Paused — publisher access changed";
  return "Could not complete";
}

function runDetail(run: SandboxAutomationRun): string {
  const actions = run.details.actionsApplied;
  const records = run.details.recordsMatched;
  if (typeof actions === "number" && typeof records === "number")
    return `${actions} change${actions === 1 ? "" : "s"} across ${records} matching item${records === 1 ? "" : "s"}`;
  if (run.state === "failed")
    return `Stopped after ${run.attempts} attempt${run.attempts === 1 ? "" : "s"}`;
  return "The run finished without exposing record data.";
}

const operators = [">", ">=", "<", "<=", "=", "!="] as const;

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function fieldsFor(
  design: SandboxDocumentDesign,
  moduleId: string,
): SandboxDocumentField[] {
  return design.modules.find((item) => item.id === moduleId)?.fields ?? [];
}

function defaultLiteral(
  field: SandboxDocumentField | undefined,
): SandboxValueSource {
  if (!field) return { kind: "literal", value: "" };
  return { kind: "literal", value: field.config.defaultValue };
}

function firstOpenModule(design: SandboxDocumentDesign): string {
  return (
    design.modules.find((item) => !item.closed)?.id ??
    design.modules[0]?.id ??
    ""
  );
}

function firstOpenField(
  design: SandboxDocumentDesign,
  moduleId: string,
): SandboxDocumentField | undefined {
  return fieldsFor(design, moduleId).find((field) => !field.closed);
}

function firstOpenNumberField(
  design: SandboxDocumentDesign,
  moduleId: string,
): SandboxDocumentField | undefined {
  return fieldsFor(design, moduleId).find(
    (field) =>
      !field.closed &&
      (field.config.kind === "number" || field.config.kind === "integer"),
  );
}

export function sandboxFieldsAreDirectionallyCompatible(
  source: SandboxDocumentField,
  target: SandboxDocumentField,
): boolean {
  if (!source.required && target.required) return false;
  const sourceKind = source.config.kind;
  const targetKind = target.config.kind;
  const textMaximum = (field: SandboxDocumentField) => {
    const config = field.config;
    return config.kind === "text" ||
      config.kind === "long-text" ||
      config.kind === "email" ||
      config.kind === "url"
      ? config.maxLength
      : undefined;
  };
  const sourceMaximum = textMaximum(source);
  const targetMaximum = textMaximum(target);
  const rangeFits = <T extends string | number>(
    sourceMin: T | undefined,
    sourceMax: T | undefined,
    targetMin: T | undefined,
    targetMax: T | undefined,
  ) =>
    (targetMin === undefined ||
      (sourceMin !== undefined && sourceMin >= targetMin)) &&
    (targetMax === undefined ||
      (sourceMax !== undefined && sourceMax <= targetMax));
  const maximumFits =
    targetMaximum === undefined ||
    (sourceMaximum !== undefined && sourceMaximum <= targetMaximum);
  if (sourceKind === "select") {
    if (targetKind !== "select") return false;
    const targetOptions = target.config.options;
    return source.config.options.every((value) =>
      targetOptions.includes(value),
    );
  }
  if (sourceKind === "number" || sourceKind === "integer") {
    if (targetKind !== "number" && sourceKind !== targetKind) return false;
    if (
      !rangeFits(
        source.config.min,
        source.config.max,
        target.config.min,
        target.config.max,
      )
    )
      return false;
    if (target.config.step === undefined) return true;
    const sourceStep =
      source.config.step ?? (sourceKind === "integer" ? 1 : undefined);
    if (sourceStep === undefined) return false;
    const stepRatio = sourceStep / target.config.step;
    const baseRatio =
      ((source.config.min ?? 0) - (target.config.min ?? 0)) /
      target.config.step;
    return (
      Math.abs(stepRatio - Math.round(stepRatio)) <= 1e-9 &&
      Math.abs(baseRatio - Math.round(baseRatio)) <= 1e-9
    );
  }
  if (sourceKind === "date" || sourceKind === "datetime")
    return (
      targetKind === sourceKind &&
      dateRangeFits(
        sourceKind,
        source.config.earliest,
        source.config.latest,
        target.config.earliest,
        target.config.latest,
      )
    );
  if (sourceKind === targetKind)
    return sourceMaximum === undefined && targetMaximum === undefined
      ? true
      : maximumFits;
  if (
    ["text", "long-text", "email", "url"].includes(sourceKind) &&
    ["text", "long-text"].includes(targetKind)
  )
    return maximumFits;
  return false;
}

function automationOrigin(
  automation: SandboxAutomation,
  design: SandboxDocumentDesign,
): string {
  if (automation.trigger.kind !== "schedule")
    return automation.trigger.moduleId;
  return automation.trigger.moduleId ?? firstOpenModule(design);
}

export function automationPublicationBlockers(
  automations: readonly SandboxAutomation[],
  design: SandboxDocumentDesign,
): string[] {
  return automations.flatMap((automation) => {
    const moduleId = automationOrigin(automation, design);
    const blockers: string[] = [];
    if (automation.trigger.kind === "schedule" && !automation.trigger.moduleId)
      blockers.push(`${automation.name}: scheduled automations need a module.`);
    for (const condition of automation.conditionGroup.conditions)
      if (
        condition.field.moduleId !== moduleId ||
        condition.field.relationshipId !== undefined ||
        (condition.value.kind === "field-reference" &&
          (condition.value.moduleId !== moduleId ||
            condition.value.relationshipId !== undefined))
      )
        blockers.push(
          `${automation.name}: conditions must use fields from the same module.`,
        );
    for (const action of automation.actions) {
      if (action.kind !== "set-field") {
        blockers.push(
          `${automation.name}: ${action.kind} is not supported for publishing.`,
        );
        continue;
      }
      if (
        action.target.moduleId !== moduleId ||
        action.target.relationshipId !== undefined ||
        (action.value.kind === "field-reference" &&
          (action.value.moduleId !== moduleId ||
            action.value.relationshipId !== undefined))
      )
        blockers.push(
          `${automation.name}: Set field must stay in the same module.`,
        );
    }
    return blockers;
  });
}

type ReferenceOption = {
  value: string;
  label: string;
  reference: SandboxFieldReference;
};

export function fieldReferenceOptionValue(
  reference: SandboxFieldReference,
): string {
  return [reference.relationshipId, reference.moduleId, reference.fieldId]
    .filter((part): part is string => Boolean(part))
    .join("|");
}

export function scheduleFrequencyChange(
  trigger: Extract<SandboxAutomationTrigger, { kind: "schedule" }>,
  frequency: "daily" | "weekly",
): Extract<SandboxAutomationTrigger, { kind: "schedule" }> {
  const { weekday, ...withoutWeekday } = trigger;
  return frequency === "weekly"
    ? { ...withoutWeekday, frequency, weekday: weekday ?? 1 }
    : { ...withoutWeekday, frequency };
}

export function compatibleReferenceOptions(
  design: SandboxDocumentDesign,
  automation: SandboxAutomation,
  target: SandboxDocumentField | undefined,
): ReferenceOption[] {
  if (!target) return [];
  const origin = automationOrigin(automation, design);
  const sandboxModule = design.modules.find((item) => item.id === origin);
  return (sandboxModule?.fields ?? [])
    .filter(
      (field) =>
        !field.closed && sandboxFieldsAreDirectionallyCompatible(field, target),
    )
    .map((field) => ({
      value: fieldReferenceOptionValue({ moduleId: origin, fieldId: field.id }),
      label: `${sandboxModule?.name ?? "Module"} · ${field.name}`,
      reference: { moduleId: origin, fieldId: field.id },
    }));
}

function parseLiteral(
  raw: string,
  field: SandboxDocumentField | undefined,
): SandboxFieldValue {
  if (!field) return raw;
  if (field.config.kind === "checkbox") return raw === "true";
  if (field.config.kind === "number" || field.config.kind === "integer") {
    if (!raw.trim()) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  return raw;
}

function displayLiteral(value: SandboxFieldValue): string {
  return value === null ? "" : String(value);
}

export function validateFieldLiteral(
  value: SandboxFieldValue,
  field: SandboxDocumentField,
): string | null {
  if (value === null)
    return field.required ? `${field.name} is required.` : null;
  if (field.required && typeof value === "string" && !value.trim())
    return `${field.name} is required.`;
  const config = field.config;
  if (
    typeof value === "string" &&
    (config.kind === "text" ||
      config.kind === "long-text" ||
      config.kind === "email" ||
      config.kind === "url")
  ) {
    if (config.maxLength !== undefined && value.length > config.maxLength)
      return `${field.name} exceeds its maximum length.`;
    if (
      config.kind === "email" &&
      value &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    )
      return `${field.name} must be a valid email.`;
    if (config.kind === "url" && value) {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        return `${field.name} must be a valid HTTP or HTTPS URL.`;
      }
    }
  }
  if (
    (config.kind === "number" || config.kind === "integer") &&
    value !== null
  ) {
    if (
      typeof value !== "number" ||
      (config.kind === "integer" && !Number.isInteger(value))
    )
      return `${field.name} has an invalid number.`;
    if (config.min !== undefined && value < config.min)
      return `${field.name} is below its minimum.`;
    if (config.max !== undefined && value > config.max)
      return `${field.name} is above its maximum.`;
    const step = config.step ?? (config.kind === "integer" ? 1 : undefined);
    if (
      step !== undefined &&
      Math.abs(
        (value - (config.min ?? 0)) / step -
          Math.round((value - (config.min ?? 0)) / step),
      ) > 1e-9
    )
      return `${field.name} does not match its step.`;
  }
  if (
    (config.kind === "date" || config.kind === "datetime") &&
    typeof value === "string" &&
    value
  ) {
    const valid =
      config.kind === "date"
        ? /^\d{4}-\d{2}-\d{2}$/.test(value)
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
    if (
      !valid ||
      !dateValueInRange(config.kind, value, config.earliest, config.latest)
    )
      return `${field.name} is outside its allowed date range.`;
  }
  if (
    config.kind === "select" &&
    typeof value === "string" &&
    !config.options.includes(value)
  )
    return `${field.name} must use a configured option.`;
  return null;
}

function automationLiteralError(
  automation: SandboxAutomation,
  design: SandboxDocumentDesign,
): string | null {
  const check = (
    value: SandboxValueSource,
    field: SandboxDocumentField | undefined,
  ) =>
    value.kind === "literal" && field
      ? validateFieldLiteral(value.value, field)
      : null;
  const trigger = automation.trigger;
  if (trigger.kind === "threshold-crossed") {
    const error = check(
      trigger.value,
      fieldsFor(design, trigger.moduleId).find(
        (field) => field.id === trigger.fieldId,
      ),
    );
    if (error) return error;
  }
  for (const condition of automation.conditionGroup.conditions) {
    const error = check(
      condition.value,
      fieldsFor(design, condition.field.moduleId).find(
        (field) => field.id === condition.field.fieldId,
      ),
    );
    if (error) return error;
  }
  for (const action of automation.actions) {
    if (action.kind === "set-field") {
      const error = check(
        action.value,
        fieldsFor(design, action.target.moduleId).find(
          (field) => field.id === action.target.fieldId,
        ),
      );
      if (error) return error;
    }
    if (action.kind === "create-record")
      for (const value of action.values) {
        const error = check(
          value.value,
          fieldsFor(design, action.moduleId).find(
            (field) => field.id === value.fieldId,
          ),
        );
        if (error) return error;
      }
  }
  return null;
}

export function defaultAutomation(
  design: SandboxDocumentDesign,
): SandboxAutomation {
  const moduleId = firstOpenModule(design);
  return {
    id: newId("automation"),
    name: "New automation",
    enabled: true,
    priority: 0,
    trigger: { kind: "record-created", moduleId },
    conditionGroup: { operator: "all", conditions: [] },
    actions: [
      {
        id: newId("action"),
        kind: "set-field",
        target: {
          moduleId,
          fieldId: firstOpenField(design, moduleId)?.id ?? "",
        },
        value: defaultLiteral(firstOpenField(design, moduleId)),
      },
    ],
  };
}

export function addAutomationCondition(
  automation: SandboxAutomation,
  design: SandboxDocumentDesign,
): SandboxAutomation {
  if (automation.conditionGroup.conditions.length >= 20) return automation;
  const moduleId = automationOrigin(automation, design);
  const field = firstOpenField(design, moduleId);
  if (!field) return automation;
  const condition: SandboxAutomationCondition = {
    id: newId("condition"),
    field: { moduleId, fieldId: field.id },
    operator: "=",
    value: defaultLiteral(field),
  };
  return {
    ...automation,
    conditionGroup: {
      ...automation.conditionGroup,
      conditions: [...automation.conditionGroup.conditions, condition],
    },
  };
}

export function addAutomationAction(
  automation: SandboxAutomation,
  design: SandboxDocumentDesign,
): SandboxAutomation {
  if (automation.actions.length >= 20) return automation;
  const moduleId = automationOrigin(automation, design);
  const field = firstOpenField(design, moduleId);
  return {
    ...automation,
    actions: [
      ...automation.actions,
      {
        id: newId("action"),
        kind: "set-field",
        target: { moduleId, fieldId: field?.id ?? "" },
        value: defaultLiteral(field),
      },
    ],
  };
}

function replaceAt<T>(items: readonly T[], index: number, next: T): T[] {
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function ValueEditor({
  design,
  automation,
  target,
  value,
  onChange,
}: {
  design: SandboxDocumentDesign;
  automation: SandboxAutomation;
  target?: SandboxDocumentField;
  value: SandboxValueSource;
  onChange: (value: SandboxValueSource) => void;
}) {
  const sourceId = useId();
  const literalId = useId();
  const referenceId = useId();
  const references = compatibleReferenceOptions(design, automation, target);
  return (
    <div className="grid min-w-0 gap-3 @min-[450px]/settings:grid-cols-2">
      {value.kind === "literal" ? (
        <Field>
          <FieldLabel htmlFor={literalId}>Value</FieldLabel>
          {target?.config.kind === "checkbox" ? (
            <NativeSelect
              id={literalId}
              value={String(value.value)}
              onChange={(event) =>
                onChange({
                  kind: "literal",
                  value: event.target.value === "true",
                })
              }
            >
              <NativeSelectOption value="true">Checked</NativeSelectOption>
              <NativeSelectOption value="false">Unchecked</NativeSelectOption>
            </NativeSelect>
          ) : target?.config.kind === "long-text" ? (
            <Textarea
              id={literalId}
              value={displayLiteral(value.value)}
              required={target.required}
              maxLength={target.config.maxLength}
              onChange={(event) =>
                onChange({
                  kind: "literal",
                  value: parseLiteral(event.target.value, target),
                })
              }
            />
          ) : (
            <Input
              id={literalId}
              type={
                target?.config.kind === "number" ||
                target?.config.kind === "integer"
                  ? "number"
                  : target?.config.kind === "email"
                    ? "email"
                    : target?.config.kind === "url"
                      ? "url"
                      : target?.config.kind === "date"
                        ? "date"
                        : target?.config.kind === "datetime"
                          ? "datetime-local"
                          : "text"
              }
              value={displayLiteral(value.value)}
              required={target?.required}
              min={
                target?.config.kind === "number" ||
                target?.config.kind === "integer"
                  ? target.config.min
                  : target?.config.kind === "date" ||
                      target?.config.kind === "datetime"
                    ? target.config.earliest
                    : undefined
              }
              max={
                target?.config.kind === "number" ||
                target?.config.kind === "integer"
                  ? target.config.max
                  : target?.config.kind === "date" ||
                      target?.config.kind === "datetime"
                    ? target.config.latest
                    : undefined
              }
              step={
                target?.config.kind === "number" ||
                target?.config.kind === "integer"
                  ? target.config.step
                  : undefined
              }
              maxLength={
                target?.config.kind === "text" ||
                target?.config.kind === "email" ||
                target?.config.kind === "url"
                  ? target.config.maxLength
                  : undefined
              }
              onChange={(event) =>
                onChange({
                  kind: "literal",
                  value: parseLiteral(event.target.value, target),
                })
              }
            />
          )}
        </Field>
      ) : (
        <Field>
          <FieldLabel htmlFor={referenceId}>Referenced field</FieldLabel>
          <NativeSelect
            id={referenceId}
            value={fieldReferenceOptionValue(value)}
            onChange={(event) => {
              const option = references.find(
                (item) => item.value === event.target.value,
              );
              if (option)
                onChange({ kind: "field-reference", ...option.reference });
            }}
          >
            {references.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
      <details className="min-w-0 self-end">
        <summary className="text-muted-foreground focus-visible:outline-ring flex min-h-11 cursor-pointer items-center gap-2 text-xs focus-visible:outline-2">
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
          Value options ·{" "}
          {value.kind === "field-reference" ? "Field reference" : "Fixed value"}
        </summary>
        <Field>
          <FieldLabel htmlFor={sourceId}>Value source</FieldLabel>
          <NativeSelect
            id={sourceId}
            value={value.kind}
            onChange={(event) =>
              onChange(
                event.target.value === "field-reference" && references[0]
                  ? { kind: "field-reference", ...references[0].reference }
                  : defaultLiteral(target),
              )
            }
          >
            <NativeSelectOption value="literal">
              Literal value
            </NativeSelectOption>
            <NativeSelectOption
              value="field-reference"
              disabled={!references.length}
            >
              Field reference
            </NativeSelectOption>
          </NativeSelect>
        </Field>
      </details>
    </div>
  );
}

export function AutomationStudio({
  design,
  automations,
  runs,
  activity,
  initialSelectedId,
  onRefreshActivity,
  onChange,
  onStateChange,
}: AutomationStudioProps) {
  const [draft, setDraft] = useState(automations);
  const studioRef = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const element = studioRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWide(entry.contentRect.width >= 1100);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [selectedStep, setSelectedStep] = useState("trigger");
  function selectStep(step: string) {
    setSelectedStep(step);
    const section = settingsRef.current?.querySelector<HTMLElement>(
      `[data-rule-target="${CSS.escape(step)}"]`,
    );
    const control = section?.querySelector<HTMLElement>(
      "input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)",
    );
    (control ?? section)?.focus({ preventScroll: true });
    section?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
  const [selectedId, setSelectedId] = useState(
    initialSelectedId &&
      automations.some((item) => item.id === initialSelectedId)
      ? initialSelectedId
      : (automations[0]?.id ?? ""),
  );
  const requestedSelection = useRef(initialSelectedId);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => setDraft(automations), [automations]);
  useEffect(() => {
    if (selectedId && draft.some((item) => item.id === selectedId)) return;
    setSelectedId(draft[0]?.id ?? "");
  }, [draft, selectedId]);
  useEffect(() => {
    if (requestedSelection.current === initialSelectedId) return;
    requestedSelection.current = initialSelectedId;
    if (
      initialSelectedId &&
      draft.some((item) => item.id === initialSelectedId)
    )
      setSelectedId(initialSelectedId);
  }, [draft, initialSelectedId]);
  const selected = draft.find((item) => item.id === selectedId);
  const dirty = JSON.stringify(draft) !== JSON.stringify(automations);
  useEffect(
    () => onStateChange?.({ dirty, pending }),
    [dirty, onStateChange, pending],
  );
  useEffect(
    () => () => onStateChange?.({ dirty: false, pending: false }),
    [onStateChange],
  );
  function updateDraft(next: SandboxAutomation[]) {
    setDraft(next);
    setError("");
  }
  async function save() {
    const snapshot = structuredClone(draft);
    const validationError = snapshot
      .map((automation) => automationLiteralError(automation, design))
      .find((message): message is string => message !== null);
    if (validationError) {
      setError(validationError);
      return;
    }
    setPending(true);
    const result = await saveStudioDraft(snapshot, onChange);
    if (!result.ok)
      setError(
        "The automation change could not be saved. Your draft is still available.",
      );
    setPending(false);
  }
  function update(next: SandboxAutomation) {
    const index = draft.findIndex((item) => item.id === next.id);
    if (index >= 0) updateDraft(replaceAt(draft, index, next));
  }
  return (
    <section
      ref={studioRef}
      aria-labelledby="automation-studio-title"
      className="@container/studio min-w-0"
    >
      <div className="border-border min-w-0 overflow-hidden rounded-xl border @min-[1100px]/studio:h-[calc(100dvh-14rem)] @min-[1100px]/studio:min-h-[38rem]">
        <ResizablePanelGroup
          orientation="horizontal"
          disabled={!wide}
          className="block! h-auto! @min-[1100px]/studio:flex! @min-[1100px]/studio:h-full!"
        >
          <ResizablePanel
            id="automation-list"
            defaultSize="18.2rem"
            minSize={wide ? "18.2rem" : 0}
            groupResizeBehavior="preserve-pixel-size"
            className="min-w-0 overflow-visible! @min-[1100px]/studio:h-full @min-[1100px]/studio:overflow-hidden!"
          >
            <aside
              aria-label="Automation list"
              className="bg-card border-border min-w-0 border-b p-4 @min-[1100px]/studio:h-full @min-[1100px]/studio:overflow-y-auto @min-[1100px]/studio:border-b-0"
            >
              <div className="mb-4 flex items-center justify-between gap-2">
                <h2 id="automation-studio-title" className="font-semibold">
                  Automations
                </h2>
                <span className="text-muted-foreground text-xs">
                  {draft.length}
                </span>
              </div>
              <Button
                variant="outline"
                className="mb-4 min-h-11 w-full"
                onClick={() => {
                  const next = defaultAutomation(design);
                  setSelectedId(next.id);
                  setSelectedStep("trigger");
                  updateDraft([...draft, next]);
                }}
                disabled={pending || draft.length >= 500}
              >
                <Plus aria-hidden="true" />
                New automation
              </Button>
              <nav
                aria-label="Automation list"
                className="grid max-h-64 gap-1 overflow-y-auto @min-[1100px]/studio:max-h-none"
              >
                {draft.map((automation) => (
                  <Button
                    key={automation.id}
                    variant={
                      automation.id === selectedId ? "secondary" : "ghost"
                    }
                    aria-current={
                      automation.id === selectedId ? "true" : undefined
                    }
                    className="h-auto min-h-16 w-full min-w-0 flex-col items-start justify-center gap-1 px-3 py-3 text-left whitespace-normal"
                    onClick={() => {
                      setSelectedId(automation.id);
                      setSelectedStep("trigger");
                    }}
                  >
                    <span className="w-full [overflow-wrap:anywhere] break-words">
                      {automation.name || "Untitled automation"}
                    </span>
                    <span className="text-muted-foreground text-xs font-normal">
                      {automationTriggerLabel(automation)}
                      {!automation.enabled ? " · Disabled" : ""}
                    </span>
                  </Button>
                ))}
              </nav>
            </aside>
          </ResizablePanel>
          {wide && (
            <ResizableHandle withHandle aria-label="Resize automation list" />
          )}
          <ResizablePanel
            id="automation-graph"
            minSize={wide ? "18rem" : 0}
            className="min-w-0 overflow-visible! @min-[1100px]/studio:h-full @min-[1100px]/studio:overflow-hidden!"
          >
            <div className="border-border min-w-0 border-b p-5 @min-[1100px]/studio:h-full @min-[1100px]/studio:overflow-y-auto @min-[1100px]/studio:border-b-0">
              {selected ? (
                <>
                  <div className="border-border mb-5 flex items-start justify-between gap-3 border-b pb-5">
                    <div className="min-w-0">
                      <h2 className="text-lg font-semibold [overflow-wrap:anywhere] break-words">
                        {selected.name || "Untitled automation"}
                      </h2>
                      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                        Follow the steps to see when this automation makes a
                        change.
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11 shrink-0"
                            aria-label="Automation options"
                            disabled={pending}
                          />
                        }
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={pending}
                          onClick={() =>
                            updateDraft(
                              draft.filter((item) => item.id !== selected.id),
                            )
                          }
                        >
                          <Trash2 aria-hidden="true" />
                          Delete automation
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <AutomationFlow
                    automation={selected}
                    design={design}
                    selectedStep={selectedStep}
                    onSelect={selectStep}
                  />
                </>
              ) : (
                <p className="text-muted-foreground py-10 text-sm">
                  Create an automation to define triggers, conditions, and
                  actions.
                </p>
              )}
              <details className="border-border mt-6 border-t pt-4">
                <summary className="focus-visible:outline-ring flex min-h-11 cursor-pointer list-none items-center justify-between text-sm font-medium focus-visible:outline-2">
                  <h3>Recent activity</h3>
                  <ChevronDown className="size-4" aria-hidden="true" />
                </summary>
                <section
                  aria-label="Recent activity details"
                  className="mt-4 grid gap-3"
                >
                  <div>
                    <p className="text-muted-foreground mt-1 text-sm">
                      See what published automations did in the live workspace.
                    </p>
                    <Button
                      variant="outline"
                      className="mt-2 min-h-11"
                      disabled={activity.loading}
                      onClick={() => void onRefreshActivity()}
                    >
                      {activity.loading ? "Refreshing…" : "Refresh activity"}
                    </Button>
                  </div>
                  {activity.error ? (
                    <Alert variant="destructive">
                      {activity.error}{" "}
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-11"
                        onClick={() => void onRefreshActivity()}
                      >
                        Retry
                      </Button>
                    </Alert>
                  ) : null}
                  {runs.length ? (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {runs.map((run) => (
                        <Card key={run.id}>
                          <CardHeader className="gap-1">
                            <CardTitle className="text-base">
                              {run.automationName}
                            </CardTitle>
                            <p className="text-muted-foreground text-xs">
                              <time dateTime={run.createdAt}>
                                {new Date(run.createdAt).toLocaleString()}
                              </time>
                            </p>
                          </CardHeader>
                          <CardContent className="grid gap-1 text-sm">
                            <p className="font-medium">
                              {automationRunStatus(run)}
                            </p>
                            <p className="text-muted-foreground">
                              {runDetail(run)}
                            </p>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  ) : activity.loading ? (
                    <p className="text-muted-foreground text-sm" role="status">
                      Loading recent activity…
                    </p>
                  ) : activity.error ? null : (
                    <p className="text-muted-foreground text-sm">
                      No published automation activity yet.
                    </p>
                  )}
                </section>
              </details>
            </div>
          </ResizablePanel>
          {wide && (
            <ResizableHandle withHandle aria-label="Resize rule settings" />
          )}
          <ResizablePanel
            id="automation-settings"
            defaultSize="26rem"
            minSize={wide ? "13rem" : 0}
            groupResizeBehavior="preserve-pixel-size"
            className="min-w-0 overflow-visible! @min-[1100px]/studio:h-full @min-[1100px]/studio:overflow-hidden!"
          >
            <section
              aria-label="Rule settings"
              className="bg-card @container/settings flex min-w-0 flex-col @min-[1100px]/studio:h-full @min-[1100px]/studio:min-h-0"
            >
              <div className="border-border border-b px-5 py-4">
                <h2 className="font-semibold">Rule settings</h2>
              </div>
              <div
                ref={settingsRef}
                className="min-w-0 flex-1 space-y-4 p-4 @min-[1100px]/studio:overflow-y-auto [&_[data-slot=native-select-wrapper]]:w-full [&_input]:min-w-0 [&_select]:w-full"
                onFocusCapture={(event) => {
                  const target = (
                    event.target as HTMLElement
                  ).closest<HTMLElement>("[data-rule-target]")?.dataset
                    .ruleTarget;
                  if (target) setSelectedStep(target);
                }}
              >
                {error && (
                  <Alert variant="destructive" role="alert">
                    {error}
                  </Alert>
                )}
                {selected && (
                  <AutomationEditor
                    design={design}
                    automation={selected}
                    pending={pending}
                    onChange={update}
                    selectedStep={selectedStep}
                  />
                )}
              </div>
              <div className="border-border flex flex-wrap items-center justify-end gap-3 border-t p-4">
                <p className="text-muted-foreground mr-auto text-xs">
                  Saves all automation drafts. Publishing is a separate step.
                </p>
                <Button
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => {
                    setDraft(automations);
                    setSelectedId(automations[0]?.id ?? "");
                    setSelectedStep("trigger");
                    setError("");
                  }}
                  disabled={pending || !dirty}
                >
                  Discard changes
                </Button>
                <Button
                  className="min-h-11"
                  onClick={() => void save()}
                  disabled={pending || !dirty}
                >
                  {pending ? "Saving…" : "Save automations"}
                </Button>
              </div>
            </section>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </section>
  );
}

function AutomationEditor({
  design,
  automation,
  pending,
  onChange,
  selectedStep,
}: {
  design: SandboxDocumentDesign;
  automation: SandboxAutomation;
  pending: boolean;
  onChange: (automation: SandboxAutomation) => void;
  selectedStep: string;
}) {
  const nameId = useId();
  const triggerId = useId();
  const enabledId = useId();
  const triggerModuleId = useId();
  const scheduleModuleId = useId();
  const scheduleFrequencyId = useId();
  const scheduleTimeId = useId();
  const scheduleWeekdayId = useId();
  const triggerModule = automationOrigin(automation, design);
  const scheduleTrigger =
    automation.trigger.kind === "schedule" ? automation.trigger : null;
  const thresholdTrigger =
    automation.trigger.kind === "threshold-crossed" ? automation.trigger : null;
  const changeTrigger = (kind: SandboxAutomation["trigger"]["kind"]) => {
    const moduleId = firstOpenModule(design);
    const field =
      kind === "threshold-crossed"
        ? firstOpenNumberField(design, moduleId)
        : firstOpenField(design, moduleId);
    const trigger =
      kind === "record-created"
        ? { kind, moduleId }
        : kind === "field-changed"
          ? { kind, moduleId, fieldId: field?.id ?? "" }
          : kind === "threshold-crossed"
            ? {
                kind,
                moduleId,
                fieldId: field?.id ?? "",
                operator: ">=" as const,
                value: defaultLiteral(field),
              }
            : {
                kind: "schedule" as const,
                moduleId,
                frequency: "daily" as const,
                time: "09:00",
              };
    onChange({ ...automation, trigger });
  };
  return (
    <fieldset
      className="grid min-w-0 gap-3 border-0 p-0"
      disabled={pending}
      aria-busy={pending}
    >
      <div className="grid min-w-0 items-end gap-4 @min-[350px]/settings:grid-cols-[minmax(0,1fr)_auto]">
        <Field>
          <FieldLabel htmlFor={nameId}>Automation name</FieldLabel>
          <Input
            id={nameId}
            value={automation.name}
            onChange={(event) =>
              onChange({ ...automation, name: event.target.value })
            }
          />
        </Field>
        <Field className="min-h-11 flex-row items-center justify-between gap-3 @min-[350px]/settings:flex-col @min-[350px]/settings:items-end">
          <FieldLabel htmlFor={enabledId}>Enabled in draft</FieldLabel>
          <Switch
            id={enabledId}
            disabled={pending}
            checked={automation.enabled}
            onCheckedChange={(checked) =>
              onChange({ ...automation, enabled: checked })
            }
          />
        </Field>
      </div>
      <section
        data-rule-target="trigger"
        tabIndex={-1}
        className={`border-border grid grid-cols-1 gap-3 rounded-xl border p-4 @min-[450px]/settings:grid-cols-3 ${selectedStep === "trigger" ? "ring-ring ring-1" : ""}`}
      >
        <h3 className="col-span-full font-semibold">When</h3>
        <p className="text-muted-foreground col-span-full text-sm">
          Choose what starts this automation.
        </p>
        <div className="contents">
          <Field>
            <FieldLabel htmlFor={triggerId}>Trigger</FieldLabel>
            <NativeSelect
              id={triggerId}
              value={automation.trigger.kind}
              onChange={(event) =>
                changeTrigger(
                  event.target.value as SandboxAutomation["trigger"]["kind"],
                )
              }
            >
              <NativeSelectOption value="record-created">
                Item added
              </NativeSelectOption>
              <NativeSelectOption value="field-changed">
                Field changed
              </NativeSelectOption>
              <NativeSelectOption value="threshold-crossed">
                Threshold crossed
              </NativeSelectOption>
              <NativeSelectOption value="schedule">Schedule</NativeSelectOption>
            </NativeSelect>
          </Field>
        </div>
        {automation.trigger.kind !== "schedule" ? (
          <Field>
            <FieldLabel htmlFor={triggerModuleId}>Trigger module</FieldLabel>
            <NativeSelect
              id={triggerModuleId}
              value={triggerModule}
              onChange={(event) => {
                const moduleId = event.target.value;
                const field =
                  automation.trigger.kind === "threshold-crossed"
                    ? firstOpenNumberField(design, moduleId)
                    : firstOpenField(design, moduleId);
                const trigger =
                  automation.trigger.kind === "record-created"
                    ? { kind: "record-created" as const, moduleId }
                    : automation.trigger.kind === "field-changed"
                      ? {
                          kind: "field-changed" as const,
                          moduleId,
                          fieldId: field?.id ?? "",
                        }
                      : {
                          kind: "threshold-crossed" as const,
                          moduleId,
                          fieldId: field?.id ?? "",
                          operator: thresholdTrigger?.operator ?? ">=",
                          value:
                            thresholdTrigger?.value ?? defaultLiteral(field),
                        };
                onChange({ ...automation, trigger });
              }}
            >
              <ModuleOptions design={design} />
            </NativeSelect>
          </Field>
        ) : scheduleTrigger ? (
          <div className="col-span-full grid gap-3 @min-[350px]/settings:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={scheduleModuleId}>Module</FieldLabel>
              <NativeSelect
                id={scheduleModuleId}
                value={scheduleTrigger.moduleId ?? ""}
                onChange={(event) =>
                  onChange({
                    ...automation,
                    trigger: {
                      ...scheduleTrigger,
                      moduleId: event.target.value,
                    },
                  })
                }
              >
                <NativeSelectOption value="">Choose module</NativeSelectOption>
                <ModuleOptions design={design} />
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={scheduleFrequencyId}>Frequency</FieldLabel>
              <NativeSelect
                id={scheduleFrequencyId}
                value={scheduleTrigger.frequency}
                onChange={(event) =>
                  onChange({
                    ...automation,
                    trigger: scheduleFrequencyChange(
                      scheduleTrigger,
                      event.target.value as "daily" | "weekly",
                    ),
                  })
                }
              >
                <NativeSelectOption value="daily">Daily</NativeSelectOption>
                <NativeSelectOption value="weekly">Weekly</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={scheduleTimeId}>Time</FieldLabel>
              <Input
                id={scheduleTimeId}
                type="time"
                value={scheduleTrigger.time}
                onChange={(event) =>
                  onChange({
                    ...automation,
                    trigger: { ...scheduleTrigger, time: event.target.value },
                  })
                }
              />
            </Field>
            {scheduleTrigger.frequency === "weekly" ? (
              <Field>
                <FieldLabel htmlFor={scheduleWeekdayId}>Weekday</FieldLabel>
                <NativeSelect
                  id={scheduleWeekdayId}
                  value={String(scheduleTrigger.weekday ?? 1)}
                  onChange={(event) =>
                    onChange({
                      ...automation,
                      trigger: {
                        ...scheduleTrigger,
                        weekday: Number(event.target.value),
                      },
                    })
                  }
                >
                  {[1, 2, 3, 4, 5, 6, 7].map((weekday) => (
                    <NativeSelectOption key={weekday} value={String(weekday)}>
                      Day {weekday}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
          </div>
        ) : null}
        {automation.trigger.kind === "field-changed" ||
        automation.trigger.kind === "threshold-crossed" ? (
          <TriggerFieldEditor
            design={design}
            automation={automation}
            onChange={onChange}
          />
        ) : null}
      </section>
      <ConditionEditor
        design={design}
        automation={automation}
        onChange={onChange}
        selectedStep={selectedStep}
      />
      <ActionEditor
        design={design}
        automation={automation}
        onChange={onChange}
        selectedStep={selectedStep}
      />
    </fieldset>
  );
}

function TriggerFieldEditor({
  design,
  automation,
  onChange,
}: {
  design: SandboxDocumentDesign;
  automation: SandboxAutomation;
  onChange: (automation: SandboxAutomation) => void;
}) {
  const triggerFieldId = useId();
  const thresholdOperatorId = useId();
  if (
    automation.trigger.kind !== "field-changed" &&
    automation.trigger.kind !== "threshold-crossed"
  )
    return null;
  const trigger = automation.trigger;
  const triggerFields = fieldsFor(design, trigger.moduleId).filter(
    (item) =>
      !item.closed &&
      (trigger.kind !== "threshold-crossed" ||
        item.config.kind === "number" ||
        item.config.kind === "integer"),
  );
  const field = triggerFields.find((item) => item.id === trigger.fieldId);
  return (
    <div
      className={
        trigger.kind === "field-changed"
          ? "contents"
          : "col-span-full grid gap-3 @min-[350px]/settings:grid-cols-2"
      }
    >
      <Field>
        <FieldLabel htmlFor={triggerFieldId}>Trigger field</FieldLabel>
        <NativeSelect
          id={triggerFieldId}
          value={trigger.fieldId}
          onChange={(event) => {
            const nextField = triggerFields.find(
              (item) => item.id === event.target.value,
            );
            onChange({
              ...automation,
              trigger:
                trigger.kind === "field-changed"
                  ? { ...trigger, fieldId: event.target.value }
                  : {
                      ...trigger,
                      fieldId: event.target.value,
                      value: defaultLiteral(nextField),
                    },
            });
          }}
        >
          {triggerFields.map((item) => (
            <NativeSelectOption key={item.id} value={item.id}>
              {item.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {trigger.kind === "threshold-crossed" ? (
        <>
          <Field>
            <FieldLabel htmlFor={thresholdOperatorId}>
              Threshold operator
            </FieldLabel>
            <NativeSelect
              id={thresholdOperatorId}
              value={trigger.operator}
              onChange={(event) =>
                onChange({
                  ...automation,
                  trigger: {
                    ...trigger,
                    operator: event.target
                      .value as SandboxAutomationCondition["operator"],
                  },
                })
              }
            >
              {operators.map((operator) => (
                <NativeSelectOption key={operator} value={operator}>
                  {operator}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <ValueEditor
            design={design}
            automation={automation}
            target={field}
            value={trigger.value}
            onChange={(value) =>
              onChange({ ...automation, trigger: { ...trigger, value } })
            }
          />
        </>
      ) : null}
    </div>
  );
}

function ModuleOptions({ design }: { design: SandboxDocumentDesign }) {
  return (
    <>
      {design.modules
        .filter((item) => !item.closed)
        .map((item) => (
          <NativeSelectOption key={item.id} value={item.id}>
            {item.name}
          </NativeSelectOption>
        ))}
    </>
  );
}

function ConditionEditor({
  design,
  automation,
  onChange,
  selectedStep,
}: {
  design: SandboxDocumentDesign;
  automation: SandboxAutomation;
  onChange: (automation: SandboxAutomation) => void;
  selectedStep: string;
}) {
  const moduleId = automationOrigin(automation, design);
  const update = (index: number, condition: SandboxAutomationCondition) =>
    onChange({
      ...automation,
      conditionGroup: {
        ...automation.conditionGroup,
        conditions: replaceAt(
          automation.conditionGroup.conditions,
          index,
          condition,
        ),
      },
    });
  return (
    <fieldset
      data-rule-target="conditions"
      tabIndex={-1}
      className="border-border grid min-w-0 gap-3 rounded-xl border p-4"
    >
      <legend className="px-1 font-semibold">If</legend>
      <p className="text-muted-foreground text-sm">
        Only continue when these conditions match.
      </p>
      <NativeSelect
        aria-label="Condition group operator"
        value={automation.conditionGroup.operator}
        onChange={(event) =>
          onChange({
            ...automation,
            conditionGroup: {
              ...automation.conditionGroup,
              operator: event.target.value as "all" | "any",
            },
          })
        }
      >
        <NativeSelectOption value="all">
          All conditions match
        </NativeSelectOption>
        <NativeSelectOption value="any">
          Any condition matches
        </NativeSelectOption>
      </NativeSelect>
      {automation.conditionGroup.conditions.map((condition, index) => {
        const target = fieldsFor(design, condition.field.moduleId).find(
          (field) => field.id === condition.field.fieldId,
        );
        return (
          <div
            key={condition.id}
            data-rule-target={`condition:${condition.id}`}
            tabIndex={-1}
            className={`grid min-w-0 gap-3 rounded-lg p-2 ${selectedStep === `condition:${condition.id}` ? "bg-accent ring-ring ring-1" : "bg-muted/40"}`}
          >
            <div className="grid gap-2 @min-[350px]/settings:grid-cols-2">
              <NativeSelect
                aria-label={`Condition ${index + 1} field`}
                value={
                  condition.field.moduleId === moduleId
                    ? condition.field.fieldId
                    : (firstOpenField(design, moduleId)?.id ?? "")
                }
                onChange={(event) => {
                  const field = fieldsFor(design, moduleId).find(
                    (item) => item.id === event.target.value,
                  );
                  update(index, {
                    ...condition,
                    field: {
                      moduleId,
                      fieldId: event.target.value,
                    },
                    value: defaultLiteral(field),
                  });
                }}
              >
                {fieldsFor(design, moduleId)
                  .filter((field) => !field.closed)
                  .map((field) => (
                    <NativeSelectOption key={field.id} value={field.id}>
                      {field.name}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
              <NativeSelect
                aria-label={`Condition ${index + 1} operator`}
                value={condition.operator}
                onChange={(event) =>
                  update(index, {
                    ...condition,
                    operator: event.target
                      .value as SandboxAutomationCondition["operator"],
                  })
                }
              >
                {operators.map((operator) => (
                  <NativeSelectOption key={operator} value={operator}>
                    {operator}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <ValueEditor
              design={design}
              automation={automation}
              target={
                condition.field.moduleId === moduleId
                  ? target
                  : firstOpenField(design, moduleId)
              }
              value={condition.value}
              onChange={(value) => update(index, { ...condition, value })}
            />
            <Button
              variant="ghost"
              onClick={() =>
                onChange({
                  ...automation,
                  conditionGroup: {
                    ...automation.conditionGroup,
                    conditions: automation.conditionGroup.conditions.filter(
                      (item) => item.id !== condition.id,
                    ),
                  },
                })
              }
            >
              Remove condition
            </Button>
          </div>
        );
      })}
      <Button
        variant="outline"
        onClick={() => onChange(addAutomationCondition(automation, design))}
        disabled={automation.conditionGroup.conditions.length >= 20}
      >
        Add condition
      </Button>
    </fieldset>
  );
}

function ActionEditor({
  design,
  automation,
  onChange,
  selectedStep,
}: {
  design: SandboxDocumentDesign;
  automation: SandboxAutomation;
  onChange: (automation: SandboxAutomation) => void;
  selectedStep: string;
}) {
  const update = (index: number, action: SandboxAutomationAction) =>
    onChange({
      ...automation,
      actions: replaceAt(automation.actions, index, action),
    });
  return (
    <fieldset
      data-rule-target="actions"
      tabIndex={-1}
      className="border-border grid min-w-0 gap-3 rounded-xl border p-4"
    >
      <legend className="px-1 font-semibold">Then</legend>
      <p className="text-muted-foreground text-sm">
        Choose what changes when the conditions match.
      </p>
      {automation.actions.map((action, index) => (
        <div
          key={action.id}
          data-rule-target={`action:${action.id}`}
          tabIndex={-1}
          className={`grid min-w-0 gap-3 rounded-lg p-2 ${selectedStep === `action:${action.id}` ? "bg-accent ring-ring ring-1" : "bg-muted/40"}`}
        >
          <p className="text-sm font-medium">
            {action.kind === "set-field" ? "Set field" : "Unsupported action"}
          </p>
          {action.kind === "set-field" ? (
            <SetFieldAction
              design={design}
              automation={automation}
              action={action}
              onChange={(next) => update(index, next)}
            />
          ) : (
            <Alert variant="destructive" role="alert">
              This imported action is not supported for publishing. Remove it or
              replace it with Set field.
            </Alert>
          )}
          <Button
            variant="ghost"
            onClick={() =>
              onChange({
                ...automation,
                actions: automation.actions.filter(
                  (item) => item.id !== action.id,
                ),
              })
            }
          >
            Remove action
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        onClick={() => onChange(addAutomationAction(automation, design))}
        disabled={automation.actions.length >= 20}
      >
        Add action
      </Button>
    </fieldset>
  );
}

function SetFieldAction({
  design,
  automation,
  action,
  onChange,
}: {
  design: SandboxDocumentDesign;
  automation: SandboxAutomation;
  action: Extract<SandboxAutomationAction, { kind: "set-field" }>;
  onChange: (action: SandboxAutomationAction) => void;
}) {
  const target = fieldsFor(design, action.target.moduleId).find(
    (field) => field.id === action.target.fieldId,
  );
  const moduleId = automationOrigin(automation, design);
  return (
    <div className="grid gap-2">
      <NativeSelect
        aria-label="Set field target"
        value={
          action.target.moduleId === moduleId
            ? action.target.fieldId
            : (firstOpenField(design, moduleId)?.id ?? "")
        }
        onChange={(event) => {
          const field = fieldsFor(design, moduleId).find(
            (item) => item.id === event.target.value,
          );
          onChange({
            ...action,
            target: { moduleId, fieldId: event.target.value },
            value: defaultLiteral(field),
          });
        }}
      >
        {fieldsFor(design, moduleId)
          .filter((field) => !field.closed)
          .map((field) => (
            <NativeSelectOption key={field.id} value={field.id}>
              {field.name}
            </NativeSelectOption>
          ))}
      </NativeSelect>
      <ValueEditor
        design={design}
        automation={automation}
        target={
          action.target.moduleId === moduleId
            ? target
            : firstOpenField(design, moduleId)
        }
        value={action.value}
        onChange={(value) => onChange({ ...action, value })}
      />
    </div>
  );
}
