import { parseSandboxFile, type SandboxFileV1 } from "../helpers/file-format";
import {
  dateRangeFits,
  dateTimeInstant,
  dateValueInRange,
} from "./date-values";
import {
  canonicalFieldType,
  normalizeField,
  normalizeRule,
  type FieldConfig,
  type FieldTypeName,
} from "./model";

export const SANDBOX_DOCUMENT_LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  departments: 100,
  modules: 500,
  fields: 5_000,
  relationships: 1_000,
  automations: 500,
  scenarios: 500,
  recordsPerScenario: 5_000,
  fieldMappings: 1_000,
  conditionsPerAutomation: 20,
  actionsPerAutomation: 20,
  versions: 50,
  nameCharacters: 80,
  textCharacters: 1_000,
  selectOptions: 100,
  selectOptionCharacters: 100,
  layoutCoordinate: 100_000,
} as const;

export type SandboxFieldValue = string | number | boolean | null;
export type SandboxLayoutBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type SandboxDocumentField = {
  id: string;
  name: string;
  type: FieldTypeName;
  required: boolean;
  closed: boolean;
  description?: string;
  config: FieldConfig;
};
export type SandboxDocumentDepartment = {
  id: string;
  name: string;
  closed: boolean;
};
export type SandboxDocumentModule = {
  id: string;
  departmentId: string;
  name: string;
  closed: boolean;
  fields: SandboxDocumentField[];
};
export type SandboxFieldMapping = {
  sourceFieldId: string;
  targetFieldId: string;
};
export type SandboxRelationship = {
  id: string;
  name: string;
  sourceModuleId: string;
  targetModuleId: string;
  cardinality: "one-to-one" | "one-to-many" | "many-to-many";
  fieldMappings: SandboxFieldMapping[];
};
export type SandboxFieldReference = {
  moduleId: string;
  fieldId: string;
  relationshipId?: string;
};
export type SandboxValueSource =
  | { kind: "literal"; value: SandboxFieldValue }
  | ({ kind: "field-reference" } & SandboxFieldReference);
export type SandboxAutomationTrigger =
  | { kind: "record-created"; moduleId: string }
  | { kind: "field-changed"; moduleId: string; fieldId: string }
  | {
      kind: "threshold-crossed";
      moduleId: string;
      fieldId: string;
      operator: SandboxComparisonOperator;
      value: SandboxValueSource;
    }
  | {
      kind: "schedule";
      /** Absent only in imported legacy documents. New authoring always sets it. */
      moduleId?: string;
      frequency: "daily" | "weekly";
      time: string;
      weekday?: number;
    };
export type SandboxComparisonOperator = ">" | ">=" | "<" | "<=" | "=" | "!=";
export type SandboxAutomationCondition = {
  id: string;
  field: SandboxFieldReference;
  operator: SandboxComparisonOperator;
  value: SandboxValueSource;
};
export type SandboxAutomationAction =
  | { id: string; kind: "notification"; message: string }
  | { id: string; kind: "channel-message"; channel: string }
  | { id: string; kind: "assign-task"; assignee: string }
  | {
      id: string;
      kind: "set-field";
      target: SandboxFieldReference;
      value: SandboxValueSource;
    }
  | {
      id: string;
      kind: "create-record";
      moduleId: string;
      values: Array<{ fieldId: string; value: SandboxValueSource }>;
    };
export type SandboxAutomation = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  trigger: SandboxAutomationTrigger;
  conditionGroup: {
    operator: "all" | "any";
    conditions: SandboxAutomationCondition[];
  };
  actions: SandboxAutomationAction[];
};
export type SandboxSyntheticRecord = {
  id: string;
  moduleId: string;
  values: Record<string, SandboxFieldValue>;
};
export type SandboxScenarioLink = {
  relationshipId: string;
  sourceRecordId: string;
  targetRecordId: string;
};
export type SandboxScenarioTemplate = {
  id: string;
  name: string;
  records: SandboxSyntheticRecord[];
  links: SandboxScenarioLink[];
};
export type SandboxDocumentDesign = {
  departments: SandboxDocumentDepartment[];
  modules: SandboxDocumentModule[];
  relationships: SandboxRelationship[];
  layout: Record<string, SandboxLayoutBox>;
};
export type SandboxVersionSnapshot = {
  id: string;
  label: string;
  kind: "checkpoint" | "published" | "imported";
  document: Omit<SandboxDocumentV2, "kind" | "schemaVersion" | "versions">;
  published: boolean;
  date: string;
  note?: string;
};
export type SandboxDocumentV2 = {
  kind: "openslate-sandbox";
  schemaVersion: 2;
  design: SandboxDocumentDesign;
  automations: SandboxAutomation[];
  scenarios: SandboxScenarioTemplate[];
  versions?: SandboxVersionSnapshot[];
};
export type SandboxDocumentParseResult =
  { ok: true; document: SandboxDocumentV2 } | { ok: false; error: string };

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

