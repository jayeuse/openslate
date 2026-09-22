import type {
  Department,
  Design,
  Field,
  FieldConfig,
  Module,
  Relationship,
  Rule,
  RuleAction,
  RuleCondition,
  RuleConfig,
  RuleOperator,
  RuleTrigger,
  Version,
} from "../domain/model";
import { normalizeField } from "../domain/model";
import { SANDBOX_LIMITS, validateSandboxDesign } from "../domain/validation";

export type SandboxFileV1 = {
  kind: "openslate-sandbox";
  schemaVersion: 1;
  design: Design;
  versions?: Version[];
};

export type SandboxFileParseResult =
  { ok: true; file: SandboxFileV1 } | { ok: false; error: string };

type UnknownRecord = Record<string, unknown>;

function exactKeys(
  source: UnknownRecord,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(source).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} contains unknown property ${unknown}`);
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as UnknownRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} must be a finite number`);
  return value;
}

function ruleOperator(value: unknown, label: string): RuleOperator {
  if (![">", ">=", "<", "<=", "=", "!="].includes(String(value)))
    throw new Error(`${label} is invalid`);
  return value as RuleOperator;
}

function parseRuleTrigger(value: unknown): RuleTrigger {
  const source = record(value, "rule trigger config");
  const kind = string(source.kind, "rule trigger kind");
  if (kind === "new-record") {
    exactKeys(source, ["kind", "moduleId"], "rule trigger config");
    return { kind, moduleId: string(source.moduleId, "trigger moduleId") };
  }
  if (kind === "field-change") {
    exactKeys(source, ["kind", "moduleId", "fieldId"], "rule trigger config");
    return {
      kind,
      moduleId: string(source.moduleId, "trigger moduleId"),
      fieldId: string(source.fieldId, "trigger fieldId"),
    };
  }
  if (kind === "threshold") {
    exactKeys(
      source,
      ["kind", "moduleId", "fieldId", "operator", "value"],
      "rule trigger config",
    );
    return {
      kind,
      moduleId: string(source.moduleId, "trigger moduleId"),
      fieldId: string(source.fieldId, "trigger fieldId"),
      operator: ruleOperator(source.operator, "trigger operator"),
      value: string(source.value, "trigger value"),
    };
  }
  if (kind === "schedule") {
    exactKeys(
      source,
      ["kind", "frequency", "time", "weekday"],
      "rule trigger config",
    );
    const frequency = string(source.frequency, "schedule frequency");
    if (frequency !== "daily" && frequency !== "weekly")
      throw new Error("schedule frequency is invalid");
    const weekday = optionalNumber(source.weekday, "schedule weekday");
    return {
      kind,
      frequency,
      time: string(source.time, "schedule time"),
      ...(weekday === undefined ? {} : { weekday }),
    };
  }
  throw new Error("rule trigger kind is invalid");
}

function parseRuleCondition(value: unknown): RuleCondition {
  const source = record(value, "rule condition config");
  const kind = string(source.kind, "rule condition kind");
  if (kind === "always") {
    exactKeys(source, ["kind"], "rule condition config");
    return { kind };
  }
  if (kind === "field-comparison") {
    exactKeys(
      source,
      ["kind", "moduleId", "fieldId", "operator", "value"],
      "rule condition config",
    );
    return {
      kind,
      moduleId: string(source.moduleId, "condition moduleId"),
      fieldId: string(source.fieldId, "condition fieldId"),
      operator: ruleOperator(source.operator, "condition operator"),
      value: string(source.value, "condition value"),
    };
  }
  throw new Error("rule condition kind is invalid");
}

function parseRuleAction(value: unknown): RuleAction {
  const source = record(value, "rule action config");
  const kind = string(source.kind, "rule action kind");
  if (kind === "notification") {
    exactKeys(source, ["kind", "message"], "rule action config");
    return { kind, message: string(source.message, "notification message") };
  }
  if (kind === "channel-message") {
    exactKeys(source, ["kind", "channel"], "rule action config");
    return { kind, channel: string(source.channel, "message channel") };
  }
  if (kind === "assign-task") {
    exactKeys(source, ["kind", "assignee"], "rule action config");
    return { kind, assignee: string(source.assignee, "task assignee") };
  }
  if (kind === "create-record" || kind === "update-field") {
    exactKeys(
      source,
      ["kind", "moduleId", "fieldId", "value"],
      "rule action config",
    );
    return {
      kind,
      moduleId: string(source.moduleId, "action moduleId"),
      fieldId: string(source.fieldId, "action fieldId"),
      value: string(source.value, "action value"),
    };
  }
  throw new Error("rule action kind is invalid");
}

