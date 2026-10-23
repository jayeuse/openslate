// The trigger rules the Triggers section edits by: what counts as unsaved,
// which settings cannot publish, which fixed values do not fit their field,
// and the defaults for a new trigger, condition, or action. The list pane,
// the When/If/Then rail, and the trigger draft all read them from here.

import type {
  SandboxTrigger,
  SandboxTriggerCondition,
  SandboxTriggerEvent,
  SandboxDocumentDesign,
  SandboxDocumentField,
  SandboxFieldReference,
  SandboxFieldValue,
  SandboxValueSource,
} from "./document";
import { issue, type SandboxValidationIssue } from "./validation-types";
import { dateRangeFits, dateValueInRange } from "./date-values";

/** Counts triggers added, changed, or deleted, matched by id. */
export function unsavedTriggerChanges(
  draft: readonly SandboxTrigger[],
  saved: readonly SandboxTrigger[],
): number {
  const savedById = new Map(saved.map((item) => [item.id, item]));
  const draftIds = new Set(draft.map((item) => item.id));
  const changed = draft.filter((item) => {
    const before = savedById.get(item.id);
    return !before || JSON.stringify(before) !== JSON.stringify(item);
  }).length;
  return changed + saved.filter((item) => !draftIds.has(item.id)).length;
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function fieldsFor(
  design: SandboxDocumentDesign,
  moduleId: string,
): SandboxDocumentField[] {
  return design.modules.find((item) => item.id === moduleId)?.fields ?? [];
}

export function defaultLiteral(
  field: SandboxDocumentField | undefined,
): SandboxValueSource {
  if (!field) return { kind: "literal", value: "" };
  return {
    kind: "literal",
    value: field.config.kind === "user" ? null : field.config.defaultValue,
  };
}

export function firstOpenModule(design: SandboxDocumentDesign): string {
  return (
    design.modules.find((item) => !item.closed)?.id ??
    design.modules[0]?.id ??
    ""
  );
}

export function firstOpenField(
  design: SandboxDocumentDesign,
  moduleId: string,
): SandboxDocumentField | undefined {
  return fieldsFor(design, moduleId).find((field) => !field.closed);
}

export function firstOpenNumberField(
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
    return source.config.options.every((option) =>
      targetOptions.some((candidate) => candidate.label === option.label),
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

export function triggerOrigin(
  recordTrigger: SandboxTrigger,
  design: SandboxDocumentDesign,
): string {
  if (recordTrigger.trigger.kind !== "schedule")
    return recordTrigger.trigger.moduleId;
  return recordTrigger.trigger.moduleId ?? firstOpenModule(design);
}

/**
 * Trigger settings the server cannot publish. Each one is an issue on its
 * trigger, so the page's "need attention" list opens that trigger.
 */
export function triggerPublicationBlockers(
  triggers: readonly SandboxTrigger[],
  design: SandboxDocumentDesign,
): SandboxValidationIssue[] {
  return triggers.flatMap((recordTrigger) => {
    const moduleId = triggerOrigin(recordTrigger, design);
    const messages: string[] = [];
    if (
      recordTrigger.trigger.kind === "schedule" &&
      !recordTrigger.trigger.moduleId
    )
      messages.push(`${recordTrigger.name}: scheduled triggers need a module.`);
    for (const condition of recordTrigger.conditionGroup.conditions)
      if (
        condition.field.moduleId !== moduleId ||
        condition.field.relationshipId !== undefined ||
        (condition.value.kind === "field-reference" &&
          (condition.value.moduleId !== moduleId ||
            condition.value.relationshipId !== undefined))
      )
        messages.push(
          `${recordTrigger.name}: conditions must use fields from the same module.`,
        );
    for (const action of recordTrigger.actions) {
      if (action.kind !== "set-field") {
        messages.push(
          `${recordTrigger.name}: ${action.kind} actions can't be published yet.`,
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
        messages.push(
          `${recordTrigger.name}: Set field must stay in the same module.`,
        );
    }
    return [...new Set(messages)].map((message) =>
      issue("trigger.publish_blocked", message, recordTrigger.id),
    );
  });
}

export type ReferenceOption = {
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
  trigger: Extract<SandboxTriggerEvent, { kind: "schedule" }>,
  frequency: "daily" | "weekly",
): Extract<SandboxTriggerEvent, { kind: "schedule" }> {
  const { weekday, ...withoutWeekday } = trigger;
  return frequency === "weekly"
    ? { ...withoutWeekday, frequency, weekday: weekday ?? 1 }
    : { ...withoutWeekday, frequency };
}

export function compatibleReferenceOptions(
  design: SandboxDocumentDesign,
  recordTrigger: SandboxTrigger,
  target: SandboxDocumentField | undefined,
): ReferenceOption[] {
  if (!target) return [];
  const origin = triggerOrigin(recordTrigger, design);
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

export function parseLiteral(
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

export function displayLiteral(value: SandboxFieldValue): string {
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
    !config.options.some((option) => option.id === value)
  )
    return `${field.name} must use a configured option.`;
  return null;
}

/**
 * Fixed values that do not fit their field, by flow step ("trigger",
 * "condition:<id>", "action:<id>"), so the flow can mark a step before
 * Save refuses it.
 */
export function triggerStepErrors(
  recordTrigger: SandboxTrigger,
  design: SandboxDocumentDesign,
): Map<string, string> {
  const errors = new Map<string, string>();
  const check = (
    step: string,
    value: SandboxValueSource,
    field: SandboxDocumentField | undefined,
  ) => {
    const error =
      value.kind === "literal" && field
        ? validateFieldLiteral(value.value, field)
        : null;
    if (error && !errors.has(step)) errors.set(step, error);
  };
  const trigger = recordTrigger.trigger;
  if (trigger.kind === "threshold-crossed")
    check(
      "trigger",
      trigger.value,
      fieldsFor(design, trigger.moduleId).find(
        (field) => field.id === trigger.fieldId,
      ),
    );
  for (const condition of recordTrigger.conditionGroup.conditions)
    check(
      `condition:${condition.id}`,
      condition.value,
      fieldsFor(design, condition.field.moduleId).find(
        (field) => field.id === condition.field.fieldId,
      ),
    );
  for (const action of recordTrigger.actions) {
    if (action.kind === "set-field")
      check(
        `action:${action.id}`,
        action.value,
        fieldsFor(design, action.target.moduleId).find(
          (field) => field.id === action.target.fieldId,
        ),
      );
    if (action.kind === "create-record")
      for (const value of action.values)
        check(
          `action:${action.id}`,
          value.value,
          fieldsFor(design, action.moduleId).find(
            (field) => field.id === value.fieldId,
          ),
        );
  }
  return errors;
}

/** The first fixed value that does not fit its field, as Save reports it. */
export function triggerLiteralError(
  recordTrigger: SandboxTrigger,
  design: SandboxDocumentDesign,
): string | null {
  return triggerStepErrors(recordTrigger, design).values().next().value ?? null;
}

export function defaultTrigger(design: SandboxDocumentDesign): SandboxTrigger {
  const moduleId = firstOpenModule(design);
  return {
    id: newId("trigger"),
    name: "New trigger",
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

export function addTriggerCondition(
  recordTrigger: SandboxTrigger,
  design: SandboxDocumentDesign,
): SandboxTrigger {
  if (recordTrigger.conditionGroup.conditions.length >= 20)
    return recordTrigger;
  const moduleId = triggerOrigin(recordTrigger, design);
  const field = firstOpenField(design, moduleId);
  if (!field) return recordTrigger;
  const condition: SandboxTriggerCondition = {
    id: newId("condition"),
    field: { moduleId, fieldId: field.id },
    operator: "=",
    value: defaultLiteral(field),
  };
  return {
    ...recordTrigger,
    conditionGroup: {
      ...recordTrigger.conditionGroup,
      conditions: [...recordTrigger.conditionGroup.conditions, condition],
    },
  };
}

export function addTriggerAction(
  recordTrigger: SandboxTrigger,
  design: SandboxDocumentDesign,
): SandboxTrigger {
  if (recordTrigger.actions.length >= 20) return recordTrigger;
  const moduleId = triggerOrigin(recordTrigger, design);
  const field = firstOpenField(design, moduleId);
  return {
    ...recordTrigger,
    actions: [
      ...recordTrigger.actions,
      {
        id: newId("action"),
        kind: "set-field",
        target: { moduleId, fieldId: field?.id ?? "" },
        value: defaultLiteral(field),
      },
    ],
  };
}

export function replaceAt<T>(items: readonly T[], index: number, next: T): T[] {
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}
