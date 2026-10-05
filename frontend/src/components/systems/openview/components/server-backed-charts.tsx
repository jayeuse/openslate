"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
import { subscribeOpenViewInvalidations } from "../adapters/invalidation-events";
import {
  catalogFirstPageOptions,
  extendsRead,
  fieldsFirstPageOptions,
  invalidatesRecords,
  isAuthorizationDenied,
  moduleFieldKeys,
  openViewKeys,
  readStamp,
  recordPageDenial,
} from "../adapters/openview-queries";
import { useOpenViewAccessDenied } from "../adapters/openview-access";
import {
  queryOpenViewAggregateSnapshot,
  type OpenViewAggregateSnapshotRequest,
} from "../adapters/analytics-api";
import {
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  type OpenViewDataSource,
  type OpenViewDataSourceField,
  type OpenViewQueryDefinition,
} from "../adapters/views-api";
import type { AppliedSnapshot } from "./chart-snapshot-results";
import { ChartDefinitionForm } from "./chart-definition-form";
import { ChartFormSkeleton } from "./openview-skeletons";
import { ChartSnapshotResults } from "./chart-snapshot-results";
import {
  EMPTY_OPERATORS,
  canonicalDecimal,
  dateWindowDays,
  isCategoricalField,
  isNumericField,
  isValidInteger,
  operatorsFor,
  scalarForFilter,
  type Aggregation,
  type ChartType,
  type FilterDraft,
  type FilterLogic,
} from "../domain/chart-query";

const AUTHORIZATION_ERROR =
  "Chart data is unavailable. Sign in or ask for access, then retry.";

function fieldReference(field: OpenViewDataSourceField) {
  return { fieldId: field.id, expectedType: field.type };
}

function formatError(error: unknown, fallback: string): string {
  return apiErrorMessage(error, fallback);
}

// Pages loaded with "Load more" extend the cached first page of one read
// (`readAt`, see readStamp; `scope` names the data source for fields). Any
// later read of that page drops them, like the former reload did. A refused
// page is recorded on the shared cached reads (recordPageDenial), so the
// refusal holds here and in every other section until a read succeeds.
type PageExtension<T> = {
  scope: string;
  readAt: number;
  items: T[];
  hasMore: boolean;
  nextOffset: number;
};

