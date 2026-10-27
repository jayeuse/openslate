import { z } from "zod";
import {
  presentationSchema,
  queryDefinitionSchema,
  wireQueryDefinitionSchema,
} from "./views-schemas";
import type { OpenViewPresentation } from "./views-schemas";

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
    group_by_field_id: presentation.groupByFieldId,
  };
}
