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

/** A short name for a record: its title field's value, or its ID. */
export function openViewRecordTitle(
  record: Pick<OpenViewRecord, "id" | "data" | "displayValues">,
  titleFieldId: string | null | undefined,
): string {
  if (titleFieldId) {
    const label = record.displayValues[titleFieldId];
    if (typeof label === "string" && label.trim()) return label;
    const raw = record.data[titleFieldId];
    if (typeof raw === "string" && raw.trim()) return raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return `Record ${record.id.slice(0, 8)}`;
}
