import type { SandboxCanvasLayout } from "@/lib/sandbox/model";
import { dateRangeFits } from "./date-values";

export const FIELD_TYPES = [
  { name: "Text", kind: "text" },
  { name: "Long text", kind: "long-text" },
  { name: "Number", kind: "number" },
  { name: "Integer", kind: "integer" },
  { name: "Date", kind: "date" },
  { name: "Date/Time", kind: "datetime" },
  { name: "Checkbox", kind: "checkbox" },
  { name: "Select", kind: "select" },
  { name: "User", kind: "user" },
  { name: "Email", kind: "email" },
  { name: "URL", kind: "url" },
] as const;

export type FieldTypeName = (typeof FIELD_TYPES)[number]["name"];
export type SelectOption = { id: string; label: string };
export type FieldConfig =
  | {
      kind: "text" | "long-text" | "email" | "url";
      defaultValue: string;
      maxLength?: number;
    }
  | {
      kind: "number" | "integer";
      defaultValue: number | null;
      min?: number;
      max?: number;
      step?: number;
    }
  | {
      kind: "date" | "datetime";
      defaultValue: string | null;
      earliest?: string;
      latest?: string;
    }
  | { kind: "checkbox"; defaultValue: boolean }
  | { kind: "select"; defaultValue: string | null; options: SelectOption[] }
  | { kind: "user" };

export type SandboxDesignTarget = {
  kind: "department" | "module" | "field" | "link";
  id: string;
};
export type Field = {
  id: string;
  name: string;
  type: string;
  required: boolean;
  value: string;
  options: string;
  closed: boolean;
  description?: string;
  config?: FieldConfig;
};
export type Department = { id: string; name: string; closed: boolean };
export type Module = {
  id: string;
  department: string;
  name: string;
  closed: boolean;
  fields: Field[];
  titleFieldId?: string | null;
  x: number;
  y: number;
};
export type RelationshipFieldMapping = {
  sourceFieldId: string;
  targetFieldId: string;
};
export type Relationship = {
  id: string;
  name: string;
  source: string;
  target: string;
  cardinality: string;
  fieldMappings: RelationshipFieldMapping[];
};
export type RuleOperator = ">" | ">=" | "<" | "<=" | "=" | "!=";
export type RuleTrigger =
  | { kind: "new-record"; moduleId: string }
  | { kind: "field-change"; moduleId: string; fieldId: string }
  | {
      kind: "threshold";
      moduleId: string;
      fieldId: string;
      operator: RuleOperator;
      value: string;
    }
  | {
      kind: "schedule";
      frequency: "daily" | "weekly";
      time: string;
      weekday?: number;
    };
export type RuleCondition =
  | { kind: "always" }
  | {
      kind: "field-comparison";
      moduleId: string;
      fieldId: string;
      operator: RuleOperator;
      value: string;
    };
export type RuleAction =
  | { kind: "notification"; message: string }
  | { kind: "channel-message"; channel: string }
  | { kind: "create-record"; moduleId: string; fieldId: string; value: string }
  | { kind: "update-field"; moduleId: string; fieldId: string; value: string }
  | { kind: "assign-task"; assignee: string };
export type RuleConfig = {
  trigger: RuleTrigger;
  condition: RuleCondition;
  action: RuleAction;
};
export type Rule = {
  id: string;
  name: string;
  trigger: string;
  condition: string;
  action: string;
  enabled: boolean;
  config?: RuleConfig;
};
export type DesignUpdate = Design | ((previous: Design) => Design);
export type Design = {
  layout?: SandboxCanvasLayout;
  departments: Department[];
  modules: Module[];
  relationships: Relationship[];
  rules: Rule[];
};
export type Version = {
  id: string;
  label: string;
  design: Design;
  published: boolean;
  date: string;
  note?: string;
};

export function appendVersion(
  versions: Version[],
  version: Version,
): Version[] {
  return [...versions.slice(-49), version];
}

const canonicalFieldNames = new Map<string, FieldTypeName>([
  ...FIELD_TYPES.map((entry) => [entry.name, entry.name] as const),
  ["Date time", "Date/Time"],
  ["Decimal", "Number"],
]);

export function canonicalFieldType(type: string): FieldTypeName | null {
  return canonicalFieldNames.get(type) ?? null;
}

