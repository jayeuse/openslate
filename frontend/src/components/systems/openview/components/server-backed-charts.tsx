"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  putOpenViewChartPreferences,
  type OpenViewChartPreferenceConfig,
} from "../adapters/chart-preferences-api";
import { subscribeOpenViewInvalidations } from "../adapters/invalidation-events";
import {
  catalogFirstPageOptions,
  chartPreferencesOptions,
  fieldsFirstPageOptions,
  invalidatesRecords,
  isAuthorizationDenied,
} from "../adapters/openview-queries";
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

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const AUTHORIZATION_ERROR =
  "Chart data is unavailable. Sign in or ask for access, then retry.";

function fieldReference(field: OpenViewDataSourceField) {
  return { fieldId: field.id, expectedType: field.type };
}

function formatError(error: unknown, fallback: string): string {
  return messageFor(error, fallback);
}

// Pages loaded with "Load more" extend the cached first page they follow. A
// refetch replaces that page and drops them, like the former reload did.
type PageExtension<T> = {
  base: unknown;
  items: T[];
  hasMore: boolean;
  nextOffset: number;
  denied: boolean;
};

export default function ServerBackedCharts() {
  const queryClient = useQueryClient();
  const preferencesQuery = useQuery(chartPreferencesOptions());
  const sourcesQuery = useQuery(catalogFirstPageOptions());
  const [sourcesExtension, setSourcesExtension] =
    useState<PageExtension<OpenViewDataSource> | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const [metadataRetryTarget, setMetadataRetryTarget] = useState<
    "sources" | "fields" | null
  >(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [chosenModuleId, setChosenModuleId] = useState<string | null>(null);
  const [preferredSourceResolved, setPreferredSourceResolved] = useState(false);
  const [fieldsExtension, setFieldsExtension] =
    useState<PageExtension<OpenViewDataSourceField> | null>(null);
  const [preferenceMessage, setPreferenceMessage] = useState("");
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [preferencesNotice, setPreferencesNotice] = useState("");
  const [saveDenied, setSaveDenied] = useState<boolean | null>(null);
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
  const hydratedPreferenceKey = useRef("");
  // A confirmed save asks the form to re-apply the saved settings. The cache
  // keeps one identity for equal settings, so a repeated Reset needs this
  // explicit request to restore controls edited since the last one.
  const [preferenceHydration, setPreferenceHydration] = useState(0);

  useEffect(() => {
    appliedRef.current = applied;
  }, [applied]);

  // Saved settings. A retry in flight clears the last failure message.
  const preferencesLoading =
    preferencesQuery.isFetching && preferencesQuery.data === undefined;
  const preferencesLoaded = preferencesQuery.data !== undefined;
  const preferenceConfig = preferencesQuery.data?.config ?? null;
  const preferencesLoadError = preferencesQuery.isFetching
    ? null
    : preferencesQuery.error;
  const preferencesLoadDenied = isAuthorizationDenied(preferencesLoadError);
  const settingsDenied = saveDenied ?? preferencesLoadDenied;
  const preferencesError =
    preferenceMessage ||
    (preferencesLoadError
      ? preferencesLoadDenied
        ? "Chart settings are unavailable. Sign in or ask for access, then retry."
        : formatError(
            preferencesLoadError,
            "Saved chart settings could not be loaded.",
          )
      : "");

  // The data-source catalog: the cached first page plus loaded pages.
  const sourcesBase = sourcesQuery.data;
  const sourcesMore =
    sourcesExtension && sourcesExtension.base === sourcesBase
      ? sourcesExtension
      : null;
  const sourcesLoadError = sourcesQuery.isFetching ? null : sourcesQuery.error;
  const sourcesDenied =
    isAuthorizationDenied(sourcesLoadError) || Boolean(sourcesMore?.denied);
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

  // Saved settings choose the first data source once both reads settle,
  // during render so a cached revisit never loads another source first.
  if (
    !preferredSourceResolved &&
    !preferencesLoading &&
    !preferencesQuery.isPending &&
    !sourcesQuery.isPending
  ) {
    setPreferredSourceResolved(true);
    if (
      preferenceConfig &&
      sources.some((source) => source.id === preferenceConfig.moduleId)
    )
      setChosenModuleId(preferenceConfig.moduleId);
    else if (preferenceConfig)
      setPreferenceMessage(
        "Saved chart settings refer to a data source you can no longer access.",
      );
  }
  const moduleId =
    chosenModuleId && sources.some((source) => source.id === chosenModuleId)
      ? chosenModuleId
      : (sources[0]?.id ?? "");

  // Fields of the chosen data source: the cached first page plus loaded pages.
  const fieldsQuery = useQuery(fieldsFirstPageOptions(moduleId));
  const fieldsBase = moduleId ? fieldsQuery.data : undefined;
  const fieldsMore =
    fieldsExtension && fieldsBase && fieldsExtension.base === fieldsBase
      ? fieldsExtension
      : null;
  const fieldsLoadError =
    moduleId && !fieldsQuery.isFetching ? fieldsQuery.error : null;
  const fieldsDenied =
    isAuthorizationDenied(fieldsLoadError) || Boolean(fieldsMore?.denied);
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
  const fieldsError = fieldsDenied
    ? AUTHORIZATION_ERROR
    : fieldsLoadError
      ? formatError(
          fieldsLoadError,
          "The data-source fields could not be loaded.",
        )
      : "";

  // A denied read withdraws the applied chart, as every read did before.
  const readDenied = preferencesLoadDenied || sourcesDenied || fieldsDenied;
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

  // Layout effect: a cached revisit paints the saved settings, not defaults.
  useLayoutEffect(() => {
    if (
      preferencesLoading ||
      !preferenceConfig ||
      preferenceConfig.moduleId !== moduleId ||
      !fieldsReady
    )
      return;
    const key = JSON.stringify(preferenceConfig);
    if (hydratedPreferenceKey.current === key) return;
    hydratedPreferenceKey.current = key;
    setChartType(preferenceConfig.chartType);
    setDimensionId(preferenceConfig.dimensionId ?? "");
    setDateFieldId(preferenceConfig.dateFieldId ?? "");
    setAggregation(preferenceConfig.aggregation);
    setMeasureId(preferenceConfig.measureId ?? "");
    setFilterLogic(preferenceConfig.filterLogic);
    setFromDate(preferenceConfig.fromDate ?? "");
    setToDate(preferenceConfig.toDate ?? "");
    setTop(preferenceConfig.top?.toString() ?? "");
    setShowLegend(preferenceConfig.showLegend);
    setShowValues(preferenceConfig.showValues);
    setFilters(
      preferenceConfig.filters.map((filter, index) => ({
        id: index,
        fieldId: filter.fieldId,
        operator: filter.operator,
        value: Array.isArray(filter.value)
          ? filter.value.join(", ")
          : String(filter.value ?? ""),
      })),
    );
    setFilterSequence(preferenceConfig.filters.length);
  }, [
    fieldsReady,
    moduleId,
    preferenceConfig,
    preferenceHydration,
    preferencesLoading,
  ]);

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

  const preferenceConfigDraft: OpenViewChartPreferenceConfig | null =
    moduleId &&
    sources.some((source) => source.id === moduleId) &&
    fieldsReady &&
    !filterValidation &&
    dateWindowReady &&
    (dateSeries ? selectedDateField && dateWindowValid : selectedDimension) &&
    (aggregation === "count" || selectedMeasure)
      ? {
          version: 1,
          moduleId,
          chartType,
          dimensionId: dateSeries ? null : selectedDimension!.id,
          dateFieldId: selectedDateField?.id ?? null,
          aggregation,
          measureId: aggregation === "count" ? null : selectedMeasure!.id,
          filterLogic,
          filters: filters.map((filter) => {
            const field = filterFields.find(
              (candidate) => candidate.id === filter.fieldId,
            )!;
            return {
              fieldId: field.id,
              expectedType: field.type,
              operator: filter.operator,
              ...(EMPTY_OPERATORS.has(filter.operator)
                ? {}
                : { value: scalarForFilter(field, filter.value) }),
            };
          }),
          fromDate:
            dateSeries || categoricalDateWindowSelected ? fromDate : null,
          toDate: dateSeries || categoricalDateWindowSelected ? toDate : null,
          top: dateSeries
            ? null
            : top
              ? (Number(top) as NonNullable<
                  OpenViewChartPreferenceConfig["top"]
                >)
              : null,
          showLegend,
          showValues,
        }
      : null;

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
  const draftSignatureRef = useRef(draftSignature);
  useLayoutEffect(() => {
    draftSignatureRef.current = draftSignature;
  }, [draftSignature]);

  async function loadMoreSources() {
    if (metadataLoading || !sourcesHasMore) return;
    setMetadataLoading(true);
    setMetadataError("");
    setMetadataRetryTarget(null);
    const base = sourcesBase;
    const loaded = sourcesMore?.items ?? [];
    try {
      const page = await listOpenViewDataSources({
        limit: 100,
        offset: sourcesNextOffset,
      });
      setSourcesExtension({
        base,
        items: [...loaded, ...page.items],
        hasMore: page.pagination.hasMore,
        nextOffset: sourcesNextOffset + page.pagination.count,
        denied: false,
      });
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        setSourcesExtension({
          base,
          items: [],
          hasMore: false,
          nextOffset: sourcesNextOffset,
          denied: true,
        });
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
    const base = fieldsBase;
    const loaded = fieldsMore?.items ?? [];
    try {
      const page = await listOpenViewDataSourceFields(moduleId, {
        limit: 100,
        offset: fieldsNextOffset,
      });
      setFieldsExtension({
        base,
        items: [...loaded, ...page.items],
        hasMore: page.pagination.hasMore,
        nextOffset: fieldsNextOffset + page.pagination.count,
        denied: false,
      });
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        setFieldsExtension({
          base,
          items: [],
          hasMore: false,
          nextOffset: fieldsNextOffset,
          denied: true,
        });
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

  async function persistPreference(
    config: OpenViewChartPreferenceConfig,
    successMessage: string,
  ) {
    if (preferencesSaving) return;
    const submittedDraftSignature = draftSignatureRef.current;
    setPreferencesSaving(true);
    setPreferenceMessage("");
    setPreferencesNotice("");
    try {
      const response = await putOpenViewChartPreferences(config);
      const confirmedConfig = response.config ?? config;
      hydratedPreferenceKey.current =
        draftSignatureRef.current === submittedDraftSignature
          ? ""
          : JSON.stringify(confirmedConfig);
      queryClient.setQueryData(chartPreferencesOptions().queryKey, {
        config: confirmedConfig,
      });
      setPreferenceHydration((value) => value + 1);
      setSaveDenied(false);
      setPreferencesNotice(successMessage);
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        setSaveDenied(true);
        setApplied(null);
        appliedRef.current = null;
        setQueryError(AUTHORIZATION_ERROR);
        setPreferenceMessage(
          "Chart settings could not be saved without current access.",
        );
      } else {
        setPreferenceMessage(
          formatError(error, "Chart settings could not be saved."),
        );
      }
    } finally {
      setPreferencesSaving(false);
    }
  }

  async function saveSettings() {
    if (
      !preferencesLoaded ||
      settingsDenied ||
      preferencesLoading ||
      !preferenceConfigDraft
    )
      return;
    await persistPreference(
      preferenceConfigDraft,
      "Chart settings saved for this account.",
    );
  }

  async function resetSettings() {
    const dimension = categoryFields[0];
    const dateField = dateFields[0];
    if (
      !preferencesLoaded ||
      settingsDenied ||
      preferencesLoading ||
      !moduleId ||
      (!dimension && !dateField)
    )
      return;
    const today = new Date();
    const config: OpenViewChartPreferenceConfig = {
      version: 1,
      moduleId,
      chartType: dimension ? "bar" : "line",
      dimensionId: dimension?.id ?? null,
      dateFieldId: dimension ? null : (dateField?.id ?? null),
      aggregation: "count",
      measureId: null,
      filterLogic: "and",
      filters: [],
      fromDate: dimension
        ? null
        : new Date(today.getTime() - 29 * 86_400_000)
            .toISOString()
            .slice(0, 10),
      toDate: dimension ? null : today.toISOString().slice(0, 10),
      top: null,
      showLegend: true,
      showValues: true,
    };
    await persistPreference(config, "Chart settings reset for this account.");
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

  const appliedResult = applied?.result ?? null;
  // Only a first visit waits for the setup reads; a cached revisit renders
  // the form at once, and a retry after a failure keeps the form and its
  // retry alert in place.
  const chartSetupColdLoad =
    (sourcesQuery.isPending && sourcesQuery.isFetching) ||
    (preferencesQuery.isPending && preferencesQuery.isFetching);

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
          preferences={{
            preferencesError,
            preferencesNotice,
            preferencesLoading,
            preferencesLoaded,
            preferencesSaving,
            settingsDenied,
            preferenceConfigDraft,
          }}
          actions={{
            retryPreferences: () => {
              setPreferenceMessage("");
              void preferencesQuery.refetch();
            },
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
            saveSettings,
            resetSettings,
            applySnapshot,
          }}
        />
      </LoadingRegion>

      {queryError ? (
        <Alert
          role="alert"
          variant="warning"
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
        applied={applied}
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
