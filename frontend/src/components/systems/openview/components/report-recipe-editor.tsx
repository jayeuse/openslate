"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DialogFrameFooter,
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
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
import { cn } from "@/lib/utils";
import {
  assignableUsersOptions,
  CATALOG_PAGE_SIZE,
  fieldsFirstPageOptions,
  isAuthorizationDenied,
  moduleFieldKeys,
  readStamp,
  recordPageDenial,
} from "../adapters/openview-queries";
import { useOpenViewAccessDenied } from "../adapters/openview-access";
import {
  createOpenViewReport,
  getOpenViewReport,
  getOpenViewReportConflict,
  updateOpenViewReport,
  type OpenViewReport,
  type OpenViewReportRecipe,
} from "../adapters/reports-api";
import {
  listOpenViewDataSourceFields,
  type OpenViewDataSourceField,
} from "../adapters/views-api";
import {
  emptyReportDraft,
  reportDraftFrom,
  reportDraftFromView,
  reportDraftSignature,
  reportRecipeFromDraft,
  ReportDraftError,
  type ReportDraft,
  type ReportFilterDraft,
  type ReportViewSource,
} from "./report-draft";

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

/**
 * What the report dialog opens on: a new draft, the view on the page (a
 * `ReportViewSource` snapshot, DC7), or a saved report.
 */
export type ReportDialogTarget =
  | { kind: "new"; draft: ReportDraft }
  | { kind: "view"; snapshot: string }
  | { kind: "edit"; report: OpenViewReport };

function draftFor(moduleId: string, target: ReportDialogTarget): ReportDraft {
  if (target.kind === "edit") return reportDraftFrom(target.report);
  if (target.kind === "view")
    return reportDraftFromView(
      moduleId,
      JSON.parse(target.snapshot) as ReportViewSource,
    );
  return target.draft;
}

export type ReportRecipeEditorProps = {
  moduleId: string;
  moduleName: string;
  target: ReportDialogTarget;
  onClose: () => void;
  /** A confirmed save; `created` is true for a new report. */
  onSaved: (report: OpenViewReport, created: boolean) => void;
};

type FieldPages = {
  moduleId: string;
  readAt: number;
  items: OpenViewDataSourceField[];
  hasMore: boolean;
  nextOffset: number;
};

/**
 * New report and Edit (DC6) on the shared dialog frame. The module is the
 * page's module, so there is no module picker. Basics, Columns, then Filters
 * and order; Cancel and Create (or Save) stay pinned in the footer.
 */
