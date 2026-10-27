"use client";

import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
  OpenViewSavedView,
} from "../adapters/views-api";
import type { SavedDraft } from "../domain/server-view-draft";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select } from "@/components/ui/select";

type SavedViewAdvancedFields = {
  all: readonly OpenViewDataSourceField[];
  queried: readonly OpenViewDataSourceField[];
  groupByField?: OpenViewDataSourceField;
};

type SavedViewAdvancedControlsModel = {
  draft: SavedDraft;
  fields: SavedViewAdvancedFields;
};

type SavedViewAdvancedControlsActions = {
  updateDefinition: (
    update: (current: OpenViewQueryDefinition) => OpenViewQueryDefinition,
  ) => void;
  updatePresentation: (
    update: (
      current: OpenViewSavedView["presentation"],
    ) => OpenViewSavedView["presentation"],
  ) => void;
};

/** Sort priority and grouping; Table, Grid and Gallery all group (BR77). */
export function SavedViewAdvancedControls({
  model,
  actions,
}: {
  model: SavedViewAdvancedControlsModel;
  actions: SavedViewAdvancedControlsActions;
}) {
  const {
    draft,
    fields: { all: fields, queried: queriedFields, groupByField },
  } = model;
  const { updateDefinition, updatePresentation } = actions;

  return (
    <>
      <section
        aria-labelledby="openview-advanced-settings-heading"
        className="flex flex-col gap-4"
      >
        <div>
          <h3
            data-slot="section-title"
            id="openview-advanced-settings-heading"
            className="font-medium"
          >
            Advanced query settings
          </h3>
          <p className="text-muted-foreground text-sm">
            Control sort priority and grouping.
          </p>
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 data-slot="section-title" className="font-medium">
                  Sort order
                </h3>
                <p className="text-muted-foreground text-xs">
                  The first rule has the highest priority. Use up to three
                  rules.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={
                  draft.definition.sort.length >= 3 ||
                  fields.every((field) =>
                    draft.definition.sort.some(
                      (sort) => sort.fieldId === field.id,
                    ),
                  )
                }
                onClick={() => {
                  const unused = fields.find(
                    (field) =>
                      !draft.definition.sort.some(
                        (sort) => sort.fieldId === field.id,
                      ),
                  );
                  if (!unused || draft.definition.sort.length >= 3) return;
                  updateDefinition((current) => ({
                    ...current,
                    sort: [
                      ...current.sort,
                      {
                        fieldId: unused.id,
                        expectedType: unused.type,
                        direction: "asc",
                      },
                    ],
                  }));
                }}
              >
                Add sort rule
              </Button>
            </div>
            {draft.definition.sort.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Records keep their source order.
              </p>
            ) : null}
            {draft.definition.sort.map((sort, index) => (
              <div
                key={`${sort.fieldId}:${index}`}
                className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] sm:items-end"
              >
                <Field>
                  <FieldLabel htmlFor={`openview-sort-field-${index}`}>
                    Sort field {index + 1}
                  </FieldLabel>
                  <Select
                    id={`openview-sort-field-${index}`}
                    className="min-h-11"
                    value={sort.fieldId}
                    onValueChange={(fieldId) => {
                      const field = fields.find(
                        (candidate) => candidate.id === fieldId,
                      );
                      if (
                        !field ||
                        draft.definition.sort.some(
                          (entry, entryIndex) =>
                            entryIndex !== index && entry.fieldId === field.id,
                        )
                      )
                        return;
                      updateDefinition((current) => ({
                        ...current,
                        sort: current.sort.map((entry, entryIndex) =>
                          entryIndex === index
                            ? {
                                ...entry,
                                fieldId: field.id,
                                expectedType: field.type,
                              }
                            : entry,
                        ),
                      }));
                    }}
                  >
                    {!fields.some((field) => field.id === sort.fieldId) ? (
                      <option value={sort.fieldId} disabled>
                        Saved sort field unavailable
                      </option>
                    ) : null}
                    {fields.map((field) => (
                      <option
                        key={field.id}
                        value={field.id}
                        disabled={draft.definition.sort.some(
                          (entry, entryIndex) =>
                            entryIndex !== index && entry.fieldId === field.id,
                        )}
                      >
                        {field.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`openview-sort-direction-${index}`}>
                    Sort direction {index + 1}
                  </FieldLabel>
                  <Select
                    id={`openview-sort-direction-${index}`}
                    className="min-h-11"
                    value={sort.direction}
                    onValueChange={(direction) => {
                      if (direction !== "asc" && direction !== "desc") return;
                      updateDefinition((current) => ({
                        ...current,
                        sort: current.sort.map((entry, entryIndex) =>
                          entryIndex === index
                            ? { ...entry, direction }
                            : entry,
                        ),
                      }));
                    }}
                  >
                    <option value="asc">Ascending (A → Z)</option>
                    <option value="desc">Descending (Z → A)</option>
                  </Select>
                </Field>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-11"
                  aria-label={`Remove sort rule ${index + 1}`}
                  onClick={() =>
                    updateDefinition((current) => ({
                      ...current,
                      sort: current.sort.filter(
                        (_, entryIndex) => entryIndex !== index,
                      ),
                    }))
                  }
                >
                  ×
                </Button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <Field className="w-full max-w-72">
              <FieldLabel htmlFor="openview-general-group-field">
                Group records by
              </FieldLabel>
              <Select
                id="openview-general-group-field"
                className="min-h-11"
                value={draft.presentation.groupByFieldId ?? ""}
                onValueChange={(value) =>
                  updatePresentation((current) => ({
                    ...current,
                    groupByFieldId: value || null,
                  }))
                }
              >
                {draft.presentation.groupByFieldId && !groupByField ? (
                  <option value={draft.presentation.groupByFieldId} disabled>
                    Saved field unavailable
                  </option>
                ) : null}
                <option value="">No grouping</option>
                {queriedFields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-muted-foreground max-w-prose text-sm">
              Counts come from the server. Select a group to load its paged
              records.
            </p>
            {draft.presentation.groupByFieldId && !groupByField ? (
              <p role="note" className="text-muted-foreground text-sm">
                The saved grouping field is unavailable; records are shown
                without grouping.
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}
