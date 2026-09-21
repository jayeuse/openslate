import type { SandboxCanvasLayout } from "@/components/sandbox/sandbox-canvas";
import {
  canonicalFieldType,
  normalizeField,
  normalizeRule,
  ruleConfigLabels,
  type Design,
  type Field,
  type FieldConfig,
  type Rule,
  type RuleAction,
  type RuleCondition,
  type RuleConfig,
  type RuleTrigger,
} from "./model";
import type {
  SandboxAutomation,
  SandboxAutomationAction,
  SandboxAutomationCondition,
  SandboxAutomationTrigger,
  SandboxDocumentDesign,
  SandboxDocumentField,
  SandboxDocumentV2,
  SandboxFieldReference,
  SandboxLayoutBox,
  SandboxRelationship,
  SandboxValueSource,
} from "./document";

function legacyFieldValue(config: FieldConfig): string {
  if (
    config.kind === "text" ||
    config.kind === "long-text" ||
    config.kind === "email" ||
    config.kind === "url"
  )
    return config.defaultValue;
  if (config.kind === "number" || config.kind === "integer")
    return config.defaultValue === null ? "" : String(config.defaultValue);
  if (config.kind === "date" || config.kind === "datetime")
    return config.defaultValue ?? "";
  if (config.kind === "checkbox") return String(config.defaultValue);
  if (config.kind === "select") return config.defaultValue ?? "";
  return "";
}

function legacyFieldOptions(config: FieldConfig): string {
  return config.kind === "select" ? config.options.join(", ") : "";
}

function documentFieldToLegacy(field: SandboxDocumentField): Field {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    required: field.required,
    value: legacyFieldValue(field.config),
    options: legacyFieldOptions(field.config),
    closed: field.closed,
    ...(field.description === undefined
      ? {}
      : { description: field.description }),
    config: structuredClone(field.config),
  };
}

function legacyCardinality(
  cardinality: SandboxRelationship["cardinality"],
): "One-to-one" | "One-to-many" | "Many-to-many" {
  switch (cardinality) {
    case "one-to-one":
      return "One-to-one";
    case "one-to-many":
      return "One-to-many";
    case "many-to-many":
      return "Many-to-many";
  }
}

function documentCardinality(
  cardinality: string,
): SandboxRelationship["cardinality"] {
  if (cardinality === "One-to-one") return "one-to-one";
  if (cardinality === "Many-to-many") return "many-to-many";
  return "one-to-many";
}

function legacyValue(value: SandboxValueSource): string {
  if (value.kind === "literal")
    return value.value === null ? "" : String(value.value);
  const relationship = value.relationshipId
    ? ` via ${value.relationshipId}`
    : "";
  return `Value from ${value.moduleId}.${value.fieldId}${relationship}`;
}

function projectTrigger(trigger: SandboxAutomationTrigger): RuleTrigger {
  switch (trigger.kind) {
    case "record-created":
      return { kind: "new-record", moduleId: trigger.moduleId };
    case "field-changed":
      return {
        kind: "field-change",
        moduleId: trigger.moduleId,
        fieldId: trigger.fieldId,
      };
    case "threshold-crossed":
      return {
        kind: "threshold",
        moduleId: trigger.moduleId,
        fieldId: trigger.fieldId,
        operator: trigger.operator,
        value: legacyValue(trigger.value),
      };
    case "schedule":
      return {
        kind: "schedule",
        frequency: trigger.frequency,
        time: trigger.time,
        ...(trigger.weekday === undefined ? {} : { weekday: trigger.weekday }),
      };
  }
}

function projectCondition(automation: SandboxAutomation): RuleCondition {
  const condition = automation.conditionGroup.conditions[0];
  if (!condition) return { kind: "always" };
  return {
    kind: "field-comparison",
    moduleId: condition.field.moduleId,
    fieldId: condition.field.fieldId,
    operator: condition.operator,
    value: legacyValue(condition.value),
  };
}