export function relationshipFieldTypesAreCompatible(
  source: Field,
  target: Field,
): boolean {
  const sourceType = canonicalFieldType(source.type);
  const targetType = canonicalFieldType(target.type);
  if (!sourceType || !targetType) return false;
  if (!source.required && target.required) return false;
  if (sourceType === "Select" && targetType === "Select") {
    const sourceConfig = normalizeField(source).config;
    const targetConfig = normalizeField(target).config;
    return (
      sourceConfig.kind === "select" &&
      targetConfig.kind === "select" &&
      sourceConfig.options.every((option) =>
        targetConfig.options.some(
          (candidate) => candidate.label === option.label,
        ),
      )
    );
  }
  if (
    (sourceType === "Integer" || sourceType === "Number") &&
    (targetType === "Integer" || targetType === "Number")
  ) {
    if (!(
      sourceType === targetType ||
      (sourceType === "Integer" && targetType === "Number")
    ))
      return false;
    const sourceConfig = normalizeField(source).config;
    const targetConfig = normalizeField(target).config;
    if (
      (sourceConfig.kind !== "integer" && sourceConfig.kind !== "number") ||
      (targetConfig.kind !== "integer" && targetConfig.kind !== "number")
    )
      return false;
    if (
      (targetConfig.min !== undefined &&
        (sourceConfig.min === undefined ||
          sourceConfig.min < targetConfig.min)) ||
      (targetConfig.max !== undefined &&
        (sourceConfig.max === undefined || sourceConfig.max > targetConfig.max))
    )
      return false;
    if (targetConfig.step === undefined) return true;
    const sourceStep = sourceConfig.step;
    if (sourceStep === undefined) return false;
    return (
      isStepAligned(sourceStep, targetConfig.step) &&
      isStepAligned(
        (sourceConfig.min ?? 0) - (targetConfig.min ?? 0),
        targetConfig.step,
      )
    );
  }
  if (sourceType === "Date" || sourceType === "Date/Time") {
    if (sourceType !== targetType) return false;
    const sourceConfig = normalizeField(source).config;
    const targetConfig = normalizeField(target).config;
    if (
      (sourceConfig.kind !== "date" && sourceConfig.kind !== "datetime") ||
      (targetConfig.kind !== "date" && targetConfig.kind !== "datetime")
    )
      return false;
    return dateRangeFits(
      sourceConfig.kind,
      sourceConfig.earliest,
      sourceConfig.latest,
      targetConfig.earliest,
      targetConfig.latest,
    );
  }
  const textLikeTypes = new Set<FieldTypeName>([
    "Text",
    "Long text",
    "Email",
    "URL",
  ]);
  const plainTextTypes = new Set<FieldTypeName>(["Text", "Long text"]);
  if (textLikeTypes.has(sourceType) && plainTextTypes.has(targetType)) {
    const sourceConfig = normalizeField(source).config;
    const targetConfig = normalizeField(target).config;
    const sourceMaxLength =
      "maxLength" in sourceConfig ? sourceConfig.maxLength : undefined;
    const targetMaxLength =
      "maxLength" in targetConfig ? targetConfig.maxLength : undefined;
    return (
      targetMaxLength === undefined ||
      (sourceMaxLength !== undefined && sourceMaxLength <= targetMaxLength)
    );
  }
  if (sourceType === "Email" && targetType === "Email") return true;
  if (sourceType === "URL" && targetType === "URL") return true;
  return sourceType === targetType;
}

function isStepAligned(value: number, step: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
    return false;
  const quotient = value / step;
  const tolerance = Math.min(
    1e-7,
    Number.EPSILON * 32 * Math.max(1, Math.abs(quotient)),
  );
  return Math.abs(quotient - Math.round(quotient)) <= tolerance;
}

function numericDefault(value: string): number | null {
  if (!value.trim()) return null;
  return Number(value);
}

