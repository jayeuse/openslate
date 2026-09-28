"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { assignableUsersOptions } from "../adapters/openview-queries";
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
  moduleId: string;
  filterFields: OpenViewDataSourceField[];
  filters: FilterDraft[];
  filterLogic: FilterLogic;
  filterValidation: FilterDraft | undefined;
  queryLoading: boolean;
  setFilters: Dispatch<SetStateAction<FilterDraft[]>>;
  setFilterLogic: (logic: FilterLogic) => void;
  addFilter: () => void;
};

function selectOptionsForField(
  field: OpenViewDataSourceField | undefined,
): Array<{ id: string; label: string }> {
  if (!field || field.type !== "select" || !Array.isArray(field.config.options))
    return [];
  return field.config.options.flatMap((option) => {
    if (typeof option !== "object" || option === null) return [];
    const candidate = option as Record<string, unknown>;
    return typeof candidate.id === "string" &&
      typeof candidate.label === "string"
      ? [{ id: candidate.id, label: candidate.label }]
      : [];
  });
}

export function ChartFilterControls({
  moduleId,
  filterFields,
  filters,
  filterLogic,
  filterValidation,
  queryLoading,
  setFilters,
  setFilterLogic,
  addFilter,
}: ChartFilterControlsProps) {
  const [userSearch, setUserSearch] = useState("");
  const hasUserFilter = filters.some((filter) => {
    const field = filterFields.find(
      (candidate) => candidate.id === filter.fieldId,
    );
    return field?.type === "user" && !EMPTY_OPERATORS.has(filter.operator);
  });
  const assignableUsers = useQuery(
    assignableUsersOptions(moduleId, userSearch, hasUserFilter),
  );
  const eligiblePeople =
    assignableUsers.isSuccess && !assignableUsers.isFetching
      ? assignableUsers.data.items
      : [];
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="sr-only">Filters</legend>
      <p className="text-muted-foreground text-sm">
        Combine up to 10 field filters before aggregation. The separate date
        window is also applied to the matching records.
      </p>
      {hasUserFilter ? (
        <div className="grid max-w-xl gap-2">
          <Field>
            <FieldLabel htmlFor="chart-eligible-user-search">
              Search eligible people
            </FieldLabel>
            <Input
              id="chart-eligible-user-search"
              className="min-h-11"
              type="search"
              maxLength={100}
              value={userSearch}
              onChange={(event) => setUserSearch(event.target.value)}
            />
            <FieldDescription>
              Only people who can read this data source can be selected.
            </FieldDescription>
          </Field>
          {assignableUsers.isFetching ? (
            <p role="status" className="text-muted-foreground text-sm">
              Loading eligible people…
            </p>
          ) : null}
          {assignableUsers.isError ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-destructive text-sm">
                Eligible people could not be loaded.
              </p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => void assignableUsers.refetch()}
              >
                Retry people
              </Button>
            </div>
          ) : null}
          {!assignableUsers.isFetching &&
          !assignableUsers.isError &&
          assignableUsers.data?.pagination.hasMore ? (
            <p className="text-muted-foreground text-sm">
              Showing the first 100 eligible people. Search to narrow the list.
            </p>
          ) : null}
          {!assignableUsers.isFetching &&
          !assignableUsers.isError &&
          assignableUsers.data?.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No eligible people match this search.
            </p>
          ) : null}
        </div>
      ) : null}
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
        const selectChoices = selectOptionsForField(field);
        const selectedUser = eligiblePeople.some(
          (person) => person.id === filter.value,
        );
        const selectedChoice = selectChoices.some(
          (choice) => choice.id === filter.value,
        );
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
                {field?.type === "select" ? (
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
                    <option value="">Select a value</option>
                    {filter.value && !selectedChoice ? (
                      <option value={filter.value} disabled>
                        Unavailable option
                      </option>
                    ) : null}
                    {selectChoices.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </Select>
                ) : field?.type === "user" ? (
                  <Select
                    id={`chart-filter-${filter.id}-value`}
                    className="min-h-11"
                    value={filter.value}
                    disabled={
                      queryLoading ||
                      assignableUsers.isFetching ||
                      assignableUsers.isError
                    }
                    onValueChange={(value) =>
                      setFilters((current) =>
                        current.map((item) =>
                          item.id === filter.id ? { ...item, value } : item,
                        ),
                      )
                    }
                  >
                    <option value="">Choose an eligible person</option>
                    {filter.value &&
                    assignableUsers.isSuccess &&
                    !assignableUsers.isFetching &&
                    !selectedUser ? (
                      <option value={filter.value} disabled>
                        Selected person is not in the current results
                      </option>
                    ) : null}
                    {eligiblePeople.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.displayName?.trim() || person.username}
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
