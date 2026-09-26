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
import { ApiError } from "@/lib/api";
import {
  getOpenViewChartPreferences,
  putOpenViewChartPreferences,
  type OpenViewChartPreferenceConfig,
} from "../adapters/chart-preferences-api";
import { subscribeOpenViewInvalidations } from "../adapters/invalidation-events";
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

function isAuthorizationDenied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403].includes(error.status);
}

const AUTHORIZATION_ERROR =
  "Chart data is unavailable. Sign in or ask for access, then retry.";

function fieldReference(field: OpenViewDataSourceField) {
  return { fieldId: field.id, expectedType: field.type };
}

function formatError(error: unknown, fallback: string): string {
  return messageFor(error, fallback);
}

export default function ServerBackedCharts() {
  const [sources, setSources] = useState<OpenViewDataSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState("");
  const [sourcesHasMore, setSourcesHasMore] = useState(false);
  const [sourcesNextOffset, setSourcesNextOffset] = useState(0);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [metadataError, setMetadataError] = useState("");
  const [metadataRetryTarget, setMetadataRetryTarget] = useState<
    "sources" | "fields" | null
  >(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [moduleId, setModuleId] = useState("");
  const [fields, setFields] = useState<OpenViewDataSourceField[]>([]);
  const [fieldsForModule, setFieldsForModule] = useState("");
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsError, setFieldsError] = useState("");
  const [fieldsHasMore, setFieldsHasMore] = useState(false);
  const [fieldsNextOffset, setFieldsNextOffset] = useState(0);
  const [fieldsRetry, setFieldsRetry] = useState(0);
  const [preferenceConfig, setPreferenceConfig] =
    useState<OpenViewChartPreferenceConfig | null>(null);
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [preferencesRetry, setPreferencesRetry] = useState(0);
  const [preferencesError, setPreferencesError] = useState("");
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [preferencesNotice, setPreferencesNotice] = useState("");
  const [settingsDenied, setSettingsDenied] = useState(false);
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
  const preferredSourceResolved = useRef(false);

  useEffect(() => {
    appliedRef.current = applied;
  }, [applied]);

  useEffect(() => {
    let active = true;
    setPreferencesLoading(true);
    setPreferencesError("");
    void getOpenViewChartPreferences()
      .then(({ config }) => {
        if (!active) return;
        setPreferencesLoaded(true);
        setPreferenceConfig(config);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPreferencesLoaded(false);
        if (isAuthorizationDenied(error)) {
          setSettingsDenied(true);
          setApplied(null);
          appliedRef.current = null;
          setQueryError(AUTHORIZATION_ERROR);
          setPreferencesError(
            "Chart settings are unavailable. Sign in or ask for access, then retry.",
          );
        } else {
          setPreferencesError(
            formatError(error, "Saved chart settings could not be loaded."),
          );
        }
      })
      .finally(() => {
        if (active) setPreferencesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [preferencesRetry]);

  useEffect(() => {
    return subscribeOpenViewInvalidations((event) => {
      const relevant =
        event.type === "resync" ||
        [
          "records",
          "relationships",
          "fields",
          "modules",
          "departments",
          "workspace_profiles",
        ].includes(event.entity);
      if (!relevant) return;
      setInvalidationRevision((value) => value + 1);
      if (
        event.type === "resync" ||
        ["fields", "modules", "departments", "workspace_profiles"].includes(
          event.entity,
        )
      ) {
        setCatalogRetry((value) => value + 1);
        setFieldsRetry((value) => value + 1);
      }
    });
  }, []);

  useEffect(() => {
    if (preferencesLoading || sourcesLoading || preferredSourceResolved.current)
      return;
    preferredSourceResolved.current = true;
    const preferredSource = preferenceConfig
      ? sources.find((source) => source.id === preferenceConfig.moduleId)
      : undefined;
    if (preferredSource) setModuleId(preferenceConfig!.moduleId);
    else if (preferenceConfig)
      setPreferencesError(
        "Saved chart settings refer to a data source you can no longer access.",
      );
  }, [preferenceConfig, preferencesLoading, sources, sourcesLoading]);

  useEffect(() => {
    if (
      preferencesLoading ||
      !preferenceConfig ||
      preferenceConfig.moduleId !== moduleId ||
      fieldsForModule !== moduleId
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
  }, [fieldsForModule, moduleId, preferenceConfig, preferencesLoading]);

  useEffect(() => {
    let active = true;
    setSourcesLoading(true);
    setSourcesError("");
    void listOpenViewDataSources({ limit: 100, offset: 0 })
      .then((page) => {
        if (!active) return;
        setSources(page.items);
        setSourcesHasMore(page.pagination.hasMore);
        setSourcesNextOffset(page.pagination.count);
        setModuleId((current) =>
          page.items.some((source) => source.id === current)
            ? current
            : (page.items[0]?.id ?? ""),
        );
      })
      .catch((error: unknown) => {
        if (active && isAuthorizationDenied(error)) {
          setSources([]);
          setSourcesHasMore(false);
          setSourcesNextOffset(0);
          setFields([]);
          setFieldsForModule("");
          setApplied(null);
          appliedRef.current = null;
          setQueryError(AUTHORIZATION_ERROR);
          setSourcesError(AUTHORIZATION_ERROR);
          return;
        }
        if (active)
          setSourcesError(
            formatError(
              error,
              "The OpenView data-source catalog could not be loaded.",
            ),
          );
      })
      .finally(() => {
        if (active) setSourcesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [catalogRetry]);

  useEffect(() => {
    if (!moduleId) {
      setFields([]);
      setFieldsForModule("");
      setFieldsHasMore(false);
      return;
    }
    let active = true;
    setFieldsLoading(true);
    setFieldsError("");
    setFields([]);
    setFieldsForModule("");
    setFieldsHasMore(false);
    setFieldsNextOffset(0);
    void listOpenViewDataSourceFields(moduleId, { limit: 100, offset: 0 })
      .then((page) => {
        if (!active) return;
        setFields(page.items);
        setFieldsForModule(moduleId);
        setFieldsHasMore(page.pagination.hasMore);
        setFieldsNextOffset(page.pagination.count);
      })
      .catch((error: unknown) => {
        if (active && isAuthorizationDenied(error)) {
          setFields([]);
          setFieldsForModule("");
          setApplied(null);
          appliedRef.current = null;
          setQueryError(AUTHORIZATION_ERROR);
          setFieldsError(AUTHORIZATION_ERROR);
          return;
        }
        if (active)
          setFieldsError(
            formatError(error, "The data-source fields could not be loaded."),
          );
      })
      .finally(() => {
        if (active) setFieldsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [moduleId, fieldsRetry]);

  const sourceName =
    sources.find((source) => source.id === moduleId)?.name ?? "Data source";
  const moduleFields = fieldsForModule === moduleId ? fields : [];
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
    fieldsForModule === moduleId &&
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
    try {
      const page = await listOpenViewDataSources({
        limit: 100,
        offset: sourcesNextOffset,
      });
      setSources((current) => [...current, ...page.items]);
      setSourcesHasMore(page.pagination.hasMore);
      setSourcesNextOffset((current) => current + page.pagination.count);
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        setSources([]);
        setSourcesHasMore(false);
        setFields([]);
        setFieldsForModule("");
        setApplied(null);
        appliedRef.current = null;
        setQueryError(AUTHORIZATION_ERROR);
        setSourcesError(AUTHORIZATION_ERROR);
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
    try {
      const page = await listOpenViewDataSourceFields(moduleId, {
        limit: 100,
        offset: fieldsNextOffset,
      });
      setFields((current) => [...current, ...page.items]);
      setFieldsHasMore(page.pagination.hasMore);
      setFieldsNextOffset((current) => current + page.pagination.count);
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        setFields([]);
        setFieldsForModule("");
        setApplied(null);
        appliedRef.current = null;
        setQueryError(AUTHORIZATION_ERROR);
        setFieldsError(AUTHORIZATION_ERROR);
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
    setPreferencesError("");
    setPreferencesNotice("");
    try {
      const response = await putOpenViewChartPreferences(config);
      const confirmedConfig = response.config ?? config;
      hydratedPreferenceKey.current =
        draftSignatureRef.current === submittedDraftSignature
          ? ""
          : JSON.stringify(confirmedConfig);
      setPreferenceConfig(confirmedConfig);
      setPreferencesLoaded(true);
      setSettingsDenied(false);
      setPreferencesNotice(successMessage);
    } catch (error) {
      if (isAuthorizationDenied(error)) {
        setSettingsDenied(true);
        setApplied(null);
        appliedRef.current = null;
        setQueryError(AUTHORIZATION_ERROR);
        setPreferencesError(
          "Chart settings could not be saved without current access.",
        );
      } else {
        setPreferencesError(
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

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3 sm:gap-4 print:hidden">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Charts
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Ask a question about your records.
          </p>
        </div>
      </header>

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
          retryPreferences: () => setPreferencesRetry((value) => value + 1),
          retryCatalog: () => setCatalogRetry((value) => value + 1),
          retryFields: () => setFieldsRetry((value) => value + 1),
          loadMoreSources,
          loadMoreFields,
          setModuleId: (nextModuleId) => {
            setModuleId(nextModuleId);
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
