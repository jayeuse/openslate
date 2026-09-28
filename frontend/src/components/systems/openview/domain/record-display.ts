import type {
  OpenViewDataSourceField,
  OpenViewRecord,
} from "../adapters/views-api";

/** Present read-authorized labels while keeping stable IDs in record data. */
export function openViewRecordFieldValue(
  record: OpenViewRecord,
  field: Pick<OpenViewDataSourceField, "id" | "type">,
): unknown {
  const raw = record.data[field.id];
  if (raw === null || raw === undefined || raw === "") return raw;
  const label = record.displayValues[field.id];
  if (typeof label === "string" && label.trim()) return label;
  if (field.type === "user") return "Unavailable user";
  if (field.type === "select") return "Unavailable option";
  return raw;
}