export default function ServerBackedCharts() {
  const queryClient = useQueryClient();
  // A refusal of any cached OpenView read hides them all (openview-access.ts).
  const accessDenied = useOpenViewAccessDenied();
  const sourcesQuery = useQuery(catalogFirstPageOptions());
  const [sourcesExtension, setSourcesExtension] =
    useState<PageExtension<OpenViewDataSource> | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const [metadataRetryTarget, setMetadataRetryTarget] = useState<
    "sources" | "fields" | null
  >(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [chosenModuleId, setChosenModuleId] = useState<string | null>(null);
  const [fieldsExtension, setFieldsExtension] =
    useState<PageExtension<OpenViewDataSourceField> | null>(null);
  const [invalidationRevision, setInvalidationRevision] = useState(0);
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [dimensionId, setDimensionId] = useState("");
  const [dateFieldId, setDateFieldId] = useState("");
  const [aggregation, setAggregation] = useState<Aggregation>("count");
  const [measureId, setMeasureId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [top, setTop] = useState("");
  const [filters, setFilters] = useState<FilterDraft[]>([]);
  const [filterLogic, setFilterLogic] = useState<FilterLogic>("and");
  const [showLegend, setShowLegend] = useState(true);
  const [showValues, setShowValues] = useState(true);
  const [filterSequence, setFilterSequence] = useState(0);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [applied, setApplied] = useState<AppliedSnapshot | null>(null);
  const [tablePage, setTablePage] = useState(0);
  const [tablePageSize, setTablePageSize] = useState(25);
  const appliedRef = useRef<AppliedSnapshot | null>(null);
  const appliedRequestSequence = useRef(0);
  const consumedInvalidationRevision = useRef(0);

  useEffect(() => {
    appliedRef.current = applied;
  }, [applied]);

  // The data-source catalog: the cached first page plus loaded pages.
  const sourcesBase = sourcesQuery.data;
  const sourcesReadAt = readStamp(sourcesQuery);
  const sourcesMore =
    sourcesExtension && extendsRead(sourcesExtension.readAt, sourcesQuery)
      ? sourcesExtension
      : null;
  const sourcesLoadError = sourcesQuery.isFetching ? null : sourcesQuery.error;
  const sourcesDenied =
    accessDenied || isAuthorizationDenied(sourcesQuery.error);
  const sources = sourcesDenied
    ? []
    : [...(sourcesBase?.items ?? []), ...(sourcesMore?.items ?? [])];
  const sourcesHasMore = sourcesDenied
    ? false
    : sourcesMore
      ? sourcesMore.hasMore
      : (sourcesBase?.pagination.hasMore ?? false);
  const sourcesNextOffset = sourcesMore
    ? sourcesMore.nextOffset
    : (sourcesBase?.pagination.count ?? 0);
  const sourcesLoading = sourcesQuery.isFetching;
  const sourcesError = sourcesDenied
    ? AUTHORIZATION_ERROR
    : sourcesLoadError
      ? formatError(
          sourcesLoadError,
          "The OpenView data-source catalog could not be loaded.",
        )
      : "";

  // Chart settings are not saved: they last while this page is open.
  const moduleId =
    chosenModuleId && sources.some((source) => source.id === chosenModuleId)
      ? chosenModuleId
      : (sources[0]?.id ?? "");

  // Fields of the chosen data source: the cached first page plus loaded pages.
  const fieldsQuery = useQuery(fieldsFirstPageOptions(moduleId));
  const fieldsBase = moduleId ? fieldsQuery.data : undefined;
  const fieldsReadAt = moduleId ? readStamp(fieldsQuery) : 0;
  const fieldsMore =
    fieldsExtension &&
    moduleId &&
    fieldsExtension.scope === moduleId &&
    extendsRead(fieldsExtension.readAt, fieldsQuery)
      ? fieldsExtension
      : null;
  const fieldsLoadError =
    moduleId && !fieldsQuery.isFetching ? fieldsQuery.error : null;
  const fieldsDenied =
    accessDenied ||
    (Boolean(moduleId) && isAuthorizationDenied(fieldsQuery.error));
  const fields = fieldsDenied
    ? []
    : [...(fieldsBase?.items ?? []), ...(fieldsMore?.items ?? [])];
  const fieldsReady = Boolean(fieldsBase) && !fieldsDenied;
  const fieldsHasMore = fieldsMore
    ? fieldsMore.hasMore
    : (fieldsBase?.pagination.hasMore ?? false);
  const fieldsNextOffset = fieldsMore
    ? fieldsMore.nextOffset
    : (fieldsBase?.pagination.count ?? 0);
  const fieldsLoading = Boolean(moduleId) && fieldsQuery.isFetching;
  // While data sources are refused, their alert carries the one message.
  const fieldsError = sourcesDenied
    ? ""
    : fieldsDenied
      ? AUTHORIZATION_ERROR
      : fieldsLoadError
        ? formatError(
            fieldsLoadError,
            "The data-source fields could not be loaded.",
          )
        : "";

  // A denied read withdraws the applied chart, as every read did before.
  const readDenied = sourcesDenied || fieldsDenied;
  useEffect(() => {
    if (!readDenied) return;
    setApplied(null);
    appliedRef.current = null;
    setQueryError(AUTHORIZATION_ERROR);
  }, [readDenied]);

  // Applied snapshots are not cached reads; they refresh through this
  // counter. The catalog and fields refresh through OpenViewQuerySync.
  useEffect(() => {
    return subscribeOpenViewInvalidations((event) => {
      if (event.type === "resync" || invalidatesRecords(event.entity))
        setInvalidationRevision((value) => value + 1);
    });
  }, []);

  const sourceName =
    sources.find((source) => source.id === moduleId)?.name ?? "Data source";
  const moduleFields = fieldsReady ? fields : [];
  const categoryFields = moduleFields.filter(isCategoricalField);
  const dateFields = moduleFields.filter((field) =>
    ["date", "datetime"].includes(field.type),
  );
  const numericFields = moduleFields.filter(isNumericField);
  const filterFields = moduleFields;
  const dateSeries = chartType === "line";
  const selectedDimension =
    categoryFields.find((field) => field.id === dimensionId) ??
    categoryFields[0];
  const selectedDateField =
    dateFields.find((field) => field.id === dateFieldId) ??
    (dateSeries ? dateFields[0] : undefined);
  const selectedMeasure =
    numericFields.find((field) => field.id === measureId) ?? numericFields[0];
  const requestedDays = dateWindowDays(fromDate, toDate);
  const dateWindowValid = requestedDays >= 1 && requestedDays <= 366;
  const categoricalDateWindowSelected = Boolean(
    !dateSeries && (fromDate || toDate),
  );
  const dateWindowReady = dateSeries
    ? Boolean(selectedDateField && dateWindowValid)
    : !categoricalDateWindowSelected ||
      Boolean(selectedDateField && dateWindowValid);

  const filterValidation = filters.find((filter) => {
    const field = filterFields.find(
      (candidate) => candidate.id === filter.fieldId,
    );
    if (!field || !operatorsFor(field).includes(filter.operator)) return true;
    if (EMPTY_OPERATORS.has(filter.operator)) return false;
    if (!filter.value.trim()) return true;
    if (field.type === "decimal")
      return canonicalDecimal(filter.value) === null;
    if (field.type === "int") return !isValidInteger(filter.value);
    return field.type === "number" && !Number.isFinite(Number(filter.value));
  });
  const canRunQuery = Boolean(
    !sourcesLoading &&
    !sourcesError &&
    sources.some((source) => source.id === moduleId) &&
    !fieldsLoading &&
    !fieldsError &&
    moduleFields.length > 0 &&
    (dateSeries ? selectedDateField && dateWindowReady : selectedDimension) &&
    dateWindowReady &&
    (aggregation === "count" || selectedMeasure) &&
    !filterValidation &&
    !queryLoading,
  );

  const draftSignature = JSON.stringify({
    moduleId,
    chartType,
    dimensionId: dateSeries ? null : selectedDimension?.id,
    dateFieldId: selectedDateField?.id ?? null,
    aggregation,
    measureId: aggregation === "count" ? null : selectedMeasure?.id,
    filterLogic,
    fromDate: dateSeries || categoricalDateWindowSelected ? fromDate : null,
    toDate: dateSeries || categoricalDateWindowSelected ? toDate : null,
    filters,
    top: dateSeries ? null : top,
    showLegend,
    showValues,
  });

  async function loadMoreSources() {
    if (metadataLoading || !sourcesHasMore) return;
    setMetadataLoading(true);
    setMetadataError("");
    setMetadataRetryTarget(null);
    const readAt = sourcesReadAt;
    const loaded = sourcesMore?.items ?? [];
    try {
      const page = await listOpenViewDataSources({
        limit: 100,
        offset: sourcesNextOffset,
      });
      setSourcesExtension({
        scope: "",
        readAt,
        items: [...loaded, ...page.items],
        hasMore: page.pagination.hasMore,
        nextOffset: sourcesNextOffset + page.pagination.count,
      });
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        void recordPageDenial(queryClient, [openViewKeys.catalog], error);
      } else {
        setMetadataError(
          formatError(error, "More data sources could not be loaded."),
        );
      }
      setMetadataRetryTarget("sources");
    } finally {
      setMetadataLoading(false);
    }
  }

  async function loadMoreFields() {
    if (metadataLoading || !fieldsHasMore || !moduleId) return;
    setMetadataLoading(true);
    setMetadataError("");
    setMetadataRetryTarget(null);
    const readAt = fieldsReadAt;
    const loaded = fieldsMore?.items ?? [];
    try {
      const page = await listOpenViewDataSourceFields(moduleId, {
        limit: 100,
        offset: fieldsNextOffset,
      });
      setFieldsExtension({
        scope: moduleId,
        readAt,
        items: [...loaded, ...page.items],
        hasMore: page.pagination.hasMore,
        nextOffset: fieldsNextOffset + page.pagination.count,
      });
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        void recordPageDenial(queryClient, moduleFieldKeys(moduleId), error);
      } else {
        setMetadataError(
          formatError(error, "More data-source fields could not be loaded."),
        );
      }
      setMetadataRetryTarget("fields");
    } finally {
      setMetadataLoading(false);
    }
  }

  async function applySnapshot(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!canRunQuery || !moduleId) return;
    const definition: OpenViewQueryDefinition = {
      version: 1,
      logic: filterLogic,
      columns: [],
      filters: filters.map((filter) => {
        const field = filterFields.find(
          (candidate) => candidate.id === filter.fieldId,
        );
        if (!field)
          throw new Error("Choose an available field for every filter.");
        return {
          fieldId: field.id,
          expectedType: field.type,
          operator: filter.operator,
          ...(EMPTY_OPERATORS.has(filter.operator)
            ? {}
            : { value: scalarForFilter(field, filter.value) }),
        };
      }),
      sort: [],
      deleted: "exclude",
      search: null,
      searchFields: [],
    };
    const request: OpenViewAggregateSnapshotRequest = dateSeries
      ? {
          moduleId,
          definition,
          mode: "date_series",
          dateField: fieldReference(selectedDateField!),
          fromDate,
          toDate,
          aggregation,
          ...(aggregation === "count"
            ? {}
            : { measure: fieldReference(selectedMeasure!) }),
        }
      : {
          moduleId,
          definition,
          mode: "groups",
          dimension: fieldReference(selectedDimension!),
          ...(categoricalDateWindowSelected
            ? {
                dateField: fieldReference(selectedDateField!),
                fromDate,
                toDate,
              }
            : {}),
          aggregation,
          ...(aggregation === "count"
            ? {}
            : { measure: fieldReference(selectedMeasure!) }),
        };
    const requestSequence = ++appliedRequestSequence.current;
    setQueryLoading(true);
    setQueryError("");
    try {
      const result = await queryOpenViewAggregateSnapshot(request);
      if (requestSequence !== appliedRequestSequence.current) return;
      const appliedChartType = chartType;
      const labelName = dateSeries
        ? selectedDateField!.name
        : selectedDimension!.name;
      const valueName =
        aggregation === "count" ? "Records" : selectedMeasure!.name;
      setApplied({
        result,
        request,
        sourceName,
        chartType: appliedChartType,
        labelName,
        valueName,
        aggregationName:
          aggregation === "average" ? "Average" : titleCase(aggregation),
        signature: draftSignature,
      });
      setTablePage(0);
    } catch (error) {
      if (requestSequence !== appliedRequestSequence.current) return;
      if (isAuthorizationDenied(error)) {
        setApplied(null);
        appliedRef.current = null;
        setQueryError(AUTHORIZATION_ERROR);
        return;
      }
      setQueryError(
        formatError(
          error,
          "The aggregate snapshot could not be loaded. Try again.",
        ),
      );
    } finally {
      if (requestSequence === appliedRequestSequence.current)
        setQueryLoading(false);
    }
  }

  function addFilter() {
    if (filters.length >= 10) return;
    const field = filterFields[0];
    if (!field) return;
    setFilters((current) => [
      ...current,
      { id: filterSequence, fieldId: field.id, operator: "eq", value: "" },
    ]);
    setFilterSequence((current) => current + 1);
  }

  useEffect(() => {
    if (
      invalidationRevision <= consumedInvalidationRevision.current ||
      queryLoading
    )
      return;
    consumedInvalidationRevision.current = invalidationRevision;
    const current = appliedRef.current;
    if (!current) return;
    const requestSequence = ++appliedRequestSequence.current;
    setQueryLoading(true);
    setQueryError("");
    void queryOpenViewAggregateSnapshot(current.request)
      .then((result) => {
        if (requestSequence !== appliedRequestSequence.current) return;
        if (
          appliedRef.current?.signature !== current.signature ||
          appliedRef.current.request !== current.request
        )
          return;
        setApplied((previous) =>
          previous?.request === current.request
            ? { ...previous, result }
            : previous,
        );
        setTablePage(0);
      })
      .catch((error: unknown) => {
        if (requestSequence !== appliedRequestSequence.current) return;
        if (isAuthorizationDenied(error)) {
          setApplied(null);
          appliedRef.current = null;
          setQueryError(AUTHORIZATION_ERROR);
        } else {
          setQueryError(
            "The applied chart could not be refreshed. Showing the last loaded snapshot.",
          );
        }
      })
      .finally(() => {
        if (requestSequence === appliedRequestSequence.current)
          setQueryLoading(false);
      });
  }, [invalidationRevision, queryLoading]);

  // A denied read hides the applied chart in the same render; the effect
  // above then clears it.
  const visibleApplied = readDenied ? null : applied;
  const appliedResult = visibleApplied?.result ?? null;
  // Only a first visit waits for the setup reads; a cached revisit renders
  // the form at once, and a retry after a failure keeps the form and its
  // retry alert in place.
  const chartSetupColdLoad = sourcesQuery.isPending && sourcesQuery.isFetching;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3 sm:gap-4 print:hidden">
        <div className="min-w-0">
          <h1
            data-slot="page-title"
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            Charts
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Ask a question about your records.
          </p>
        </div>
      </header>

      <LoadingRegion
        loading={chartSetupColdLoad}
        label="Loading the authorized data-source catalog…"
        skeleton={<ChartFormSkeleton />}
      >
        <ChartDefinitionForm
          catalog={{
            sources,
            sourcesLoading,
            sourcesError,
            sourcesHasMore,
            fieldsLoading,
            fieldsError,
            fieldsHasMore,
            metadataError,
            metadataRetryTarget,
            metadataLoading,
            sourceName,
            categoryFields,
            dateFields,
            numericFields,
            filterFields,
          }}
          draft={{
            moduleId,
            chartType,
            dateSeries,
            selectedDateField,
            selectedDimension,
            dateFieldId,
            aggregation,
            selectedMeasure,
            fromDate,
            toDate,
            dateWindowValid,
            top,
            filters,
            filterLogic,
            filterValidation,
            showLegend,
            showValues,
            queryLoading,
            canRunQuery,
          }}
          actions={{
            retryCatalog: () => {
              setSourcesExtension(null);
              void sourcesQuery.refetch();
            },
            retryFields: () => {
              setFieldsExtension(null);
              void fieldsQuery.refetch();
            },
            loadMoreSources,
            loadMoreFields,
            setModuleId: (nextModuleId) => {
              setChosenModuleId(nextModuleId);
              setFilters([]);
            },
            setChartType,
            setDateFieldId,
            setDimensionId,
            setAggregation,
            setMeasureId,
            setFromDate,
            setToDate,
            setTop,
            setFilters,
            setFilterLogic,
            setShowLegend,
            setShowValues,
            addFilter,
            applySnapshot,
          }}
        />
      </LoadingRegion>

      {/* While a read is refused, the data-source alert already says so
          and offers Retry; one message, not two. */}
      {queryError && !(readDenied && queryError === AUTHORIZATION_ERROR) ? (
        <Alert
          role="alert"
          variant="destructive"
          className="flex flex-wrap items-center justify-between gap-3 print:hidden"
        >
          <span>
            {queryError}
            {appliedResult
              ? " Showing the last successful snapshot."
              : " No aggregate snapshot has been applied yet."}
          </span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={queryLoading || !canRunQuery}
            onClick={() => void applySnapshot()}
          >
            {queryLoading ? "Retrying…" : "Retry chart query"}
          </Button>
        </Alert>
      ) : null}

      <ChartSnapshotResults
        applied={visibleApplied}
        draftSignature={draftSignature}
        top={top}
        showValues={showValues}
        showLegend={showLegend}
        tablePage={tablePage}
        tablePageSize={tablePageSize}
        setTablePage={setTablePage}
        setTablePageSize={setTablePageSize}
      />
    </div>
  );
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