function projectAction(
  action: SandboxAutomationAction | undefined,
): RuleAction {
  if (!action) return { kind: "notification", message: "" };
  switch (action.kind) {
    case "notification":
      return { kind: "notification", message: action.message };
    case "channel-message":
      return { kind: "channel-message", channel: action.channel };
    case "assign-task":
      return { kind: "assign-task", assignee: action.assignee };
    case "set-field":
      return {
        kind: "update-field",
        moduleId: action.target.moduleId,
        fieldId: action.target.fieldId,
        value: legacyValue(action.value),
      };
    case "create-record": {
      const value = action.values[0];
      return {
        kind: "create-record",
        moduleId: action.moduleId,
        fieldId: value?.fieldId ?? "",
        value: value ? legacyValue(value.value) : "",
      };
    }
  }
}

function projectAutomation(
  automation: SandboxAutomation,
  design: Design,
): Rule {
  const config: RuleConfig = {
    trigger: projectTrigger(automation.trigger),
    condition: projectCondition(automation),
    action: projectAction(automation.actions[0]),
  };
  const labels = ruleConfigLabels(config, design);
  return {
    id: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    ...labels,
    config,
  };
}

/**
 * Adapts the v2 persisted document for the current single-condition,
 * single-action Designer UI. The projection deliberately does not flatten the
 * original document: `mergeProjectedDesign` uses the matching projection to
 * retain richer automations when the Designer did not edit them.
 */
export function projectSandboxDocument(document: SandboxDocumentV2): Design {
  const layout = structuredClone(document.design.layout) as SandboxCanvasLayout;
  const designWithoutRules: Omit<Design, "rules"> = {
    layout,
    departments: document.design.departments.map((department) => ({
      id: department.id,
      name: department.name,
      closed: department.closed,
    })),
    modules: document.design.modules.map((sandboxModule) => ({
      id: sandboxModule.id,
      department: sandboxModule.departmentId,
      name: sandboxModule.name,
      closed: sandboxModule.closed,
      fields: sandboxModule.fields.map((field) => documentFieldToLegacy(field)),
      x: document.design.layout[sandboxModule.id]?.x ?? 0,
      y: document.design.layout[sandboxModule.id]?.y ?? 0,
    })),
    relationships: document.design.relationships.map((relationship) => ({
      id: relationship.id,
      name: relationship.name,
      source: relationship.sourceModuleId,
      target: relationship.targetModuleId,
      cardinality: legacyCardinality(relationship.cardinality),
      fieldMappings: relationship.fieldMappings.map((mapping) => ({
        ...mapping,
      })),
    })),
  };
  const structuralDesign: Design = { ...designWithoutRules, rules: [] };
  return {
    ...structuralDesign,
    rules: document.automations
      .map((automation, index) => ({ automation, index }))
      .sort(
        (left, right) =>
          left.automation.priority - right.automation.priority ||
          left.index - right.index,
      )
      .map(({ automation }) => projectAutomation(automation, structuralDesign)),
  };
}

function legacyLiteral(
  value: string,
  field: Field | undefined,
): SandboxValueSource {
  if (!field) return { kind: "literal", value };
  const normalized = normalizeField(field);
  if (!value.trim() && !normalized.required)
    return { kind: "literal", value: null };
  if (
    normalized.config.kind === "number" ||
    normalized.config.kind === "integer"
  ) {
    const parsed = Number(value);
    return {
      kind: "literal",
      value: Number.isFinite(parsed) ? parsed : null,
    };
  }
  if (normalized.config.kind === "checkbox")
    return { kind: "literal", value: value === "true" };
  return { kind: "literal", value };
}

function fieldFor(
  design: Design,
  moduleId: string,
  fieldId: string,
): Field | undefined {
  return design.modules
    .find((sandboxModule) => sandboxModule.id === moduleId)
    ?.fields.find((field) => field.id === fieldId);
}

