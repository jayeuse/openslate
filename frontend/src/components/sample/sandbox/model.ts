import { MODULE_TABLE, moduleTableHeight } from "@/lib/sandbox/x6-adapter";
import type { SandboxCanvasLayout } from "@/components/sandbox/sandbox-canvas";

export const FIELD_TYPES = [
  { name: "Text", kind: "text" },
  { name: "Long text", kind: "long-text" },
  { name: "Number", kind: "number" },
  { name: "Integer", kind: "integer" },
  { name: "Date", kind: "date" },
  { name: "Date/Time", kind: "datetime" },
  { name: "Checkbox", kind: "checkbox" },
  { name: "Select", kind: "select" },
  { name: "Email", kind: "email" },
  { name: "URL", kind: "url" },
] as const;

export type FieldTypeName = (typeof FIELD_TYPES)[number]["name"];
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
  | { kind: "select"; defaultValue: string | null; options: string[] };

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
  x: number;
  y: number;
};
export type Relationship = {
  id: string;
  name: string;
  source: string;
  target: string;
  cardinality: string;
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

function numericDefault(value: string): number | null {
  if (!value.trim()) return null;
  return Number(value);
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
    case "Select": {
      const rawOptions =
        field.config?.kind === "select"
          ? field.config.options
          : field.options.split(",");
      const options = [
        ...new Set(rawOptions.map((option) => option.trim()).filter(Boolean)),
      ];
      const rawDefault =
        field.config?.kind === "select"
          ? field.config.defaultValue
          : field.value.trim() || null;
      config = { kind: "select", defaultValue: rawDefault, options };
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
      ? { kind: "channel-message", channel: "Operations" }
      : rule.action === "Create a record"
        ? {
            kind: "create-record",
            moduleId: sandboxModule?.id ?? "",
            fieldId: status?.id ?? "",
            value: "Open",
          }
        : rule.action === "Update a field"
          ? {
              kind: "update-field",
              moduleId: sandboxModule?.id ?? "",
              fieldId: status?.id ?? "",
              value: "In progress",
            }
          : rule.action === "Assign a task"
            ? { kind: "assign-task", assignee: "Sample operator" }
            : {
                kind: "notification",
                message: "Urgent request needs attention.",
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
export const uid = () => `sample-${crypto.randomUUID()}`;
const fields = (names: string[]): Field[] =>
  names.map((name, i) => ({
    id: `sample-field-${name}`,
    name,
    type: i === 2 ? "Select" : "Text",
    required: i === 0,
    value: "",
    options: i === 2 ? "Open, In progress, Complete" : "",
    closed: false,
  }));
export const initialDesign: Design = {
  departments: [
    { id: "sample-operations", name: "Operations", closed: false },
    { id: "sample-commercial", name: "Commercial", closed: false },
  ],
  modules: [
    {
      id: "sample-requests",
      department: "sample-operations",
      name: "Service requests",
      closed: false,
      fields: fields(["Request number", "Title", "Status", "Priority"]),
      x: 0,
      y: 0,
    },
    {
      id: "sample-equipment",
      department: "sample-operations",
      name: "Equipment",
      closed: false,
      fields: fields(["Asset tag", "Name", "Status", "Location"]),
      x: 340,
      y: 0,
    },
    {
      id: "sample-customers",
      department: "sample-commercial",
      name: "Customers",
      closed: false,
      fields: fields(["Customer ID", "Name", "Status", "Email"]),
      x: 170,
      y: 360,
    },
  ],
  relationships: [
    {
      id: "sample-uses",
      name: "Uses equipment",
      source: "sample-requests",
      target: "sample-equipment",
      cardinality: "One-to-many",
    },
  ],
  rules: [
    {
      id: "sample-urgent",
      name: "Urgent request alert",
      trigger: "New record",
      condition: "Priority is urgent",
      action: "Send a notification",
      enabled: true,
    },
  ],
};
export const counts = (d: Design) =>
  `${d.departments.length} departments · ${d.modules.length} modules · ${d.modules.reduce((n, m) => n + m.fields.length, 0)} fields · ${d.relationships.length} relationships · ${d.rules.length} rules`;
export function reorder<T>(items: T[], index: number, delta: number): T[] {
  const next = [...items];
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// The sample starts compact; the standalone editor keeps its own defaults.
export const compactDefaultLayout: SandboxCanvasLayout = {
  "sample-operations": { x: 24, y: 24, width: 656, height: 240 },
  "sample-commercial": { x: 184, y: 296, width: 336, height: 240 },
  "sample-requests": {
    x: 48,
    y: 72,
    width: MODULE_TABLE.width,
    height: moduleTableHeight(initialDesign.modules[0].fields.length),
  },
  "sample-equipment": {
    x: 376,
    y: 72,
    width: MODULE_TABLE.width,
    height: moduleTableHeight(initialDesign.modules[1].fields.length),
  },
  "sample-customers": {
    x: 208,
    y: 344,
    width: MODULE_TABLE.width,
    height: moduleTableHeight(initialDesign.modules[2].fields.length),
  },
};

export function changesFrom(
  previous: Design | undefined,
  next: Design,
): string[] {
  if (!previous) return ["Initial sample publication"];
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
    name: "Relationship" | "Rule",
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
  compareNamedGroup("Rule", previous.rules, next.rules);
  if (
    JSON.stringify(previous.layout ?? compactDefaultLayout) !==
    JSON.stringify(next.layout ?? compactDefaultLayout)
  )
    changes.push("Canvas layout changed");
  return changes.length
    ? changes
    : ["No structural changes since the last publication."];
}

export const initialSandboxHistory: {
  past: Design[];
  present: Design;
  future: Design[];
} = { past: [], present: initialDesign, future: [] };
