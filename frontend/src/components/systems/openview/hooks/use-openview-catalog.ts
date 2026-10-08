"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
import { listOpenViewDepartments } from "../adapters/departments-api";
import {
  dataSourceOptions,
  departmentOptions,
  departmentsOptions,
  extendsRead,
  fieldOptions,
  readStamp,
} from "../adapters/openview-queries";
import { uuidSchema } from "../adapters/views-schemas";
import type {
  OpenViewDataSource,
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
  OpenViewPresentation,
} from "../adapters/views-api";

const NO_FIELDS: OpenViewDataSourceField[] = [];

/** Only selected metadata missing from a loaded page uses a detail read. */
export function useOpenViewSource(
  sources: readonly OpenViewDataSource[],
  id: string | null | undefined,
) {
  const listed = sources.find((source) => source.id === id);
  const detail = useQuery(
    dataSourceOptions(
      id ?? "",
      Boolean(!listed && uuidSchema.safeParse(id).success),
    ),
  );
  return listed ?? (detail.isSuccess ? detail.data : undefined);
}

export function useOpenViewDepartmentNames(ids: readonly string[]) {
  const first = useQuery(departmentsOptions());
  const items = first.data?.items ?? [];
  const details = useQueries({
    queries: [...new Set(ids)]
      .filter((id) => !items.some((item) => item.id === id))
      .map((id) => departmentOptions(id, first.isSuccess)),
    combine: (results) =>
      results.flatMap((result) =>
        result.isSuccess && result.data ? [result.data] : [],
      ),
  });
  return new Map([...items, ...details].map((item) => [item.id, item.name]));
}

export function selectedFieldIds(
  draft:
    | {
        definition: OpenViewQueryDefinition;
        presentation: OpenViewPresentation;
      }
    | null
    | undefined,
): string[] {
  if (!draft) return [];
  const { definition, presentation } = draft;
  return [
    ...new Set(
      [
        ...definition.columns.map((item) => item.fieldId),
        ...definition.filters.map((item) => item.fieldId),
        ...definition.sort.map((item) => item.fieldId),
        ...definition.searchFields.map((item) => item.fieldId),
        ...presentation.columnFieldIds,
        ...presentation.pinnedFieldIds,
        presentation.primaryFieldId,
        presentation.secondaryFieldId,
        presentation.dateFieldId,
        presentation.groupByFieldId,
        presentation.timelineStartFieldId,
        presentation.timelineEndFieldId,
        presentation.timelineDeadlineFieldId,
        presentation.timelineProgressFieldId,
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
}

/** Resolves selected labels; it never expands the catalog to every field. */
export function useOpenViewSelectedFields(
  moduleId: string | undefined,
  loaded: readonly OpenViewDataSourceField[] | undefined,
  ids: readonly string[],
) {
  const fields = loaded ?? NO_FIELDS;
  const detail = useQueries({
    queries: loaded
      ? [...new Set(ids)]
          .filter((id) => !fields.some((field) => field.id === id))
          .map((id) => fieldOptions(moduleId ?? "", id))
      : [],
    combine: (results) => ({
      fields: results.flatMap((result) =>
        result.isSuccess && result.data ? [result.data] : [],
      ),
      pending: results.some((result) => result.isPending || result.isFetching),
      error: results.find((result) => result.isError)?.error,
      retry: () => {
        for (const result of results) {
          if (result.isError) void result.refetch();
        }
      },
    }),
  });
  const items = useMemo(
    () => [...fields, ...detail.fields],
    [fields, detail.fields],
  );
  return {
    items,
    pending: detail.pending,
    error: detail.error,
    retry: detail.retry,
  };
}

/** Search and user-requested department pages for the Dashboard picker. */
export function useOpenViewDepartmentPicker(
  search: string,
  selectedId: string,
) {
  const first = useQuery(departmentsOptions(search));
  const [extension, setExtension] = useState<{
    readAt: number;
    items: NonNullable<typeof first.data>["items"];
    hasMore: boolean;
    nextOffset: number;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const more =
    extension && extendsRead(extension.readAt, first) ? extension : null;
  const items = [...(first.data?.items ?? []), ...(more?.items ?? [])];
  const selected = items.find((item) => item.id === selectedId);
  const detail = useQuery(departmentOptions(selectedId, !selected));
  const hasMore = more?.hasMore ?? first.data?.pagination.hasMore ?? false;
  const loadMore = async () => {
    if (!first.data || !hasMore || loadingMore) return;
    const readAt = readStamp(first);
    setLoadingMore(true);
    setMoreError("");
    try {
      const page = await listOpenViewDepartments({
        search,
        limit: 100,
        offset:
          more?.nextOffset ??
          first.data.pagination.offset + first.data.pagination.count,
      });
      setExtension({
        readAt,
        items: [...(more?.items ?? []), ...page.items],
        hasMore: page.pagination.hasMore,
        nextOffset: page.pagination.offset + page.pagination.count,
      });
    } catch (error) {
      setMoreError(
        apiErrorMessage(
          error,
          "More departments could not be loaded. Try again.",
        ),
      );
    } finally {
      setLoadingMore(false);
    }
  };
  return {
    items,
    selected: selected ?? (detail.isSuccess ? detail.data : undefined),
    hasMore,
    loadMore,
    loadingMore,
    loading: first.isFetching,
    error: first.isError
      ? apiErrorMessage(first.error, "Departments could not be loaded.")
      : moreError,
    retry: () => {
      if (moreError) void loadMore();
      else void first.refetch();
    },
  };
}
