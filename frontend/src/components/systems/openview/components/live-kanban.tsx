"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import {
  queryOpenViewGroupedRecords,
  type OpenViewGroupSelector,
} from "../adapters/analytics-api";
import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
  OpenViewRecord,
} from "../adapters/views-api";

const GROUP_PAGE_SIZE = 12;
const RECORD_PAGE_SIZE = 25;

type GroupedPage = Awaited<ReturnType<typeof queryOpenViewGroupedRecords>>;

type LiveKanbanProps = {
  moduleId: string;
  definition: OpenViewQueryDefinition;
  refreshKey?: number;
  groupByFieldId: string;
  groupByFieldType: OpenViewDataSourceField["type"];
  fields: readonly OpenViewDataSourceField[];
  primaryFieldId: string | null;
  secondaryFieldId: string | null;
  linkedRecordRequested: boolean;
  linkedRecord: OpenViewRecord | null;
  linkedRecordLoading: boolean;
  linkedRecordError: string;
  onOpenRecord: (recordId: string) => void;
  onRetryLinkedRecord: () => void;
};

type RequestSnapshot = {
  key: string;
  page: GroupedPage | null;
  loading: boolean;
  error: string;
};

function selectorForValue(value: string | null): OpenViewGroupSelector {
  return value === null ? { kind: "unspecified" } : { kind: "value", value };
}

function groupKey(group: OpenViewGroupSelector | null): string {
  if (group === null) return "none";
  return group.kind === "unspecified" ? "unspecified" : `value:${group.value}`;
}

function groupLabel(value: string | null, label: string): string {
  if (value === null) return "Unspecified";
  if (value === "") return "Blank value";
  return label;
}

function valueText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "—";
}

