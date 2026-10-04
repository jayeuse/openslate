import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The backend's OpenAPI snapshot (contracts/openapi.json) and the small
// JSON-schema subset Pydantic emits: $ref resolution, value validation, and
// response generation.

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Schema = JsonObject;
export type ResponseMode = "values" | "nulls";

export const REFRESH =
  "cd backend && uv run python -m tests.contracts.export_openapi";

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectAt(value: Json | undefined): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

export function schemasAt(value: Json | undefined): Schema[] | undefined {
  return Array.isArray(value) ? value.filter(isObject) : undefined;
}

function numberAt(value: Json | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function stringAt(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function loadDocument(): JsonObject {
  const file = resolve(process.cwd(), "..", "contracts", "openapi.json");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isObject(parsed) || !isObject(parsed.paths))
    throw new Error(`${file} is not an OpenAPI document; run ${REFRESH}`);
  return parsed;
}

const document = loadDocument();
/** `paths` of the snapshot, keyed by template such as `/api/records/{record_id}`. */
export const openApiPaths = objectAt(document.paths) ?? {};
const componentSchemas = objectAt(objectAt(document.components)?.schemas) ?? {};

/** Follows `$ref` (keeping sibling keywords) and unwraps a single-`allOf` wrapper. */
export function resolveSchema(
  schema: Schema,
  seen = new Set<string>(),
): Schema {
  const ref = stringAt(schema.$ref);
  if (ref !== undefined) {
    const name = ref.replace("#/components/schemas/", "");
    const target = objectAt(componentSchemas[name]);
    if (target === undefined || seen.has(name))
      throw new Error(`Unresolvable schema reference ${ref}`);
    const { $ref: _ref, ...siblings } = schema;
    void _ref;
    return resolveSchema({ ...target, ...siblings }, new Set(seen).add(name));
  }
  const allOf = schemasAt(schema.allOf);
  if (allOf?.length === 1) {
    const { allOf: _allOf, ...siblings } = schema;
    void _allOf;
    return resolveSchema({ ...allOf[0], ...siblings }, seen);
  }
  return schema;
}

function isNullSchema(schema: Schema): boolean {
  return resolveSchema(schema).type === "null";
}

// ---------------------------------------------------------------- validation

const FORMATS: Record<string, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "date-time":
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
};

function jsonType(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function sameJson(left: Json, right: Json): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Validates `value` against the JSON-schema subset Pydantic emits; returns error lines. */
export function validateValue(raw: Schema, value: Json, at: string): string[] {
  const schema = resolveSchema(raw);
  const branches = schemasAt(schema.anyOf) ?? schemasAt(schema.oneOf);
  if (branches !== undefined) {
    const results = branches.map((branch) => validateValue(branch, value, at));
    if (results.some((errors) => errors.length === 0)) return [];
    return [
      `${at}: matches no allowed shape (${results.map((errors) => errors[0]).join(" | ")})`,
    ];
  }
  const allOf = schemasAt(schema.allOf);
  if (allOf !== undefined)
    return allOf.flatMap((branch) => validateValue(branch, value, at));
  if ("const" in schema && !sameJson(schema.const, value))
    return [`${at}: expected ${JSON.stringify(schema.const)}`];
  const allowed = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (allowed && !allowed.some((item) => sameJson(item, value)))
    return [
      `${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`,
    ];
  const type = stringAt(schema.type);
  if (type === undefined) return [];
  const actual = jsonType(value);
  if (!(actual === type || (type === "number" && actual === "integer")))
    return [`${at}: expected ${type}, got ${actual}`];
  if (typeof value === "string") return validateString(schema, value, at);
  if (typeof value === "number") return validateNumber(schema, value, at);
  if (Array.isArray(value)) return validateArray(schema, value, at);
  if (isObject(value)) return validateObject(schema, value, at);
  return [];
}

function validateString(schema: Schema, value: string, at: string): string[] {
  const errors: string[] = [];
  const format = stringAt(schema.format);
  const formatPattern = format === undefined ? undefined : FORMATS[format];
  if (formatPattern && !formatPattern.test(value))
    errors.push(`${at}: ${JSON.stringify(value)} is not a ${format}`);
  const pattern = stringAt(schema.pattern);
  if (pattern !== undefined && !new RegExp(pattern).test(value))
    errors.push(`${at}: ${JSON.stringify(value)} does not match ${pattern}`);
  const min = numberAt(schema.minLength);
  const max = numberAt(schema.maxLength);
  if (min !== undefined && value.length < min)
    errors.push(`${at}: shorter than ${min}`);
  if (max !== undefined && value.length > max)
    errors.push(`${at}: longer than ${max}`);
  return errors;
}

function validateNumber(schema: Schema, value: number, at: string): string[] {
  const errors: string[] = [];
  const minimum = numberAt(schema.minimum);
  const maximum = numberAt(schema.maximum);
  const exclusiveMinimum = numberAt(schema.exclusiveMinimum);
  if (minimum !== undefined && value < minimum)
    errors.push(`${at}: below ${minimum}`);
  if (maximum !== undefined && value > maximum)
    errors.push(`${at}: above ${maximum}`);
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum)
    errors.push(`${at}: not above ${exclusiveMinimum}`);
  return errors;
}

