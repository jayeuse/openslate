import { z } from "zod";
import {
  audienceInputSchema,
  presentationSchema,
  queryDefinitionSchema,
  wireQueryDefinitionSchema,
} from "./views-schemas";
import type { OpenViewPresentation } from "./views-schemas";

export function serializeOpenViewAudience(
  audience: z.input<typeof audienceInputSchema>,
) {
  const validAudience = audienceInputSchema.parse(audience);
  switch (validAudience.kind) {
    case "private":
      return { kind: "private" as const };
    case "everyone":
      return { kind: "everyone" as const };
    case "role":
      // Access groups replaced role audiences; the server accepts none.
      throw new Error("Role audiences are no longer available");
    case "identity":
      return { kind: "user" as const, user_id: validAudience.id };
  }
}

export function serializeOpenViewQueryDefinition(
  raw: unknown,
): z.input<typeof wireQueryDefinitionSchema> {
  const definition = queryDefinitionSchema.parse(raw);
  const wireDefinition = {
    version: definition.version,
    logic: definition.logic,
    columns: definition.columns.map(({ fieldId, expectedType }) => ({
      field_id: fieldId,
      expected_type: expectedType,
    })),
    filters: definition.filters.map(({ fieldId, expectedType, ...filter }) => ({
      field_id: fieldId,
      expected_type: expectedType,
      ...filter,
    })),
    sort: definition.sort.map(({ fieldId, expectedType, direction }) => ({
      field_id: fieldId,
      expected_type: expectedType,
      direction,
    })),
    deleted: definition.deleted,
    search: definition.search,
    search_fields: definition.searchFields.map(({ fieldId, expectedType }) => ({
      field_id: fieldId,
      expected_type: expectedType,
    })),
  };
  wireQueryDefinitionSchema.parse(wireDefinition);
  return wireDefinition;
}

export function serializeOpenViewPresentation(raw: OpenViewPresentation) {
  const presentation = presentationSchema.parse(raw);
  return {
    version: presentation.version,
    layout: presentation.layout,
    column_field_ids: presentation.columnFieldIds,
    pinned_field_ids: presentation.pinnedFieldIds,
    density: presentation.density,
    wrap: presentation.wrap,
    card_size: presentation.cardSize,
    primary_field_id: presentation.primaryFieldId,
    secondary_field_id: presentation.secondaryFieldId,
    date_field_id: presentation.dateFieldId,
    timeline_start_field_id: presentation.timelineStartFieldId ?? null,
    timeline_end_field_id: presentation.timelineEndFieldId ?? null,
    timeline_deadline_field_id: presentation.timelineDeadlineFieldId ?? null,
    timeline_progress_field_id: presentation.timelineProgressFieldId ?? null,
    group_by_field_id: presentation.groupByFieldId,
    date_range: presentation.dateRange,
    scale: presentation.scale,
  };
}