function dateText(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function KanbanMemberCards({
  rows,
  fields,
  primaryFieldId,
  secondaryFieldId,
  listLabel = "Kanban lane records",
  onOpenRecord,
}: {
  rows: readonly OpenViewRecord[];
  fields: readonly OpenViewDataSourceField[];
  primaryFieldId: string | null;
  secondaryFieldId: string | null;
  listLabel?: string;
  onOpenRecord: (recordId: string) => void;
}) {
  const primaryField =
    fields.find((field) => field.id === primaryFieldId) ?? fields[0];
  const secondaryField = fields.find(
    (field) => field.id === secondaryFieldId && field.id !== primaryField?.id,
  );
  const detailFields = fields.filter(
    (field) => field.id !== primaryField?.id && field.id !== secondaryField?.id,
  );

  return (
    <ul
      aria-label={listLabel}
      className="grid min-w-0 grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3"
    >
      {rows.map((row) => {
        const title = primaryField
          ? valueText(row.data[primaryField.id])
          : "Untitled record";
        return (
          <li key={row.id} className="min-w-0">
            <article className="bg-background flex h-full min-w-0 flex-col gap-3 rounded-[var(--radius)] border p-4">
              <header className="min-w-0">
                <h3 className="font-semibold">
                  <button
                    type="button"
                    aria-label={`Open record: ${title}`}
                    className="text-primary focus-visible:ring-ring min-h-11 max-w-full min-w-11 text-left underline-offset-4 hover:underline focus-visible:ring-2"
                    onClick={() => onOpenRecord(row.id)}
                  >
                    <span className="block truncate">{title}</span>
                  </button>
                </h3>
                {secondaryField ? (
                  <p className="text-muted-foreground mt-1 text-sm break-words">
                    {secondaryField.name}:{" "}
                    {valueText(row.data[secondaryField.id])}
                  </p>
                ) : null}
              </header>
              {detailFields.length ? (
                <dl className="grid min-w-0 gap-3 text-sm">
                  {detailFields.map((field) => (
                    <div key={field.id} className="min-w-0">
                      <dt className="text-muted-foreground truncate">
                        {field.name}
                      </dt>
                      <dd className="break-words">
                        {valueText(row.data[field.id])}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <p className="text-muted-foreground mt-auto text-xs">
                Updated{" "}
                <time dateTime={row.updatedAt}>{dateText(row.updatedAt)}</time>
              </p>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

function LinkedRecordSummary({
  record,
  fields,
  primaryFieldId,
  secondaryFieldId,
}: {
  record: OpenViewRecord;
  fields: readonly OpenViewDataSourceField[];
  primaryFieldId: string | null;
  secondaryFieldId: string | null;
}) {
  const primaryField =
    fields.find((field) => field.id === primaryFieldId) ?? fields[0];
  const secondaryField = fields.find(
    (field) => field.id === secondaryFieldId && field.id !== primaryField?.id,
  );
  const detailFields = fields.filter(
    (field) => field.id !== primaryField?.id && field.id !== secondaryField?.id,
  );

  return (
    <section aria-label="Linked record" className="border-t px-4 py-3">
      <h2 className="font-medium">Linked record</h2>
      <article className="bg-background mt-3 min-w-0 rounded-[var(--radius)] border p-4">
        <h3 className="font-semibold">
          {primaryField
            ? valueText(record.data[primaryField.id])
            : "Untitled record"}
        </h3>
        {secondaryField ? (
          <p className="text-muted-foreground mt-1 text-sm break-words">
            {secondaryField.name}: {valueText(record.data[secondaryField.id])}
          </p>
        ) : null}
        {detailFields.length ? (
          <dl className="mt-3 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
            {detailFields.map((field) => (
              <div key={field.id} className="min-w-0">
                <dt className="text-muted-foreground truncate">{field.name}</dt>
                <dd className="break-words">
                  {valueText(record.data[field.id])}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="text-muted-foreground mt-3 text-xs">
          Updated{" "}
          <time dateTime={record.updatedAt}>{dateText(record.updatedAt)}</time>
        </p>
      </article>
    </section>
  );
}

export function LiveKanban({
  moduleId,
  definition,
  refreshKey = 0,
  groupByFieldId,
  groupByFieldType,
  fields,
  primaryFieldId,
  secondaryFieldId,
  linkedRecordRequested,
  linkedRecord,
  linkedRecordLoading,
  linkedRecordError,
  onOpenRecord,
  onRetryLinkedRecord,
}: LiveKanbanProps) {
  const [groupOffset, setGroupOffset] = useState(0);
  const [selectedGroup, setSelectedGroup] =
    useState<OpenViewGroupSelector | null>(null);
  const [recordOffset, setRecordOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const requestSequence = useRef(0);
  const lastGoodPage = useRef<GroupedPage | null>(null);
  const requestKey = useMemo(
    () =>
      JSON.stringify({
        moduleId,
        definition,
        groupByFieldId,
        groupByFieldType,
        groupOffset,
        selectedGroup: groupKey(selectedGroup),
        recordOffset,
        retry,
        refreshKey,
      }),
    [
      definition,
      groupByFieldId,
      groupByFieldType,
      groupOffset,
      moduleId,
      recordOffset,
      refreshKey,
      retry,
      selectedGroup,
    ],
  );
  const [snapshot, setSnapshot] = useState<RequestSnapshot | null>(null);

  useEffect(() => {
    const request = ++requestSequence.current;
    setSnapshot({ key: requestKey, page: null, loading: true, error: "" });
    void queryOpenViewGroupedRecords({
      moduleId,
      definition,
      groupBy: { fieldId: groupByFieldId, expectedType: groupByFieldType },
      limit: RECORD_PAGE_SIZE,
      offset: recordOffset,
      groupLimit: GROUP_PAGE_SIZE,
      groupOffset,
      selectedGroup,
    })
      .then((page) => {
        if (request !== requestSequence.current) return;
        lastGoodPage.current = page;
        setSnapshot({ key: requestKey, page, loading: false, error: "" });
      })
      .catch((error: unknown) => {
        if (request !== requestSequence.current) return;
        const denied =
          error instanceof ApiError && [401, 403].includes(error.status);
        if (denied) lastGoodPage.current = null;
        setSnapshot({
          key: requestKey,
          page: denied ? null : lastGoodPage.current,
          loading: false,
          error: denied
            ? "You no longer have access to these records. Sign in or ask for access, then retry."
            : error instanceof Error && error.message
              ? error.message
              : "Kanban lanes could not be loaded.",
        });
      });
    return () => {
      requestSequence.current += 1;
    };
  }, [
    definition,
    groupByFieldId,
    groupByFieldType,
    groupOffset,
    moduleId,
    recordOffset,
    refreshKey,
    requestKey,
    selectedGroup,
  ]);

  const currentSnapshot = snapshot?.key === requestKey ? snapshot : null;
  const page = currentSnapshot?.page ?? null;
  const groups = page?.groups ?? [];
  const groupPagination = page?.groupPagination;
  const selectedGroupKey = groupKey(selectedGroup);
  const memberPage =
    page && groupKey(page.selectedGroup) === selectedGroupKey ? page : null;
  const recordPagination = memberPage?.pagination;
  const groupStart =
    groupPagination && groupPagination.count > 0
      ? groupPagination.offset + 1
      : 0;
  const groupEnd = groupPagination
    ? groupPagination.offset + groupPagination.count
    : 0;
  const recordStart =
    recordPagination && recordPagination.count > 0
      ? recordPagination.offset + 1
      : 0;
  const recordEnd = recordPagination
    ? recordPagination.offset + recordPagination.count
    : 0;
  const groupRange = groupPagination
    ? groupPagination.total === 0
      ? "No lanes"
      : `Lanes ${groupStart}–${groupEnd} of ${groupPagination.total}`
    : "Lane page unavailable";
  const recordRange = recordPagination
    ? recordPagination.total === 0
      ? "No records in this lane."
      : `Showing ${recordStart}–${recordEnd} of ${recordPagination.total} records`
    : selectedGroup
      ? "Lane records unavailable."
      : "Select a lane to load its records.";
  const selectedGroupDetails = groups.find(
    (group) => groupKey(selectorForValue(group.value)) === selectedGroupKey,
  );
  const loading = currentSnapshot === null || currentSnapshot.loading;
  const requestError = currentSnapshot?.error ?? "";

  return (
    <section
      aria-label="Kanban results"
      className="bg-card min-w-0 overflow-hidden rounded-[var(--radius)] border"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="font-medium">Kanban lanes</h2>
          <p className="text-muted-foreground text-sm">
            Lane counts are from the server. Records load only for the selected
            lane.
          </p>
        </div>
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {loading
            ? "Loading lanes…"
            : groupPagination
              ? groupRange
              : "Lanes unavailable"}
        </p>
      </div>

      {linkedRecordRequested ? (
        linkedRecord ? (
          <LinkedRecordSummary
            record={linkedRecord}
            fields={fields}
            primaryFieldId={primaryFieldId}
            secondaryFieldId={secondaryFieldId}
          />
        ) : linkedRecordError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
            <p role="alert">{linkedRecordError}</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onRetryLinkedRecord}
            >
              Retry linked record
            </Button>
          </div>
        ) : linkedRecordLoading ? (
          <p role="status" className="text-muted-foreground border-t px-4 py-3">
            Loading linked record…
          </p>
        ) : (
          <p role="status" className="text-muted-foreground border-t px-4 py-3">
            This linked record is unavailable.
          </p>
        )
      ) : null}

      {requestError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <p role="alert">
            {requestError} The last successful page remains visible when
            available.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => setRetry((value) => value + 1)}
          >
            {selectedGroup ? "Retry lane records" : "Retry lanes"}
          </Button>
        </div>
      ) : null}

      {loading && groups.length === 0 ? (
        <p
          role="status"
          className="text-muted-foreground px-4 py-8 text-center"
        >
          Loading lanes…
        </p>
      ) : groups.length === 0 ? (
        <p
          role={requestError ? "status" : undefined}
          className="text-muted-foreground px-4 py-8 text-center"
        >
          {requestError
            ? "Lane results are unavailable until the request succeeds."
            : "No lanes match this view."}
        </p>
      ) : (
        <ul
          aria-label="Kanban lanes"
          className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {groups.map((group) => {
            const selector = selectorForValue(group.value);
            const label = groupLabel(group.value, group.label);
            const active = groupKey(selector) === selectedGroupKey;
            return (
              <li key={groupKey(selector)} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={active}
                  aria-label={`${label}, ${group.count} records`}
                  className={`focus-visible:ring-ring flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-[var(--radius)] border px-3 py-2 text-left focus-visible:ring-2 ${active ? "border-primary bg-primary/5" : "bg-background hover:bg-muted/50"}`}
                  onClick={() => {
                    setSelectedGroup(selector);
                    setRecordOffset(0);
                  }}
                >
                  <span className="truncate font-medium">{label}</span>
                  <span className="text-muted-foreground shrink-0 text-sm">
                    {group.count}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {groupRange}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            aria-label="Previous lanes"
            disabled={
              !groupPagination ||
              groupPagination.offset === 0 ||
              loading ||
              Boolean(requestError)
            }
            onClick={() => {
              setGroupOffset(
                Math.max(0, (groupPagination?.offset ?? 0) - GROUP_PAGE_SIZE),
              );
              setSelectedGroup(null);
              setRecordOffset(0);
            }}
          >
            Previous lanes
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            aria-label="Next lanes"
            disabled={
              !groupPagination?.hasMore || loading || Boolean(requestError)
            }
            onClick={() => {
              setGroupOffset((groupPagination?.offset ?? 0) + GROUP_PAGE_SIZE);
              setSelectedGroup(null);
              setRecordOffset(0);
            }}
          >
            Next lanes
          </Button>
        </div>
      </div>

      {selectedGroup ? (
        <section
          aria-label={`${selectedGroupDetails ? groupLabel(selectedGroupDetails.value, selectedGroupDetails.label) : "Selected"} lane records`}
          className="border-t"
        >
          <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
            <div>
              <h2 className="font-medium">
                {selectedGroupDetails
                  ? groupLabel(
                      selectedGroupDetails.value,
                      selectedGroupDetails.label,
                    )
                  : "Selected lane"}
              </h2>
              <p className="text-muted-foreground text-sm">
                {selectedGroupDetails?.count ?? recordPagination?.total ?? 0}{" "}
                records in this lane
              </p>
            </div>
            <p aria-live="polite" className="text-muted-foreground text-sm">
              {loading
                ? "Loading lane records…"
                : recordPagination
                  ? recordRange
                  : "Lane records unavailable"}
            </p>
          </div>

          {requestError && !memberPage ? (
            <p
              role="status"
              className="text-muted-foreground px-4 py-8 text-center"
            >
              Lane records could not be loaded. Use the retry action above.
            </p>
          ) : (
            <>
              {requestError ? (
                <p role="status" className="text-muted-foreground px-4 py-3">
                  Showing the last successfully loaded page for this lane.
                </p>
              ) : null}
              {loading ? (
                <p
                  role="status"
                  className="text-muted-foreground px-4 py-8 text-center"
                >
                  Loading selected lane records…
                </p>
              ) : memberPage?.items.length ? (
                <KanbanMemberCards
                  rows={memberPage.items}
                  fields={fields}
                  primaryFieldId={primaryFieldId}
                  secondaryFieldId={secondaryFieldId}
                  onOpenRecord={onOpenRecord}
                />
              ) : (
                <p className="text-muted-foreground px-4 py-8 text-center">
                  No records in this lane.
                </p>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
            <p aria-live="polite" className="text-muted-foreground text-sm">
              {recordRange}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                aria-label="Previous lane records"
                disabled={
                  !recordPagination ||
                  recordPagination.offset === 0 ||
                  loading ||
                  Boolean(requestError)
                }
                onClick={() =>
                  setRecordOffset(
                    Math.max(
                      0,
                      (recordPagination?.offset ?? 0) - RECORD_PAGE_SIZE,
                    ),
                  )
                }
              >
                Previous records
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                aria-label="Next lane records"
                disabled={
                  !recordPagination?.hasMore || loading || Boolean(requestError)
                }
                onClick={() => setRecordOffset(recordOffset + RECORD_PAGE_SIZE)}
              >
                Next records
              </Button>
            </div>
          </div>
        </section>
      ) : null}
    </section>
  );
}
