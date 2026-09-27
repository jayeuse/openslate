"use client";

import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
} from "../adapters/views-api";
import {
  EMPTY_OPERATORS,
  OPERATOR_LABELS,
  filterInputValue,
  filterValueForType,
  hasUnsafeIntegerFilter,
  isFilterOperator,
  isFilterReady,
  operatorChoices,
} from "../domain/server-view-draft";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

type SavedFilter = OpenViewQueryDefinition["filters"][number];

type SavedViewFilterControlsProps = {
  logic: OpenViewQueryDefinition["logic"];
  filters: readonly SavedFilter[];
  fields: readonly OpenViewDataSourceField[];
  activeFields: ReadonlyMap<string, OpenViewDataSourceField>;
  rowKeyFor: (filter: SavedFilter, index: number) => string;
  onLogicChange: (logic: OpenViewQueryDefinition["logic"]) => void;
  onUpdateFilter: (
    index: number,
    update: (filter: SavedFilter) => SavedFilter,
  ) => void;
  onRemoveFilter: (index: number) => void;
  onAddFilter: () => void;
};

const UNSAFE_INTEGER_FILTER_ERROR =
  "Enter a whole number from -9007199254740991 to 9007199254740991.";

export function SavedViewFilterControls({
  logic,
  filters,
  fields,
  activeFields,
  rowKeyFor,
  onLogicChange,
  onUpdateFilter,
  onRemoveFilter,
  onAddFilter,
}: SavedViewFilterControlsProps) {
  return (
    <section
      aria-labelledby="openview-filter-controls-heading"
      className="flex flex-col gap-4"
    >
      <div>
        <h2 id="openview-filter-controls-heading" className="font-medium">
          Filter conditions
        </h2>
        <p className="text-muted-foreground text-sm">
          Match all conditions or any condition, then add or update a filter.
        </p>
      </div>
      <Field className="max-w-xs">
        <FieldLabel htmlFor="openview-filter-logic">Match filters</FieldLabel>
        <Select
          id="openview-filter-logic"
          className="min-h-11"
          value={logic}
          onValueChange={(value) => {
            if (value === "and" || value === "or") onLogicChange(value);
          }}
        >
          <option value="and">All conditions (AND)</option>
          <option value="or">Any condition (OR)</option>
        </Select>
      </Field>
      {filters.map((filter, index) => {
        const field = activeFields.get(filter.fieldId);
        const operators = operatorChoices(filter.expectedType);
        const needsValue = !EMPTY_OPERATORS.has(filter.operator);
        const unsafeIntegerValue = hasUnsafeIntegerFilter(filter);
        const valueErrorId = `openview-filter-value-error-${index}`;
        return (
          <div
            key={rowKeyFor(filter, index)}
            className="bg-muted/40 grid min-w-0 gap-3 rounded-md p-3 sm:grid-cols-[minmax(8rem,1fr)_minmax(9rem,1fr)_minmax(8rem,1fr)_auto]"
          >
            <Field>
              <FieldLabel htmlFor={`openview-filter-field-${index}`}>
                Field
              </FieldLabel>
              <Select
                id={`openview-filter-field-${index}`}
                className="min-h-11"
                value={filter.fieldId}
                onValueChange={(fieldId) => {
                  const nextField = activeFields.get(fieldId);
                  if (!nextField) return;
                  const expectedType = nextField.type;
                  const nextOperator = operatorChoices(expectedType)[0] ?? "eq";
                  onUpdateFilter(index, () => ({
                    fieldId,
                    expectedType,
                    operator: nextOperator,
                    value: EMPTY_OPERATORS.has(nextOperator) ? null : "",
                  }));
                }}
              >
                {fields.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`openview-filter-operator-${index}`}>
                Condition
              </FieldLabel>
              <Select
                id={`openview-filter-operator-${index}`}
                className="min-h-11"
                value={filter.operator}
                onValueChange={(operator) => {
                  if (!isFilterOperator(operator, filter.expectedType)) return;
                  onUpdateFilter(index, (item) => ({
                    ...item,
                    operator,
                    value: EMPTY_OPERATORS.has(operator)
                      ? null
                      : operator === "in" || item.operator === "in"
                        ? ""
                        : (item.value ?? ""),
                  }));
                }}
              >
                {operators.map((operator) => (
                  <option key={operator} value={operator}>
                    {OPERATOR_LABELS[operator] ?? operator}
                  </option>
                ))}
              </Select>
            </Field>
            {needsValue ? (
              <Field>
                <FieldLabel htmlFor={`openview-filter-value-${index}`}>
                  Value
                </FieldLabel>
                {filter.expectedType === "boolean" ? (
                  <Select
                    id={`openview-filter-value-${index}`}
                    className="min-h-11"
                    value={String(filter.value ?? "")}
                    onValueChange={(value) =>
                      onUpdateFilter(index, (item) => ({
                        ...item,
                        value: value === "" ? "" : value === "true",
                      }))
                    }
                  >
                    <option value="">Choose…</option>
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </Select>
                ) : (
                  <>
                    <Input
                      id={`openview-filter-value-${index}`}
                      className="min-h-11"
                      aria-invalid={unsafeIntegerValue || undefined}
                      aria-describedby={
                        unsafeIntegerValue ? valueErrorId : undefined
                      }
                      type={
                        filter.expectedType === "date"
                          ? "date"
                          : ["number", "decimal", "int"].includes(
                                filter.expectedType,
                              )
                            ? "number"
                            : "text"
                      }
                      value={filterInputValue(filter)}
                      onChange={(event) =>
                        onUpdateFilter(index, (item) => ({
                          ...item,
                          value:
                            item.operator === "in"
                              ? event.target.value
                              : filterValueForType(
                                  item.expectedType,
                                  event.target.value,
                                ),
                        }))
                      }
                    />
                    {unsafeIntegerValue ? (
                      <p
                        id={valueErrorId}
                        role="alert"
                        className="text-destructive text-sm"
                      >
                        {UNSAFE_INTEGER_FILTER_ERROR}
                      </p>
                    ) : null}
                  </>
                )}
              </Field>
            ) : (
              <div aria-hidden="true" />
            )}
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-end"
              aria-label={`Remove filter ${index + 1}`}
              onClick={() => onRemoveFilter(index)}
            >
              Remove
            </Button>
            {!isFilterReady(filter) ? (
              <p className="text-destructive col-span-full text-sm">
                Complete this condition or remove it before saving.
              </p>
            ) : null}
            {!field ? (
              <p className="text-destructive col-span-full text-sm">
                This saved filter refers to an unavailable field. Remove it
                before saving.
              </p>
            ) : null}
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        className="min-h-11 self-start"
        disabled={fields.length === 0 || filters.length >= 10}
        onClick={onAddFilter}
      >
        Add filter
      </Button>
    </section>
  );
}
