"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
} from "../adapters/views-api";
import { assignableUsersOptions } from "../adapters/openview-queries";
import {
  EMPTY_OPERATORS,
  OPERATOR_LABELS,
  filterInputValue,
  filterValueForType,
  hasUnsafeIntegerFilter,
  isFilterOperator,
  isFilterReady,
  membershipFilterValues,
  operatorChoices,
} from "../domain/server-view-draft";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { filterRowClassName } from "@/components/systems/access/components/access-toolbar";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

type SavedFilter = OpenViewQueryDefinition["filters"][number];

type SavedViewFilterControlsProps = {
  moduleId: string;
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

export function SavedViewFilterControls({
  moduleId,
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
  const [userSearch, setUserSearch] = useState("");
  const hasValuedUserFilter = filters.some(
    (filter) =>
      filter.expectedType === "user" && !EMPTY_OPERATORS.has(filter.operator),
  );
  const assignableUsers = useQuery(
    assignableUsersOptions(moduleId, userSearch, hasValuedUserFilter),
  );
  const eligiblePeople =
    assignableUsers.isSuccess && !assignableUsers.isFetching
      ? assignableUsers.data.items
      : [];
  return (
    // The Filters popover's rows (OD3): label-left, no heading of its own.
    <section aria-label="Filter conditions" className="flex flex-col gap-2">
      <Field className={filterRowClassName}>
        <FieldLabel
          htmlFor="openview-filter-logic"
          className="md:text-muted-foreground"
        >
          Match filters
        </FieldLabel>
        <Select
          id="openview-filter-logic"
          className="min-h-11 w-full"
          value={logic}
          onValueChange={(value) => {
            if (value === "and" || value === "or") onLogicChange(value);
          }}
        >
          <option value="and">All conditions</option>
          <option value="or">Any condition</option>
        </Select>
      </Field>
      {hasValuedUserFilter ? (
        <div className="grid max-w-xl gap-2">
          <Field>
            <FieldLabel htmlFor="openview-eligible-user-search">
              Search eligible people
            </FieldLabel>
            <Input
              id="openview-eligible-user-search"
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
      {filters.map((filter, index) => {
        const field = activeFields.get(filter.fieldId);
        const operators = operatorChoices(filter.expectedType);
        const needsValue = !EMPTY_OPERATORS.has(filter.operator);
        const unsafeIntegerValue = hasUnsafeIntegerFilter(filter);
        const valueErrorId = `openview-filter-value-error-${index}`;
        const value = filterInputValue(filter);
        const selectOptions = selectOptionsForField(field);
        const eligiblePersonSelected = eligiblePeople.some(
          (person) => person.id === value,
        );
        const selectChoiceSelected = selectOptions.some(
          (option) => option.id === value,
        );
        const selectedChoiceIds = membershipFilterValues(filter.value);
        const selectedChoiceIdSet = new Set(selectedChoiceIds);
        const unavailableSelectedChoiceCount = selectedChoiceIds.filter(
          (selectedId) =>
            !selectOptions.some((option) => option.id === selectedId),
        ).length;
        return (
          <div
            key={rowKeyFor(filter, index)}
            className="bg-muted/40 grid min-w-0 gap-2 rounded-md p-2.5"
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
                ) : filter.expectedType === "select" &&
                  filter.operator === "in" ? (
                  <fieldset
                    aria-describedby={`openview-filter-value-help-${index}`}
                    className="min-w-0 rounded-md border p-3"
                  >
                    <legend className="px-1 text-sm font-medium">Value</legend>
                    <p
                      id={`openview-filter-value-help-${index}`}
                      className="text-muted-foreground mb-2 text-sm"
                    >
                      Choose one or more options. You can select up to 100.
                    </p>
                    <div className="max-h-48 space-y-2 overflow-y-auto">
                      {selectOptions.map((option) => {
                        const optionId = `openview-filter-value-${index}-${option.id}`;
                        const optionLabelId = `${optionId}-label`;
                        const checked = selectedChoiceIdSet.has(option.id);
                        return (
                          <div
                            key={option.id}
                            className="flex min-h-8 items-center gap-2"
                          >
                            <Checkbox
                              id={optionId}
                              aria-labelledby={optionLabelId}
                              checked={checked}
                              disabled={
                                !checked && selectedChoiceIds.length >= 100
                              }
                              onCheckedChange={(nextChecked) =>
                                onUpdateFilter(index, (item) => {
                                  const current = membershipFilterValues(
                                    item.value,
                                  );
                                  const next =
                                    nextChecked === true
                                      ? current.includes(option.id)
                                        ? current
                                        : [...current, option.id]
                                      : current.filter(
                                          (selectedId) =>
                                            selectedId !== option.id,
                                        );
                                  return { ...item, value: next };
                                })
                              }
                            />
                            <label
                              id={optionLabelId}
                              htmlFor={optionId}
                              className="cursor-pointer text-sm"
                            >
                              {option.label}
                            </label>
                          </div>
                        );
                      })}
                    </div>
                    {unavailableSelectedChoiceCount > 0 ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <p role="alert" className="text-destructive text-sm">
                          {unavailableSelectedChoiceCount === 1
                            ? "One selected option is unavailable."
                            : "Some selected options are unavailable."}
                        </p>
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-9"
                          onClick={() =>
                            onUpdateFilter(index, (item) => ({
                              ...item,
                              value: membershipFilterValues(item.value).filter(
                                (selectedId) =>
                                  selectOptions.some(
                                    (option) => option.id === selectedId,
                                  ),
                              ),
                            }))
                          }
                        >
                          Remove unavailable options
                        </Button>
                      </div>
                    ) : null}
                  </fieldset>
                ) : filter.expectedType === "select" ? (
                  <Select
                    id={`openview-filter-value-${index}`}
                    className="min-h-11"
                    value={value}
                    onValueChange={(nextValue) =>
                      onUpdateFilter(index, (item) => ({
                        ...item,
                        value: nextValue,
                      }))
                    }
                  >
                    <option value="">Choose a value</option>
                    {value && !selectChoiceSelected ? (
                      <option value={value} disabled>
                        Unavailable option
                      </option>
                    ) : null}
                    {selectOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                ) : filter.expectedType === "user" ? (
                  <Select
                    id={`openview-filter-value-${index}`}
                    className="min-h-11"
                    value={value}
                    disabled={
                      assignableUsers.isFetching || assignableUsers.isError
                    }
                    onValueChange={(value) =>
                      onUpdateFilter(index, (item) => ({ ...item, value }))
                    }
                  >
                    <option value="">Choose an eligible person</option>
                    {value &&
                    assignableUsers.isSuccess &&
                    !assignableUsers.isFetching &&
                    !eligiblePersonSelected ? (
                      <option value={value} disabled>
                        Selected person is not in the current results
                      </option>
                    ) : null}
                    {eligiblePeople.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName?.trim() || user.username}
                      </option>
                    ))}
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
                      value={value}
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