function boundedString(
  value: unknown,
  label: string,
  max: number = SANDBOX_DOCUMENT_LIMITS.textCharacters,
): string {
  const parsed = string(value, label);
  if (!parsed.trim()) throw new Error(`${label} is required`);
  if (parsed.length > max) throw new Error(`${label} is too long`);
  return parsed;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} must be a finite number`);
  return value;
}

function optionalFiniteNumber(
  value: unknown,
  label: string,
): number | undefined {
  return value === undefined || value === null
    ? undefined
    : finiteNumber(value, label);
}

function comparisonOperator(
  value: unknown,
  label: string,
): SandboxComparisonOperator {
  const parsed = string(value, label);
  if (![">", ">=", "<", "<=", "=", "!="].includes(parsed))
    throw new Error(`${label} is invalid`);
  return parsed as SandboxComparisonOperator;
}

function parseFieldConfig(value: unknown): FieldConfig {
  const source = record(value, "field config");
  const kind = string(source.kind, "field config kind");
  if (["text", "long-text", "email", "url"].includes(kind)) {
    exactKeys(source, ["kind", "defaultValue", "maxLength"], "field config");
    const maxLength = optionalFiniteNumber(
      source.maxLength,
      "field config maxLength",
    );
    if (
      maxLength !== undefined &&
      (!Number.isInteger(maxLength) ||
        maxLength < 1 ||
        maxLength > SANDBOX_DOCUMENT_LIMITS.textCharacters)
    )
      throw new Error("field config maxLength is invalid");
    const defaultValue = string(
      source.defaultValue,
      "field config defaultValue",
    );
    if (defaultValue.length > SANDBOX_DOCUMENT_LIMITS.textCharacters)
      throw new Error("field config defaultValue is too long");
    return {
      kind: kind as "text" | "long-text" | "email" | "url",
      defaultValue,
      ...(maxLength === undefined ? {} : { maxLength }),
    };
  }
  if (kind === "number" || kind === "integer") {
    exactKeys(
      source,
      ["kind", "defaultValue", "min", "max", "step"],
      "field config",
    );
    const defaultValue = source.defaultValue;
    if (
      defaultValue !== null &&
      (typeof defaultValue !== "number" || !Number.isFinite(defaultValue))
    )
      throw new Error(
        "field config defaultValue must be a finite number or null",
      );
    const min = optionalFiniteNumber(source.min, "field config min");
    const max = optionalFiniteNumber(source.max, "field config max");
    const step = optionalFiniteNumber(source.step, "field config step");
    if (
      (min !== undefined && max !== undefined && min > max) ||
      (step !== undefined && step <= 0)
    )
      throw new Error("field config numeric bounds are invalid");
    if (
      kind === "integer" &&
      [defaultValue, min, max, step].some(
        (item) =>
          item !== undefined && item !== null && !Number.isInteger(item),
      )
    )
      throw new Error("integer field config must use whole numbers");
    return {
      kind,
      defaultValue,
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
    const defaultValue = source.defaultValue;
    if (defaultValue !== null && typeof defaultValue !== "string")
      throw new Error("field config defaultValue must be a string or null");
    const earliest =
      source.earliest === undefined || source.earliest === null
        ? undefined
        : string(source.earliest, "field config earliest");
    const latest =
      source.latest === undefined || source.latest === null
        ? undefined
        : string(source.latest, "field config latest");
    const valid = kind === "date" ? validDate : validDateTime;
    if (
      (earliest !== undefined && !valid(earliest)) ||
      (latest !== undefined && !valid(latest))
    )
      throw new Error("field config date bounds are invalid");
    if (earliest !== undefined && latest !== undefined) {
      const earliestInstant = dateTimeInstant(earliest);
      const latestInstant = dateTimeInstant(latest);
      const ordered =
        kind === "date"
          ? earliest <= latest
          : earliestInstant !== undefined &&
            latestInstant !== undefined &&
            earliestInstant <= latestInstant;
      if (!ordered) throw new Error("field config date bounds are invalid");
    }
    return {
      kind,
      defaultValue,
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
    if (source.defaultValue !== null && typeof source.defaultValue !== "string")
      throw new Error("field config defaultValue must be a string or null");
    const options = array(source.options, "field config options").map((item) =>
      boundedString(
        item,
        "field config option",
        SANDBOX_DOCUMENT_LIMITS.selectOptionCharacters,
      ),
    );
    if (
      options.length > SANDBOX_DOCUMENT_LIMITS.selectOptions ||
      new Set(options).size !== options.length
    )
      throw new Error("field config options are invalid");
    if (
      source.defaultValue !== null &&
      !options.includes(source.defaultValue as string)
    )
      throw new Error("field config defaultValue must be a select option");
    return {
      kind,
      defaultValue: source.defaultValue as string | null,
      options,
    };
  }
  throw new Error("field config kind is invalid");
}

function parseField(value: unknown): SandboxDocumentField {
  const source = record(value, "field");
  exactKeys(
    source,
    ["id", "name", "type", "required", "closed", "description", "config"],
    "field",
  );
  const type = canonicalFieldType(string(source.type, "field type"));
  if (!type) throw new Error("field type is unsupported");
  const config = parseFieldConfig(source.config);
  const expectedKind = normalizeField({
    id: "type",
    name: "type",
    type,
    required: false,
    value: "",
    options: "",
    closed: false,
  }).config.kind;
  if (config.kind !== expectedKind)
    throw new Error("field config does not match field type");
  const description =
    source.description === undefined || source.description === null
      ? undefined
      : string(source.description, "field description");
  if ((description?.length ?? 0) > SANDBOX_DOCUMENT_LIMITS.textCharacters)
    throw new Error("field description is too long");
  const field: SandboxDocumentField = {
    id: boundedString(source.id, "field id"),
    name: boundedString(
      source.name,
      "field name",
      SANDBOX_DOCUMENT_LIMITS.nameCharacters,
    ),
    type,
    required: boolean(source.required, "field required"),
    closed: boolean(source.closed, "field closed"),
    ...(description === undefined ? {} : { description }),
    config,
  };
  if (!valueMatchesField(config.defaultValue, field, false))
    throw new Error("field config defaultValue does not match its field");
  return field;
}

function parseFieldValue(value: unknown, label: string): SandboxFieldValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${label} must be a string, number, boolean, or null`);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
  );
}