function validateArray(schema: Schema, value: Json[], at: string): string[] {
  const errors: string[] = [];
  const min = numberAt(schema.minItems);
  const max = numberAt(schema.maxItems);
  if (min !== undefined && value.length < min)
    errors.push(`${at}: fewer than ${min} items`);
  if (max !== undefined && value.length > max)
    errors.push(`${at}: more than ${max} items`);
  const prefix = schemasAt(schema.prefixItems);
  const items = objectAt(schema.items);
  value.forEach((item, index) => {
    const itemSchema = prefix?.[index] ?? items;
    if (itemSchema)
      errors.push(...validateValue(itemSchema, item, `${at}[${index}]`));
  });
  return errors;
}

function validateObject(
  schema: Schema,
  value: JsonObject,
  at: string,
): string[] {
  const errors: string[] = [];
  const properties = objectAt(schema.properties) ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) {
    if (typeof name === "string" && !(name in value))
      errors.push(`${at}.${name}: required by the backend but not sent`);
  }
  const extra = schema.additionalProperties;
  for (const [name, item] of Object.entries(value)) {
    const property = objectAt(properties[name]);
    if (property !== undefined) {
      errors.push(...validateValue(property, item, `${at}.${name}`));
    } else if (extra === false) {
      errors.push(
        `${at}.${name}: not declared by the backend (extra="forbid")`,
      );
    } else if (isObject(extra)) {
      errors.push(...validateValue(extra, item, `${at}.${name}`));
    }
  }
  return errors;
}

// ---------------------------------------------------------------- generation

// Response strings with a pattern need a value that matches it.
const PATTERN_SAMPLES: Record<string, string> = {
  "^[a-zA-Z0-9_-]+$": "sample",
  "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$": "09:30",
  "^([01]\\d|2[0-3]):[0-5]\\d$": "09:30",
  "^[0-9a-f]{56}$": "a".repeat(56),
  "^[a-f0-9]{64}$": "a".repeat(64),
  "^[0-9a-f]{64}$": "a".repeat(64),
  "^[0-9]{6}$": "123456",
};

export class Generator {
  private uuids = 0;

  constructor(private readonly mode: ResponseMode) {}

