import { z } from "zod";
import type { Field } from "./api";

const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.[0-9]{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const NUMERIC_INPUT_PATTERN =
  /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/;

type FieldSchema = z.ZodType;
type NumericConfig = {
  minimum?: number;
  maximum?: number;
};
type DecimalConfig = {
  minimum?: string;
  maximum?: string;
};
type TextConfig = {
  minLength?: number;
  maxLength?: number;
};

export type FormValues = Record<string, string | boolean>;
export type FieldErrorMap = Record<string, string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function invalidFieldSchema(): FieldSchema {
  return z.never("Invalid field configuration");
}

function optional<T extends FieldSchema>(
  schema: T,
  field: Field,
): T | z.ZodOptional<T> {
  return field.required ? schema : schema.optional();
}

function requiredMessage(field: Field): string {
  return `${field.name} is required`;
}

function parseLengthConfig(config: unknown): TextConfig | null {
  if (!isRecord(config) || !hasOnlyKeys(config, ["minLength", "maxLength"])) {
    return null;
  }

  const parsed: TextConfig = {};
  for (const key of ["minLength", "maxLength"] as const) {
    if (!(key in config)) continue;
    const value = config[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      return null;
    }
    parsed[key] = value;
  }
  if (
    parsed.minLength !== undefined &&
    parsed.maxLength !== undefined &&
    parsed.minLength > parsed.maxLength
  ) {
    return null;
  }
  return parsed;
}

function parseNumericConfig(config: unknown): NumericConfig | null {
  if (!isRecord(config) || !hasOnlyKeys(config, ["minimum", "maximum"])) {
    return null;
  }

  const parsed: NumericConfig = {};
  for (const key of ["minimum", "maximum"] as const) {
    if (!(key in config)) continue;
    const value = config[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    parsed[key] = value;
  }
  if (
    parsed.minimum !== undefined &&
    parsed.maximum !== undefined &&
    parsed.minimum > parsed.maximum
  ) {
    return null;
  }
  return parsed;
}

function parseDecimalConfig(config: unknown): DecimalConfig | null {
  if (!isRecord(config) || !hasOnlyKeys(config, ["minimum", "maximum"])) {
    return null;
  }

  const parsed: DecimalConfig = {};
  for (const key of ["minimum", "maximum"] as const) {
    if (!(key in config)) continue;
    const value = config[key];
    if (typeof value !== "string") return null;
    const canonical = canonicalDecimalOrNull(value);
    if (canonical === null) return null;
    parsed[key] = canonical;
  }
  if (parsed.minimum !== undefined && parsed.maximum !== undefined) {
    const comparison = compareDecimalValues(parsed.minimum, parsed.maximum);
    if (comparison !== null && comparison > 0) return null;
  }
  return parsed;
}

function parseSelectOptions(config: unknown): string[] | null {
  if (
    !isRecord(config) ||
    Object.keys(config).length !== 1 ||
    !Array.isArray(config.options)
  ) {
    return null;
  }
  if (
    config.options.length === 0 ||
    config.options.some(
      (option) => typeof option !== "string" || option.trim() === "",
    ) ||
    new Set(config.options).size !== config.options.length
  ) {
    return null;
  }
  return config.options as string[];
}

function decimalParts(value: string): {
  negative: boolean;
  integer: string;
  fraction: string;
} | null {
  if (!DECIMAL_PATTERN.test(value)) return null;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  return { negative, integer, fraction };
}

function canonicalizeDecimal(value: string): string {
  const parts = decimalParts(value);
  if (!parts) return value;
  const fraction = parts.fraction.replace(/0+$/, "");
  if (parts.integer === "0" && fraction === "") return "0";
  return `${parts.negative ? "-" : ""}${parts.integer}${fraction ? `.${fraction}` : ""}`;
}

function canonicalDecimalOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 58) return null;
  const parts = decimalParts(value);
  if (
    parts === null ||
    parts.integer.length > 38 ||
    parts.fraction.length > 18
  ) {
    return null;
  }
  return canonicalizeDecimal(value);
}

function compareDecimalValues(left: string, right: string): number | null {
  const leftParts = decimalParts(canonicalizeDecimal(left));
  const rightParts = decimalParts(canonicalizeDecimal(right));
  if (!leftParts || !rightParts) return null;
  if (leftParts.negative !== rightParts.negative) {
    return leftParts.negative ? -1 : 1;
  }

  const compareMagnitude = (): number => {
    if (leftParts.integer.length !== rightParts.integer.length) {
      return leftParts.integer.length < rightParts.integer.length ? -1 : 1;
    }
    if (leftParts.integer !== rightParts.integer) {
      return leftParts.integer < rightParts.integer ? -1 : 1;
    }
    const fractionLength = Math.max(
      leftParts.fraction.length,
      rightParts.fraction.length,
    );
    const leftFraction = leftParts.fraction.padEnd(fractionLength, "0");
    const rightFraction = rightParts.fraction.padEnd(fractionLength, "0");
    if (leftFraction === rightFraction) return 0;
    return leftFraction < rightFraction ? -1 : 1;
  };

  const magnitude = compareMagnitude();
  return leftParts.negative ? -magnitude : magnitude;
}

