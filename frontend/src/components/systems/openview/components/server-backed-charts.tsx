"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ApiContractError } from "@/lib/api";
import { SlidersHorizontal } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { LoadingRegion } from "@/components/ui/loading-region";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
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
import { queryOpenViewAggregateSnapshot } from "../adapters/analytics-api";
import {
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  getOpenViewDataSource,
  getOpenViewDataSourceField,
  type OpenViewDataSource,
  type OpenViewDataSourceField,
} from "../adapters/views-api";
import type { AppliedSnapshot } from "./chart-snapshot-results";
import { ChartSourceEditor } from "./chart-editor/chart-source-editor";
import {
  getOpenViewChart,
  readOpenViewChart,
  chartMatchesWidget,
  type SavedChart,
} from "../adapters/charts-api";
import type { OpenViewDashboardChartConfig } from "../adapters/dashboards-api";
import { ChartFormSkeleton } from "./openview-skeletons";
import { ChartSnapshotResults } from "./chart-snapshot-results";
import { SavedChartManagement } from "./saved-chart-management";
import {
  aggregationLabel,
  chartEditorDraftFrom,
  compileChartEditorDraft,
  editorField,
  newChartEditorDraft,
  type ChartEditorDraft,
} from "../domain/chart-query";

const AUTHORIZATION_ERROR =
  "Chart data is unavailable. Sign in or ask for access, then retry.";

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
  const searchParams = useSearchParams();
  const urlChart = searchParams.get("chart");
  const [selectedSavedId, setSelectedSavedId] = useState<string | null>(null);
  const [openedChart, setOpenedChart] = useState<SavedChart | null>(null);
  const [openedMetadata, setOpenedMetadata] = useState<{
    source: OpenViewDataSource;
    fields: OpenViewDataSourceField[];
  } | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const [persistenceBusy, setPersistenceBusy] = useState(false);
  const openSequence = useRef(0);
  const loadedSavedId = useRef<string | null>(null);
  const consumedUrlChart = useRef<string | null | undefined>(undefined);
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
  const [fieldsExtension, setFieldsExtension] =
    useState<PageExtension<OpenViewDataSourceField> | null>(null);
  const [invalidationRevision, setInvalidationRevision] = useState(0);
  const [editorDraft, setEditorDraft] = useState<ChartEditorDraft | null>(null);
  const [chartId, setChartId] = useState<string | null>(null);
  const [refusedChartId, setRefusedChartId] = useState<string | null>(null);
  const [presentation, setPresentation] = useState({
    top: "",
    showLegend: true,
    showValues: true,
  });
  const { top, showLegend, showValues } = presentation;
  const displayOptionsCount =
    Number(Boolean(top)) + Number(!showLegend) + Number(!showValues);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [applied, setApplied] = useState<AppliedSnapshot | null>(null);
  const [tablePage, setTablePage] = useState(0);
  const [tablePageSize, setTablePageSize] = useState(25);
  const appliedRef = useRef<AppliedSnapshot | null>(null);
  const appliedRequestSequence = useRef(0);
  const appliedChartId = useRef<string | null>(null);
  const appliedEditedChartId = useRef<string | null>(null);
  const pendingChartId = useRef<string | null>(null);
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
  const catalogSources = sourcesDenied
    ? []
    : [...(sourcesBase?.items ?? []), ...(sourcesMore?.items ?? [])];
  const sources =
    !sourcesDenied &&
    openedMetadata &&
    !catalogSources.some((source) => source.id === openedMetadata.source.id)
      ? [...catalogSources, openedMetadata.source]
      : catalogSources;
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

  const moduleId = editorDraft?.moduleId ?? sources[0]?.id ?? "";

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
  const catalogFields = fieldsDenied
    ? []
    : [...(fieldsBase?.items ?? []), ...(fieldsMore?.items ?? [])];
  const fields =
    !fieldsDenied && openedMetadata?.source.id === moduleId
      ? [
          ...catalogFields,
          ...openedMetadata.fields.filter(
            (field) =>
              !catalogFields.some((current) => current.id === field.id),
          ),
        ]
      : catalogFields;
  const fieldsReady =
    (Boolean(fieldsBase) || openedMetadata?.source.id === moduleId) &&
    !fieldsDenied;
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
    openSequence.current += 1;
    setOpening(false);
    setOpenedChart(null);
    setOpenedMetadata(null);
    appliedRequestSequence.current += 1;
    pendingChartId.current = null;
    setQueryLoading(false);
    setApplied(null);
    appliedRef.current = null;
    setQueryError(AUTHORIZATION_ERROR);
  }, [readDenied]);

  function replaceChartUrl(id: string | null) {
    consumedUrlChart.current = id;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("chart", id);
    else url.searchParams.delete("chart");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
  const openSavedChart = useCallback(
    async (id: string, preserveDraft = false) => {
      preserveDraft = preserveDraft && loadedSavedId.current === id;
      const sequence = ++openSequence.current;
      setSelectedSavedId(id);
      setOpening(true);
      setOpenError("");
      if (!preserveDraft) {
        setOpenedChart(null);
        setOpenedMetadata(null);
        appliedRequestSequence.current += 1;
        pendingChartId.current = null;
        setApplied(null);
        appliedRef.current = null;
        setQueryLoading(false);
        replaceChartUrl(id);
      }
      try {
        const chart = await readOpenViewChart(id);
        if (sequence !== openSequence.current) return false;
        if (
          !chartMatchesWidget(chart, "chart") ||
          !("chartType" in chart.config)
        )
          throw new ApiContractError();
        const request = chart.config.query;
        const source = await getOpenViewDataSource(request.moduleId);
        if (sequence !== openSequence.current) return false;
        const definition = request.definition;
        const references = new Map(
          [
            ...(request.mode === "date_series"
              ? [request.dateField]
              : [request.dimension]),
            ...(request.measure ? [request.measure] : []),
            ...(request.mode === "groups" && request.dateField
              ? [request.dateField]
              : []),
            ...definition.columns,
            ...definition.filters,
            ...definition.sort,
            ...definition.searchFields,
          ].map((ref) => [ref.fieldId, ref]),
        );
        const fields: OpenViewDataSourceField[] = [];
        for (const ref of references.values()) {
          const field = await getOpenViewDataSourceField(
            request.moduleId,
            ref.fieldId,
          );
          if (sequence !== openSequence.current) return false;
          if (field.type !== ref.expectedType) throw new ApiContractError();
          fields.push(field);
        }
        if (sequence !== openSequence.current) return false;
        setOpenedChart(chart);
        setOpenedMetadata({ source, fields });
        loadedSavedId.current = id;
        if (!preserveDraft) {
          setEditorDraft(
            chartEditorDraftFrom({ widgetType: "chart", config: chart.config }),
          );
          setChartId(null);
          setRefusedChartId(null);
        }
        return true;
      } catch {
        if (sequence !== openSequence.current) return false;
        setOpenedChart(null);
        setOpenedMetadata(null);
        setOpenError(
          "Saved chart is unavailable. Your draft is retained; retry to check current access.",
        );
        return false;
      } finally {
        if (sequence === openSequence.current) setOpening(false);
      }
    },
    [],
  );
  useEffect(() => {
    if (consumedUrlChart.current === urlChart) return;
    consumedUrlChart.current = urlChart;
    if (urlChart) void openSavedChart(urlChart);
    else {
      openSequence.current += 1;
      setSelectedSavedId(null);
      setOpenedChart(null);
      setOpenedMetadata(null);
      setOpening(false);
      setOpenError("");
    }
  }, [urlChart, openSavedChart]);

  // Applied snapshots are not cached reads; they refresh through this
  // counter. The catalog and fields refresh through OpenViewQuerySync.
  useEffect(() => {
    return subscribeWorkspaceInvalidations((event) => {
      if (event.type === "resync" || invalidatesRecords(event.entity))
        setInvalidationRevision((value) => value + 1);
    });
  }, []);

  const sourceName =
    sources.find((source) => source.id === moduleId)?.name ?? "Data source";
  const moduleFields = fieldsReady ? fields : [];
  // A fresh unsaved chart may use the first available dimension. Once edited
  // or applied, its typed refs remain caller-owned through every metadata read.
  const editorValue =
    editorDraft ?? newChartEditorDraft(moduleId, moduleFields);
  const compiled = compileChartEditorDraft(editorValue, moduleFields);
  const chartConfig = compiled?.widgetType === "chart" ? compiled.config : null;
  const canRunQuery = Boolean(
    !sourcesLoading &&
    !sourcesError &&
    sources.some((source) => source.id === moduleId) &&
    !fieldsLoading &&
    !fieldsError &&
    (chartConfig || chartId) &&
    (!chartId || chartId !== refusedChartId) &&
    !queryLoading &&
    !opening &&
    !persistenceBusy &&
    !openError &&
    !openedChart?.isDeleted,
  );

  const draftSignature = JSON.stringify({ inline: editorValue, chartId });
  const withdrawSource = useCallback(() => {
    if (
      appliedChartId.current !== chartId &&
      pendingChartId.current !== chartId
    )
      return;
    // Refusal advances the same epoch checked after every read, including a
    // first Apply or a different source whose aggregate has not committed yet.
    appliedRequestSequence.current += 1;
    pendingChartId.current = null;
    setRefusedChartId(chartId);
    setApplied(null);
    appliedRef.current = null;
    setQueryLoading(false);
  }, [chartId]);
  useEffect(
    () => () => {
      appliedRequestSequence.current += 1;
      openSequence.current += 1;
      consumedUrlChart.current = undefined;
    },
    [],
  );

  async function currentChartConfig(
    id: string,
    sequence: number,
  ): Promise<
    | (Pick<AppliedSnapshot, "sourceName" | "labelName" | "valueName"> & {
        config: OpenViewDashboardChartConfig;
      })
    | null
  > {
    try {
      const chart = await getOpenViewChart(id);
      if (sequence !== appliedRequestSequence.current) return null;
      if (!chartMatchesWidget(chart, "chart") || !("chartType" in chart.config))
        throw new ApiContractError();
      const config = chart.config;
      return await currentChartLabels(config, sequence);
    } catch (error) {
      if (sequence === appliedRequestSequence.current) setRefusedChartId(id);
      throw error;
    }
  }

  async function currentChartLabels(
    config: OpenViewDashboardChartConfig,
    sequence: number,
  ) {
    const request = config.query;
    const dimension =
      request.mode === "date_series" ? request.dateField : request.dimension;
    const measure = request.aggregation === "count" ? null : request.measure;
    if (request.aggregation !== "count" && !measure)
      throw new ApiContractError();
    // Resolve only the referenced labels through the existing by-ID reads;
    // neither the inline catalog nor a paged catalog is this source's metadata.
    const source = await getOpenViewDataSource(request.moduleId);
    if (sequence !== appliedRequestSequence.current) return null;
    const references = new Map(
      [dimension, ...(measure ? [measure] : [])].map((ref) => [
        ref.fieldId,
        ref,
      ]),
    );
    const names = new Map<string, string>();
    for (const ref of references.values()) {
      const field = await getOpenViewDataSourceField(
        request.moduleId,
        ref.fieldId,
      );
      if (sequence !== appliedRequestSequence.current) return null;
      if (field.type !== ref.expectedType) throw new ApiContractError();
      names.set(ref.fieldId, field.name);
    }
    return {
      config,
      sourceName: source.name,
      labelName: names.get(dimension.fieldId)!,
      valueName: measure ? names.get(measure.fieldId)! : "Records",
    };
  }

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

  async function applySnapshot() {
    if (!canRunQuery) return;
    setEditorDraft(editorValue);
    const requestSequence = ++appliedRequestSequence.current;
    pendingChartId.current = chartId;
    setQueryLoading(true);
    setQueryError("");
    try {
      const resolved = chartId
        ? await currentChartConfig(chartId, requestSequence)
        : openedChart && chartConfig
          ? await currentChartLabels(chartConfig, requestSequence)
          : null;
      const config = chartId ? resolved?.config : chartConfig;
      if (!config || requestSequence !== appliedRequestSequence.current) return;
      const request = config.query;
      const result = await queryOpenViewAggregateSnapshot(request);
      if (requestSequence !== appliedRequestSequence.current) return;
      const labelName =
        resolved?.labelName ??
        editorField(
          request.mode === "date_series"
            ? request.dateField
            : request.dimension,
          moduleFields,
        )?.name ??
        "Group";
      const valueName =
        resolved?.valueName ??
        (request.aggregation === "count"
          ? "Records"
          : (editorField(request.measure ?? null, moduleFields)?.name ??
            "Value"));
      appliedChartId.current = chartId;
      appliedEditedChartId.current = openedChart?.id ?? null;
      setApplied({
        result,
        request,
        sourceName: resolved?.sourceName ?? sourceName,
        chartType: config.chartType,
        labelName,
        valueName,
        aggregationName: aggregationLabel(request.aggregation),
        signature: draftSignature,
      });
      setTablePage(0);
    } catch (error) {
      if (requestSequence !== appliedRequestSequence.current) return;
      if (isAuthorizationDenied(error) || chartId || openedChart) {
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
      if (requestSequence === appliedRequestSequence.current) {
        pendingChartId.current = null;
        setQueryLoading(false);
      }
    }
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
    const sourceId = appliedChartId.current;
    pendingChartId.current = sourceId;
    void (async () => {
      const resolved = sourceId
        ? await currentChartConfig(sourceId, requestSequence)
        : appliedEditedChartId.current
          ? await currentChartLabels(
              {
                version: 1,
                query: current.request,
                chartType: current.chartType,
              },
              requestSequence,
            )
          : null;
      if (requestSequence !== appliedRequestSequence.current) return null;
      const request = resolved?.config.query ?? current.request;
      return {
        result: await queryOpenViewAggregateSnapshot(request),
        request,
        chartType: resolved?.config.chartType ?? current.chartType,
        sourceName: resolved?.sourceName ?? current.sourceName,
        labelName: resolved?.labelName ?? current.labelName,
        valueName: resolved?.valueName ?? current.valueName,
      };
    })()
      .then((updated) => {
        if (!updated) return;
        if (requestSequence !== appliedRequestSequence.current) return;
        if (
          appliedRef.current?.signature !== current.signature ||
          appliedRef.current.request !== current.request
        )
          return;
        setApplied((previous) =>
          previous?.request === current.request
            ? {
                ...previous,
                ...updated,
                aggregationName: aggregationLabel(updated.request.aggregation),
              }
            : previous,
        );
        setTablePage(0);
      })
      .catch((error: unknown) => {
        if (requestSequence !== appliedRequestSequence.current) return;
        if (
          isAuthorizationDenied(error) ||
          sourceId ||
          appliedEditedChartId.current
        ) {
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
        if (requestSequence === appliedRequestSequence.current) {
          pendingChartId.current = null;
          setQueryLoading(false);
        }
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

      <SavedChartManagement
        opened={readDenied ? null : openedChart}
        selectedId={selectedSavedId}
        input={
          chartId === null &&
          !sourcesLoading &&
          !sourcesError &&
          !fieldsLoading &&
          !fieldsError
            ? compiled
            : null
        }
        sourceId={chartId}
        departmentId={
          sources.find((source) => source.id === moduleId)?.departmentId
        }
        scope={JSON.stringify([draftSignature, selectedSavedId])}
        blocked={readDenied}
        loading={opening}
        error={openError}
        onOpen={openSavedChart}
        onBusy={setPersistenceBusy}
        onSaved={(chart) => {
          setOpenedChart(chart);
          setSelectedSavedId(chart.id);
          loadedSavedId.current = chart.id;
          setOpenError("");
          replaceChartUrl(chart.id);
        }}
        onArchived={(id) => {
          if (selectedSavedId !== id) return;
          setOpenedChart(null);
          setSelectedSavedId(null);
          setOpenError("");
          replaceChartUrl(null);
        }}
      />

      <LoadingRegion
        loading={chartSetupColdLoad}
        label="Loading the authorized data-source catalog…"
        skeleton={<ChartFormSkeleton />}
      >
        <ChartSourceEditor
          refusedChartId={refusedChartId}
          onRetrySource={() => setRefusedChartId(null)}
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
            fields: moduleFields,
          }}
          value={{ inline: editorValue, chartId }}
          onChange={(value) => {
            if (
              value.inline.moduleId !== moduleId ||
              value.chartId !== chartId
            ) {
              openSequence.current += 1;
              setOpenedChart(null);
              setSelectedSavedId(null);
              setOpenedMetadata(null);
              setOpenError("");
              setOpening(false);
              replaceChartUrl(null);
            }
            setRefusedChartId(null);
            setEditorDraft(value.inline);
            setChartId(value.chartId);
          }}
          disabled={
            queryLoading ||
            opening ||
            persistenceBusy ||
            Boolean(openedChart?.isDeleted)
          }
          onUnavailable={withdrawSource}
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
          }}
        >
          {(input) => (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      aria-label={`Display options (${displayOptionsCount} active)`}
                    />
                  }
                >
                  <SlidersHorizontal
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  <span>Display options</span>
                  {displayOptionsCount ? (
                    <Badge variant="secondary">{displayOptionsCount}</Badge>
                  ) : null}
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  collisionPadding={12}
                  className="max-h-[min(36rem,calc(100dvh-6rem))] w-[min(24rem,calc(100vw-2rem))] gap-4 overflow-y-auto p-4"
                >
                  <PopoverHeader>
                    <PopoverTitle>Display options</PopoverTitle>
                    <PopoverDescription>
                      These settings affect the chart preview. The complete
                      table and exports retain every returned value.
                    </PopoverDescription>
                  </PopoverHeader>
                  {editorValue.mode !== "date_series" ? (
                    <Field>
                      <FieldLabel htmlFor="chart-top">
                        Top groups in chart
                      </FieldLabel>
                      <Select
                        id="chart-top"
                        className="min-h-11"
                        value={top}
                        disabled={queryLoading}
                        onValueChange={(top) =>
                          setPresentation((current) => ({ ...current, top }))
                        }
                      >
                        <option value="">
                          No Top filter (large previews cap at 100)
                        </option>
                        <option value="5">Top 5</option>
                        <option value="10">Top 10</option>
                        <option value="20">Top 20</option>
                        <option value="50">Top 50</option>
                      </Select>
                      <FieldDescription>
                        Top limits the preview only. Without a Top filter, large
                        categorical previews show at most 100 groups; the table,
                        CSV, and print retain the full snapshot.
                      </FieldDescription>
                    </Field>
                  ) : null}
                  <fieldset className="flex flex-col gap-3 rounded-[var(--radius)] border p-3">
                    <legend className="px-1 text-sm font-medium">
                      Chart display
                    </legend>
                    {(
                      [
                        {
                          key: "showLegend",
                          label: "Show legend",
                          id: "chart-show-legend",
                        },
                        {
                          key: "showValues",
                          label: "Show values",
                          id: "chart-show-values",
                        },
                      ] as const
                    ).map((option) => (
                      <Field
                        key={option.key}
                        className="flex-row items-center gap-3"
                      >
                        <Checkbox
                          id={option.id}
                          checked={presentation[option.key]}
                          disabled={queryLoading}
                          onCheckedChange={(checked) =>
                            setPresentation((current) => ({
                              ...current,
                              [option.key]: checked === true,
                            }))
                          }
                        />
                        <FieldLabel htmlFor={option.id} className="font-normal">
                          {option.label}
                        </FieldLabel>
                      </Field>
                    ))}
                  </fieldset>
                </PopoverContent>
              </Popover>
              <Button
                className="min-h-11 sm:ml-auto"
                disabled={!input || !canRunQuery}
                onClick={() => void applySnapshot()}
              >
                {queryLoading ? "Loading complete snapshot…" : "Apply chart"}
              </Button>
              <p className="text-muted-foreground w-full text-sm">
                Chart query changes take effect after Apply. Display options
                update the preview; the table and exports retain the full last
                successful snapshot.
              </p>
            </div>
          )}
        </ChartSourceEditor>
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
