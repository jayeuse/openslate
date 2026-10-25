"use client";

import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
  OpenViewSavedView,
} from "../adapters/views-api";
import type { SavedDraft } from "../domain/server-view-draft";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select } from "@/components/ui/select";

type SavedViewLayout = OpenViewSavedView["presentation"]["layout"];
type GeneralGroupedLayout = "table" | "grid" | "gallery";

type SavedViewAdvancedFields = {
  all: readonly OpenViewDataSourceField[];
  queried: readonly OpenViewDataSourceField[];
  groupByField?: OpenViewDataSourceField;
  dates: readonly OpenViewDataSourceField[];
  calendarDateField?: OpenViewDataSourceField;
  timelineStartField?: OpenViewDataSourceField;
  timelineEndField?: OpenViewDataSourceField;
  timelineDeadlineField?: OpenViewDataSourceField;
  timelineProgressField?: OpenViewDataSourceField;
};

type SavedViewAdvancedControlsModel = {
  draft: SavedDraft;
  layout: SavedViewLayout;
  layoutLabel: string;
  fields: SavedViewAdvancedFields;
  incompletePresentation: boolean;
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

function isGeneralGroupedLayout(
  layout: SavedViewLayout,
): layout is GeneralGroupedLayout {
  return layout === "table" || layout === "grid" || layout === "gallery";
}

export function SavedViewAdvancedControls({
  model,
  actions,
}: {
  model: SavedViewAdvancedControlsModel;
  actions: SavedViewAdvancedControlsActions;
}) {
  const {
    draft,
    layout: presentationLayout,
    layoutLabel: presentationLayoutLabel,
    fields: {
      all: fields,
      queried: queriedFields,
      groupByField,
      dates: dateFields,
      calendarDateField,
      timelineStartField,
      timelineEndField,
      timelineDeadlineField,
      timelineProgressField,
    },
    incompletePresentation,
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
            Control sort priority, grouping, and date-based layout options.
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

          {isGeneralGroupedLayout(presentationLayout) ? (
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
          ) : null}
          {(presentationLayout === "calendar" ||
            presentationLayout === "timeline") &&
          draft.presentation.groupByFieldId ? (
            <p role="note" className="text-muted-foreground text-sm">
              General grouping is inactive in {presentationLayoutLabel}; the
              saved group field is preserved.
            </p>
          ) : null}
        </div>
      </section>

      {presentationLayout === "kanban" ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-full max-w-72">
            <FieldLabel htmlFor="openview-kanban-group-field">
              Group lanes by
            </FieldLabel>
            <Select
              id="openview-kanban-group-field"
              className="min-h-11"
              value={draft.presentation.groupByFieldId ?? ""}
              aria-describedby="openview-kanban-group-field-help"
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
              <option value="">Choose a field</option>
              {queriedFields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </Select>
          </Field>
          <p
            id="openview-kanban-group-field-help"
            className="text-muted-foreground max-w-prose text-sm"
          >
            Each lane shows its count; one lane’s records load at a time.
          </p>
        </div>
      ) : null}
      {presentationLayout === "calendar" ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-full max-w-72">
            <FieldLabel htmlFor="openview-calendar-date-field">
              Calendar date field
            </FieldLabel>
            <Select
              id="openview-calendar-date-field"
              className="min-h-11"
              value={draft.presentation.dateFieldId ?? ""}
              onValueChange={(value) =>
                updatePresentation((current) => ({
                  ...current,
                  dateFieldId: value || null,
                }))
              }
            >
              {draft.presentation.dateFieldId && !calendarDateField ? (
                <option value={draft.presentation.dateFieldId} disabled>
                  Saved date field unavailable
                </option>
              ) : null}
              <option value="">Choose a queried date field</option>
              {dateFields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name} · {field.type}
                </option>
              ))}
            </Select>
          </Field>
          <Field className="w-full max-w-56">
            <FieldLabel htmlFor="openview-calendar-date-range">
              Calendar date range
            </FieldLabel>
            <Select
              id="openview-calendar-date-range"
              className="min-h-11"
              value={draft.presentation.dateRange}
              onValueChange={(value) =>
                updatePresentation((current) => ({
                  ...current,
                  dateRange:
                    value as OpenViewSavedView["presentation"]["dateRange"],
                }))
              }
            >
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
            </Select>
          </Field>
          <Field className="w-full max-w-56">
            <FieldLabel htmlFor="openview-calendar-scale">
              Calendar scale
            </FieldLabel>
            <Select
              id="openview-calendar-scale"
              className="min-h-11"
              value={draft.presentation.scale ?? "month"}
              onValueChange={(value) =>
                updatePresentation((current) => ({
                  ...current,
                  scale: value as "month" | "list",
                }))
              }
            >
              <option value="month">Month</option>
              <option value="list">List</option>
            </Select>
          </Field>
          <p className="text-muted-foreground max-w-prose text-sm">
            Choose an active date or datetime field. The range and Month or List
            layout are saved with this view.
          </p>
        </div>
      ) : null}
      {presentationLayout === "timeline" ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-full max-w-72">
            <FieldLabel htmlFor="openview-timeline-start-field">
              Timeline start field
            </FieldLabel>
            <Select
              id="openview-timeline-start-field"
              className="min-h-11"
              value={draft.presentation.timelineStartFieldId ?? ""}
              onValueChange={(value) =>
                updatePresentation((current) => ({
                  ...current,
                  timelineStartFieldId: value || null,
                }))
              }
            >
              {draft.presentation.timelineStartFieldId &&
              !timelineStartField ? (
                <option
                  value={draft.presentation.timelineStartFieldId}
                  disabled
                >
                  Saved start field unavailable
                </option>
              ) : null}
              <option value="">Choose a queried date field</option>
              {dateFields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name} · {field.type}
                </option>
              ))}
            </Select>
          </Field>
          <Field className="w-full max-w-72">
            <FieldLabel htmlFor="openview-timeline-end-field">
              Timeline end field
            </FieldLabel>
            <Select
              id="openview-timeline-end-field"
              className="min-h-11"
              value={draft.presentation.timelineEndFieldId ?? ""}
              onValueChange={(value) =>
                updatePresentation((current) => ({
                  ...current,
                  timelineEndFieldId: value || null,
                }))
              }
            >
              {draft.presentation.timelineEndFieldId && !timelineEndField ? (
                <option value={draft.presentation.timelineEndFieldId} disabled>
                  Saved end field unavailable
                </option>
              ) : null}
              <option value="">Choose a queried date field</option>
              {dateFields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name} · {field.type}
                </option>
              ))}
            </Select>
          </Field>
          <Field className="w-full max-w-72">
            <FieldLabel htmlFor="openview-timeline-deadline-field">
              Deadline field (optional)
            </FieldLabel>
            <Select
              id="openview-timeline-deadline-field"
              className="min-h-11"
              value={draft.presentation.timelineDeadlineFieldId ?? ""}
              onValueChange={(value) =>
                updatePresentation((current) => ({
                  ...current,
                  timelineDeadlineFieldId: value || null,
                }))
              }
            >
              {draft.presentation.timelineDeadlineFieldId &&
              !timelineDeadlineField ? (
                <option
                  value={draft.presentation.timelineDeadlineFieldId}
                  disabled
                >
                  Saved deadline field unavailable
                </option>
              ) : null}
              <option value="">No deadline</option>
              {dateFields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name} · {field.type}
                </option>
              ))}
            </Select>
          </Field>
          <Field className="w-full max-w-72">
            <FieldLabel htmlFor="openview-timeline-progress-field">
              Progress field (optional)
            </FieldLabel>
            <Select
              id="openview-timeline-progress-field"
              className="min-h-11"
              value={draft.presentation.timelineProgressFieldId ?? ""}
              onValueChange={(value) =>
                updatePresentation((current) => ({
                  ...current,
                  timelineProgressFieldId: value || null,
                }))
              }
            >
              {draft.presentation.timelineProgressFieldId &&
              !timelineProgressField ? (
                <option
                  value={draft.presentation.timelineProgressFieldId}
                  disabled
                >
                  Saved progress field unavailable
                </option>
              ) : null}
              <option value="">No progress</option>
              {queriedFields
                .filter((field) =>
                  ["number", "decimal", "int"].includes(field.type),
                )
                .map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name} · {field.type}
                  </option>
                ))}
            </Select>
          </Field>
          <p className="text-muted-foreground max-w-prose text-sm">
            Timeline bars use the complete start/end interval. The visible
            window only clips the bar and filters matching intervals.
          </p>
        </div>
      ) : null}
      {incompletePresentation ? (
        <Alert role="note">
          {presentationLayout === "kanban"
            ? "Choose a field to group the lanes before saving the view."
            : presentationLayout === "calendar"
              ? "Choose a date field before saving the view."
              : presentationLayout === "timeline"
                ? "Choose start and end date fields, and clear any unavailable optional fields, before saving the view."
                : "Complete the saved presentation fields before saving."}
        </Alert>
      ) : null}
    </>
  );
}