function validDateTime(value: string): boolean {
  return dateTimeInstant(value) !== undefined;
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function valueMatchesField(
  value: SandboxFieldValue,
  field: SandboxDocumentField,
  enforceRequired = true,
): boolean {
  if (value === null) return !enforceRequired || !field.required;
  if (
    enforceRequired &&
    field.required &&
    typeof value === "string" &&
    !value.trim()
  )
    return false;
  switch (field.config.kind) {
    case "number": {
      if (typeof value !== "number") return false;
      if (field.config.min !== undefined && value < field.config.min)
        return false;
      if (field.config.max !== undefined && value > field.config.max)
        return false;
      if (field.config.step !== undefined) {
        const steps = (value - (field.config.min ?? 0)) / field.config.step;
        if (Math.abs(steps - Math.round(steps)) > 1e-9) return false;
      }
      return true;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) return false;
      if (field.config.min !== undefined && value < field.config.min)
        return false;
      if (field.config.max !== undefined && value > field.config.max)
        return false;
      const step = field.config.step ?? 1;
      const steps = (value - (field.config.min ?? 0)) / step;
      return Math.abs(steps - Math.round(steps)) <= 1e-9;
    }
    case "checkbox":
      return typeof value === "boolean";
    case "select":
      return typeof value === "string" && field.config.options.includes(value);
    case "date":
      return (
        typeof value === "string" &&
        validDate(value) &&
        (field.config.earliest === undefined ||
          value >= field.config.earliest) &&
        (field.config.latest === undefined || value <= field.config.latest)
      );
    case "datetime":
      return (
        typeof value === "string" &&
        dateValueInRange(
          "datetime",
          value,
          field.config.earliest,
          field.config.latest,
        )
      );
    case "email":
      return (
        typeof value === "string" &&
        (value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) &&
        (field.config.maxLength === undefined ||
          value.length <= field.config.maxLength)
      );
    case "url":
      return (
        typeof value === "string" &&
        (value === "" || validHttpUrl(value)) &&
        (field.config.maxLength === undefined ||
          value.length <= field.config.maxLength)
      );
    case "text":
    case "long-text":
      return (
        typeof value === "string" &&
        (field.config.maxLength === undefined ||
          value.length <= field.config.maxLength)
      );
  }
}

function parseLayout(value: unknown): Record<string, SandboxLayoutBox> {
  const source = record(value, "layout");
  return Object.fromEntries(
    Object.entries(source).map(([id, rawBox]) => {
      const box = record(rawBox, "layout box");
      exactKeys(box, ["x", "y", "width", "height"], "layout box");
      const parsed: SandboxLayoutBox = {
        x: finiteNumber(box.x, "layout x"),
        y: finiteNumber(box.y, "layout y"),
        width: finiteNumber(box.width, "layout width"),
        height: finiteNumber(box.height, "layout height"),
      };
      if (
        Object.values(parsed).some(
          (item) => Math.abs(item) > SANDBOX_DOCUMENT_LIMITS.layoutCoordinate,
        ) ||
        parsed.width <= 0 ||
        parsed.height <= 0
      )
        throw new Error("layout box is outside the supported range");
      return [boundedString(id, "layout ID"), parsed];
    }),
  );
}

function parseDesign(value: unknown, semantic = true): SandboxDocumentDesign {
  const source = record(value, "design");
  exactKeys(
    source,
    ["departments", "modules", "relationships", "layout"],
    "design",
  );
  const departments = array(source.departments, "departments");
  const modules = array(source.modules, "modules");
  const relationships = array(source.relationships, "relationships");
  if (
    departments.length > SANDBOX_DOCUMENT_LIMITS.departments ||
    modules.length > SANDBOX_DOCUMENT_LIMITS.modules ||
    relationships.length > SANDBOX_DOCUMENT_LIMITS.relationships
  )
    throw new Error("design entity limit exceeded");
  const parsedDepartments = departments.map(
    (item): SandboxDocumentDepartment => {
      const source = record(item, "department");
      exactKeys(source, ["id", "name", "closed"], "department");
      return {
        id: boundedString(source.id, "department id"),
        name: boundedString(
          source.name,
          "department name",
          SANDBOX_DOCUMENT_LIMITS.nameCharacters,
        ),
        closed: boolean(source.closed, "department closed"),
      };
    },
  );
  const parsedModules = modules.map((item): SandboxDocumentModule => {
    const source = record(item, "module");
    exactKeys(
      source,
      ["id", "departmentId", "name", "closed", "fields"],
      "module",
    );
    const fields = array(source.fields, "module fields").map(parseField);
    return {
      id: boundedString(source.id, "module id"),
      departmentId: boundedString(source.departmentId, "module departmentId"),
      name: boundedString(
        source.name,
        "module name",
        SANDBOX_DOCUMENT_LIMITS.nameCharacters,
      ),
      closed: boolean(source.closed, "module closed"),
      fields,
    };
  });
  if (
    parsedModules.reduce((count, item) => count + item.fields.length, 0) >
    SANDBOX_DOCUMENT_LIMITS.fields
  )
    throw new Error("Field limit exceeded");
  if (semantic) {
    assertUnique(
      parsedDepartments.map((item) => item.id),
      "department IDs",
    );
    assertUnique(
      parsedModules.map((item) => item.id),
      "module IDs",
    );
  }
  for (const sandboxModule of parsedModules) {
    if (
      semantic &&
      !parsedDepartments.some(
        (department) => department.id === sandboxModule.departmentId,
      )
    )
      throw new Error("Module department does not exist");
    if (semantic)
      assertUnique(
        sandboxModule.fields.map((field) => field.id),
        "field IDs",
      );
  }
  const parsedRelationships = relationships.map((item): SandboxRelationship => {
    const source = record(item, "relationship");
    exactKeys(
      source,
      [
        "id",
        "name",
        "sourceModuleId",
        "targetModuleId",
        "cardinality",
        "fieldMappings",
      ],
      "relationship",
    );
    const cardinality = string(source.cardinality, "relationship cardinality");
    if (!["one-to-one", "one-to-many", "many-to-many"].includes(cardinality))
      throw new Error("relationship cardinality is invalid");
    const fieldMappings = array(
      source.fieldMappings,
      "relationship fieldMappings",
    ).map((mapping): SandboxFieldMapping => {
      const source = record(mapping, "field mapping");
      exactKeys(source, ["sourceFieldId", "targetFieldId"], "field mapping");
      return {
        sourceFieldId: boundedString(source.sourceFieldId, "sourceFieldId"),
        targetFieldId: boundedString(source.targetFieldId, "targetFieldId"),
      };
    });
    if (fieldMappings.length > SANDBOX_DOCUMENT_LIMITS.fieldMappings)
      throw new Error("field mapping limit exceeded");
    return {
      id: boundedString(source.id, "relationship id"),
      name: boundedString(
        source.name,
        "relationship name",
        SANDBOX_DOCUMENT_LIMITS.nameCharacters,
      ),
      sourceModuleId: boundedString(
        source.sourceModuleId,
        "relationship sourceModuleId",
      ),
      targetModuleId: boundedString(
        source.targetModuleId,
        "relationship targetModuleId",
      ),
      cardinality: cardinality as SandboxRelationship["cardinality"],
      fieldMappings,
    };
  });
  if (semantic)
    assertUnique(
      parsedRelationships.map((item) => item.id),
      "relationship IDs",
    );
  if (semantic)
    for (const relationship of parsedRelationships)
      validateRelationship(relationship, parsedModules);
  const layout = parseLayout(source.layout);
  const layoutIds = new Set(Object.keys(layout));
  const expectedLayoutIds = [...parsedDepartments, ...parsedModules].map(
    (item) => item.id,
  );
  if (
    semantic &&
    (layoutIds.size !== expectedLayoutIds.length ||
      expectedLayoutIds.some((id) => !layoutIds.has(id)))
  )
    throw new Error("layout must contain exactly every department and module");
  return {
    departments: parsedDepartments,
    modules: parsedModules,
    relationships: parsedRelationships,
    layout,
  };
}

