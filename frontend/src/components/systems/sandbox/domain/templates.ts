import type {
  SandboxAutomation,
  SandboxAutomationAction,
  SandboxComparisonOperator,
  SandboxDocumentDepartment,
  SandboxDocumentField,
  SandboxDocumentModule,
  SandboxFieldValue,
  SandboxRelationship,
  SandboxDocumentV2,
} from "./document-types";
import {
  SANDBOX_TEMPLATE_DEFINITIONS,
  type AutomationActionWithoutId,
  type CustomField,
  type ModuleDefinition,
  type RelationshipDefinition,
  type TemplateDefinition,
} from "./template-definitions";

export type SandboxOrganizationTemplate = {
  id: string;
  name: string;
  category: string;
  description: string;
  recommendedFor: string[];
  highlights: string[];
  document: SandboxDocumentV2;
  createDocument: () => SandboxDocumentV2;
};

const fieldId = (moduleId: string, key: string) => `${moduleId}-${key}`;

function singularModuleName(name: string): string {
  const compound: Record<string, string> = {
    "Bills of material": "Bill of material",
    "Returns and refunds": "Return and refund",
    "Stores and channels": "Store and channel",
  };
  return compound[name] ?? name.replace(/ies$/, "y").replace(/s$/, "");
}

function field(
  moduleId: string,
  [key, name, type, required = false, selectOptions = []]: CustomField,
): SandboxDocumentField {
  const base = {
    id: fieldId(moduleId, key),
    name,
    type,
    required,
    closed: false,
  };
  switch (type) {
    case "Text":
      return {
        ...base,
        config: { kind: "text", defaultValue: "", maxLength: 200 },
      };
    case "Long text":
      return {
        ...base,
        config: { kind: "long-text", defaultValue: "", maxLength: 1_000 },
      };
    case "Number":
      return {
        ...base,
        config: { kind: "number", defaultValue: null, step: 0.01 },
      };
    case "Integer":
      return {
        ...base,
        config: { kind: "integer", defaultValue: null, step: 1 },
      };
    case "Date":
      return { ...base, config: { kind: "date", defaultValue: null } };
    case "Date/Time":
      return { ...base, config: { kind: "datetime", defaultValue: null } };
    case "Checkbox":
      return { ...base, config: { kind: "checkbox", defaultValue: false } };
    case "Select":
      return {
        ...base,
        config: {
          kind: "select",
          defaultValue: null,
          options: [...selectOptions],
        },
      };
    case "Email":
      return {
        ...base,
        config: { kind: "email", defaultValue: "", maxLength: 254 },
      };
    case "URL":
      return {
        ...base,
        config: { kind: "url", defaultValue: "", maxLength: 1_000 },
      };
  }
}

function buildModule(definition: ModuleDefinition): SandboxDocumentModule {
  const [id, departmentId, name, customFields] = definition;
  return {
    id,
    departmentId,
    name,
    closed: false,
    fields: [
      field(id, ["id", `${singularModuleName(name)} ID`, "Text", true]),
      field(id, [
        "status",
        "Status",
        "Select",
        true,
        ["Draft", "Active", "On hold", "Complete", "Cancelled"],
      ]),
      field(id, ["needs-review", "Needs review", "Checkbox"]),
      ...customFields.map((item) => field(id, item)),
    ],
  };
}

function relationship([
  id,
  name,
  sourceModuleId,
  targetModuleId,
  cardinality = "one-to-many",
]: RelationshipDefinition): SandboxRelationship {
  return {
    id,
    name,
    sourceModuleId,
    targetModuleId,
    cardinality,
    fieldMappings: [],
  };
}

function literal(value: SandboxFieldValue) {
  return { kind: "literal" as const, value };
}

function fieldChangeAutomation(
  id: string,
  name: string,
  moduleId: string,
  action: AutomationActionWithoutId,
  priority: number,
): SandboxAutomation {
  return {
    id,
    name,
    enabled: true,
    priority,
    trigger: {
      kind: "field-changed",
      moduleId,
      fieldId: fieldId(moduleId, "status"),
    },
    conditionGroup: {
      operator: "all",
      conditions: [
        {
          id: `${id}-condition`,
          field: { moduleId, fieldId: fieldId(moduleId, "status") },
          operator: "=",
          value: literal("On hold"),
        },
      ],
    },
    actions: [{ ...action, id: `${id}-action` } as SandboxAutomationAction],
  };
}

function thresholdAutomation(
  id: string,
  name: string,
  moduleId: string,
  thresholdFieldId: string,
  operator: SandboxComparisonOperator,
  value: number,
  priority: number,
): SandboxAutomation {
  return {
    id,
    name,
    enabled: true,
    priority,
    trigger: {
      kind: "threshold-crossed",
      moduleId,
      fieldId: thresholdFieldId,
      operator,
      value: literal(value),
    },
    conditionGroup: { operator: "all", conditions: [] },
    actions: [
      {
        id: `${id}-set-status`,
        kind: "set-field",
        target: { moduleId, fieldId: fieldId(moduleId, "needs-review") },
        value: literal(true),
      },
    ],
  };
}

