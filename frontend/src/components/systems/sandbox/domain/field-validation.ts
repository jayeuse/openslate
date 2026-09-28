import { normalizeField, type Field } from "./model";
import { dateValueInRange } from "./date-values";
import {
  issue,
  SANDBOX_LIMITS,
  type SandboxValidationIssue,
} from "./validation-types";

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
  );
}

function validDateTime(value: string): boolean {
  return value.includes("T") && !Number.isNaN(Date.parse(value));
}

export function validateFieldValue(
  field: Field,
  value: string | boolean,
  required = field.required,
): string | null {
  const config = normalizeField(field).config;
  if (config.kind === "checkbox")
    return typeof value === "boolean" || value === "true" || value === "false"
      ? null
      : `${field.name} must be checked or unchecked`;
  if (typeof value !== "string") return `${field.name} has an invalid value`;
  if (!value.trim()) return required ? `${field.name} is required` : null;
  if (
    (config.kind === "text" ||
      config.kind === "long-text" ||
      config.kind === "email" ||
      config.kind === "url") &&
    config.maxLength !== undefined &&
    value.length > config.maxLength
  )
    return `${field.name} exceeds its maximum length`;
  if (config.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    return `${field.name} must be a valid email address`;
  if (config.kind === "url") {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error();
    } catch {
      return `${field.name} must be a valid HTTP or HTTPS URL`;
    }
  }
  if (config.kind === "number" || config.kind === "integer") {
    const number = Number(value);
    if (!Number.isFinite(number)) return `${field.name} must be a number`;
    if (config.kind === "integer" && !Number.isInteger(number))
      return `${field.name} must be a whole number`;
    if (config.min !== undefined && number < config.min)
      return `${field.name} must be at least ${config.min}`;
    if (config.max !== undefined && number > config.max)
      return `${field.name} must be at most ${config.max}`;
    const step = config.kind === "integer" ? 1 : config.step;
    if (step !== undefined) {
      const base = config.min ?? 0;
      const steps = (number - base) / step;
      if (Math.abs(steps - Math.round(steps)) > 1e-9)
        return `${field.name} must use increments of ${step}`;
    }
  }
  if (config.kind === "date" || config.kind === "datetime") {
    const valid =
      config.kind === "date" ? validDate(value) : validDateTime(value);
    if (!valid) return `${field.name} must be a valid date`;
    if (
      config.earliest !== undefined &&
      !dateValueInRange(config.kind, value, config.earliest, undefined)
    )
      return `${field.name} is earlier than allowed`;
    if (
      config.latest !== undefined &&
      !dateValueInRange(config.kind, value, undefined, config.latest)
    )
      return `${field.name} is later than allowed`;
  }
  if (
    config.kind === "select" &&
    !config.options.some((option) => option.id === value)
  )
    return `${field.name} must use an available option`;
  return null;
}

export function fieldDefaultMatches(field: Field): boolean {
  const normalized = normalizeField(field);
  if (
    !field.config &&
    normalized.config.kind === "checkbox" &&
    !["", "true", "false"].includes(field.value)
  )
    return false;
  switch (normalized.config.kind) {
    case "number":
      return (
        normalized.config.defaultValue === null ||
        Number.isFinite(normalized.config.defaultValue)
      );
    case "integer":
      return (
        normalized.config.defaultValue === null ||
        Number.isInteger(normalized.config.defaultValue)
      );
    case "date":
      return (
        normalized.config.defaultValue === null ||
        validDate(normalized.config.defaultValue)
      );
    case "datetime":
      return (
        normalized.config.defaultValue === null ||
        validDateTime(normalized.config.defaultValue)
      );
    case "select": {
      const select = normalized.config;
      return (
        select.defaultValue === null ||
        select.options.some((option) => option.id === select.defaultValue)
      );
    }
    case "email":
      return (
        normalized.config.defaultValue === "" ||
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.config.defaultValue)
      );
    case "url":
      if (normalized.config.defaultValue === "") return true;
      try {
        const url = new URL(normalized.config.defaultValue);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    default:
      return true;
  }
}

export function validateFieldConfig(field: Field): SandboxValidationIssue[] {
  const config = normalizeField(field).config;
  const issues: SandboxValidationIssue[] = [];
  if (
    "defaultValue" in config &&
    ["text", "long-text", "email", "url"].includes(config.kind) &&
    typeof config.defaultValue === "string" &&
    config.defaultValue.length > SANDBOX_LIMITS.textCharacters
  )
    issues.push(
      issue("field.default_too_long", "Default value is too long", field.id),
    );
  if (
    (config.kind === "text" ||
      config.kind === "long-text" ||
      config.kind === "email" ||
      config.kind === "url") &&
    config.maxLength !== undefined &&
    (!Number.isInteger(config.maxLength) ||
      config.maxLength < 1 ||
      config.maxLength > SANDBOX_LIMITS.textCharacters)
  )
    issues.push(
      issue(
        "field.max_length_invalid",
        "Maximum length is outside the supported range",
        field.id,
      ),
    );
  if (config.kind === "number" || config.kind === "integer") {
    if (
      config.min !== undefined &&
      config.max !== undefined &&
      config.min > config.max
    )
      issues.push(
        issue(
          "field.number_range_invalid",
          "Minimum cannot exceed maximum",
          field.id,
        ),
      );
    if (config.step !== undefined && config.step <= 0)
      issues.push(
        issue(
          "field.number_step_invalid",
          "Number step must be positive",
          field.id,
        ),
      );
    if (
      config.kind === "integer" &&
      [config.defaultValue, config.min, config.max].some(
        (value) =>
          value !== undefined && value !== null && !Number.isInteger(value),
      )
    )
      issues.push(
        issue(
          "field.integer_constraint_invalid",
          "Integer defaults and limits must be whole numbers",
          field.id,
        ),
      );
  }
  if (config.kind === "date" || config.kind === "datetime") {
    const valid = config.kind === "date" ? validDate : validDateTime;
    if (
      (config.earliest !== undefined && !valid(config.earliest)) ||
      (config.latest !== undefined && !valid(config.latest)) ||
      (config.earliest !== undefined &&
        config.latest !== undefined &&
        !dateValueInRange(
          config.kind,
          config.earliest,
          undefined,
          config.latest,
        ))
    )
      issues.push(
        issue("field.date_range_invalid", "Date limits are invalid", field.id),
      );
  }
  return issues;
}