function parseRuleConfig(value: unknown): RuleConfig {
  const source = record(value, "rule config");
  exactKeys(source, ["trigger", "condition", "action"], "rule config");
  return {
    trigger: parseRuleTrigger(source.trigger),
    condition: parseRuleCondition(source.condition),
    action: parseRuleAction(source.action),
  };
}

function parseFieldConfig(value: unknown): FieldConfig {
  const source = record(value, "field config");
  const kind = string(source.kind, "field config kind");
  if (["text", "long-text", "email", "url"].includes(kind)) {
    exactKeys(source, ["kind", "defaultValue", "maxLength"], "field config");
    const maxLength = optionalNumber(
      source.maxLength,
      "field config maxLength",
    );
    return {
      kind: kind as "text" | "long-text" | "email" | "url",
      defaultValue: string(source.defaultValue, "field config defaultValue"),
      ...(maxLength === undefined ? {} : { maxLength }),
    };
  }
  if (kind === "number" || kind === "integer") {
    exactKeys(
      source,
      ["kind", "defaultValue", "min", "max", "step"],
      "field config",
    );
    const rawDefault = source.defaultValue;
    if (
      rawDefault !== null &&
      (typeof rawDefault !== "number" || !Number.isFinite(rawDefault))
    )
      throw new Error(
        "field config defaultValue must be a finite number or null",
      );
    const min = optionalNumber(source.min, "field config min");
    const max = optionalNumber(source.max, "field config max");
    const step = optionalNumber(source.step, "field config step");
    return {
      kind,
      defaultValue: rawDefault,
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(step === undefined ? {} : { step }),
    };
  }
  if (kind === "date" || kind === "datetime") {
    exactKeys(
      source,
      ["kind", "defaultValue", "earliest", "latest"],
      "field config",
    );
    const rawDefault = source.defaultValue;
    if (rawDefault !== null && typeof rawDefault !== "string")
      throw new Error("field config defaultValue must be a string or null");
    const earliest =
      source.earliest === undefined
        ? undefined
        : string(source.earliest, "field config earliest");
    const latest =
      source.latest === undefined
        ? undefined
        : string(source.latest, "field config latest");
    return {
      kind,
      defaultValue: rawDefault,
      ...(earliest === undefined ? {} : { earliest }),
      ...(latest === undefined ? {} : { latest }),
    };
  }
  if (kind === "checkbox") {
    exactKeys(source, ["kind", "defaultValue"], "field config");
    return {
      kind,
      defaultValue: boolean(source.defaultValue, "field config defaultValue"),
    };
  }
  if (kind === "select") {
    exactKeys(source, ["kind", "defaultValue", "options"], "field config");
    const rawDefault = source.defaultValue;
    if (rawDefault !== null && typeof rawDefault !== "string")
      throw new Error("field config defaultValue must be a string or null");
    return {
      kind,
      defaultValue: rawDefault,
      options: array(source.options, "field config options").map((option) =>
        string(option, "field config option"),
      ),
    };
  }
  throw new Error("field config kind is invalid");
}

function parseField(value: unknown): Field {
  const source = record(value, "field");
  exactKeys(
    source,
    [
      "id",
      "name",
      "type",
      "required",
      "value",
      "options",
      "closed",
      "description",
      "config",
    ],
    "field",
  );
  const field: Field = {
    id: string(source.id, "field id"),
    name: string(source.name, "field name"),
    type: string(source.type, "field type"),
    required: boolean(source.required, "field required"),
    value: string(source.value, "field default value"),
    options: string(source.options, "field options"),
    closed: boolean(source.closed, "field closed"),
    ...(source.description === undefined
      ? {}
      : { description: string(source.description, "field description") }),
    ...(source.config === undefined
      ? {}
      : { config: parseFieldConfig(source.config) }),
  };
  return field.config ? normalizeField(field) : field;
}

