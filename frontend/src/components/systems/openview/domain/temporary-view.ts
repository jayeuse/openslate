import {
  presentationSchema,
  queryDefinitionSchema,
} from "../adapters/views-schemas";
import type {
  OpenViewDataSourceField,
  OpenViewPresentation,
  OpenViewQueryDefinition,
} from "../adapters/views-api";
import {
  hasUnsafeIntegerFilter,
  isFilterReady,
  normalizeFilterValues,
  type SavedDraft,
} from "./server-view-draft";

/**
 * Temporary View changes live in the page address, so a person can bookmark
 * or share them; they are never saved to the server. The `changes` parameter
 * holds only the definition and presentation settings that differ from the
 * View it starts from (the saved View, or "All records"), as base64url JSON.
 * The View name is never in the address.
 *
 * A shared address is untrusted input: it is decoded, merged onto the base
 * View, checked with the saved-View schemas, and refused when it names a
 * field the module does not have.
 */
export const TEMPORARY_VIEW_PARAM = "changes";
const MAX_ENCODED_LENGTH = 6000;

type Changes = {
  d?: Partial<OpenViewQueryDefinition>;
  p?: Partial<OpenViewPresentation>;
};

function differingKeys<T extends object>(base: T, next: T): Partial<T> | null {
  const changed: Partial<T> = {};
  let any = false;
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (JSON.stringify(next[key]) !== JSON.stringify(base[key])) {
      changed[key] = next[key];
      any = true;
    }
  }
  return any ? changed : null;
}

/** The definition a temporary address keeps: filters that can run. */
function addressDefinition(
  definition: OpenViewQueryDefinition,
): OpenViewQueryDefinition {
  const normalized = normalizeFilterValues(definition);
  return {
    ...normalized,
    filters: normalized.filters.filter(
      (filter) => isFilterReady(filter) && !hasUnsafeIntegerFilter(filter),
    ),
  };
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The address value for a draft, or null when it matches its base View. */
export function encodeTemporaryView(
  base: SavedDraft,
  draft: SavedDraft,
): string | null {
  const definition = differingKeys(
    addressDefinition(base.definition),
    addressDefinition(draft.definition),
  );
  const presentation = differingKeys(base.presentation, draft.presentation);
  if (!definition && !presentation) return null;
  const changes: Changes = {};
  if (definition) changes.d = definition;
  if (presentation) changes.p = presentation;
  const encoded = toBase64Url(JSON.stringify(changes));
  return encoded.length > MAX_ENCODED_LENGTH ? null : encoded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function referencesKnownFields(
  definition: OpenViewQueryDefinition,
  presentation: OpenViewPresentation,
  fields: readonly OpenViewDataSourceField[],
): boolean {
  const types = new Map(fields.map((field) => [field.id, field.type]));
  const references = [
    ...definition.columns,
    ...definition.filters,
    ...definition.sort,
    ...definition.searchFields,
  ];
  if (references.some((item) => types.get(item.fieldId) !== item.expectedType))
    return false;
  const presentationIds = [
    ...presentation.columnFieldIds,
    ...presentation.pinnedFieldIds,
    presentation.primaryFieldId,
    presentation.secondaryFieldId,
    presentation.dateFieldId,
    presentation.groupByFieldId,
    presentation.timelineStartFieldId,
    presentation.timelineEndFieldId,
    presentation.timelineDeadlineFieldId,
    presentation.timelineProgressFieldId,
  ];
  return presentationIds.every((id) => id == null || types.has(id));
}

/** Schema-validated settings for discovering required metadata, not restoration. */
export function parseTemporaryView(
  value: string,
  base: SavedDraft,
): SavedDraft | null {
  if (!value || value.length > MAX_ENCODED_LENGTH) return null;
  const text = fromBase64Url(value);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const { d = {}, p = {}, ...extra } = parsed;
  if (Object.keys(extra).length || !isPlainObject(d) || !isPlainObject(p))
    return null;
  const definition = queryDefinitionSchema.safeParse({
    ...base.definition,
    ...d,
  });
  const presentation = presentationSchema.safeParse({
    ...base.presentation,
    ...p,
  });
  if (!definition.success || !presentation.success) return null;
  return {
    name: base.name,
    definition: definition.data,
    presentation: presentation.data,
  };
}

/**
 * The draft an address describes, merged onto its base View, or null when
 * the value is malformed, too long, or names fields the module lacks.
 */
export function decodeTemporaryView(
  value: string,
  base: SavedDraft,
  fields: readonly OpenViewDataSourceField[],
): SavedDraft | null {
  const parsed = parseTemporaryView(value, base);
  return parsed &&
    referencesKnownFields(parsed.definition, parsed.presentation, fields)
    ? parsed
    : null;
}