export function ReportRecipeEditor({
  moduleId,
  moduleName,
  target,
  onClose,
  onSaved,
}: ReportRecipeEditorProps) {
  const queryClient = useQueryClient();
  const accessDenied = useOpenViewAccessDenied();
  const [baselineReport, setBaselineReport] = useState<OpenViewReport | null>(
    target.kind === "edit" ? target.report : null,
  );
  const [baselineDraft, setBaselineDraft] = useState<ReportDraft>(() =>
    target.kind === "edit"
      ? reportDraftFrom(target.report)
      : emptyReportDraft(moduleId),
  );
  const [draft, setDraft] = useState<ReportDraft>(() =>
    draftFor(moduleId, target),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const dirty =
    reportDraftSignature(draft) !== reportDraftSignature(baselineDraft);
  const canEdit = !pending;

  // The module's fields: the cached first page, then pages loaded on request.
  const fieldsQuery = useQuery(fieldsFirstPageOptions(moduleId));
  const fieldsDenied = accessDenied || isAuthorizationDenied(fieldsQuery.error);
  const fieldsBase = fieldsDenied ? undefined : fieldsQuery.data;
  const fieldsReadAt = fieldsBase ? readStamp(fieldsQuery) : 0;
  const [extension, setExtension] = useState<FieldPages | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const more =
    extension &&
    extension.moduleId === moduleId &&
    extension.readAt === fieldsReadAt
      ? extension
      : null;
  const moduleFields: OpenViewDataSourceField[] = [
    ...(fieldsBase?.items ?? []),
    ...(more?.items ?? []),
  ];
  const fieldsHasMore = more
    ? more.hasMore
    : (fieldsBase?.pagination.hasMore ?? false);
  const fieldsLoading = fieldsQuery.isFetching || loadingMore;
  const fieldsError = moreFailed
    ? "More fields could not be loaded. Try again."
    : fieldsQuery.isError && !fieldsQuery.isFetching
      ? "Fields could not be loaded. Try again."
      : "";
  function onRetryFields(): void {
    setExtension(null);
    setMoreFailed(false);
    void fieldsQuery.refetch();
  }
  async function loadMoreFields(): Promise<void> {
    if (fieldsLoading || !fieldsHasMore || !fieldsBase) return;
    const offset = more ? more.nextOffset : fieldsBase.pagination.count;
    const loaded = more?.items ?? [];
    const readAt = fieldsReadAt;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await listOpenViewDataSourceFields(moduleId, {
        limit: CATALOG_PAGE_SIZE,
        offset,
      });
      setExtension({
        moduleId,
        readAt,
        items: [...loaded, ...page.items],
        hasMore: page.pagination.hasMore,
        nextOffset: offset + page.pagination.count,
      });
    } catch (failure) {
      if (isAuthorizationDenied(failure))
        void recordPageDenial(queryClient, moduleFieldKeys(moduleId), failure);
      else setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const hasValuedUserFilter = draft.filters.some(
    (filter) =>
      filter.expectedType === "user" && !VALUELESS.has(filter.operator),
  );
  const assignableUsers = useQuery(
    assignableUsersOptions(moduleId, userSearch, hasValuedUserFilter),
  );
  const eligiblePeople =
    assignableUsers.isSuccess && !assignableUsers.isFetching
      ? assignableUsers.data.items
      : [];

  function updateFilter(key: string, change: Partial<ReportFilterDraft>): void {
    setDraft((current) => ({
      ...current,
      filters: current.filters.map((filter) =>
        filter.key === key
          ? {
              ...filter,
              ...change,
              ...("fieldId" in change || "operator" in change
                ? { originalValue: undefined, originalText: undefined }
                : {}),
            }
          : filter,
      ),
    }));
  }

  // Chosen columns in report order, then the module's other fields.
  const orderedFields = [
    ...draft.fields.flatMap((entry) => {
      const field = moduleFields.find((item) => item.id === entry.fieldId);
      return field ? [field] : [];
    }),
    ...moduleFields.filter(
      (field) => !draft.fields.some((entry) => entry.fieldId === field.id),
    ),
  ];
  const [moveNotice, setMoveNotice] = useState("");

  function moveColumn(
    field: OpenViewDataSourceField,
    position: number,
    step: -1 | 1,
  ): void {
    const target = position + step;
    if (target < 0 || target >= draft.fields.length) return;
    setDraft((current) => {
      const entries = [...current.fields];
      [entries[position], entries[target]] = [
        entries[target]!,
        entries[position]!,
      ];
      return { ...current, fields: entries };
    });
    setMoveNotice(`${field.name} moved to column ${target + 1}`);
    // Focus stays on the moved column's arrow, or its other arrow at an end.
    const atEnd = target === 0 || target === draft.fields.length - 1;
    const direction = step < 0 ? "up" : "down";
    const other = step < 0 ? "down" : "up";
    requestAnimationFrame(() =>
      document
        .getElementById(`report-move-${atEnd ? other : direction}-${field.id}`)
        ?.focus(),
    );
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    try {
      if (!draft.name.trim()) throw new ReportDraftError("Enter a report name");
      const recipe = reportRecipeFromDraft(draft);
      const input = {
        moduleId,
        name: draft.name.trim(),
        subtitle: draft.subtitle.trim() || null,
        recipe,
      };
      const saved = baselineReport
        ? await updateOpenViewReport({
            id: baselineReport.id,
            revision: baselineReport.revision,
            ...input,
          })
        : await createOpenViewReport(input);
      onSaved(saved, !baselineReport);
    } catch (reason) {
      const conflict = getOpenViewReportConflict(reason);
      setStale(Boolean(conflict));
      setError(
        conflict?.message ??
          (reason instanceof ReportDraftError
            ? reason.message
            : apiErrorMessage(
                reason,
                "The report could not be saved. Your changes are still here.",
              )),
      );
    } finally {
      setPending(false);
    }
  }

  async function reloadLatest(): Promise<void> {
    if (!baselineReport || pending) return;
    if (
      dirty &&
      !window.confirm("Replace your changes with the latest saved report?")
    )
      return;
    setPending(true);
    try {
      const latest = await getOpenViewReport(baselineReport.id);
      const next = reportDraftFrom(latest);
      setBaselineReport(latest);
      setBaselineDraft(next);
      setDraft(next);
      setStale(false);
      setError("");
    } catch (reason) {
      setError(
        apiErrorMessage(
          reason,
          "The latest report could not be loaded. Try again.",
        ),
      );
    } finally {
      setPending(false);
    }
  }

  // Leaving with changes asks first (Keep editing, Discard).
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  function close(): void {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }

  const title = baselineReport ? "Edit report" : "New report";
  // A save that cannot run says why (the Four Moments Rule).
  const saveBlocked = fieldsError
    ? "Fields could not be loaded"
    : fieldsLoading
      ? "Fields are loading"
      : baselineReport && !dirty
        ? "No changes to save"
        : null;
  return (
    <>
      <Dialog
        open
        dismissible={!dirty && !pending}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent className={cn(dialogFrameContentClass, "max-w-3xl")}>
          <DialogFrameHeader
            title={<DialogTitle>{title}</DialogTitle>}
            description={
              <DialogDescription>
                {baselineReport
                  ? `${baselineReport.name} · ${moduleName}`
                  : moduleName}
              </DialogDescription>
            }
            closeLabel={`Close ${title.toLowerCase()}`}
            closeDisabled={pending}
            onClose={close}
          />
          <form
            noValidate
            onSubmit={(event) => void save(event)}
            className="flex min-h-0 flex-col gap-6"
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
            <FieldSet>
              <FieldLegend>Basics</FieldLegend>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="report-name">Name</FieldLabel>
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
                </Field>
              </FieldGroup>
            </FieldSet>
            <div className="contents">
              <FieldSet>
                <FieldLegend>Columns</FieldLegend>
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
                {/* Chosen columns first, in report order, then the rest:
                  the rows show the order the arrows change (DC6). */}
                <div className="flex flex-col">
                  {orderedFields.map((field) => {
                    const position = draft.fields.findIndex(
                      (entry) => entry.fieldId === field.id,
                    );
                    return (
                      <Field
                        key={field.id}
                        className="min-h-11 flex-row items-center gap-3 xl:min-h-9"
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
                              id={`report-move-up-${field.id}`}
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-11 xl:size-8"
                              aria-label={`Move ${field.name} up`}
                              disabled={!canEdit || position === 0}
                              onClick={() => moveColumn(field, position, -1)}
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              id={`report-move-down-${field.id}`}
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-11 xl:size-8"
                              aria-label={`Move ${field.name} down`}
                              disabled={
                                !canEdit || position === draft.fields.length - 1
                              }
                              onClick={() => moveColumn(field, position, 1)}
                            >
                              <ArrowDown />
                            </Button>
                          </span>
                        ) : null}
                      </Field>
                    );
                  })}
                </div>
                <p role="status" className="sr-only">
                  {moveNotice}
                </p>
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
            </div>
            <section
              aria-labelledby="report-filters-heading"
              className="flex flex-col gap-5"
            >
              <h3
                id="report-filters-heading"
                data-slot="section-title"
                className="text-sm font-semibold"
              >
                Filters and order
              </h3>
              <div className="flex flex-col gap-5">
                <FieldSet>
                  <FieldLegend>Filters</FieldLegend>
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
            </section>
            <DialogFrameFooter>
              <DialogFooter className="mt-0">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={pending}
                  onClick={close}
                >
                  Cancel
                </Button>
                <DisabledReason reason={saveBlocked} stable>
                  <Button type="submit" className="min-h-11" disabled={pending}>
                    {pending
                      ? "Saving…"
                      : baselineReport
                        ? "Save report"
                        : "Create report"}
                  </Button>
                </DisabledReason>
              </DialogFooter>
            </DialogFrameFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent className="slim-ui">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your report changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The report stays as it was saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={() => {
                setConfirmDiscard(false);
                onClose();
              }}
            >
              Discard
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