function parseDepartment(value: unknown): Department {
  const source = record(value, "department");
  exactKeys(source, ["id", "name", "closed"], "department");
  return {
    id: string(source.id, "department id"),
    name: string(source.name, "department name"),
    closed: boolean(source.closed, "department closed"),
  };
}

function parseModule(value: unknown): Module {
  const source = record(value, "module");
  exactKeys(
    source,
    ["id", "department", "name", "closed", "fields", "x", "y"],
    "module",
  );
  const x = optionalNumber(source.x, "module x");
  const y = optionalNumber(source.y, "module y");
  if (x === undefined || y === undefined)
    throw new Error("module position is required");
  return {
    id: string(source.id, "module id"),
    department: string(source.department, "module department"),
    name: string(source.name, "module name"),
    closed: boolean(source.closed, "module closed"),
    fields: array(source.fields, "module fields").map(parseField),
    x,
    y,
  };
}

function parseRelationship(value: unknown): Relationship {
  const source = record(value, "relationship");
  exactKeys(
    source,
    ["id", "name", "source", "target", "cardinality", "fieldMappings"],
    "relationship",
  );
  const fieldMappings =
    source.fieldMappings === undefined
      ? []
      : array(source.fieldMappings, "relationship fieldMappings").map(
          (mapping) => {
            const source = record(mapping, "relationship field mapping");
            exactKeys(
              source,
              ["sourceFieldId", "targetFieldId"],
              "relationship field mapping",
            );
            return {
              sourceFieldId: string(
                source.sourceFieldId,
                "relationship mapping sourceFieldId",
              ),
              targetFieldId: string(
                source.targetFieldId,
                "relationship mapping targetFieldId",
              ),
            };
          },
        );
  return {
    id: string(source.id, "relationship id"),
    name: string(source.name, "relationship name"),
    source: string(source.source, "relationship source"),
    target: string(source.target, "relationship target"),
    cardinality: string(source.cardinality, "relationship cardinality"),
    fieldMappings,
  };
}

function parseRule(value: unknown): Rule {
  const source = record(value, "rule");
  exactKeys(
    source,
    ["id", "name", "trigger", "condition", "action", "enabled", "config"],
    "rule",
  );
  return {
    id: string(source.id, "rule id"),
    name: string(source.name, "rule name"),
    trigger: string(source.trigger, "rule trigger"),
    condition: string(source.condition, "rule condition"),
    action: string(source.action, "rule action"),
    enabled: boolean(source.enabled, "rule enabled"),
    ...(source.config === undefined
      ? {}
      : { config: parseRuleConfig(source.config) }),
  };
}

function parseLayout(value: unknown): NonNullable<Design["layout"]> {
  const source = record(value, "layout");
  return Object.fromEntries(
    Object.entries(source).map(([id, rawBox]) => {
      const box = record(rawBox, "layout box");
      exactKeys(box, ["x", "y", "width", "height"], "layout box");
      const values = ["x", "y", "width", "height"].map((key) => {
        const parsed = optionalNumber(box[key], `layout ${key}`);
        if (parsed === undefined) throw new Error(`layout ${key} is required`);
        return parsed;
      });
      return [
        id,
        { x: values[0], y: values[1], width: values[2], height: values[3] },
      ];
    }),
  );
}

function parseDesign(value: unknown): Design {
  const source = record(value, "design");
  exactKeys(
    source,
    ["departments", "modules", "relationships", "rules", "layout"],
    "design",
  );
  const departments = array(source.departments, "departments");
  const modules = array(source.modules, "modules");
  const relationships = array(source.relationships, "relationships");
  const rules = array(source.rules, "rules");
  if (departments.length > SANDBOX_LIMITS.departments)
    throw new Error("Department limit exceeded");
  if (modules.length > SANDBOX_LIMITS.modules)
    throw new Error("Module limit exceeded");
  if (relationships.length > SANDBOX_LIMITS.relationships)
    throw new Error("Relationship limit exceeded");
  if (rules.length > SANDBOX_LIMITS.rules)
    throw new Error("Rule limit exceeded");
  const design: Design = {
    departments: departments.map(parseDepartment),
    modules: modules.map(parseModule),
    relationships: relationships.map(parseRelationship),
    rules: rules.map(parseRule),
    ...(source.layout === undefined
      ? {}
      : { layout: parseLayout(source.layout) }),
  };
  const errors = validateSandboxDesign(design).filter(
    (issue) => issue.severity === "error",
  );
  if (errors.length) throw new Error(errors[0].message);
  return design;
}

