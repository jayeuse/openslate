import type { OpenViewDataSourceField } from "../adapters/views-api";

// Converts record values between their stored JSON form and the strings a
// form control holds. Each type keeps the server's wire form: `decimal` is a
// string, `int` an integer, `number` any finite number, `datetime` an ISO
// instant, `select` an option ID, and `user` a user ID.

export type RecordFormValue = string | boolean;
export type RecordFormValues = Record<string, RecordFormValue>;
export type RecordFormErrors = Record<string, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PATTERN = /^https?:\/\/[^\s/$.?#][^\s]*$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** An ISO instant as the `YYYY-MM-DDTHH:MM` local text of a datetime input. */
function localDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function selectOptions(
  field: Pick<OpenViewDataSourceField, "config">,
): Array<{ id: string; label: string }> {
  const options = field.config.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) =>
    typeof option === "object" &&
    option !== null &&
    typeof (option as { id?: unknown }).id === "string" &&
    typeof (option as { label?: unknown }).label === "string"
      ? [
          {
            id: (option as { id: string }).id,
            label: (option as { label: string }).label,
          },
        ]
      : [],
  );
}

/** The form value for a stored value. */
export function toFormValue(
  field: OpenViewDataSourceField,
  stored: unknown,
): RecordFormValue {
  if (field.type === "boolean") return stored === true;
  if (stored === null || stored === undefined) return "";
  if (field.type === "datetime" && typeof stored === "string")
    return localDateTime(stored);
  if (typeof stored === "number") return String(stored);
  return typeof stored === "string" ? stored : "";
}

/** Form values for a new record, starting from each field's default. */
export function initialFormValues(
  fields: readonly OpenViewDataSourceField[],
  data: Record<string, unknown> | null,
): RecordFormValues {
  return Object.fromEntries(
    fields.map((field) => [
      field.id,
      toFormValue(
        field,
        data ? data[field.id] : (field.config.defaultValue ?? null),
      ),
    ]),
  );
}

type Encoded = { value: unknown } | { error: string };

/** The stored value for a form value, or the reason it cannot be saved. */
export function encodeFormValue(
  field: OpenViewDataSourceField,
  value: RecordFormValue,
): Encoded {
  if (field.type === "boolean") return { value: value === true };
  const text = typeof value === "string" ? value : "";
  const trimmed = text.trim();
  if (!trimmed) {
    if (field.required) return { error: "Enter a value." };
    const textual = ["text", "long_text", "email", "url"].includes(field.type);
    return { value: textual && text ? "" : null };
  }
  switch (field.type) {
    case "number": {
      const number = Number(trimmed);
      return Number.isFinite(number)
        ? { value: number }
        : { error: "Enter a number." };
    }
    case "int": {
      const number = Number(trimmed);
      return Number.isSafeInteger(number)
        ? { value: number }
        : { error: "Enter a whole number." };
    }
    case "decimal":
      return DECIMAL.test(trimmed)
        ? { value: trimmed }
        : { error: "Enter a decimal number, such as 12.50." };
    case "email":
      return EMAIL.test(trimmed)
        ? { value: trimmed }
        : { error: "Enter an email address." };
    case "url":
      return URL_PATTERN.test(trimmed)
        ? { value: trimmed }
        : {
            error: "Enter a web address that starts with http:// or https://.",
          };
    case "datetime": {
      const date = new Date(trimmed);
      return Number.isNaN(date.valueOf())
        ? { error: "Enter a date and time." }
        : { value: date.toISOString() };
    }
    default:
      return { value: field.type.endsWith("text") ? text : trimmed };
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * The values to send, the errors that block sending them, and whether any
 * value changed. A save replaces every active value of the record, so with
 * `original` each field is sent: unchanged ones keep their stored value.
 * A new record sends only filled values; the server fills defaults.
 */
export function encodeRecordForm(
  fields: readonly OpenViewDataSourceField[],
  values: RecordFormValues,
  original: Record<string, unknown> | null,
): {
  data: Record<string, unknown>;
  errors: RecordFormErrors;
  changed: boolean;
} {
  const data: Record<string, unknown> = {};
  const errors: RecordFormErrors = {};
  let changed = false;
  for (const field of fields) {
    const encoded = encodeFormValue(field, values[field.id] ?? "");
    if ("error" in encoded) {
      errors[field.id] = encoded.error;
      continue;
    }
    if (original) {
      const before = original[field.id];
      const unchanged =
        sameValue(before, encoded.value) ||
        toFormValue(field, before) === values[field.id];
      data[field.id] = unchanged ? (before ?? null) : encoded.value;
      if (!unchanged) changed = true;
    } else if (encoded.value !== null && encoded.value !== "") {
      data[field.id] = encoded.value;
      changed = true;
    }
  }
  return { data, errors, changed };
}

/** A server message without the field ID it starts with. */
export function serverFieldMessage(message: string): string {
  const text = message
    .replace(/^Field [0-9a-f-]{36}\s*/i, "")
    .replace(/\.$/, "");
  if (!text) return "This value cannot be saved.";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
