"use client";

import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { assignableUsersOptions } from "../adapters/openview-queries";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  OpenViewReport,
  OpenViewReportRecipe,
} from "../adapters/reports-api";
import type {
  OpenViewDataSource,
  OpenViewDataSourceField,
} from "../adapters/views-api";
import type { ReportDraft, ReportFilterDraft } from "./report-draft";

type FilterOperator = ReportFilterDraft["operator"];
const VALUELESS = new Set<FilterOperator>([
  "empty",
  "not_empty",
  "blank",
  "not_blank",
]);
const OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: "eq", label: "Is" },
  { value: "neq", label: "Is not" },
  { value: "lt", label: "Less than" },
  { value: "lte", label: "At most" },
  { value: "gt", label: "Greater than" },
  { value: "gte", label: "At least" },
  { value: "contains", label: "Contains" },
  { value: "prefix", label: "Starts with" },
  { value: "suffix", label: "Ends with" },
  { value: "in", label: "Is one of" },
  { value: "empty", label: "Is empty" },
  { value: "not_empty", label: "Is not empty" },
  { value: "blank", label: "Is blank" },
  { value: "not_blank", label: "Is not blank" },
];

function fieldReference(
  field: OpenViewDataSourceField,
): OpenViewReportRecipe["fields"][number] {
  return { fieldId: field.id, expectedType: field.type };
}

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

function membershipIds(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function operatorsFor(type: OpenViewDataSourceField["type"]): FilterOperator[] {
  const base: FilterOperator[] = [
    "eq",
    "neq",
    "empty",
    "not_empty",
    "blank",
    "not_blank",
  ];
  if (["text", "long_text", "email", "url"].includes(type))
    return [...base, "contains", "prefix", "suffix"];
  if (type === "select") return [...base, "contains", "in"];
  if (["number", "decimal", "int", "date", "datetime"].includes(type))
    return [...base, "lt", "lte", "gt", "gte"];
  return base;
}

export type ReportRecipeEditorProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baselineReport: OpenViewReport | null;
  draft: ReportDraft;
  setDraft: Dispatch<SetStateAction<ReportDraft>>;
  dirty: boolean;
  actionPending: string;
  error: string;
  notice: string;
  stale: boolean;
  sources: OpenViewDataSource[];
  sourcesHasMore: boolean;
  sourcesLoading: boolean;
  sourcesError: string;
  fields: OpenViewDataSourceField[];
  fieldsForModule: string;
  fieldsHasMore: boolean;
  fieldsLoading: boolean;
  fieldsError: string;
  onRetrySources: () => void;
  onRetryFields: () => void;
  loadMoreSources: () => Promise<void>;
  loadMoreFields: () => Promise<void>;
  saveReport: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  reloadLatest: () => Promise<void>;
  changeModule: (moduleId: string) => void;
  updateFilter: (key: string, change: Partial<ReportFilterDraft>) => void;
  resetDraft: () => void;
};