function parseVersion(value: unknown): Version {
  const source = record(value, "version");
  exactKeys(
    source,
    ["id", "label", "design", "published", "date", "note"],
    "version",
  );
  const id = string(source.id, "version id");
  const label = string(source.label, "version label");
  const date = string(source.date, "version date");
  const note =
    source.note === undefined ? undefined : string(source.note, "version note");
  if (!id.trim() || id.length > SANDBOX_LIMITS.textCharacters)
    throw new Error("Version ID is invalid");
  if (!label.trim() || label.length > SANDBOX_LIMITS.nameCharacters)
    throw new Error("Version label is invalid");
  if (date.length > SANDBOX_LIMITS.textCharacters)
    throw new Error("Version date is too long");
  if ((note?.length ?? 0) > 500) throw new Error("Version note is too long");
  return {
    id,
    label,
    design: parseDesign(source.design),
    published: boolean(source.published, "version published"),
    date,
    ...(note === undefined ? {} : { note }),
  };
}

function assertUniqueVersionIds(versions: readonly Version[]): void {
  const ids = new Set<string>();
  for (const version of versions) {
    if (ids.has(version.id)) throw new Error("Version IDs must be unique");
    ids.add(version.id);
  }
}

export function exportSandboxFile(input: {
  design: Design;
  versions?: Version[];
}): string {
  if ((input.versions?.length ?? 0) > SANDBOX_LIMITS.versions)
    throw new Error("Version limit exceeded");
  assertUniqueVersionIds(input.versions ?? []);
  const designErrors = validateSandboxDesign(input.design).filter(
    (issue) => issue.severity === "error",
  );
  if (designErrors.length) throw new Error(designErrors[0].message);
  for (const version of input.versions ?? []) {
    if (!version.id.trim() || version.id.length > SANDBOX_LIMITS.textCharacters)
      throw new Error("Version ID is invalid");
    if (
      !version.label.trim() ||
      version.label.length > SANDBOX_LIMITS.nameCharacters
    )
      throw new Error("Version label is invalid");
    if (version.date.length > SANDBOX_LIMITS.textCharacters)
      throw new Error("Version date is too long");
    if ((version.note?.length ?? 0) > 500)
      throw new Error("Version note is too long");
    const errors = validateSandboxDesign(version.design).filter(
      (issue) => issue.severity === "error",
    );
    if (errors.length) throw new Error(errors[0].message);
  }
  const text = JSON.stringify({
    kind: "openslate-sandbox",
    schemaVersion: 1,
    design: input.design,
    ...(input.versions === undefined ? {} : { versions: input.versions }),
  } satisfies SandboxFileV1);
  if (new TextEncoder().encode(text).byteLength > SANDBOX_LIMITS.fileBytes)
    throw new Error("Sandbox file exceeds the 2 MiB limit");
  return text;
}

export function parseSandboxFile(
  text: string,
  maximumFileBytes = SANDBOX_LIMITS.fileBytes,
): SandboxFileParseResult {
  try {
    if (new TextEncoder().encode(text).byteLength > maximumFileBytes)
      throw new Error("Sandbox file exceeds the allowed size limit");
    const source = record(JSON.parse(text) as unknown, "sandbox file");
    exactKeys(
      source,
      ["kind", "schemaVersion", "design", "versions"],
      "sandbox file",
    );
    if (source.kind !== "openslate-sandbox")
      throw new Error("File kind must be openslate-sandbox");
    if (source.schemaVersion !== 1)
      throw new Error("Sandbox schema version is not supported");
    const rawVersions =
      source.versions === undefined
        ? undefined
        : array(source.versions, "versions");
    if ((rawVersions?.length ?? 0) > SANDBOX_LIMITS.versions)
      throw new Error("Version limit exceeded");
    const versions = rawVersions?.map(parseVersion);
    assertUniqueVersionIds(versions ?? []);
    return {
      ok: true,
      file: {
        kind: "openslate-sandbox",
        schemaVersion: 1,
        design: parseDesign(source.design),
        ...(versions === undefined ? {} : { versions }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Sandbox file is invalid",
    };
  }
}
