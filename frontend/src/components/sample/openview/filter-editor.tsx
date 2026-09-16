"use client";

import { Plus, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import { FILTER_OPERATORS } from "./model";
import type {
  FilterGroup,
  FilterOperator,
  OpenViewModule,
  OpenViewRow,
} from "./model";
import {
  addFilterClause,
  filterOperatorLabel,
  inputTypeForField,
  operatorsForField,
  type FilterOperatorMode,
  updateFilterClause,
  valuesForFilterField,
} from "./filter-helpers";

export type OpenViewFilterEditorProps = {
  module: OpenViewModule;
  filters: FilterGroup;
  onChange: (filters: FilterGroup) => void;
  title?: string;
  description?: ReactNode;
  idPrefix?: string;
  rows?: OpenViewRow[];
  operatorMode?: FilterOperatorMode;
  clearValueOnFieldChange?: boolean;
  selectValueFields?: boolean;
  showLogicWhenEmpty?: boolean;
  logicControl?: "toggle" | "select";
  logicLabel?: string;
  logicOptions?: { and: string; or: string };
  showEmptyState?: boolean;
  valueMaxLength?: number | null;
  addOperator?:
    | FilterOperator
    | ((field: OpenViewModule["fields"][number]) => FilterOperator);
  addLabel?: string;
  showLimitLabel?: boolean;
  operatorLabel?: (operator: FilterOperator) => string;
  removeVariant?: "outline" | "ghost";
};

export function constrainFilterValue(
  value: string,
  maxLength: number | null,
): string {
  return maxLength === null ? value : value.slice(0, maxLength);
}

export function OpenViewFilterEditor({
  module,
  filters,
  onChange,
  title = "Filters",
  description = "Combine up to eight conditions with AND or OR.",
  idPrefix,
  rows = [],
  operatorMode = "field-compatible",
  clearValueOnFieldChange = false,
  selectValueFields = false,
  showLogicWhenEmpty = true,
  logicControl = "toggle",
  logicLabel,
  logicOptions = { and: "Match all", or: "Match any" },
  showEmptyState = false,
  valueMaxLength = 240,
  addOperator,
  addLabel = "Add filter",
  showLimitLabel = true,
  operatorLabel = filterOperatorLabel,
  removeVariant = "ghost",
}: OpenViewFilterEditorProps) {
  const prefix =
    idPrefix ??
    `openview-filter-${title.toLocaleLowerCase().replaceAll(" ", "-")}`;
  const updateClause = (
    index: number,
    patch: Parameters<typeof updateFilterClause>[3],
  ) => {
    onChange(
      updateFilterClause(module, filters, index, patch, {
        operatorMode,
        clearValueOnFieldChange,
      }),
    );
  };
  const showLogic = showLogicWhenEmpty || filters.clauses.length > 0;

  return (
    <FieldSet>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <FieldLegend>{title}</FieldLegend>
          {description ? (
            <p className="text-muted-foreground text-xs">{description}</p>
          ) : null}
        </div>
        {showLogic && logicControl === "toggle" ? (
          <ToggleGroup
            value={[filters.logic]}
            onValueChange={(value) => {
              const logic = value[0];
              if (logic === "and" || logic === "or")
                onChange({ ...filters, logic });
            }}
            variant="outline"
            aria-label="Filter matching logic"
          >
            <ToggleGroupItem value="and" className="min-h-11">
              {logicOptions.and}
            </ToggleGroupItem>
            <ToggleGroupItem value="or" className="min-h-11">
              {logicOptions.or}
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
        {showLogic && logicControl === "select" ? (
          <Field className="w-full sm:w-64">
            {logicLabel ? (
              <FieldLabel htmlFor={`${prefix}-logic`}>{logicLabel}</FieldLabel>
            ) : null}
            <Select
              id={`${prefix}-logic`}
              className="min-h-11"
              value={filters.logic}
              onValueChange={(logic) => {
                if (logic === "and" || logic === "or")
                  onChange({ ...filters, logic });
              }}
            >
              <option value="and">{logicOptions.and}</option>
              <option value="or">{logicOptions.or}</option>
            </Select>
          </Field>
        ) : null}
      </div>
      {filters.clauses.length === 0 && showEmptyState ? (
        <Empty className="min-h-28 border">
          <EmptyHeader>
            <EmptyTitle>No filters yet</EmptyTitle>
            <EmptyDescription>
              Add conditions to narrow the records.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {filters.clauses.length > 0 ? (
        <FieldGroup className="gap-3">
          {filters.clauses.map((clause, index) => {
            const field =
              module.fields.find(
                (candidate) => candidate.id === clause.field,
              ) ?? module.fields[0];
            const needsValue =
              clause.operator !== "is-empty" &&
              clause.operator !== "is-not-empty";
            const valueOptions =
              selectValueFields && field?.type === "select"
                ? valuesForFilterField(rows, clause.field)
                : [];
            const fieldId = `${prefix}-field-${index}`;
            const operatorId = `${prefix}-operator-${index}`;
            const valueId = `${prefix}-value-${index}`;
            const operators = field
              ? operatorMode === "all"
                ? [...FILTER_OPERATORS]
                : operatorsForField(field)
              : [];
            return (
              <div
                key={`${prefix}-${index}-${clause.field}`}
                className="border-border grid gap-3 rounded-[var(--radius)] border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
              >
                <Field>
                  <FieldLabel htmlFor={fieldId}>
                    {filters.clauses.length > 1
                      ? `Field ${index + 1}`
                      : "Field"}
                  </FieldLabel>
                  <Select
                    id={fieldId}
                    className="min-h-11"
                    value={clause.field}
                    onValueChange={(fieldIdValue) =>
                      updateClause(index, { field: fieldIdValue })
                    }
                  >
                    {module.fields.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={operatorId}>Condition</FieldLabel>
                  <Select
                    id={operatorId}
                    className="min-h-11"
                    value={clause.operator}
                    onValueChange={(operator) =>
                      updateClause(index, {
                        operator: operator as FilterOperator,
                      })
                    }
                  >
                    {operators.map((operator) => (
                      <option key={operator} value={operator}>
                        {operatorLabel(operator)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field data-disabled={!needsValue}>
                  <FieldLabel htmlFor={valueId}>Value</FieldLabel>
                  {valueOptions.length > 0 && needsValue ? (
                    <Select
                      id={valueId}
                      className="min-h-11"
                      value={clause.value}
                      onValueChange={(value) => updateClause(index, { value })}
                    >
                      <option value="">Choose a value</option>
                      {valueOptions.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      id={valueId}
                      className="min-h-11"
                      type={inputTypeForField(field)}
                      value={clause.value}
                      maxLength={valueMaxLength ?? undefined}
                      disabled={!needsValue}
                      placeholder={needsValue ? "Enter a value" : "Not needed"}
                      onChange={(event) =>
                        updateClause(index, {
                          value: constrainFilterValue(
                            event.target.value,
                            valueMaxLength,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                <Button
                  type="button"
                  variant={removeVariant}
                  size="icon"
                  className={
                    removeVariant === "ghost"
                      ? "text-destructive min-h-11 min-w-11"
                      : "size-11"
                  }
                  aria-label={`Remove filter ${index + 1}`}
                  onClick={() =>
                    onChange({
                      ...filters,
                      clauses: filters.clauses.filter(
                        (_, clauseIndex) => clauseIndex !== index,
                      ),
                    })
                  }
                >
                  {removeVariant === "ghost" ? (
                    <Trash2 aria-hidden="true" />
                  ) : (
                    <X aria-hidden="true" />
                  )}
                </Button>
              </div>
            );
          })}
        </FieldGroup>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="min-h-11 self-start"
        disabled={filters.clauses.length >= 8}
        onClick={() =>
          onChange(
            addFilterClause(module, filters, {
              operator: addOperator,
            }),
          )
        }
      >
        <Plus data-icon="inline-start" aria-hidden="true" /> {addLabel}{" "}
        {showLimitLabel && filters.clauses.length >= 8 ? "(limit reached)" : ""}
      </Button>
    </FieldSet>
  );
}
