import type { SandboxFileV1 } from "../helpers/file-format";
import { canonicalFieldType, normalizeField, normalizeRule } from "./model";
import {
  type SandboxAutomation,
  type SandboxAutomationAction,
  type SandboxAutomationCondition,
  type SandboxAutomationTrigger,
  type SandboxDocumentDesign,
  type SandboxDocumentField,
  type SandboxDocumentV2,
  type SandboxLayoutBox,
  type SandboxRelationship,
  type SandboxValueSource,
} from "./document-types";
import { parseSandboxDocumentValue } from "./document-parser";
import { exportSandboxDocument } from "./document-serialization";

function legacyCardinality(value: string): SandboxRelationship["cardinality"] {
  if (value === "One-to-one") return "one-to-one";
  if (value === "Many-to-many") return "many-to-many";
  return "one-to-many";
}

function legacyLiteral(
  value: string,
  field: SandboxDocumentField | undefined,
): SandboxValueSource {
  if (!field) return { kind: "literal", value };
  if (!value.trim() && !field.required) return { kind: "literal", value: null };
  if (field.config.kind === "number" || field.config.kind === "integer") {
    const parsed = Number(value);
    return { kind: "literal", value: Number.isFinite(parsed) ? parsed : null };
  }
  if (field.config.kind === "checkbox")
    return { kind: "literal", value: value === "true" };
  return { kind: "literal", value };
}

function legacyLayout(
  file: SandboxFileV1,
  design: SandboxDocumentDesign,
): Record<string, SandboxLayoutBox> {
  const existing = file.design.layout ?? {};
  const layout: Record<string, SandboxLayoutBox> = {};
  for (const [index, department] of design.departments.entries()) {
    const box = existing[department.id];
    layout[department.id] = box ?? {
      x: index * 360,
      y: 0,
      width: 336,
      height: 240,
    };
  }
  for (const [index, module] of design.modules.entries()) {
    const legacy = file.design.modules[index];
    const box = existing[module.id];
    layout[module.id] = box ?? {
      x: legacy?.x ?? index * 320,
      y: legacy?.y ?? 48,
      width: 280,
      height: 64 + Math.max(1, module.fields.length) * 28,
    };
  }
  return layout;
}

function legacyAutomation(
  file: SandboxFileV1,
  design: SandboxDocumentDesign,
): SandboxAutomation[] {
  const field = (moduleId: string, fieldId: string) =>
    design.modules
      .find((item) => item.id === moduleId)
      ?.fields.find((item) => item.id === fieldId);
  return file.design.rules.map((rule, index) => {
    const config = normalizeRule(rule, file.design).config;
    const trigger: SandboxAutomationTrigger =
      config.trigger.kind === "new-record"
        ? { kind: "record-created", moduleId: config.trigger.moduleId }
        : config.trigger.kind === "field-change"
          ? {
              kind: "field-changed",
              moduleId: config.trigger.moduleId,
              fieldId: config.trigger.fieldId,
            }
          : config.trigger.kind === "threshold"
            ? {
                kind: "threshold-crossed",
                moduleId: config.trigger.moduleId,
                fieldId: config.trigger.fieldId,
                operator: config.trigger.operator,
                value: legacyLiteral(
                  config.trigger.value,
                  field(config.trigger.moduleId, config.trigger.fieldId),
                ),
              }
            : {
                kind: "schedule",
                frequency: config.trigger.frequency,
                time: config.trigger.time,
                ...(config.trigger.weekday === undefined
                  ? {}
                  : { weekday: config.trigger.weekday }),
              };
    const conditions: SandboxAutomationCondition[] =
      config.condition.kind === "always"
        ? []
        : [
            {
              id: `${rule.id}:condition`,
              field: {
                moduleId: config.condition.moduleId,
                fieldId: config.condition.fieldId,
              },
              operator: config.condition.operator,
              value: legacyLiteral(
                config.condition.value,
                field(config.condition.moduleId, config.condition.fieldId),
              ),
            },
          ];
    const action: SandboxAutomationAction =
      config.action.kind === "notification"
        ? {
            id: `${rule.id}:action`,
            kind: "notification",
            message: config.action.message,
          }
        : config.action.kind === "channel-message"
          ? {
              id: `${rule.id}:action`,
              kind: "channel-message",
              channel: config.action.channel,
            }
          : config.action.kind === "assign-task"
            ? {
                id: `${rule.id}:action`,
                kind: "assign-task",
                assignee: config.action.assignee,
              }
            : config.action.kind === "update-field"
              ? {
                  id: `${rule.id}:action`,
                  kind: "set-field",
                  target: {
                    moduleId: config.action.moduleId,
                    fieldId: config.action.fieldId,
                  },
                  value: legacyLiteral(
                    config.action.value,
                    field(config.action.moduleId, config.action.fieldId),
                  ),
                }
              : {
                  id: `${rule.id}:action`,
                  kind: "create-record",
                  moduleId: config.action.moduleId,
                  values: [
                    {
                      fieldId: config.action.fieldId,
                      value: legacyLiteral(
                        config.action.value,
                        field(config.action.moduleId, config.action.fieldId),
                      ),
                    },
                  ],
                };
    return {
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      priority: index,
      trigger,
      conditionGroup: { operator: "all", conditions },
      actions: [action],
    };
  });
}

export function migrateSandboxFileV1(file: SandboxFileV1): SandboxDocumentV2 {
  const designWithoutLayout: Omit<SandboxDocumentDesign, "layout"> = {
    departments: file.design.departments.map((item) => ({
      id: item.id,
      name: item.name,
      closed: item.closed,
    })),
    modules: file.design.modules.map((item) => ({
      id: item.id,
      departmentId: item.department,
      name: item.name,
      closed: item.closed,
      fields: item.fields.map((field) => {
        const normalized = normalizeField(field);
        const type = canonicalFieldType(normalized.type);
        if (!type) throw new Error("Legacy field type is unsupported");
        return {
          id: normalized.id,
          name: normalized.name,
          type,
          required: normalized.required,
          closed: normalized.closed,
          ...(normalized.description === undefined
            ? {}
            : { description: normalized.description }),
          config: normalized.config,
        };
      }),
    })),
    relationships: file.design.relationships.map((item) => ({
      id: item.id,
      name: item.name,
      sourceModuleId: item.source,
      targetModuleId: item.target,
      cardinality: legacyCardinality(item.cardinality),
      fieldMappings: item.fieldMappings.map((mapping) => ({ ...mapping })),
    })),
  };
  const design: SandboxDocumentDesign = {
    ...designWithoutLayout,
    layout: legacyLayout(file, designWithoutLayout as SandboxDocumentDesign),
  };
  const document: SandboxDocumentV2 = {
    kind: "openslate-sandbox",
    schemaVersion: 2,
    design,
    automations: legacyAutomation(file, design),
    scenarios: [],
  };
  if (file.versions !== undefined) {
    document.versions = file.versions.map((version) => ({
      id: version.id,
      label: version.label,
      kind: version.published ? "published" : "checkpoint",
      published: version.published,
      date: version.date,
      ...(version.note === undefined ? {} : { note: version.note }),
      document: (() => {
        const migrated = migrateSandboxFileV1({
          kind: "openslate-sandbox",
          schemaVersion: 1,
          design: version.design,
        });
        return {
          design: migrated.design,
          automations: migrated.automations,
          scenarios: migrated.scenarios,
        };
      })(),
    }));
  }
  const exported = exportSandboxDocument(document);
  return parseSandboxDocumentValue(JSON.parse(exported) as unknown);
}