  generate(raw: Schema, at: string): Json {
    const schema = resolveSchema(raw);
    if ("const" in schema) return schema.const;
    if (Array.isArray(schema.enum)) return schema.enum[0];
    const branches = schemasAt(schema.anyOf) ?? schemasAt(schema.oneOf);
    if (branches !== undefined) {
      const nullable = branches.some(isNullSchema);
      if (nullable && this.mode === "nulls") return null;
      const branch = branches.find((item) => !isNullSchema(item));
      return branch === undefined ? null : this.generate(branch, at);
    }
    const allOf = schemasAt(schema.allOf);
    if (allOf !== undefined) {
      return allOf.reduce<Json>(
        (merged, branch) => mergeJson(merged, this.generate(branch, at)),
        {},
      );
    }
    switch (schema.type) {
      case "string":
        return this.string(schema, at);
      case "integer":
      case "number":
        return this.number(schema);
      case "boolean":
        // false ends paged loops (has_more) and keeps optional flags off.
        return false;
      case "null":
        return null;
      case "array":
        return this.array(schema, at);
      case "object":
        return this.object(schema, at);
      case undefined:
        if (schema.properties !== undefined) return this.object(schema, at);
        // `{}` is Pydantic's Any: JSON null is a valid value.
        return null;
      default:
        throw new Error(
          `${at}: cannot generate schema type ${String(schema.type)}`,
        );
    }
  }

  private string(schema: Schema, at: string): string {
    const format = stringAt(schema.format);
    if (format === "uuid") {
      this.uuids += 1;
      return `01890000-0000-7000-8000-${this.uuids.toString(16).padStart(12, "0")}`;
    }
    if (format === "date-time") return "2026-01-02T03:04:05Z";
    if (format === "date") return "2026-01-02";
    const pattern = stringAt(schema.pattern);
    if (pattern !== undefined) {
      const sample = PATTERN_SAMPLES[pattern];
      if (sample === undefined)
        throw new Error(`${at}: add a sample for response pattern ${pattern}`);
      return sample;
    }
    const min = numberAt(schema.minLength) ?? 1;
    const max = numberAt(schema.maxLength) ?? Number.POSITIVE_INFINITY;
    return "sample".padEnd(min, "x").slice(0, Math.max(min, Math.min(max, 6)));
  }

  private number(schema: Schema): number {
    const minimum = numberAt(schema.minimum);
    const exclusive = numberAt(schema.exclusiveMinimum);
    const maximum = numberAt(schema.maximum);
    const floor =
      minimum ?? (exclusive === undefined ? 1 : Math.floor(exclusive) + 1);
    return Math.min(Math.max(floor, 1), maximum ?? Number.POSITIVE_INFINITY);
  }

  private array(schema: Schema, at: string): Json[] {
    const prefix = schemasAt(schema.prefixItems);
    if (prefix !== undefined)
      return prefix.map((item, index) =>
        this.generate(item, `${at}[${index}]`),
      );
    const items = objectAt(schema.items) ?? {};
    const max = numberAt(schema.maxItems);
    const count = Math.max(numberAt(schema.minItems) ?? 1, max === 0 ? 0 : 1);
    return Array.from({ length: count }, (_, index) =>
      this.generate(items, `${at}[${index}]`),
    );
  }

  private object(schema: Schema, at: string): JsonObject {
    const result: JsonObject = {};
    for (const [name, property] of Object.entries(
      objectAt(schema.properties) ?? {},
    )) {
      if (isObject(property))
        result[name] = this.generate(property, `${at}.${name}`);
    }
    const extra = objectAt(schema.additionalProperties);
    if (
      extra !== undefined &&
      Object.keys(extra).length > 0 &&
      schema.properties === undefined
    )
      // Map keys in this API are entity ids (field ids, user ids); OpenAPI cannot say so.
      result[this.string({ format: "uuid" }, at)] = this.generate(
        extra,
        `${at}.{key}`,
      );
    return result;
  }
}

/**
 * Deep merge: objects by key, arrays by index; `override` wins on scalars.
 * A generated null object or array stays null, so the nulls mode still sends
 * them as null; a scalar override replaces null (a cross-field requirement).
 */
export function mergeJson(base: Json, override: Json): Json {
  if (base === null && typeof override === "object" && override !== null)
    return null;
  if (Array.isArray(base) && Array.isArray(override))
    return override.map((item, index) =>
      index < base.length ? mergeJson(base[index], item) : item,
    );
  if (isObject(base) && isObject(override)) {
    const merged: JsonObject = { ...base };
    for (const [key, value] of Object.entries(override))
      merged[key] = key in base ? mergeJson(base[key], value) : value;
    return merged;
  }
  return override;
}
