"use client";

import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { OpenViewDataSourceField } from "../adapters/views-api";
import {
  COMMON_FILTER_OPERATORS,
  EMPTY_OPERATORS,
  NUMERIC_TYPES,
  operatorLabel,
  operatorsFor,
  type FilterDraft,
  type FilterLogic,
  type FilterOperator,
} from "../domain/chart-query";

type ChartFilterControlsProps = {
  filterFields: OpenViewDataSourceField[];
  filters: FilterDraft[];
  filterLogic: FilterLogic;
  filterValidation: FilterDraft | undefined;
  queryLoading: boolean;
  setFilters: Dispatch<SetStateAction<FilterDraft[]>>;
  setFilterLogic: (logic: FilterLogic) => void;
  addFilter: () => void;
};

export function ChartFilterControls({
  filterFields,
  filters,
  filterLogic,
  filterValidation,
  queryLoading,
  setFilters,
  setFilterLogic,
  addFilter,
}: ChartFilterControlsProps) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-[var(--radius)] border p-4">
      <legend className="px-1 text-sm font-medium">Filters</legend>
      <p className="text-muted-foreground text-sm">
        Combine up to 10 field filters with the selected logic before
        aggregation. A separate date window is ANDed with those filters.
      </p>
      <Field className="w-full max-w-56">
        <FieldLabel htmlFor="chart-filter-logic">Chart filter logic</FieldLabel>
        <Select
          id="chart-filter-logic"
          className="min-h-11"
          value={filterLogic}
          disabled={queryLoading}
          onValueChange={(value) => setFilterLogic(value as FilterLogic)}
        >
          <option value="and">Match all filters (AND)</option>
          <option value="or">Match any filter (OR)</option>
        </Select>
      </Field>
      {filters.map((filter, index) => {
        const field = filterFields.find(
          (candidate) => candidate.id === filter.fieldId,
        );
        const fieldOperators = field
          ? operatorsFor(field)
          : COMMON_FILTER_OPERATORS;
        const choices = field?.config.options;
        const selectChoices = Array.isArray(choices)
          ? choices.filter(
              (choice): choice is string => typeof choice === "string",
            )
          : [];
        return (
          <div
            key={filter.id}
            className="bg-muted/30 grid gap-3 rounded-[var(--radius)] p-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <Field>
              <FieldLabel htmlFor={`chart-filter-${filter.id}-field`}>
                Filter {index + 1} field
              </FieldLabel>
              <Select
                id={`chart-filter-${filter.id}-field`}
                className="min-h-11"
                value={filter.fieldId}
                disabled={queryLoading || !filterFields.length}
                onValueChange={(fieldId) =>
                  setFilters((current) =>
                    current.map((item) =>
                      item.id === filter.id
                        ? {
                            ...item,
                            fieldId,
                            operator: "eq",
                            value: "",
                          }
                        : item,
                    ),
                  )
                }
              >
                {filterFields.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`chart-filter-${filter.id}-operator`}>
                Filter {index + 1} operator
              </FieldLabel>
              <Select
                id={`chart-filter-${filter.id}-operator`}
                className="min-h-11"
                value={filter.operator}
                disabled={queryLoading}
                onValueChange={(operator) =>
                  setFilters((current) =>
                    current.map((item) =>
                      item.id === filter.id
                        ? {
                            ...item,
                            operator: operator as FilterOperator,
                            value: "",
                          }
                        : item,
                    ),
                  )
                }
              >
                {fieldOperators.map((operator) => (
                  <option key={operator} value={operator}>
                    {operatorLabel(operator)}
                  </option>
                ))}
              </Select>
            </Field>
            {!EMPTY_OPERATORS.has(filter.operator) ? (
              <Field>
                <FieldLabel htmlFor={`chart-filter-${filter.id}-value`}>
                  Filter {index + 1} value
                </FieldLabel>
                {selectChoices.length ? (
                  <Select
                    id={`chart-filter-${filter.id}-value`}
                    className="min-h-11"
                    value={filter.value}
                    disabled={queryLoading}
                    onValueChange={(value) =>
                      setFilters((current) =>
                        current.map((item) =>
                          item.id === filter.id ? { ...item, value } : item,
                        ),
                      )
                    }
                  >
                    <option value="" disabled>
                      Select a value
                    </option>
                    {selectChoices.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                  </Select>
                ) : field?.type === "boolean" ? (
                  <Select
                    id={`chart-filter-${filter.id}-value`}
                    className="min-h-11"
                    value={filter.value}
                    disabled={queryLoading}
                    onValueChange={(value) =>
                      setFilters((current) =>
                        current.map((item) =>
                          item.id === filter.id ? { ...item, value } : item,
                        ),
                      )
                    }
                  >
                    <option value="" disabled>
                      Select a value
                    </option>
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </Select>
                ) : (
                  <Input
                    id={`chart-filter-${filter.id}-value`}
                    className="min-h-11"
                    type={
                      field?.type === "decimal"
                        ? "text"
                        : field && NUMERIC_TYPES.has(field.type)
                          ? "number"
                          : field?.type === "date"
                            ? "date"
                            : field?.type === "datetime"
                              ? "datetime-local"
                              : "text"
                    }
                    step={
                      field?.type === "int"
                        ? 1
                        : field?.type === "number"
                          ? "any"
                          : undefined
                    }
                    inputMode={
                      field?.type === "decimal" ? "decimal" : undefined
                    }
                    maxLength={field?.type === "decimal" ? 58 : undefined}
                    value={filter.value}
                    disabled={queryLoading}
                    onChange={(event) =>
                      setFilters((current) =>
                        current.map((item) =>
                          item.id === filter.id
                            ? { ...item, value: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                )}
              </Field>
            ) : (
              <p className="text-muted-foreground self-center text-sm">
                This operator does not need a value.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-end"
              disabled={queryLoading}
              onClick={() =>
                setFilters((current) =>
                  current.filter((item) => item.id !== filter.id),
                )
              }
            >
              Remove filter {index + 1}
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={
            filters.length >= 10 || !filterFields.length || queryLoading
          }
          onClick={addFilter}
        >
          Add filter
        </Button>
      </div>
      {filterValidation ? (
        <p role="alert" className="text-destructive text-sm">
          Complete each filter with a value allowed by its field type.
        </p>
      ) : null}
    </fieldset>
  );
}
