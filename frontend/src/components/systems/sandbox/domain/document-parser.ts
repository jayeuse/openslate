import {
  dateRangeFits,
  dateTimeInstant,
  dateValueInRange,
} from "./date-values";
import { canonicalFieldType, normalizeField, type FieldConfig } from "./model";
import {
  SANDBOX_DOCUMENT_LIMITS,
  type SandboxDocumentParseResult,
  type SandboxComparisonOperator,
  type SandboxLayoutBox,
  type SandboxFieldMapping,
  type SandboxScenarioLink,
  type SandboxDocumentV3,
  type SandboxFieldValue,
  type SandboxDocumentField,
  type SandboxDocumentDesign,
  type SandboxDocumentDepartment,
  type SandboxDocumentModule,
  type SandboxRelationship,
  type SandboxFieldReference,
  type SandboxValueSource,
  type SandboxTriggerEvent,
  type SandboxTriggerAction,
  type SandboxTriggerCondition,
  type SandboxTrigger,
  type SandboxScenarioTemplate,
  type SandboxSyntheticRecord,
  type SandboxVersionSnapshot,
  SANDBOX_DOCUMENT_SCHEMA_VERSION,
  SANDBOX_OLDER_FORMAT_MESSAGE,
} from "./document-types";

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

function parseTriggerEvent(value: unknown): SandboxTriggerEvent {
  const source = record(value, "trigger event");
  const kind = string(source.kind, "trigger event kind");
  if (kind === "record-created") {
    exactKeys(source, ["kind", "moduleId"], "trigger event");
    return {
      kind,
      moduleId: boundedString(source.moduleId, "trigger moduleId"),
    };
  }
  if (kind === "field-changed") {
    exactKeys(source, ["kind", "moduleId", "fieldId"], "trigger event");
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
      "trigger event",
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
      "trigger event",
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
  throw new Error("trigger event kind is invalid");
}

function parseTriggerAction(value: unknown): SandboxTriggerAction {
  const source = record(value, "trigger action");
  const id = boundedString(source.id, "trigger action id");
  const kind = string(source.kind, "trigger action kind");
  if (kind === "notification") {
    exactKeys(source, ["id", "kind", "message"], "trigger action");
    return {
      id,
      kind,
      message: boundedString(source.message, "notification message"),
    };
  }
  if (kind === "channel-message") {
    exactKeys(source, ["id", "kind", "channel"], "trigger action");
    return {
      id,
      kind,
      channel: boundedString(source.channel, "channel message channel"),
    };
  }
  if (kind === "assign-task") {
    exactKeys(source, ["id", "kind", "assignee"], "trigger action");
    return {
      id,
      kind,
      assignee: boundedString(source.assignee, "task assignee"),
    };
  }
  if (kind === "set-field") {
    exactKeys(source, ["id", "kind", "target", "value"], "trigger action");
    return {
      id,
      kind,
      target: parseFieldReference(source.target, "action target"),
      value: parseValueSource(source.value),
    };
  }
  if (kind === "create-record") {
    exactKeys(source, ["id", "kind", "moduleId", "values"], "trigger action");
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
  throw new Error("trigger action kind is invalid");
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

type TriggerReference = {
  moduleId: string;
  relationshipId?: string;
  fieldId?: string;
};

function triggerReferences(recordTrigger: SandboxTrigger): TriggerReference[] {
  const references: TriggerReference[] = [];
  const addField = (reference: SandboxFieldReference) =>
    references.push(reference);
  const addValue = (source: SandboxValueSource) => {
    if (source.kind === "field-reference") addField(source);
  };
  if (recordTrigger.trigger.kind === "threshold-crossed")
    addValue(recordTrigger.trigger.value);
  for (const condition of recordTrigger.conditionGroup.conditions) {
    addField(condition.field);
    addValue(condition.value);
  }
  for (const action of recordTrigger.actions) {
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

function validateTriggerReachability(
  recordTrigger: SandboxTrigger,
  design: SandboxDocumentDesign,
): void {
  const references = triggerReferences(recordTrigger);
  const directModules = [
    ...new Set(
      references
        .filter((reference) => reference.relationshipId === undefined)
        .map((reference) => reference.moduleId),
    ),
  ];
  const origin =
    recordTrigger.trigger.kind === "schedule"
      ? directModules.length === 0
        ? undefined
        : directModules.length === 1
          ? directModules[0]
          : (() => {
              throw new Error("schedule trigger references multiple modules");
            })()
      : recordTrigger.trigger.moduleId;
  for (const reference of references) {
    if (reference.fieldId !== undefined)
      fieldForReference(reference as SandboxFieldReference, design);
    if (reference.relationshipId === undefined) {
      if (origin !== undefined && reference.moduleId !== origin)
        throw new Error("trigger direct reference is not reachable");
      continue;
    }
    if (origin === undefined || reference.moduleId === origin)
      throw new Error("trigger relationship reference has no remote module");
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
      throw new Error("trigger relationship reference is not reachable");
  }
}

function parseTriggers(
  value: unknown,
  design: SandboxDocumentDesign,
  semantic = true,
): SandboxTrigger[] {
  const items = array(value, "triggers");
  if (items.length > SANDBOX_DOCUMENT_LIMITS.triggers)
    throw new Error("Trigger limit exceeded");
  const triggers = items.map((item): SandboxTrigger => {
    const source = record(item, "trigger");
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
      "trigger",
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
      "trigger conditions",
    ).map((item): SandboxTriggerCondition => {
      const source = record(item, "trigger condition");
      exactKeys(
        source,
        ["id", "field", "operator", "value"],
        "trigger condition",
      );
      return {
        id: boundedString(source.id, "trigger condition id"),
        field: parseFieldReference(source.field, "condition field"),
        operator: comparisonOperator(source.operator, "condition operator"),
        value: parseValueSource(source.value),
      };
    });
    const actions = array(source.actions, "trigger actions").map(
      parseTriggerAction,
    );
    if (
      conditions.length > SANDBOX_DOCUMENT_LIMITS.conditionsPerTrigger ||
      actions.length === 0 ||
      actions.length > SANDBOX_DOCUMENT_LIMITS.actionsPerTrigger
    )
      throw new Error("trigger condition or action limit exceeded");
    const priority = finiteNumber(source.priority, "trigger priority");
    if (!Number.isInteger(priority) || priority < -10_000 || priority > 10_000)
      throw new Error("trigger priority is invalid");
    return {
      id: boundedString(source.id, "trigger id"),
      name: boundedString(
        source.name,
        "trigger name",
        SANDBOX_DOCUMENT_LIMITS.nameCharacters,
      ),
      enabled: boolean(source.enabled, "trigger enabled"),
      priority,
      trigger: parseTriggerEvent(source.trigger),
      conditionGroup: { operator, conditions },
      actions,
    };
  });
  if (semantic)
    assertUnique(
      triggers.map((item) => item.id),
      "trigger IDs",
    );
  if (semantic)
    for (const recordTrigger of triggers)
      validateTrigger(recordTrigger, design);
  return triggers;
}

function validateTrigger(
  recordTrigger: SandboxTrigger,
  design: SandboxDocumentDesign,
): void {
  const trigger = recordTrigger.trigger;
  if (trigger.kind !== "schedule") {
    const triggerField =
      "fieldId" in trigger
        ? { moduleId: trigger.moduleId, fieldId: trigger.fieldId }
        : undefined;
    if (
      !design.modules.some((item) => item.id === trigger.moduleId) ||
      (triggerField && !fieldForReference(triggerField, design))
    )
      throw new Error("trigger event reference does not exist");
    if (trigger.kind === "threshold-crossed")
      validateValueSource(
        trigger.value,
        design,
        fieldForReference(triggerField!, design),
      );
  }
  for (const condition of recordTrigger.conditionGroup.conditions) {
    const field = fieldForReference(condition.field, design);
    validateValueSource(condition.value, design, field);
  }
  assertUnique(
    recordTrigger.conditionGroup.conditions.map((item) => item.id),
    "trigger condition IDs",
  );
  assertUnique(
    recordTrigger.actions.map((item) => item.id),
    "trigger action IDs",
  );
  for (const action of recordTrigger.actions) {
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
  validateTriggerReachability(recordTrigger, design);
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
): Omit<SandboxDocumentV3, "kind" | "schemaVersion" | "versions"> {
  return {
    design: parseDesign(source.design, semantic),
    triggers: [],
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
    ["design", "triggers", "scenarios"],
    "version document",
  );
  const contents = parseDocumentContents(documentSource, semantic);
  contents.triggers = parseTriggers(
    documentSource.triggers,
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

function parseDocument(value: unknown, semantic = true): SandboxDocumentV3 {
  const source = record(value, "sandbox document");
  if (
    typeof source.schemaVersion === "number" &&
    source.schemaVersion < SANDBOX_DOCUMENT_SCHEMA_VERSION
  )
    throw new Error(SANDBOX_OLDER_FORMAT_MESSAGE);
  exactKeys(
    source,
    ["kind", "schemaVersion", "design", "triggers", "scenarios", "versions"],
    "sandbox document",
  );
  if (source.kind !== "openslate-sandbox")
    throw new Error("File kind must be openslate-sandbox");
  if (source.schemaVersion !== SANDBOX_DOCUMENT_SCHEMA_VERSION)
    throw new Error("Sandbox schema version is not supported");
  const contents = parseDocumentContents(source, semantic);
  contents.triggers = parseTriggers(source.triggers, contents.design, semantic);
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
    schemaVersion: SANDBOX_DOCUMENT_SCHEMA_VERSION,
    ...contents,
    ...(versions === undefined ? {} : { versions }),
  };
}

/** Parses an already-decoded document at the strict schema boundary. */
export function parseSandboxDocumentValue(
  value: unknown,
  semantic = true,
): SandboxDocumentV3 {
  return parseDocument(value, semantic);
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