function assertUnique(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length)
    throw new Error(`${label} must be unique`);
}

function compatibleFields(
  source: SandboxDocumentField,
  target: SandboxDocumentField,
): boolean {
  if (!source.required && target.required) return false;
  const sourceKind = source.config.kind;
  const targetKind = target.config.kind;
  const sourceMaximum =
    sourceKind === "text" ||
    sourceKind === "long-text" ||
    sourceKind === "email" ||
    sourceKind === "url"
      ? source.config.maxLength
      : undefined;
  const targetMaximum =
    targetKind === "text" ||
    targetKind === "long-text" ||
    targetKind === "email" ||
    targetKind === "url"
      ? target.config.maxLength
      : undefined;
  const maximumFits =
    targetMaximum === undefined ||
    (sourceMaximum !== undefined && sourceMaximum <= targetMaximum);
  const rangeFits = <T extends string | number>(
    sourceMinimum: T | undefined,
    sourceMaximum: T | undefined,
    targetMinimum: T | undefined,
    targetMaximum: T | undefined,
  ) =>
    (targetMinimum === undefined ||
      (sourceMinimum !== undefined && sourceMinimum >= targetMinimum)) &&
    (targetMaximum === undefined ||
      (sourceMaximum !== undefined && sourceMaximum <= targetMaximum));
  const numericStepFits = (
    sourceMinimum: number | undefined,
    sourceStep: number | undefined,
    targetMinimum: number | undefined,
    targetStep: number | undefined,
  ) => {
    if (targetStep === undefined) return true;
    if (sourceStep === undefined) return false;
    const quotient = sourceStep / targetStep;
    const base = ((sourceMinimum ?? 0) - (targetMinimum ?? 0)) / targetStep;
    return (
      Math.abs(quotient - Math.round(quotient)) <= 1e-9 &&
      Math.abs(base - Math.round(base)) <= 1e-9
    );
  };
  if (sourceKind === "select") {
    if (targetKind !== "select") return false;
    const targetOptions = target.config.options;
    return source.config.options.every((item) => targetOptions.includes(item));
  }
  if (sourceKind === "number" || sourceKind === "integer") {
    if (targetKind !== "number" && sourceKind !== targetKind) return false;
    return (
      rangeFits(
        source.config.min,
        source.config.max,
        target.config.min,
        target.config.max,
      ) &&
      numericStepFits(
        source.config.min,
        source.config.step ?? (sourceKind === "integer" ? 1 : undefined),
        target.config.min,
        target.config.step,
      )
    );
  }
  if (sourceKind === "date" || sourceKind === "datetime") {
    if (targetKind !== sourceKind) return false;
    return dateRangeFits(
      sourceKind,
      source.config.earliest,
      source.config.latest,
      target.config.earliest,
      target.config.latest,
    );
  }
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

function validateRelationship(
  relationship: SandboxRelationship,
  modules: readonly SandboxDocumentModule[],
): void {
  const source = modules.find(
    (item) => item.id === relationship.sourceModuleId,
  );
  const target = modules.find(
    (item) => item.id === relationship.targetModuleId,
  );
  if (!source || !target || source.id === target.id)
    throw new Error("relationship modules are invalid");
  const mappingKeys = new Set<string>();
  for (const mapping of relationship.fieldMappings) {
    const sourceField = source.fields.find(
      (item) => item.id === mapping.sourceFieldId,
    );
    const targetField = target.fields.find(
      (item) => item.id === mapping.targetFieldId,
    );
    if (
      !sourceField ||
      !targetField ||
      sourceField.closed ||
      targetField.closed ||
      !compatibleFields(sourceField, targetField)
    )
      throw new Error("relationship field mapping is invalid");
    const key = `${mapping.sourceFieldId}\u0000${mapping.targetFieldId}`;
    if (mappingKeys.has(key))
      throw new Error("relationship field mappings must be unique");
    mappingKeys.add(key);
  }
}

function parseFieldReference(
  value: unknown,
  label: string,
): SandboxFieldReference {
  const source = record(value, label);
  exactKeys(source, ["moduleId", "fieldId", "relationshipId"], label);
  const relationshipId =
    source.relationshipId === undefined || source.relationshipId === null
      ? undefined
      : boundedString(source.relationshipId, `${label} relationshipId`);
  return {
    moduleId: boundedString(source.moduleId, `${label} moduleId`),
    fieldId: boundedString(source.fieldId, `${label} fieldId`),
    ...(relationshipId === undefined ? {} : { relationshipId }),
  };
}

function parseValueSource(value: unknown): SandboxValueSource {
  const source = record(value, "value source");
  const kind = string(source.kind, "value source kind");
  if (kind === "literal") {
    exactKeys(source, ["kind", "value"], "value source");
    return { kind, value: parseFieldValue(source.value, "literal value") };
  }
  if (kind === "field-reference") {
    exactKeys(
      source,
      ["kind", "moduleId", "fieldId", "relationshipId"],
      "value source",
    );
    return {
      kind,
      ...parseFieldReference(
        {
          moduleId: source.moduleId,
          fieldId: source.fieldId,
          ...(source.relationshipId === undefined ||
          source.relationshipId === null
            ? {}
            : { relationshipId: source.relationshipId }),
        },
        "value source",
      ),
    };
  }
  throw new Error("value source kind is invalid");
}

function parseAutomationTrigger(value: unknown): SandboxAutomationTrigger {
  const source = record(value, "automation trigger");
  const kind = string(source.kind, "automation trigger kind");
  if (kind === "record-created") {
    exactKeys(source, ["kind", "moduleId"], "automation trigger");
    return {
      kind,
      moduleId: boundedString(source.moduleId, "trigger moduleId"),
    };
  }
  if (kind === "field-changed") {
    exactKeys(source, ["kind", "moduleId", "fieldId"], "automation trigger");
    return {
      kind,
      moduleId: boundedString(source.moduleId, "trigger moduleId"),
      fieldId: boundedString(source.fieldId, "trigger fieldId"),
    };
  }
  if (kind === "threshold-crossed") {
    exactKeys(
      source,
      ["kind", "moduleId", "fieldId", "operator", "value"],
      "automation trigger",
    );
    return {
      kind,
      moduleId: boundedString(source.moduleId, "trigger moduleId"),
      fieldId: boundedString(source.fieldId, "trigger fieldId"),
      operator: comparisonOperator(source.operator, "trigger operator"),
      value: parseValueSource(source.value),
    };
  }
  if (kind === "schedule") {
    exactKeys(
      source,
      ["kind", "moduleId", "frequency", "time", "weekday"],
      "automation trigger",
    );
    const frequency = string(source.frequency, "schedule frequency");
    const weekday =
      source.weekday === undefined || source.weekday === null
        ? undefined
        : finiteNumber(source.weekday, "schedule weekday");
    if (
      !["daily", "weekly"].includes(frequency) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(string(source.time, "schedule time")) ||
      (frequency === "weekly" &&
        (!Number.isInteger(weekday) ||
          (weekday ?? 0) < 1 ||
          (weekday ?? 0) > 7))
    )
      throw new Error("schedule trigger is invalid");
    return {
      kind,
      ...(source.moduleId === undefined || source.moduleId === null
        ? {}
        : { moduleId: boundedString(source.moduleId, "schedule moduleId") }),
      frequency: frequency as "daily" | "weekly",
      time: string(source.time, "schedule time"),
      ...(weekday === undefined ? {} : { weekday }),
    };
  }
  throw new Error("automation trigger kind is invalid");
}

function parseAutomationAction(value: unknown): SandboxAutomationAction {
  const source = record(value, "automation action");
  const id = boundedString(source.id, "automation action id");
  const kind = string(source.kind, "automation action kind");
  if (kind === "notification") {
    exactKeys(source, ["id", "kind", "message"], "automation action");
    return {
      id,
      kind,
      message: boundedString(source.message, "notification message"),
    };
  }
  if (kind === "channel-message") {
    exactKeys(source, ["id", "kind", "channel"], "automation action");
    return {
      id,
      kind,
      channel: boundedString(source.channel, "channel message channel"),
    };
  }
  if (kind === "assign-task") {
    exactKeys(source, ["id", "kind", "assignee"], "automation action");
    return {
      id,
      kind,
      assignee: boundedString(source.assignee, "task assignee"),
    };
  }
  if (kind === "set-field") {
    exactKeys(source, ["id", "kind", "target", "value"], "automation action");
    return {
      id,
      kind,
      target: parseFieldReference(source.target, "action target"),
      value: parseValueSource(source.value),
    };
  }
  if (kind === "create-record") {
    exactKeys(
      source,
      ["id", "kind", "moduleId", "values"],
      "automation action",
    );
    const values = array(source.values, "create record values").map((item) => {
      const source = record(item, "create record value");
      exactKeys(source, ["fieldId", "value"], "create record value");
      return {
        fieldId: boundedString(source.fieldId, "create record fieldId"),
        value: parseValueSource(source.value),
      };
    });
    return {
      id,
      kind,
      moduleId: boundedString(source.moduleId, "create record moduleId"),
      values,
    };
  }
  throw new Error("automation action kind is invalid");
}

function fieldForReference(
  reference: SandboxFieldReference,
  design: SandboxDocumentDesign,
): SandboxDocumentField {
  const sandboxModule = design.modules.find(
    (item) => item.id === reference.moduleId,
  );
  const field = sandboxModule?.fields.find(
    (item) => item.id === reference.fieldId,
  );
  if (!sandboxModule || !field)
    throw new Error("field reference does not exist");
  if (reference.relationshipId !== undefined) {
    const relationship = design.relationships.find(
      (item) => item.id === reference.relationshipId,
    );
    if (
      !relationship ||
      ![relationship.sourceModuleId, relationship.targetModuleId].includes(
        sandboxModule.id,
      )
    )
      throw new Error("field reference relationship does not exist");
  }
  return field;
}

function validateValueSource(
  source: SandboxValueSource,
  design: SandboxDocumentDesign,
  target?: SandboxDocumentField,
): void {
  if (source.kind === "field-reference") {
    const sourceField = fieldForReference(source, design);
    if (target && !compatibleFields(sourceField, target))
      throw new Error("field reference does not match its target field");
  } else if (target && !valueMatchesField(source.value, target))
    throw new Error("literal value does not match its field");
}

type AutomationReference = {
  moduleId: string;
  relationshipId?: string;
  fieldId?: string;
};

function automationReferences(
  automation: SandboxAutomation,
): AutomationReference[] {
  const references: AutomationReference[] = [];
  const addField = (reference: SandboxFieldReference) =>
    references.push(reference);
  const addValue = (source: SandboxValueSource) => {
    if (source.kind === "field-reference") addField(source);
  };
  if (automation.trigger.kind === "threshold-crossed")
    addValue(automation.trigger.value);
  for (const condition of automation.conditionGroup.conditions) {
    addField(condition.field);
    addValue(condition.value);
  }
  for (const action of automation.actions) {
    if (action.kind === "set-field") {
      addField(action.target);
      addValue(action.value);
    }
    if (action.kind === "create-record") {
      for (const value of action.values) addValue(value.value);
    }
  }
  return references;
}

function validateAutomationReachability(
  automation: SandboxAutomation,
  design: SandboxDocumentDesign,
): void {
  const references = automationReferences(automation);
  const directModules = [
    ...new Set(
      references
        .filter((reference) => reference.relationshipId === undefined)
        .map((reference) => reference.moduleId),
    ),
  ];
  const origin =
    automation.trigger.kind === "schedule"
      ? directModules.length === 0
        ? undefined
        : directModules.length === 1
          ? directModules[0]
          : (() => {
              throw new Error(
                "schedule automation references multiple modules",
              );
            })()
      : automation.trigger.moduleId;
  for (const reference of references) {
    if (reference.fieldId !== undefined)
      fieldForReference(reference as SandboxFieldReference, design);
    if (reference.relationshipId === undefined) {
      if (origin !== undefined && reference.moduleId !== origin)
        throw new Error("automation direct reference is not reachable");
      continue;
    }
    if (origin === undefined || reference.moduleId === origin)
      throw new Error("automation relationship reference has no remote module");
    const relationship = design.relationships.find(
      (item) => item.id === reference.relationshipId,
    );
    if (
      !relationship ||
      !(
        (relationship.sourceModuleId === origin &&
          relationship.targetModuleId === reference.moduleId) ||
        (relationship.targetModuleId === origin &&
          relationship.sourceModuleId === reference.moduleId)
      )
    )
      throw new Error("automation relationship reference is not reachable");
  }
}

function parseAutomations(
  value: unknown,
  design: SandboxDocumentDesign,
  semantic = true,
): SandboxAutomation[] {
  const items = array(value, "automations");
  if (items.length > SANDBOX_DOCUMENT_LIMITS.automations)
    throw new Error("Automation limit exceeded");
  const automations = items.map((item): SandboxAutomation => {
    const source = record(item, "automation");
    exactKeys(
      source,
      [
        "id",
        "name",
        "enabled",
        "priority",
        "trigger",
        "conditionGroup",
        "actions",
      ],
      "automation",
    );
    const conditionGroup = record(source.conditionGroup, "condition group");
    exactKeys(conditionGroup, ["operator", "conditions"], "condition group");
    const operator = string(
      conditionGroup.operator,
      "condition group operator",
    );
    if (operator !== "all" && operator !== "any")
      throw new Error("condition group operator is invalid");
    const conditions = array(
      conditionGroup.conditions,
      "automation conditions",
    ).map((item): SandboxAutomationCondition => {
      const source = record(item, "automation condition");
      exactKeys(
        source,
        ["id", "field", "operator", "value"],
        "automation condition",
      );
      return {
        id: boundedString(source.id, "automation condition id"),
        field: parseFieldReference(source.field, "condition field"),
        operator: comparisonOperator(source.operator, "condition operator"),
        value: parseValueSource(source.value),
      };
    });
    const actions = array(source.actions, "automation actions").map(
      parseAutomationAction,
    );
    if (
      conditions.length > SANDBOX_DOCUMENT_LIMITS.conditionsPerAutomation ||
      actions.length === 0 ||
      actions.length > SANDBOX_DOCUMENT_LIMITS.actionsPerAutomation
    )
      throw new Error("automation condition or action limit exceeded");
    const priority = finiteNumber(source.priority, "automation priority");
    if (!Number.isInteger(priority) || priority < -10_000 || priority > 10_000)
      throw new Error("automation priority is invalid");
    return {
      id: boundedString(source.id, "automation id"),
      name: boundedString(
        source.name,
        "automation name",
        SANDBOX_DOCUMENT_LIMITS.nameCharacters,
      ),
      enabled: boolean(source.enabled, "automation enabled"),
      priority,
      trigger: parseAutomationTrigger(source.trigger),
      conditionGroup: { operator, conditions },
      actions,
    };
  });
  if (semantic)
    assertUnique(
      automations.map((item) => item.id),
      "automation IDs",
    );
  if (semantic)
    for (const automation of automations)
      validateAutomation(automation, design);
  return automations;
}

function validateAutomation(
  automation: SandboxAutomation,
  design: SandboxDocumentDesign,
): void {
  const trigger = automation.trigger;
  if (trigger.kind !== "schedule") {
    const triggerField =
      "fieldId" in trigger
        ? { moduleId: trigger.moduleId, fieldId: trigger.fieldId }
        : undefined;
    if (
      !design.modules.some((item) => item.id === trigger.moduleId) ||
      (triggerField && !fieldForReference(triggerField, design))
    )
      throw new Error("automation trigger reference does not exist");
    if (trigger.kind === "threshold-crossed")
      validateValueSource(
        trigger.value,
        design,
        fieldForReference(triggerField!, design),
      );
  }
  for (const condition of automation.conditionGroup.conditions) {
    const field = fieldForReference(condition.field, design);
    validateValueSource(condition.value, design, field);
  }
  assertUnique(
    automation.conditionGroup.conditions.map((item) => item.id),
    "automation condition IDs",
  );
  assertUnique(
    automation.actions.map((item) => item.id),
    "automation action IDs",
  );
  for (const action of automation.actions) {
    if (action.kind === "set-field")
      validateValueSource(
        action.value,
        design,
        fieldForReference(action.target, design),
      );
    if (action.kind === "create-record") {
      const targetModule = design.modules.find(
        (item) => item.id === action.moduleId,
      );
      if (!targetModule) throw new Error("create record module does not exist");
      assertUnique(
        action.values.map((item) => item.fieldId),
        "create record field IDs",
      );
      for (const value of action.values) {
        const field = targetModule.fields.find(
          (item) => item.id === value.fieldId,
        );
        if (!field) throw new Error("create record field does not exist");
        validateValueSource(value.value, design, field);
      }
    }
  }
  validateAutomationReachability(automation, design);
}

function parseScenarios(
  value: unknown,
  design: SandboxDocumentDesign,
  semantic = true,
): SandboxScenarioTemplate[] {
  const items = array(value, "scenarios");
  if (items.length > SANDBOX_DOCUMENT_LIMITS.scenarios)
    throw new Error("Scenario limit exceeded");
  const scenarios = items.map((item): SandboxScenarioTemplate => {
    const source = record(item, "scenario");
    exactKeys(source, ["id", "name", "records", "links"], "scenario");
    const records = array(source.records, "scenario records").map(
      (item): SandboxSyntheticRecord => {
        const source = record(item, "scenario record");
        exactKeys(source, ["id", "moduleId", "values"], "scenario record");
        const values = record(source.values, "scenario record values");
        return {
          id: boundedString(source.id, "scenario record id"),
          moduleId: boundedString(source.moduleId, "scenario record moduleId"),
          values: Object.fromEntries(
            Object.entries(values).map(([id, item]) => [
              boundedString(id, "scenario field ID"),
              parseFieldValue(item, "scenario field value"),
            ]),
          ),
        };
      },
    );
    if (records.length > SANDBOX_DOCUMENT_LIMITS.recordsPerScenario)
      throw new Error("Scenario record limit exceeded");
    const links = array(source.links, "scenario links").map(
      (item): SandboxScenarioLink => {
        const source = record(item, "scenario link");
        exactKeys(
          source,
          ["relationshipId", "sourceRecordId", "targetRecordId"],
          "scenario link",
        );
        return {
          relationshipId: boundedString(
            source.relationshipId,
            "scenario relationshipId",
          ),
          sourceRecordId: boundedString(
            source.sourceRecordId,
            "scenario sourceRecordId",
          ),
          targetRecordId: boundedString(
            source.targetRecordId,
            "scenario targetRecordId",
          ),
        };
      },
    );
    return {
      id: boundedString(source.id, "scenario id"),
      name: boundedString(
        source.name,
        "scenario name",
        SANDBOX_DOCUMENT_LIMITS.nameCharacters,
      ),
      records,
      links,
    };
  });
  if (semantic)
    assertUnique(
      scenarios.map((item) => item.id),
      "scenario IDs",
    );
  if (semantic)
    for (const scenario of scenarios) validateScenario(scenario, design);
  return scenarios;
}

function validateScenario(
  scenario: SandboxScenarioTemplate,
  design: SandboxDocumentDesign,
): void {
  assertUnique(
    scenario.records.map((item) => item.id),
    "scenario record IDs",
  );
  for (const record of scenario.records) {
    const recordModule = design.modules.find(
      (item) => item.id === record.moduleId,
    );
    if (!recordModule) throw new Error("scenario record module does not exist");
    for (const [fieldId, value] of Object.entries(record.values)) {
      const field = recordModule.fields.find((item) => item.id === fieldId);
      if (!field || !valueMatchesField(value, field))
        throw new Error("scenario field value is invalid");
    }
  }
  const linkKeys = new Set<string>();
  const sourceLinkCounts = new Map<string, number>();
  const targetLinkCounts = new Map<string, number>();
  for (const link of scenario.links) {
    const relationship = design.relationships.find(
      (item) => item.id === link.relationshipId,
    );
    const source = scenario.records.find(
      (item) => item.id === link.sourceRecordId,
    );
    const target = scenario.records.find(
      (item) => item.id === link.targetRecordId,
    );
    if (
      !relationship ||
      !source ||
      !target ||
      source.moduleId !== relationship.sourceModuleId ||
      target.moduleId !== relationship.targetModuleId
    )
      throw new Error("scenario link is invalid");
    const key = `${link.relationshipId}\u0000${link.sourceRecordId}\u0000${link.targetRecordId}`;
    if (linkKeys.has(key)) throw new Error("scenario links must be unique");
    linkKeys.add(key);
    const sourceKey = `${link.relationshipId}\u0000${link.sourceRecordId}`;
    const targetKey = `${link.relationshipId}\u0000${link.targetRecordId}`;
    const sourceCount = (sourceLinkCounts.get(sourceKey) ?? 0) + 1;
    const targetCount = (targetLinkCounts.get(targetKey) ?? 0) + 1;
    if (
      relationship.cardinality === "one-to-one" &&
      (sourceCount > 1 || targetCount > 1)
    )
      throw new Error("one-to-one scenario cardinality is invalid");
    if (relationship.cardinality === "one-to-many" && targetCount > 1)
      throw new Error("one-to-many scenario cardinality is invalid");
    sourceLinkCounts.set(sourceKey, sourceCount);
    targetLinkCounts.set(targetKey, targetCount);
  }
}

function parseDocumentContents(
  source: UnknownRecord,
  semantic = true,
): Omit<SandboxDocumentV2, "kind" | "schemaVersion" | "versions"> {
  return {
    design: parseDesign(source.design, semantic),
    automations: [],
    scenarios: [],
  };
}

function parseVersion(value: unknown, semantic = true): SandboxVersionSnapshot {
  const source = record(value, "version snapshot");
  exactKeys(
    source,
    ["id", "label", "kind", "document", "published", "date", "note"],
    "version snapshot",
  );
  const kind = string(source.kind, "version snapshot kind");
  if (!["checkpoint", "published", "imported"].includes(kind))
    throw new Error("version snapshot kind is invalid");
  const documentSource = record(source.document, "version document");
  exactKeys(
    documentSource,
    ["design", "automations", "scenarios"],
    "version document",
  );
  const contents = parseDocumentContents(documentSource, semantic);
  contents.automations = parseAutomations(
    documentSource.automations,
    contents.design,
    semantic,
  );
  contents.scenarios = parseScenarios(
    documentSource.scenarios,
    contents.design,
    semantic,
  );
  const note =
    source.note === undefined || source.note === null
      ? undefined
      : string(source.note, "version snapshot note");
  if ((note?.length ?? 0) > SANDBOX_DOCUMENT_LIMITS.textCharacters)
    throw new Error("version snapshot note is too long");
  return {
    id: boundedString(source.id, "version snapshot id"),
    label: boundedString(
      source.label,
      "version snapshot label",
      SANDBOX_DOCUMENT_LIMITS.nameCharacters,
    ),
    kind: kind as SandboxVersionSnapshot["kind"],
    document: contents,
    published: boolean(source.published, "version snapshot published"),
    date: boundedString(source.date, "version snapshot date"),
    ...(note === undefined ? {} : { note }),
  };
}

function parseDocument(value: unknown, semantic = true): SandboxDocumentV2 {
  const source = record(value, "sandbox document");
  exactKeys(
    source,
    ["kind", "schemaVersion", "design", "automations", "scenarios", "versions"],
    "sandbox document",
  );
  if (source.kind !== "openslate-sandbox")
    throw new Error("File kind must be openslate-sandbox");
  if (source.schemaVersion !== 2)
    throw new Error("Sandbox schema version is not supported");
  const contents = parseDocumentContents(source, semantic);
  contents.automations = parseAutomations(
    source.automations,
    contents.design,
    semantic,
  );
  contents.scenarios = parseScenarios(
    source.scenarios,
    contents.design,
    semantic,
  );
  const versions =
    source.versions === undefined || source.versions === null
      ? undefined
      : array(source.versions, "versions").map((item) =>
          parseVersion(item, semantic),
        );
  if ((versions?.length ?? 0) > SANDBOX_DOCUMENT_LIMITS.versions)
    throw new Error("Version limit exceeded");
  assertUnique(versions?.map((item) => item.id) ?? [], "version snapshot IDs");
  return {
    kind: "openslate-sandbox",
    schemaVersion: 2,
    ...contents,
    ...(versions === undefined ? {} : { versions }),
  };
}

export function parseSandboxDocument(text: string): SandboxDocumentParseResult {
  try {
    if (
      new TextEncoder().encode(text).byteLength >
      SANDBOX_DOCUMENT_LIMITS.fileBytes
    )
      throw new Error("Sandbox document exceeds the 5 MiB limit");
    const root = record(JSON.parse(text) as unknown, "sandbox document");
    if (root.schemaVersion === 1) {
      const parsedV1 = parseSandboxFile(
        text,
        SANDBOX_DOCUMENT_LIMITS.fileBytes,
      );
      if (!parsedV1.ok) throw new Error(parsedV1.error);
      return { ok: true, document: migrateSandboxFileV1(parsedV1.file) };
    }
    return { ok: true, document: parseDocument(root) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Sandbox document is invalid",
    };
  }
}

/** Parses an authenticated draft response without rejecting repairable graph issues. */
export function parseSandboxDocumentForApi(
  text: string,
): SandboxDocumentParseResult {
  try {
    if (
      new TextEncoder().encode(text).byteLength >
      SANDBOX_DOCUMENT_LIMITS.fileBytes
    )
      throw new Error("Sandbox document exceeds the 5 MiB limit");
    return {
      ok: true,
      document: parseDocument(JSON.parse(text) as unknown, false),
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Sandbox document is invalid",
    };
  }
}

export function exportSandboxDocument(document: SandboxDocumentV2): string {
  const candidate = JSON.stringify(document);
  const parsed = parseSandboxDocument(candidate);
  if (!parsed.ok) throw new Error(parsed.error);
  const canonical = JSON.stringify(parsed.document);
  if (
    new TextEncoder().encode(canonical).byteLength >
    SANDBOX_DOCUMENT_LIMITS.fileBytes
  )
    throw new Error("Sandbox document exceeds the 5 MiB limit");
  return canonical;
}

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
  const parsed = parseSandboxDocument(exported);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}
