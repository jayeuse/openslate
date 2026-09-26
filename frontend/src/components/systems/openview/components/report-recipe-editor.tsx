"use client";

import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useState,
} from "react";
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
import { ReportAudienceSelector } from "./report-audience-selector";

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
  const canEdit = !baselineReport?.isDeleted && !actionPending;
  const moduleFields = fieldsForModule === draft.moduleId ? fields : [];
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
              <TabsTrigger value="audience" className="min-h-11">
                Audience
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
                <h3 className="text-sm font-semibold">
                  Filters, sorting, and grouping
                </h3>
                <FieldSet>
                  <FieldLegend>Filters</FieldLegend>
                  <p className="text-muted-foreground text-sm">
                    Keep only matching records. Add up to 10 conditions.
                  </p>
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
                              {filter.operator === "in" ? (
                                <FieldDescription>
                                  Separate choices with commas; quote a choice
                                  that contains a comma.
                                </FieldDescription>
                              ) : null}
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
            <TabsContent value="audience" keepMounted className="mt-4">
              <ReportAudienceSelector
                audience={draft.audience}
                onChange={(audience) =>
                  setDraft((current) => ({ ...current, audience }))
                }
                disabled={!canEdit}
              />
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