function fieldReference(
  moduleId: string,
  fieldId: string,
): SandboxFieldReference {
  return { moduleId, fieldId };
}

function documentTrigger(
  trigger: RuleTrigger,
  design: Design,
): SandboxAutomationTrigger {
  switch (trigger.kind) {
    case "new-record":
      return { kind: "record-created", moduleId: trigger.moduleId };
    case "field-change":
      return {
        kind: "field-changed",
        moduleId: trigger.moduleId,
        fieldId: trigger.fieldId,
      };
    case "threshold":
      return {
        kind: "threshold-crossed",
        moduleId: trigger.moduleId,
        fieldId: trigger.fieldId,
        operator: trigger.operator,
        value: legacyLiteral(
          trigger.value,
          fieldFor(design, trigger.moduleId, trigger.fieldId),
        ),
      };
    case "schedule":
      return {
        kind: "schedule",
        frequency: trigger.frequency,
        time: trigger.time,
        ...(trigger.weekday === undefined ? {} : { weekday: trigger.weekday }),
      };
  }
}

function documentConditions(
  rule: RuleConfig,
  design: Design,
  automationId: string,
): SandboxAutomationCondition[] {
  if (rule.condition.kind === "always") return [];
  return [
    {
      id: `${automationId}:condition`,
      field: fieldReference(rule.condition.moduleId, rule.condition.fieldId),
      operator: rule.condition.operator,
      value: legacyLiteral(
        rule.condition.value,
        fieldFor(design, rule.condition.moduleId, rule.condition.fieldId),
      ),
    },
  ];
}

function documentAction(
  action: RuleAction,
  design: Design,
  automationId: string,
): SandboxAutomationAction {
  switch (action.kind) {
    case "notification":
      return {
        id: `${automationId}:action`,
        kind: "notification",
        message: action.message,
      };
    case "channel-message":
      return {
        id: `${automationId}:action`,
        kind: "channel-message",
        channel: action.channel,
      };
    case "assign-task":
      return {
        id: `${automationId}:action`,
        kind: "assign-task",
        assignee: action.assignee,
      };
    case "update-field":
      return {
        id: `${automationId}:action`,
        kind: "set-field",
        target: fieldReference(action.moduleId, action.fieldId),
        value: legacyLiteral(
          action.value,
          fieldFor(design, action.moduleId, action.fieldId),
        ),
      };
    case "create-record":
      return {
        id: `${automationId}:action`,
        kind: "create-record",
        moduleId: action.moduleId,
        values: [
          {
            fieldId: action.fieldId,
            value: legacyLiteral(
              action.value,
              fieldFor(design, action.moduleId, action.fieldId),
            ),
          },
        ],
      };
  }
}

function documentAutomation(
  rule: Rule,
  design: Design,
  priority: number,
): SandboxAutomation {
  const normalized = normalizeRule(rule, design);
  return {
    id: normalized.id,
    name: normalized.name,
    enabled: normalized.enabled,
    priority,
    trigger: documentTrigger(normalized.config.trigger, design),
    conditionGroup: {
      operator: "all",
      conditions: documentConditions(normalized.config, design, normalized.id),
    },
    actions: [documentAction(normalized.config.action, design, normalized.id)],
  };
}

function layoutFor(nextDesign: Design): Record<string, SandboxLayoutBox> {
  const layout = nextDesign.layout ?? {};
  const next: Record<string, SandboxLayoutBox> = {};
  for (const [index, department] of nextDesign.departments.entries()) {
    next[department.id] = layout[department.id] ?? {
      x: index * 360,
      y: 0,
      width: 336,
      height: 240,
    };
  }
  for (const [index, sandboxModule] of nextDesign.modules.entries()) {
    next[sandboxModule.id] = layout[sandboxModule.id] ?? {
      x: sandboxModule.x ?? index * 320,
      y: sandboxModule.y ?? 48,
      width: 280,
      height: 64 + Math.max(1, sandboxModule.fields.length) * 28,
    };
  }
  return next;
}

