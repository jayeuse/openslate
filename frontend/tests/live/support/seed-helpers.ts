import type {
  CatalogModule,
  PrimitiveFieldSpec,
  RelationshipDefinition,
} from "./catalog";
import { RUN_MARKER_FIELD_KEY } from "./catalog";
import type { LiveField, LiveFieldType } from "./api";

export type SeedFormValue = string | boolean;
export type SeedPayloadValue = string | number | boolean | null;
export type SeedFieldDescriptor = Pick<LiveField, "id" | "name" | "type">;
export type FieldControlRole =
  "checkbox" | "combobox" | "spinbutton" | "textbox";
export type RelationshipAssignment = Readonly<{
  sourceIndex: number;
  targetIndex: number;
}>;

function assertRecordNumber(recordNumber: number): void {
  if (!Number.isInteger(recordNumber) || recordNumber < 1) {
    throw new Error("Live seed records must use a positive record number");
  }
}

export function runMarkerValue(
  namespace: string,
  moduleKey: string,
  recordNumber: number,
): string {
  assertRecordNumber(recordNumber);
  if (!namespace || !moduleKey) {
    throw new Error("Live run markers require a namespace and module key");
  }
  return `${namespace}:${moduleKey}:record-${recordNumber}`;
}

export function generateSanityFormValue(
  catalogModule: CatalogModule,
  field: PrimitiveFieldSpec,
  recordNumber: number,
  namespace: string,
): SeedFormValue {
  assertRecordNumber(recordNumber);
  switch (field.type) {
    case "text":
      if (field.key !== `${catalogModule.key}.${RUN_MARKER_FIELD_KEY}`) {
        return `${namespace}:${catalogModule.key}:${field.key}:record-${recordNumber}`;
      }
      return runMarkerValue(namespace, catalogModule.key, recordNumber);
    case "int":
      return String(catalogModule.order * 100 + recordNumber);
    case "decimal":
      return (catalogModule.order * 1000 + recordNumber * 10 + 0.25).toFixed(2);
    case "boolean":
      return recordNumber === 1;
    case "datetime":
      return `2026-08-${String(1 + ((catalogModule.order + recordNumber) % 27)).padStart(2, "0")}T09:00`;
    case "select":
      return field.config.options?.[Math.min(recordNumber - 1, 1)] ?? "active";
  }
}

export function generateSanityFormValues(
  catalogModule: CatalogModule,
  recordNumber: number,
  namespace: string,
): Readonly<Record<string, SeedFormValue>> {
  return Object.fromEntries(
    catalogModule.primitiveFields.map((field) => [
      field.key,
      generateSanityFormValue(catalogModule, field, recordNumber, namespace),
    ]),
  );
}

export function generateSeedFormValues(
  catalogModule: CatalogModule,
  recordNumber: number,
  namespace: string,
): Readonly<Record<string, SeedFormValue>> {
  return generateSanityFormValues(catalogModule, recordNumber, namespace);
}

export function relationshipAssignments(
  relationship: Pick<
    RelationshipDefinition,
    "cardinality" | "multipleTargets" | "multipleSources"
  >,
  sourceCount: number,
  targetCount: number,
  sameModule = false,
): readonly RelationshipAssignment[] {
  if (
    !Number.isInteger(sourceCount) ||
    !Number.isInteger(targetCount) ||
    sourceCount < 1 ||
    targetCount < 1
  ) {
    return [];
  }

  const assignments: RelationshipAssignment[] = [];
  if (relationship.cardinality === "one-to-many") {
    // Each target belongs to one source, while a source may own several
    // targets. This uses every target exactly once and remains deterministic.
    for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
      const sourceIndex = Math.floor(targetIndex / 2);
      if (sourceIndex >= sourceCount) break;
      assignments.push({ sourceIndex, targetIndex });
    }
    return assignments;
  }

  if (relationship.cardinality === "many-to-many") {
    for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
      assignments.push({ sourceIndex, targetIndex: sourceIndex % targetCount });
      if (targetCount > 1) {
        assignments.push({
          sourceIndex,
          targetIndex: (sourceIndex + 1) % targetCount,
        });
      }
    }
    return assignments;
  }

  const count =
    relationship.cardinality === "one-to-one"
      ? Math.min(sourceCount, targetCount)
      : sourceCount;
  for (let sourceIndex = 0; sourceIndex < count; sourceIndex += 1) {
    const targetIndex = sameModule
      ? (sourceIndex + 1) % targetCount
      : sourceIndex % targetCount;
    assignments.push({ sourceIndex, targetIndex });
  }
  return assignments;
}

export function mapSanityFormValuesToFields(
  catalogModule: CatalogModule,
  fields: readonly SeedFieldDescriptor[],
  recordNumber: number,
  namespace: string,
): Readonly<Record<string, SeedFormValue>> {
  const values = generateSanityFormValues(
    catalogModule,
    recordNumber,
    namespace,
  );
  const mapped: Record<string, SeedFormValue> = {};
  for (const field of fields) {
    if (field.type === "relationship") continue;
    const specification = catalogModule.primitiveFields.find(
      (candidate) =>
        candidate.name === field.name && candidate.type === field.type,
    );
    if (!specification) {
      throw new Error(
        `Live field does not match the catalog: ${field.name} (${field.type})`,
      );
    }
    const value = values[specification.key];
    if (value === undefined) {
      throw new Error(
        `Live field has no generated value: ${specification.key}`,
      );
    }
    mapped[field.id] = value;
  }
  return mapped;
}

export function recordPayloadFromFormValues(
  fields: readonly SeedFieldDescriptor[],
  values: Readonly<Record<string, SeedFormValue>>,
): Readonly<Record<string, SeedPayloadValue>> {
  const payload: Record<string, SeedPayloadValue> = {};
  for (const field of fields) {
    if (field.type === "relationship") continue;
    const value = values[field.id];
    if (value === undefined) {
      throw new Error(`No form value supplied for field: ${field.id}`);
    }
    if (field.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new Error(`Boolean field has a non-boolean value: ${field.id}`);
      }
      payload[field.id] = value;
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`Non-boolean field has a boolean value: ${field.id}`);
    }
    if (value === "") {
      payload[field.id] = null;
    } else if (field.type === "int") {
      payload[field.id] = Number.parseInt(value, 10);
    } else if (field.type === "number" || field.type === "decimal") {
      payload[field.id] = Number(value);
    } else if (field.type === "datetime") {
      payload[field.id] = new Date(value).toISOString();
    } else {
      payload[field.id] = value;
    }
  }
  return payload;
}

export function relationshipTargetAccessibleName(name: string): string {
  return `${name} target`;
}

export function controlRoleForField(type: LiveFieldType): FieldControlRole {
  if (type === "boolean") return "checkbox";
  if (type === "select") return "combobox";
  if (type === "int" || type === "number" || type === "decimal") {
    return "spinbutton";
  }
  return "textbox";
}