function buildTextSchema(field: Field): FieldSchema {
  const config = parseLengthConfig(field.config);
  if (!config) return invalidFieldSchema();
  let schema = field.required
    ? z.string({ error: requiredMessage(field) })
    : z.string();
  if (field.required) schema = schema.min(1, `${field.name} is required`);
  if (config.minLength !== undefined) {
    schema = schema.min(
      config.minLength,
      `Must be at least ${config.minLength} characters`,
    );
  }
  if (config.maxLength !== undefined) {
    schema = schema.max(
      config.maxLength,
      `Must be at most ${config.maxLength} characters`,
    );
  }
  return optional(schema, field);
}

function buildNumberSchema(field: Field, integer: boolean): FieldSchema {
  const config = parseNumericConfig(field.config);
  if (!config) return invalidFieldSchema();
  let schema = field.required
    ? z.number({ error: requiredMessage(field) }).finite()
    : z.number().finite();
  if (integer) schema = schema.int();
  if (config.minimum !== undefined) schema = schema.min(config.minimum);
  if (config.maximum !== undefined) schema = schema.max(config.maximum);
  return optional(schema, field);
}

function buildDecimalSchema(field: Field): FieldSchema {
  const config = parseDecimalConfig(field.config);
  if (!config) return invalidFieldSchema();
  const minimum = config.minimum;
  const maximum = config.maximum;
  let schema = z
    .string({ error: requiredMessage(field) })
    .max(58, "Must be at most 58 characters")
    .regex(DECIMAL_PATTERN, "Must be a decimal number")
    .refine((value) => {
      const parts = decimalParts(value);
      return (
        parts !== null &&
        parts.integer.length <= 38 &&
        parts.fraction.length <= 18
      );
    }, "Must have at most 38 integer and 18 fractional digits")
    .transform(canonicalizeDecimal);
  if (minimum !== undefined) {
    schema = schema.refine((value) => {
      const comparison = compareDecimalValues(value, minimum);
      return comparison !== null && comparison >= 0;
    }, `Must be at least ${minimum}`);
  }
  if (maximum !== undefined) {
    schema = schema.refine((value) => {
      const comparison = compareDecimalValues(value, maximum);
      return comparison !== null && comparison <= 0;
    }, `Must be at most ${maximum}`);
  }
  return optional(schema, field);
}

function buildBooleanSchema(field: Field): FieldSchema {
  if (!isRecord(field.config) || Object.keys(field.config).length !== 0) {
    return invalidFieldSchema();
  }
  return optional(
    field.required ? z.boolean({ error: requiredMessage(field) }) : z.boolean(),
    field,
  );
}

function buildDateSchema(field: Field): FieldSchema {
  if (!isRecord(field.config) || Object.keys(field.config).length !== 0) {
    return invalidFieldSchema();
  }
  return optional(z.iso.date({ error: requiredMessage(field) }), field);
}

function buildDatetimeSchema(field: Field): FieldSchema {
  if (!isRecord(field.config) || Object.keys(field.config).length !== 0) {
    return invalidFieldSchema();
  }
  return optional(
    z
      .string({ error: requiredMessage(field) })
      .regex(DATETIME_PATTERN, "Must be a timezone-aware ISO datetime"),
    field,
  );
}

function buildSelectSchema(field: Field): FieldSchema {
  const options = parseSelectOptions(field.config);
  if (!options) return invalidFieldSchema();
  return optional(
    z.enum(options as [string, ...string[]], {
      error: requiredMessage(field),
    }),
    field,
  );
}

export function buildFieldSchema(field: Field): FieldSchema {
  if (!isRecord(field) || typeof field.required !== "boolean") {
    return invalidFieldSchema();
  }

  switch (field.type) {
    case "text":
      return buildTextSchema(field);
    case "number":
      return buildNumberSchema(field, false);
    case "decimal":
      return buildDecimalSchema(field);
    case "int":
      return buildNumberSchema(field, true);
    case "boolean":
      return buildBooleanSchema(field);
    case "date":
      return buildDateSchema(field);
    case "datetime":
      return buildDatetimeSchema(field);
    case "select":
      return buildSelectSchema(field);
    case "relationship":
      return invalidFieldSchema();
    default:
      return invalidFieldSchema();
  }
}

export function buildModuleSchema(fields: readonly Field[]) {
  const shape: Record<string, FieldSchema> = {};
  for (const field of fields) {
    if (!field.is_deleted && field.type !== "relationship") {
      shape[field.id] = buildFieldSchema(field);
    }
  }
  return z.object(shape).strict();
}

function serializeNumericInput(value: string): number {
  if (!NUMERIC_INPUT_PATTERN.test(value)) return Number.NaN;
  return Number(value);
}

export function serializeFieldValue(field: Field, value: unknown): unknown {
  if (field.type === "boolean") return value;
  if (typeof value !== "string") return value;
  if (value === "") return undefined;
  if (field.type === "number" || field.type === "int") {
    return serializeNumericInput(value);
  }
  if (field.type === "datetime") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return value;
}

export function serializeFormValues(
  fields: readonly Field[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.is_deleted || field.type === "relationship") continue;
    const serialized = serializeFieldValue(field, values[field.id]);
    if (serialized !== undefined) data[field.id] = serialized;
  }
  return data;
}

export function collectZodFieldErrors(error: z.ZodError): {
  fieldErrors: FieldErrorMap;
  formErrors: string[];
} {
  const fieldErrors: FieldErrorMap = {};
  const formErrors: string[] = [];
  for (const issue of error.issues) {
    const fieldId = issue.path[0];
    if (typeof fieldId !== "string") {
      formErrors.push(issue.message);
      continue;
    }
    (fieldErrors[fieldId] ??= []).push(issue.message);
  }
  return { fieldErrors, formErrors };
}