export function ReportRecipeEditor({
  open,
  onOpenChange,
  baselineReport,
  draft,
  setDraft,
  dirty,
  actionPending,
  error,
  notice,
  stale,
  sources,
  sourcesHasMore,
  sourcesLoading,
  sourcesError,
  fields,
  fieldsForModule,
  fieldsHasMore,
  fieldsLoading,
  fieldsError,
  onRetrySources,
  onRetryFields,
  loadMoreSources,
  loadMoreFields,
  saveReport,
  reloadLatest,
  changeModule,
  updateFilter,
  resetDraft,
}: ReportRecipeEditorProps) {
  const [activeTab, setActiveTab] = useState("basics");
  const [userSearch, setUserSearch] = useState("");
  const canEdit = !baselineReport?.isDeleted && !actionPending;
  const moduleFields = fieldsForModule === draft.moduleId ? fields : [];
  const hasValuedUserFilter = draft.filters.some(
    (filter) =>
      filter.expectedType === "user" && !VALUELESS.has(filter.operator),
  );
  const assignableUsers = useQuery(
    assignableUsersOptions(
      draft.moduleId,
      userSearch,
      open && hasValuedUserFilter,
    ),
  );
  const eligiblePeople =
    assignableUsers.isSuccess && !assignableUsers.isFetching
      ? assignableUsers.data.items
      : [];
  const selectedSource = sources.find((source) => source.id === draft.moduleId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 p-0">
        <DialogHeader className="border-border bg-card sticky top-0 z-10 flex-row items-start justify-between gap-4 border-b p-5">
          <div className="min-w-0">
            <DialogTitle>
              {baselineReport ? "Edit report" : "New report"}
            </DialogTitle>
            <DialogDescription className="mt-1">
              Choose one data source, then shape the saved output and who can
              open it.
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 shrink-0"
            aria-label="Close editor"
            onClick={() => onOpenChange(false)}
          >
            <X aria-hidden="true" />
          </Button>
        </DialogHeader>
        <form
          onSubmit={(event) => void saveReport(event)}
          className="flex flex-col gap-5 p-5"
        >
          {error ? (
            <Alert role="alert" variant="destructive">
              {error}
              {stale ? (
                <Button
                  type="button"
                  variant="outline"
                  className="ml-3 min-h-11"
                  onClick={() => void reloadLatest()}
                >
                  Reload latest
                </Button>
              ) : null}
            </Alert>
          ) : null}
          {notice ? <Alert variant="success">{notice}</Alert> : null}
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="min-w-0"
          >
            <TabsList
              aria-label="Report recipe sections"
              className="grid w-full grid-cols-2 sm:grid-cols-4"
            >
              <TabsTrigger value="basics" className="min-h-11">
                Basics
              </TabsTrigger>
              <TabsTrigger value="columns" className="min-h-11">
                Columns
              </TabsTrigger>
              <TabsTrigger value="advanced" className="min-h-11">
                Advanced
              </TabsTrigger>
            </TabsList>
            <TabsContent value="basics" keepMounted className="mt-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="report-source">Data source</FieldLabel>
                  <Select
                    id="report-source"
                    className="min-h-11"
                    value={draft.moduleId}
                    onValueChange={changeModule}
                    disabled={
                      !canEdit || (sourcesLoading && sources.length === 0)
                    }
                  >
                    <option value="">Choose a data source</option>
                    {draft.moduleId && !selectedSource ? (
                      <option value={draft.moduleId}>Current source</option>
                    ) : null}
                    {sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </Select>
                  <FieldDescription>
                    Reports use records from one source.
                  </FieldDescription>
                </Field>
                {sourcesError ? (
                  <Alert role="alert" variant="destructive">
                    {sourcesError}
                    <Button
                      type="button"
                      variant="outline"
                      className="ml-3 min-h-11"
                      onClick={onRetrySources}
                    >
                      Retry
                    </Button>
                  </Alert>
                ) : null}
                {sourcesHasMore ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 self-start"
                    disabled={sourcesLoading}
                    onClick={() => void loadMoreSources()}
                  >
                    Load more data sources
                  </Button>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="report-name">Report name</FieldLabel>
                  <Input
                    id="report-name"
                    className="min-h-11"
                    maxLength={80}
                    value={draft.name}
                    disabled={!canEdit}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="report-subtitle">Subtitle</FieldLabel>
                  <Input
                    id="report-subtitle"
                    className="min-h-11"
                    maxLength={160}
                    value={draft.subtitle}
                    disabled={!canEdit}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        subtitle: event.target.value,
                      }))
                    }
                  />
                  <FieldDescription>
                    Optional context for readers.
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </TabsContent>
            <TabsContent value="columns" keepMounted className="mt-4">
              <FieldSet>
                <FieldLegend>Columns</FieldLegend>
                <p className="text-muted-foreground text-sm">
                  Select at least one field. Use the arrows to set output order.
                </p>
                {fieldsError ? (
                  <Alert role="alert" variant="destructive">
                    {fieldsError}
                    <Button
                      type="button"
                      variant="outline"
                      className="ml-3 min-h-11"
                      onClick={onRetryFields}
                    >
                      Retry
                    </Button>
                  </Alert>
                ) : null}
                {fieldsLoading && moduleFields.length === 0 ? (
                  <p role="status" className="text-muted-foreground text-sm">
                    Loading fields…
                  </p>
                ) : null}
                {!fieldsLoading &&
                draft.moduleId &&
                moduleFields.length === 0 &&
                !fieldsError ? (
                  <p className="text-muted-foreground text-sm">
                    No available fields for this source.
                  </p>
                ) : null}
                <FieldGroup>
                  {moduleFields.map((field) => {
                    const position = draft.fields.findIndex(
                      (entry) => entry.fieldId === field.id,
                    );
                    return (
                      <Field
                        key={field.id}
                        className="min-h-11 flex-row items-center gap-3"
                      >
                        <Checkbox
                          id={`report-field-${field.id}`}
                          checked={position >= 0}
                          disabled={!canEdit}
                          onCheckedChange={(checked) =>
                            setDraft((current) => ({
                              ...current,
                              fields: checked
                                ? [...current.fields, fieldReference(field)]
                                : current.fields.filter(
                                    (entry) => entry.fieldId !== field.id,
                                  ),
                            }))
                          }
                        />
                        <FieldLabel htmlFor={`report-field-${field.id}`}>
                          {field.name}
                        </FieldLabel>
                        {position >= 0 ? (
                          <span className="ml-auto flex gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="min-h-11 min-w-11"
                              aria-label={`Move ${field.name} up`}
                              disabled={!canEdit || position === 0}
                              onClick={() =>
                                setDraft((current) => {
                                  const entries = [...current.fields];
                                  [entries[position - 1], entries[position]] = [
                                    entries[position]!,
                                    entries[position - 1]!,
                                  ];
                                  return { ...current, fields: entries };
                                })
                              }
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="min-h-11 min-w-11"
                              aria-label={`Move ${field.name} down`}
                              disabled={
                                !canEdit || position === draft.fields.length - 1
                              }
                              onClick={() =>
                                setDraft((current) => {
                                  const entries = [...current.fields];
                                  [entries[position], entries[position + 1]] = [
                                    entries[position + 1]!,
                                    entries[position]!,
                                  ];
                                  return { ...current, fields: entries };
                                })
                              }
                            >
                              <ArrowDown />
                            </Button>
                          </span>
                        ) : null}
                      </Field>
                    );
                  })}
                </FieldGroup>
                {draft.fields.some(
                  (entry) =>
                    !moduleFields.some((field) => field.id === entry.fieldId),
                ) ? (
                  <p className="text-muted-foreground text-sm">
                    Some selected columns are not on this field page. Load more
                    fields to inspect them.
                  </p>
                ) : null}
                {fieldsHasMore ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 self-start"
                    disabled={fieldsLoading}
                    onClick={() => void loadMoreFields()}
                  >
                    Load more fields
                  </Button>
                ) : null}
              </FieldSet>
            </TabsContent>
            <TabsContent value="advanced" keepMounted className="mt-4">
              <div className="flex flex-col gap-5">
                <h3 data-slot="section-title" className="text-sm font-semibold">
                  Filters, sorting, and grouping
                </h3>
                <FieldSet>
                  <FieldLegend>Filters</FieldLegend>
                  <p className="text-muted-foreground text-sm">
                    Keep only matching records. Add up to 10 conditions.
                  </p>
                  {hasValuedUserFilter ? (
                    <div className="grid max-w-xl gap-2">
                      <Field>
                        <FieldLabel htmlFor="report-eligible-user-search">
                          Search eligible people
                        </FieldLabel>
                        <Input
                          id="report-eligible-user-search"
                          className="min-h-11"
                          type="search"
                          maxLength={100}
                          value={userSearch}
                          disabled={!canEdit}
                          onChange={(event) =>
                            setUserSearch(event.target.value)
                          }
                        />
                        <FieldDescription>
                          Only people who can read this data source can be
                          selected.
                        </FieldDescription>
                      </Field>
                      {assignableUsers.isFetching ? (
                        <p
                          role="status"
                          className="text-muted-foreground text-sm"
                        >
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
                            disabled={!canEdit}
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
                          Showing the first 100 eligible people. Search to
                          narrow the list.
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
                  {draft.filters.length > 1 ? (
                    <Field>
                      <FieldLabel htmlFor="report-filter-logic">
                        Match
                      </FieldLabel>
                      <Select
                        id="report-filter-logic"
                        className="min-h-11"
                        value={draft.logic}
                        disabled={!canEdit}
                        onValueChange={(logic) =>
                          setDraft((current) => ({
                            ...current,
                            logic: logic === "or" ? "or" : "and",
                          }))
                        }
                      >
                        <option value="and">All conditions</option>
                        <option value="or">Any condition</option>
                      </Select>
                    </Field>
                  ) : null}
                  <FieldGroup>
                    {draft.filters.map((filter) => {
                      const allowed = operatorsFor(filter.expectedType);
                      const field = moduleFields.find(
                        (entry) => entry.id === filter.fieldId,
                      );
                      const selectOptions = selectOptionsForField(field);
                      const selectedChoiceIds = membershipIds(filter.value);
                      const selectedChoiceIdSet = new Set(selectedChoiceIds);
                      const unavailableChoiceCount = selectedChoiceIds.filter(
                        (selectedId) =>
                          !selectOptions.some(
                            (option) => option.id === selectedId,
                          ),
                      ).length;
                      const eligiblePersonSelected = eligiblePeople.some(
                        (person) => person.id === filter.value,
                      );
                      return (
                        <div
                          key={filter.key}
                          className="border-border grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
                        >
                          <Field>
                            <FieldLabel
                              htmlFor={`report-filter-field-${filter.key}`}
                            >
                              Field
                            </FieldLabel>
                            <Select
                              id={`report-filter-field-${filter.key}`}
                              className="min-h-11"
                              value={filter.fieldId}
                              disabled={!canEdit}
                              onValueChange={(fieldId) => {
                                const field = moduleFields.find(
                                  (entry) => entry.id === fieldId,
                                );
                                if (field)
                                  updateFilter(filter.key, {
                                    fieldId,
                                    expectedType: field.type,
                                    operator: "eq",
                                    value: "",
                                  });
                              }}
                            >
                              {!moduleFields.some(
                                (field) => field.id === filter.fieldId,
                              ) ? (
                                <option value={filter.fieldId}>
                                  Selected field
                                </option>
                              ) : null}
                              {moduleFields.map((field) => (
                                <option key={field.id} value={field.id}>
                                  {field.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field>
                            <FieldLabel
                              htmlFor={`report-filter-operator-${filter.key}`}
                            >
                              Condition
                            </FieldLabel>
                            <Select
                              id={`report-filter-operator-${filter.key}`}
                              className="min-h-11"
                              value={filter.operator}
                              disabled={!canEdit}
                              onValueChange={(operator) =>
                                updateFilter(filter.key, {
                                  operator: operator as FilterOperator,
                                  value: "",
                                })
                              }
                            >
                              {OPERATORS.filter((option) =>
                                allowed.includes(option.value),
                              ).map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          {!VALUELESS.has(filter.operator) ? (
                            <Field className="sm:col-span-2">
                              <FieldLabel
                                htmlFor={`report-filter-value-${filter.key}`}
                              >
                                Value
                              </FieldLabel>
                              {filter.expectedType === "boolean" ? (
                                <Select
                                  id={`report-filter-value-${filter.key}`}
                                  className="min-h-11"
                                  value={filter.value}
                                  disabled={!canEdit}
                                  onValueChange={(value) =>
                                    updateFilter(filter.key, { value })
                                  }
                                >
                                  <option value="">Choose</option>
                                  <option value="true">True</option>
                                  <option value="false">False</option>
                                </Select>
                              ) : filter.expectedType === "select" &&
                                filter.operator === "in" ? (
                                <fieldset className="min-w-0 rounded-md border p-3">
                                  <legend className="px-1 text-sm font-medium">
                                    Value
                                  </legend>
                                  <p className="text-muted-foreground mb-2 text-sm">
                                    Choose one or more options. You can select
                                    up to 100.
                                  </p>
                                  <div className="max-h-48 space-y-2 overflow-y-auto">
                                    {selectOptions.map((option) => {
                                      const optionId = `report-filter-value-${filter.key}-${option.id}`;
                                      const optionLabelId = `${optionId}-label`;
                                      const checked = selectedChoiceIdSet.has(
                                        option.id,
                                      );
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
                                              !canEdit ||
                                              (!checked &&
                                                selectedChoiceIds.length >= 100)
                                            }
                                            onCheckedChange={(nextChecked) => {
                                              const current = membershipIds(
                                                filter.value,
                                              );
                                              const next =
                                                nextChecked === true
                                                  ? current.includes(option.id)
                                                    ? current
                                                    : [...current, option.id]
                                                  : current.filter(
                                                      (selectedId) =>
                                                        selectedId !==
                                                        option.id,
                                                    );
                                              updateFilter(filter.key, {
                                                value: next.join(", "),
                                              });
                                            }}
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
                                  {unavailableChoiceCount > 0 ? (
                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                      <p
                                        role="alert"
                                        className="text-destructive text-sm"
                                      >
                                        Some selected options are unavailable.
                                      </p>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        className="min-h-9"
                                        disabled={!canEdit}
                                        onClick={() =>
                                          updateFilter(filter.key, {
                                            value: selectedChoiceIds
                                              .filter((selectedId) =>
                                                selectOptions.some(
                                                  (option) =>
                                                    option.id === selectedId,
                                                ),
                                              )
                                              .join(", "),
                                          })
                                        }
                                      >
                                        Remove unavailable options
                                      </Button>
                                    </div>
                                  ) : null}
                                </fieldset>
                              ) : filter.expectedType === "select" ? (
                                <Select
                                  id={`report-filter-value-${filter.key}`}
                                  className="min-h-11"
                                  value={filter.value}
                                  disabled={!canEdit}
                                  onValueChange={(value) =>
                                    updateFilter(filter.key, { value })
                                  }
                                >
                                  <option value="">Choose a value</option>
                                  {filter.value &&
                                  !selectOptions.some(
                                    (option) => option.id === filter.value,
                                  ) ? (
                                    <option value={filter.value} disabled>
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
                                  id={`report-filter-value-${filter.key}`}
                                  className="min-h-11"
                                  value={filter.value}
                                  disabled={
                                    !canEdit ||
                                    assignableUsers.isFetching ||
                                    assignableUsers.isError
                                  }
                                  onValueChange={(value) =>
                                    updateFilter(filter.key, { value })
                                  }
                                >
                                  <option value="">
                                    Choose an eligible person
                                  </option>
                                  {filter.value &&
                                  assignableUsers.isSuccess &&
                                  !assignableUsers.isFetching &&
                                  !eligiblePersonSelected ? (
                                    <option value={filter.value} disabled>
                                      Selected person is not in the current
                                      results
                                    </option>
                                  ) : null}
                                  {eligiblePeople.map((person) => (
                                    <option key={person.id} value={person.id}>
                                      {person.displayName?.trim() ||
                                        person.username}
                                    </option>
                                  ))}
                                </Select>
                              ) : (
                                <Input
                                  id={`report-filter-value-${filter.key}`}
                                  className="min-h-11"
                                  value={filter.value}
                                  disabled={!canEdit}
                                  maxLength={4000}
                                  onChange={(event) =>
                                    updateFilter(filter.key, {
                                      value: event.target.value,
                                    })
                                  }
                                />
                              )}
                            </Field>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            className="min-h-11 self-end justify-self-start"
                            disabled={!canEdit}
                            onClick={() =>
                              setDraft((current) => ({
                                ...current,
                                filters: current.filters.filter(
                                  (item) => item.key !== filter.key,
                                ),
                              }))
                            }
                          >
                            <Trash2 data-icon="inline-start" /> Remove filter
                          </Button>
                        </div>
                      );
                    })}
                  </FieldGroup>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 self-start"
                    disabled={
                      !canEdit ||
                      !moduleFields.length ||
                      draft.filters.length >= 10
                    }
                    onClick={() => {
                      const field = moduleFields[0]!;
                      setDraft((current) => ({
                        ...current,
                        filters: [
                          ...current.filters,
                          {
                            key: crypto.randomUUID(),
                            fieldId: field.id,
                            expectedType: field.type,
                            operator: "eq",
                            value: "",
                          },
                        ],
                      }));
                    }}
                  >
                    <Plus data-icon="inline-start" /> Add filter
                  </Button>
                </FieldSet>
                <FieldSet>
                  <FieldLegend>Sorting</FieldLegend>
                  <FieldGroup>
                    {draft.sorts.map((sort, index) => (
                      <div
                        key={sort.fieldId}
                        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto]"
                      >
                        <Field>
                          <FieldLabel htmlFor={`report-sort-field-${index}`}>
                            Sort field {index + 1}
                          </FieldLabel>
                          <Select
                            id={`report-sort-field-${index}`}
                            className="min-h-11"
                            value={sort.fieldId}
                            disabled={!canEdit}
                            onValueChange={(fieldId) => {
                              const field = moduleFields.find(
                                (item) => item.id === fieldId,
                              );
                              if (field)
                                setDraft((current) => ({
                                  ...current,
                                  sorts: current.sorts.map((item, position) =>
                                    position === index
                                      ? {
                                          ...fieldReference(field),
                                          direction: item.direction,
                                        }
                                      : item,
                                  ),
                                }));
                            }}
                          >
                            {!moduleFields.some(
                              (field) => field.id === sort.fieldId,
                            ) ? (
                              <option value={sort.fieldId}>
                                Selected field
                              </option>
                            ) : null}
                            {moduleFields
                              .filter(
                                (field) =>
                                  field.id === sort.fieldId ||
                                  !draft.sorts.some(
                                    (item) => item.fieldId === field.id,
                                  ),
                              )
                              .map((field) => (
                                <option key={field.id} value={field.id}>
                                  {field.name}
                                </option>
                              ))}
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel
                            htmlFor={`report-sort-direction-${index}`}
                          >
                            Direction
                          </FieldLabel>
                          <Select
                            id={`report-sort-direction-${index}`}
                            className="min-h-11"
                            value={sort.direction}
                            disabled={!canEdit}
                            onValueChange={(direction) =>
                              setDraft((current) => ({
                                ...current,
                                sorts: current.sorts.map((item, position) =>
                                  position === index
                                    ? {
                                        ...item,
                                        direction:
                                          direction === "desc" ? "desc" : "asc",
                                      }
                                    : item,
                                ),
                              }))
                            }
                          >
                            <option value="asc">Ascending</option>
                            <option value="desc">Descending</option>
                          </Select>
                        </Field>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="min-h-11 min-w-11 self-end"
                          aria-label={`Remove sort ${index + 1}`}
                          disabled={!canEdit}
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              sorts: current.sorts.filter(
                                (_, position) => position !== index,
                              ),
                            }))
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                  </FieldGroup>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 self-start"
                    disabled={
                      !canEdit ||
                      draft.sorts.length >= 3 ||
                      moduleFields.every((field) =>
                        draft.sorts.some((sort) => sort.fieldId === field.id),
                      )
                    }
                    onClick={() => {
                      const field = moduleFields.find(
                        (entry) =>
                          !draft.sorts.some(
                            (sort) => sort.fieldId === entry.id,
                          ),
                      );
                      if (field)
                        setDraft((current) => ({
                          ...current,
                          sorts: [
                            ...current.sorts,
                            {
                              ...fieldReference(field),
                              direction: "asc",
                            },
                          ],
                        }));
                    }}
                  >
                    <Plus data-icon="inline-start" /> Add sort
                  </Button>
                </FieldSet>
                <Field>
                  <FieldLabel htmlFor="report-group-field">
                    Group rows by
                  </FieldLabel>
                  <Select
                    id="report-group-field"
                    className="min-h-11"
                    value={draft.groupBy?.fieldId ?? ""}
                    disabled={!canEdit}
                    onValueChange={(fieldId) => {
                      const field = moduleFields.find(
                        (entry) => entry.id === fieldId,
                      );
                      setDraft((current) => ({
                        ...current,
                        groupBy: field ? fieldReference(field) : null,
                      }));
                    }}
                  >
                    <option value="">Do not group</option>
                    {draft.groupBy &&
                    !moduleFields.some(
                      (field) => field.id === draft.groupBy?.fieldId,
                    ) ? (
                      <option value={draft.groupBy.fieldId}>
                        Selected field
                      </option>
                    ) : null}
                    {moduleFields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field className="min-h-11 flex-row items-center gap-3">
                  <Checkbox
                    id="report-row-count"
                    checked={draft.includeRowCount}
                    disabled={!canEdit}
                    onCheckedChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        includeRowCount: Boolean(value),
                      }))
                    }
                  />
                  <FieldLabel htmlFor="report-row-count">
                    Include row count
                  </FieldLabel>
                </Field>
              </div>
            </TabsContent>
          </Tabs>
          <div className="border-border bg-card sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t py-3">
            <Button
              type="submit"
              className="min-h-11"
              disabled={
                !canEdit || !dirty || fieldsLoading || Boolean(fieldsError)
              }
            >
              {actionPending === "save"
                ? "Saving…"
                : baselineReport
                  ? "Save changes"
                  : "Create Report"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!canEdit || !dirty}
              onClick={resetDraft}
            >
              Reset draft
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:ml-auto"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          </div>
          {dirty ? (
            <p role="status" className="text-muted-foreground text-sm">
              Unsaved changes. Save or reset before running or archiving.
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