function buildAutomations(
  definition: TemplateDefinition,
  modules: SandboxDocumentModule[],
): SandboxAutomation[] {
  const prefix = definition.id;
  const thresholdModule = modules.find(
    (item) => item.id === definition.threshold.moduleId,
  );
  const thresholdField = thresholdModule?.fields.find(
    (item) =>
      item.id ===
      fieldId(definition.threshold.moduleId, definition.threshold.fieldKey),
  );
  const automations: SandboxAutomation[] = [
    {
      id: `${prefix}-auto-intake`,
      name: `${modules[0]!.name} intake notice`,
      enabled: true,
      priority: 0,
      trigger: {
        kind: "field-changed",
        moduleId: modules[0]!.id,
        fieldId: fieldId(modules[0]!.id, "status"),
      },
      conditionGroup: {
        operator: "all",
        conditions: [
          {
            id: `${prefix}-auto-intake-condition`,
            field: {
              moduleId: modules[0]!.id,
              fieldId: fieldId(modules[0]!.id, "status"),
            },
            operator: "=",
            value: literal("On hold"),
          },
        ],
      },
      actions: [
        {
          id: `${prefix}-auto-intake-status`,
          kind: "set-field",
          target: {
            moduleId: modules[0]!.id,
            fieldId: fieldId(modules[0]!.id, "needs-review"),
          },
          value: literal(true),
        },
      ],
    },
    fieldChangeAutomation(
      `${prefix}-auto-hold`,
      `${modules[1]!.name} hold escalation`,
      modules[1]!.id,
      {
        kind: "set-field",
        target: {
          moduleId: modules[1]!.id,
          fieldId: fieldId(modules[1]!.id, "needs-review"),
        },
        value: literal(true),
      },
      1,
    ),
    fieldChangeAutomation(
      `${prefix}-auto-exception`,
      `${modules[2]!.name} exception alert`,
      modules[2]!.id,
      {
        kind: "set-field",
        target: {
          moduleId: modules[2]!.id,
          fieldId: fieldId(modules[2]!.id, "needs-review"),
        },
        value: literal(true),
      },
      2,
    ),
    {
      id: `${prefix}-auto-weekly-review`,
      name: "Weekly management review",
      enabled: true,
      priority: 4,
      trigger: {
        kind: "schedule",
        moduleId: modules[0]!.id,
        frequency: "weekly",
        time: "08:30",
        weekday: 1,
      },
      conditionGroup: { operator: "all", conditions: [] },
      actions: [
        {
          id: `${prefix}-auto-weekly-review-status`,
          kind: "set-field",
          target: {
            moduleId: modules[0]!.id,
            fieldId: fieldId(modules[0]!.id, "needs-review"),
          },
          value: literal(true),
        },
      ],
    },
  ];
  if (thresholdModule && thresholdField)
    automations.splice(
      3,
      0,
      thresholdAutomation(
        `${prefix}-auto-threshold`,
        definition.threshold.name,
        thresholdModule.id,
        thresholdField.id,
        definition.threshold.operator,
        definition.threshold.value,
        3,
      ),
    );
  return automations;
}

function layoutFor(
  departments: SandboxDocumentDepartment[],
  modules: SandboxDocumentModule[],
): SandboxDocumentV2["design"]["layout"] {
  return Object.fromEntries(
    departments.flatMap((item, departmentIndex) => {
      const children = modules.filter(
        (module) => module.departmentId === item.id,
      );
      const x = departmentIndex * 760;
      return [
        [
          item.id,
          {
            x,
            y: 0,
            width: 700,
            height: 100 + Math.ceil(children.length / 2) * 360,
          },
        ] as const,
        ...children.map(
          (child, childIndex) =>
            [
              child.id,
              {
                x: x + 30 + (childIndex % 2) * 330,
                y: 60 + Math.floor(childIndex / 2) * 360,
                width: 300,
                height: 300,
              },
            ] as const,
        ),
      ];
    }),
  );
}

function buildTemplate(
  definition: TemplateDefinition,
): SandboxOrganizationTemplate {
  const departments = definition.departments.map(([id, name]) => ({
    id,
    name,
    closed: false,
  }));
  const modules = definition.modules.map(buildModule);
  const relationships = definition.relationships.map(relationship);
  const document: SandboxDocumentV2 = {
    kind: "openslate-sandbox",
    schemaVersion: 2,
    design: {
      departments,
      modules,
      relationships,
      layout: layoutFor(departments, modules),
    },
    automations: buildAutomations(definition, modules),
    scenarios: [],
  };
  return {
    id: definition.id,
    name: definition.name,
    category: definition.category,
    description: definition.description,
    recommendedFor: [...definition.recommendedFor],
    highlights: [...definition.highlights],
    document,
    createDocument: () => structuredClone(document),
  };
}

export const SANDBOX_ORGANIZATION_TEMPLATES =
  SANDBOX_TEMPLATE_DEFINITIONS.map(buildTemplate);

export function sandboxTemplateStats(template: SandboxOrganizationTemplate) {
  return {
    departments: template.document.design.departments.length,
    modules: template.document.design.modules.length,
    fields: template.document.design.modules.reduce(
      (total, item) => total + item.fields.length,
      0,
    ),
    relationships: template.document.design.relationships.length,
    automations: template.document.automations.length,
  };
}