function stableLegacyOptionId(fieldId: string, label: string): string {
  // Legacy in-memory Designer fixtures contain labels only. Give those labels
  // deterministic UUIDs so repeated projections do not manufacture changes;
  // all newly authored and persisted v4 options carry their own IDs.
  const input = `${fieldId}\u0000${label}`;
  const hashes = [2166136261, 2246822519, 3266489917, 668265263];
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    for (let part = 0; part < hashes.length; part += 1) {
      hashes[part] = Math.imul(hashes[part] ^ (code + part * 131), 16777619);
    }
  }
  const hex = hashes
    .map((hash) => (hash >>> 0).toString(16).padStart(8, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function normalizeField(field: Field): Field & { config: FieldConfig } {
  const type = canonicalFieldType(field.type) ?? "Text";
  let config: FieldConfig;
  switch (type) {
    case "Number":
    case "Integer": {
      const kind = type === "Number" ? "number" : "integer";
      config =
        field.config?.kind === kind
          ? kind === "integer"
            ? { ...field.config, step: 1 }
            : field.config
          : {
              kind,
              defaultValue: numericDefault(field.value),
              ...(kind === "integer" ? { step: 1 } : {}),
            };
      break;
    }
    case "Date":
    case "Date/Time": {
      const kind = type === "Date" ? "date" : "datetime";
      config =
        field.config?.kind === kind
          ? field.config
          : { kind, defaultValue: field.value.trim() || null };
      break;
    }
    case "Checkbox":
      config =
        field.config?.kind === "checkbox"
          ? field.config
          : { kind: "checkbox", defaultValue: field.value === "true" };
      break;
    case "User":
      config = { kind: "user" };
      break;
    case "Select": {
      const rawOptions =
        field.config?.kind === "select"
          ? field.config.options
          : field.options
              .split(",")
              .map((label) => label.trim())
              .filter(Boolean)
              .map((label) => ({
                id: stableLegacyOptionId(field.id, label),
                label,
              }));
      const options: SelectOption[] = [];
      for (const rawOption of rawOptions) {
        const label = rawOption.label.trim();
        if (!label || options.some((option) => option.label === label))
          continue;
        options.push({ id: rawOption.id, label });
      }
      const rawDefault =
        field.config?.kind === "select"
          ? field.config.defaultValue
          : field.value.trim() || null;
      const defaultValue =
        options.find((option) => option.id === rawDefault)?.id ??
        options.find((option) => option.label === rawDefault)?.id ??
        rawDefault;
      config = { kind: "select", defaultValue, options };
      break;
    }
    case "Text":
    case "Long text":
    case "Email":
    case "URL": {
      const kind =
        type === "Text"
          ? "text"
          : type === "Long text"
            ? "long-text"
            : (type.toLowerCase() as "email" | "url");
      config =
        field.config?.kind === kind
          ? field.config
          : { kind, defaultValue: field.value };
    }
  }
  return { ...field, type, config };
}

function firstOpenModule(design?: Design): Module | undefined {
  return design?.modules.find((item) => !item.closed) ?? design?.modules[0];
}

function fieldByName(
  sandboxModule: Module | undefined,
  name: string,
): Field | undefined {
  return (
    sandboxModule?.fields.find(
      (field) =>
        !field.closed && field.name.toLowerCase() === name.toLowerCase(),
    ) ?? sandboxModule?.fields.find((field) => !field.closed)
  );
}

export function normalizeRule(
  rule: Rule,
  design?: Design,
): Rule & { config: RuleConfig } {
  if (rule.config) return rule as Rule & { config: RuleConfig };
  const sandboxModule = firstOpenModule(design);
  const priority = fieldByName(sandboxModule, "Priority");
  const status = fieldByName(sandboxModule, "Status");
  const trigger: RuleTrigger =
    rule.trigger === "Field change"
      ? {
          kind: "field-change",
          moduleId: sandboxModule?.id ?? "",
          fieldId: status?.id ?? "",
        }
      : rule.trigger === "Threshold"
        ? {
            kind: "threshold",
            moduleId: sandboxModule?.id ?? "",
            fieldId: priority?.id ?? "",
            operator: ">=",
            value: "1",
          }
        : rule.trigger === "Schedule"
          ? { kind: "schedule", frequency: "daily", time: "09:00" }
          : { kind: "new-record", moduleId: sandboxModule?.id ?? "" };
  const condition: RuleCondition =
    rule.condition === "Always"
      ? { kind: "always" }
      : {
          kind: "field-comparison",
          moduleId: sandboxModule?.id ?? "",
          fieldId:
            rule.condition === "Status is open"
              ? (status?.id ?? "")
              : (priority?.id ?? ""),
          operator: "=",
          value: rule.condition === "Status is open" ? "Open" : "Urgent",
        };
  const action: RuleAction =
    rule.action === "Send a channel message"
      ? { kind: "channel-message", channel: rule.name }
      : rule.action === "Create a record"
        ? {
            kind: "create-record",
            moduleId: sandboxModule?.id ?? "",
            fieldId: status?.id ?? "",
            value: status?.value ?? "",
          }
        : rule.action === "Update a field"
          ? {
              kind: "update-field",
              moduleId: sandboxModule?.id ?? "",
              fieldId: status?.id ?? "",
              value: status?.value ?? "",
            }
          : rule.action === "Assign a task"
            ? { kind: "assign-task", assignee: rule.name }
            : {
                kind: "notification",
                message: rule.action,
              };
  return { ...rule, config: { trigger, condition, action } };
}

export function ruleConfigLabels(config: RuleConfig, design: Design) {
  const moduleName = (id: string) =>
    design.modules.find((item) => item.id === id)?.name ?? "Missing module";
  const fieldName = (moduleId: string, fieldId: string) =>
    design.modules
      .find((item) => item.id === moduleId)
      ?.fields.find((item) => item.id === fieldId)?.name ?? "Missing field";
  const trigger = (() => {
    switch (config.trigger.kind) {
      case "new-record":
        return `New record in ${moduleName(config.trigger.moduleId)}`;
      case "field-change":
        return `${fieldName(config.trigger.moduleId, config.trigger.fieldId)} changes`;
      case "threshold":
        return `${fieldName(config.trigger.moduleId, config.trigger.fieldId)} ${config.trigger.operator} ${config.trigger.value}`;
      case "schedule":
        return `${config.trigger.frequency === "daily" ? "Daily" : `Weekly, day ${config.trigger.weekday ?? 1}`} at ${config.trigger.time}`;
    }
  })();
  const condition =
    config.condition.kind === "always"
      ? "Always"
      : `${fieldName(config.condition.moduleId, config.condition.fieldId)} ${config.condition.operator} ${config.condition.value}`;
  const action = (() => {
    switch (config.action.kind) {
      case "notification":
        return `Notify: ${config.action.message}`;
      case "channel-message":
        return `Message #${config.action.channel}`;
      case "create-record":
        return `Create ${moduleName(config.action.moduleId)} record with ${fieldName(config.action.moduleId, config.action.fieldId)} = ${config.action.value}`;
      case "update-field":
        return `Set ${fieldName(config.action.moduleId, config.action.fieldId)} to ${config.action.value}`;
      case "assign-task":
        return `Assign task to ${config.action.assignee}`;
    }
  })();
  return { trigger, condition, action };
}
export const uid = () => `sandbox-${crypto.randomUUID()}`;
export const initialDesign: Design = {
  departments: [],
  modules: [],
  relationships: [],
  rules: [],
  layout: {},
};
const countOf = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
export const counts = (d: Design) =>
  [
    countOf(d.departments.length, "department"),
    countOf(d.modules.length, "module"),
    countOf(
      d.modules.reduce((n, m) => n + m.fields.length, 0),
      "field",
    ),
    countOf(d.relationships.length, "relationship"),
    countOf(d.rules.length, "trigger"),
  ].join(" · ");
export function reorder<T>(items: T[], index: number, delta: number): T[] {
  const next = [...items];
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export const compactDefaultLayout: SandboxCanvasLayout = {};

export function changesFrom(
  previous: Design | undefined,
  next: Design,
): string[] {
  if (!previous) return ["Initial version created"];
  const changes: string[] = [];
  const same = (before: unknown, after: unknown) =>
    JSON.stringify(before) === JSON.stringify(after);
  const fieldSettings = (field: Field) => {
    const normalized = normalizeField(field);
    return {
      type: normalized.type,
      required: normalized.required,
      description: normalized.description,
      config: normalized.config,
    };
  };
  const orderChanged = <T extends { id: string }>(before: T[], after: T[]) => {
    const shared = new Set(
      before
        .filter((item) => after.some((candidate) => candidate.id === item.id))
        .map((item) => item.id),
    );
    return (
      shared.size > 1 &&
      before
        .map((item) => item.id)
        .filter((id) => shared.has(id))
        .join() !==
        after
          .map((item) => item.id)
          .filter((id) => shared.has(id))
          .join()
    );
  };

  for (const department of next.departments) {
    const old = previous.departments.find((item) => item.id === department.id);
    if (!old) {
      changes.push(`Department added: ${department.name}`);
      continue;
    }
    if (old.name !== department.name)
      changes.push(`Department changed: ${old.name} → ${department.name}`);
    if (old.closed !== department.closed)
      changes.push(
        `Department ${department.closed ? "closed" : "reopened"}: ${department.name}`,
      );
  }
  for (const department of previous.departments)
    if (!next.departments.some((item) => item.id === department.id))
      changes.push(`Department removed: ${department.name}`);
  if (orderChanged(previous.departments, next.departments))
    changes.push("Department order changed");

  for (const sandboxModule of next.modules) {
    const old = previous.modules.find((item) => item.id === sandboxModule.id);
    if (!old) {
      changes.push(`Module added: ${sandboxModule.name}`);
      for (const field of sandboxModule.fields)
        changes.push(`Field added: ${sandboxModule.name} · ${field.name}`);
      continue;
    }
    if (old.name !== sandboxModule.name)
      changes.push(`Module changed: ${old.name} → ${sandboxModule.name}`);
    if (old.closed !== sandboxModule.closed)
      changes.push(
        `Module ${sandboxModule.closed ? "closed" : "reopened"}: ${sandboxModule.name}`,
      );
    if (old.department !== sandboxModule.department) {
      const beforeDepartment =
        previous.departments.find((item) => item.id === old.department)?.name ??
        old.department;
      const afterDepartment =
        next.departments.find((item) => item.id === sandboxModule.department)
          ?.name ?? sandboxModule.department;
      changes.push(
        `Module moved: ${sandboxModule.name} · ${beforeDepartment} → ${afterDepartment}`,
      );
    }

    for (const field of sandboxModule.fields) {
      const previousField = old.fields.find((item) => item.id === field.id);
      if (!previousField) {
        changes.push(`Field added: ${sandboxModule.name} · ${field.name}`);
        continue;
      }
      if (previousField.name !== field.name)
        changes.push(
          `Field changed: ${sandboxModule.name} · ${previousField.name} → ${field.name}`,
        );
      if (previousField.closed !== field.closed)
        changes.push(
          `Field ${field.closed ? "closed" : "reopened"}: ${sandboxModule.name} · ${field.name}`,
        );
      if (!same(fieldSettings(previousField), fieldSettings(field)))
        changes.push(
          `Field settings changed: ${sandboxModule.name} · ${field.name}`,
        );
    }
    for (const field of old.fields)
      if (!sandboxModule.fields.some((item) => item.id === field.id))
        changes.push(`Field removed: ${sandboxModule.name} · ${field.name}`);
    if (orderChanged(old.fields, sandboxModule.fields))
      changes.push(`Field order changed: ${sandboxModule.name}`);
  }
  for (const sandboxModule of previous.modules)
    if (!next.modules.some((item) => item.id === sandboxModule.id)) {
      changes.push(`Module removed: ${sandboxModule.name}`);
      for (const field of sandboxModule.fields)
        changes.push(`Field removed: ${sandboxModule.name} · ${field.name}`);
    }
  if (orderChanged(previous.modules, next.modules))
    changes.push("Module order changed");

  const compareNamedGroup = <T extends { id: string; name: string }>(
    name: "Relationship" | "Trigger",
    before: T[],
    after: T[],
  ) => {
    for (const item of after) {
      const old = before.find((candidate) => candidate.id === item.id);
      if (!old) changes.push(`${name} added: ${item.name}`);
      else if (!same(old, item)) changes.push(`${name} changed: ${item.name}`);
    }
    for (const item of before)
      if (!after.some((candidate) => candidate.id === item.id))
        changes.push(`${name} removed: ${item.name}`);
    if (orderChanged(before, after)) changes.push(`${name} order changed`);
  };
  compareNamedGroup("Relationship", previous.relationships, next.relationships);
  compareNamedGroup("Trigger", previous.rules, next.rules);
  if (
    JSON.stringify(previous.layout ?? compactDefaultLayout) !==
    JSON.stringify(next.layout ?? compactDefaultLayout)
  )
    changes.push("Canvas layout changed");
  return changes.length
    ? changes
    : ["No structural changes since the last publication."];
}