function documentDesign(nextDesign: Design): SandboxDocumentDesign {
  return {
    departments: nextDesign.departments.map((department) => ({
      id: department.id,
      name: department.name,
      closed: department.closed,
    })),
    modules: nextDesign.modules.map((sandboxModule) => ({
      id: sandboxModule.id,
      departmentId: sandboxModule.department,
      name: sandboxModule.name,
      closed: sandboxModule.closed,
      fields: sandboxModule.fields.map((field) => {
        const normalized = normalizeField(field);
        return {
          id: normalized.id,
          name: normalized.name,
          type: canonicalFieldType(normalized.type) ?? "Text",
          required: normalized.required,
          closed: normalized.closed,
          ...(normalized.description === undefined
            ? {}
            : { description: normalized.description }),
          config: structuredClone(normalized.config),
        };
      }),
    })),
    relationships: nextDesign.relationships.map((relationship) => ({
      id: relationship.id,
      name: relationship.name,
      sourceModuleId: relationship.source,
      targetModuleId: relationship.target,
      cardinality: documentCardinality(relationship.cardinality),
      fieldMappings: relationship.fieldMappings.map((mapping) => ({
        ...mapping,
      })),
    })),
    layout: layoutFor(nextDesign),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeExistingAutomation(
  automation: SandboxAutomation,
  previousRule: Rule,
  nextRule: Rule,
  previousDesign: Design,
  nextDesign: Design,
): SandboxAutomation {
  const previous = normalizeRule(previousRule, previousDesign);
  const next = normalizeRule(nextRule, nextDesign);
  const merged = structuredClone(automation);
  merged.name = next.name;
  merged.enabled = next.enabled;
  if (!sameValue(previous.config.trigger, next.config.trigger))
    merged.trigger = documentTrigger(next.config.trigger, nextDesign);
  if (!sameValue(previous.config.condition, next.config.condition))
    merged.conditionGroup = {
      operator: "all",
      conditions: documentConditions(next.config, nextDesign, next.id),
    };
  if (!sameValue(previous.config.action, next.config.action))
    merged.actions = [documentAction(next.config.action, nextDesign, next.id)];
  return merged;
}

function sameRuleOrder(
  previous: readonly Rule[],
  next: readonly Rule[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((rule, index) => rule.id === next[index]?.id)
  );
}

/**
 * Applies legacy Designer edits to a v2 document without serializing through
 * the v1 file format. Each unchanged projected rule part retains its original
 * richer canonical data; an edited legacy part becomes only the one-step form
 * that the current Designer can express.
 */
export function mergeProjectedDesign(
  document: SandboxDocumentV2,
  previousProjected: Design,
  nextDesign: Design,
): SandboxDocumentV2 {
  const existing = new Map(
    document.automations.map((automation) => [automation.id, automation]),
  );
  const previousRules = new Map(
    previousProjected.rules.map((rule) => [rule.id, rule]),
  );
  const orderChanged = !sameRuleOrder(
    previousProjected.rules,
    nextDesign.rules,
  );
  const automations = nextDesign.rules.map((rule, priority) => {
    const previous = previousRules.get(rule.id);
    const automation = existing.get(rule.id);
    if (automation && previous)
      return mergeExistingAutomation(
        automation,
        previous,
        rule,
        previousProjected,
        nextDesign,
      );
    return documentAutomation(rule, nextDesign, priority);
  });
  return {
    kind: "openslate-sandbox",
    schemaVersion: 2,
    design: documentDesign(nextDesign),
    automations: orderChanged
      ? automations.map((automation, priority) => ({
          ...automation,
          priority,
        }))
      : automations,
    scenarios: structuredClone(document.scenarios),
    ...(document.versions === undefined
      ? {}
      : { versions: structuredClone(document.versions) }),
  };
}
