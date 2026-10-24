"use client";
import { useDisplayRegion } from "@/components/use-display-region";

import { Download, FileSearch } from "lucide-react";
import { Temporal } from "@js-temporal/polyfill";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { LoadingRegion } from "@/components/ui/loading-region";
import {
  DEFAULT_TABLE_PAGE_SIZE,
  TablePagination,
} from "@/components/ui/table-pagination";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SecurityEventsView } from "../../access/components/security-events-view";
import { TableSkeleton } from "../../access/components/table-skeleton";
import {
  accessKeys,
  isAccessSecurityDenied,
} from "../../access/adapters/access-queries";
import { ApiError } from "@/lib/api";
import { requestSessionRecheck } from "@/lib/auth-api";
import {
  downloadManageAuditCsv,
  type ManageAuditLog,
  type ManageAuditListRequest,
} from "../adapters/audit-api";
import {
  manageAuditDepartmentsOptions,
  manageAuditExportOptions,
  manageAuditFieldOptions,
  manageAuditListOptions,
  manageAuditOptionsOptions,
  manageWorkspaceOptions,
  manageKeys,
  isManageAuditDenied,
  setManageAuditDenied,
} from "../adapters/manage-queries";
import {
  auditArea,
  auditExportBlockedReason,
  auditFieldIds,
  auditListEntries,
  auditRowTime,
  readShowSystemEvents,
  writeShowSystemEvents,
  type AuditKnownNames,
} from "../domain/audit-rules";
import { initialActivityFilters } from "./audit-data";
import { AuditEventSheet } from "./audit-event-sheet";
import { AuditExportDialog } from "./audit-export-dialog";
import { AuditRows, type AuditRowText } from "./audit-rows";
import { AuditToolbar, type AuditPersonOption } from "./audit-toolbar";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "../../shared/runtime/workspace-identity";
import type { ActivityFilters } from "./audit-data";

type ManageAuditProps = {
  renderHeader: (actions: ReactNode) => ReactNode;
  securityEventsAdmitted: boolean;
  securityEventsSelected: boolean;
  onSecurityEventsSelected: (selected: boolean) => void;
  /**
   * The departments a manager reads (MD12), first by default; null for an
   * administrator, who reads the whole organization and exports.
   */
  managedDepartments: readonly string[] | null;
};

function displayActor(log: Pick<ManageAuditLog, "actor_name">): string {
  return log.actor_name?.trim() || "Unknown person";
}

function downloadActivityCsv(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

function auditRequestFromFilters(
  filters: ActivityFilters,
  limit: number,
  offset: number,
  timezone: string | undefined,
  departmentId: string | undefined,
): ManageAuditListRequest {
  const request: ManageAuditListRequest = {
    sortOrder: filters.order === "newest" ? "desc" : "asc",
    limit,
    offset,
  };
  const search = filters.query.trim();
  if (search) request.search = search;
  if (departmentId) request.departmentId = departmentId;
  if (filters.user) request.performedBy = filters.user;
  if (filters.entity) request.entityType = filters.entity;
  if (filters.kind !== "all") request.action = filters.kind;
  if (timezone && filters.from)
    request.createdAfter = workspaceDayBound(filters.from, timezone, false);
  if (timezone && filters.to)
    request.createdBefore = workspaceDayBound(filters.to, timezone, true);
  return request;
}

function workspaceDayBound(
  value: string,
  timezone: string,
  endOfDay: boolean,
): string {
  const boundaryDate = endOfDay
    ? Temporal.PlainDate.from(value).add({ days: 1 })
    : Temporal.PlainDate.from(value);
  const start = boundaryDate
    .toZonedDateTime({ timeZone: timezone, plainTime: "00:00" })
    .toInstant();
  return (endOfDay ? start.subtract({ milliseconds: 1 }) : start).toString({
    fractionalSecondDigits: 3,
  });
}

function auditFiltersFromRequest(
  request: ManageAuditListRequest,
): Omit<ManageAuditListRequest, "limit" | "offset"> {
  return {
    search: request.search,
    departmentId: request.departmentId,
    action: request.action,
    entityType: request.entityType,
    performedBy: request.performedBy,
    createdAfter: request.createdAfter,
    createdBefore: request.createdBefore,
    sortOrder: request.sortOrder,
  };
}

/** A refusal names who reads audit: administrators, or the manager's lost scope. */
function refusalMessage(admin: boolean): string {
  return admin
    ? "Only administrators can view audit history."
    : "You no longer have access to this audit history.";
}

function listErrorMessage(error: unknown, admin: boolean): string {
  if (error instanceof ApiError && error.status === 403)
    return refusalMessage(admin);
  return "Audit history could not be loaded. Try again.";
}

function isAdmissionRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    (error.code === "mfa_required" || error.code === "ip_not_allowed")
  );
}

export default function ManageAudit({
  renderHeader,
  securityEventsAdmitted,
  securityEventsSelected,
  onSecurityEventsSelected,
  managedDepartments,
}: ManageAuditProps) {
  const queryClient = useQueryClient();
  const viewerId = useVerifiedWorkspaceUserId();
  const workspaceSuspended = useWorkspaceInteractionSuspended();
  const exportAdmitted = managedDepartments === null;
  const securityActive =
    securityEventsAdmitted && securityEventsSelected && !workspaceSuspended;
  const historyActive = !securityEventsAdmitted || !securityEventsSelected;
  const [, notifySecurityReads] = useReducer(
    (version: number) => version + 1,
    0,
  );
  const securityAuthority = useRef(false);
  const refusalRechecked = useRef(false);
  // This host owns events Retry. Policy/session refusals remain latched for
  // their Access owners, without suppressing a later events recheck cycle.
  const securityRefused = isAccessSecurityDenied(queryClient, "events");
  useLayoutEffect(() => {
    securityAuthority.current = securityActive;
    if (!securityActive)
      void queryClient.cancelQueries({ queryKey: accessKeys.securityEvents() });
    return () => {
      securityAuthority.current = false;
      void queryClient.cancelQueries({ queryKey: accessKeys.securityEvents() });
    };
  }, [queryClient, securityActive]);
  const onSecurityReadChange = useCallback(() => {
    if (securityAuthority.current) notifySecurityReads();
  }, []);
  useEffect(() => {
    if (!securityActive) return;
    if (!securityRefused) {
      refusalRechecked.current = false;
      return;
    }
    for (const [kind, queryKey] of [
      ["policy", accessKeys.security()],
      ["sessions", accessKeys.adminSessions()],
      ["events", accessKeys.securityEvents()],
    ] as const) {
      if (isAccessSecurityDenied(queryClient, kind))
        void queryClient
          .cancelQueries({ queryKey })
          .then(() => queryClient.removeQueries({ queryKey }));
    }
    let current = true;
    queueMicrotask(() => {
      if (!current || !securityAuthority.current || refusalRechecked.current)
        return;
      refusalRechecked.current = true;
      requestSessionRecheck();
    });
    return () => {
      current = false;
    };
  }, [queryClient, securityActive, securityRefused]);
  const [auditDenied, setAuditDenied] = useState(() =>
    isManageAuditDenied(queryClient),
  );
  const [downloadPending, setDownloadPending] = useState(false);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const downloadController = useRef<AbortController | null>(null);
  const auditPurge = useRef<Promise<void> | null>(null);
  const [filters, setFilters] = useState<ActivityFilters>(
    initialActivityFilters,
  );
  const [chosenDepartment, setChosenDepartment] = useState("");
  // The departments name the Area column and order a manager's picker; the
  // read needs no department scope.
  const departmentsQuery = useQuery({
    ...manageAuditDepartmentsOptions(),
    enabled: historyActive && !auditDenied && !workspaceSuspended,
  });
  const loadedDepartmentNames = new Map(
    (departmentsQuery.data?.items ?? []).map((department) => [
      department.id,
      department.department_name,
    ]),
  );
  const departmentLabel = (id: string) =>
    loadedDepartmentNames.get(id) ?? `Department ${id.slice(0, 8)}`;
  // MD16: the picker is sorted by name, and with two or more departments the
  // default (the first by name) waits for the names.
  const managedByName = managedDepartments
    ? [...managedDepartments].sort((left, right) =>
        departmentLabel(left).localeCompare(departmentLabel(right)),
      )
    : null;
  const namesSettled =
    !departmentsQuery.isPending || (managedDepartments?.length ?? 0) <= 1;
  const departmentId = managedByName
    ? managedByName.includes(chosenDepartment)
      ? chosenDepartment
      : namesSettled
        ? managedByName[0]
        : undefined
    : undefined;
  const [pageIndex, setPageIndex] = useState(0);
  const [appliedSearch, setAppliedSearch] = useState("");
  const [actorSearch, setActorSearch] = useState("");
  const [appliedActorSearch, setAppliedActorSearch] = useState("");
  const [chosenActor, setChosenActor] = useState<AuditPersonOption | null>(
    null,
  );
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TABLE_PAGE_SIZE);
  const [selected, setSelected] = useState<ManageAuditLog | null>(null);
  const [showSystem, setShowSystem] = useState(() =>
    readShowSystemEvents(viewerId),
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [exportRequest, setExportRequest] = useState<Omit<
    ManageAuditListRequest,
    "limit" | "offset"
  > | null>(null);
  const [notice, setNotice] = useState("");
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const exportTrigger = useRef<HTMLButtonElement | null>(null);
  // A manager's reads wait for a department; an administrator's never do.
  const scopeReady = managedDepartments === null || departmentId !== undefined;
  const reading =
    historyActive && !auditDenied && !workspaceSuspended && scopeReady;
  const workspaceQuery = useQuery({
    ...manageWorkspaceOptions(),
    enabled: historyActive && !workspaceSuspended,
  });
  const listRequest = auditRequestFromFilters(
    { ...filters, query: appliedSearch },
    pageSize,
    pageIndex * pageSize,
    workspaceQuery.data?.timezone,
    departmentId,
  );
  const listQuery = useQuery({
    ...manageAuditListOptions(listRequest),
    enabled: reading,
  });
  // The unsearched options name the Area filter and the first people; a
  // person search reads its own options.
  const optionsQuery = useQuery({
    ...manageAuditOptionsOptions("", departmentId),
    enabled: reading,
  });
  const actorOptionsQuery = useQuery({
    ...manageAuditOptionsOptions(appliedActorSearch, departmentId),
    enabled: reading && appliedActorSearch !== "",
  });
  const displayRegion = useDisplayRegion(workspaceQuery.data);
  const exportQuery = useQuery({
    ...manageAuditExportOptions(exportRequest ?? { sortOrder: "desc" }),
    enabled:
      exportAdmitted &&
      exportOpen &&
      historyActive &&
      exportRequest !== null &&
      !auditDenied &&
      !workspaceSuspended,
  });
  const peopleQuery = appliedActorSearch ? actorOptionsQuery : optionsQuery;
  const auditErrors = [
    listQuery.error,
    optionsQuery.error,
    actorOptionsQuery.error,
    exportQuery.error,
    downloadError,
  ];
  const admissionRefused = auditErrors.some(isAdmissionRefusal);
  const auditRefused =
    auditDenied ||
    auditErrors.some(
      (error) =>
        error instanceof ApiError &&
        error.status === 403 &&
        !isAdmissionRefusal(error),
    );
  const auditConcealed = auditRefused || admissionRefused || workspaceSuspended;
  const logs = auditConcealed ? [] : (listQuery.data?.items ?? []);
  const actors = auditConcealed ? [] : (peopleQuery.data?.actors ?? []);
  const actorOptions: AuditPersonOption[] = [
    ...new Map(
      [
        ...(auditConcealed || !chosenActor ? [] : [chosenActor]),
        ...actors.map((actor) => ({
          id: actor.performed_by,
          label:
            actor.actor_name?.trim() ||
            actor.actor_label?.trim() ||
            "Unknown person",
        })),
      ].map((actor) => [actor.id, actor]),
    ).values(),
  ];
  const entityTypes = auditConcealed
    ? []
    : (optionsQuery.data?.entity_types ?? []);
  const departmentNames: ReadonlyMap<string, string> = auditConcealed
    ? new Map()
    : loadedDepartmentNames;
  // One cached read per distinct record field on this page (MD16); a field
  // the viewer cannot read keeps its short id.
  const fieldIds = auditFieldIds(logs);
  const fieldQueries = useQueries({
    queries: fieldIds.map((fieldId) => ({
      ...manageAuditFieldOptions(fieldId),
      enabled: reading,
    })),
  });
  const fieldNames = new Map(
    fieldIds.flatMap((fieldId, index) => {
      const field = fieldQueries[index]?.data;
      return field ? [[fieldId, field.name] as const] : [];
    }),
  );
  // The same reads give select option labels and which fields hold people.
  const fieldKinds = new Map(
    fieldIds.flatMap((fieldId, index) => {
      const field = fieldQueries[index]?.data;
      return field
        ? [[fieldId, { type: field.type, options: field.options }] as const]
        : [];
    }),
  );
  // Names this page already holds (Phase 8): the organization, which the
  // server cannot name, and the people the Person filter lists.
  const knownNames: AuditKnownNames = {
    departments: departmentNames,
    fields: fieldKinds,
    organizations: workspaceQuery.data
      ? new Map([[workspaceQuery.data.id, workspaceQuery.data.display_name]])
      : undefined,
    // The unsearched options, so a Person search does not change the sheet.
    people: new Map(
      (auditConcealed ? [] : (optionsQuery.data?.actors ?? [])).flatMap(
        (actor) => {
          const name = actor.actor_name?.trim();
          return name ? [[actor.performed_by, name] as const] : [];
        },
      ),
    ),
  };
  const total = auditConcealed ? 0 : (listQuery.data?.pagination.total ?? 0);
  const serverOffset =
    listQuery.data?.pagination.offset ?? pageIndex * pageSize;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePageIndex = listQuery.data
    ? Math.min(pageIndex, pageCount - 1)
    : pageIndex;
  const exportLogs = auditConcealed ? [] : (exportQuery.data?.items ?? []);
  const exportCount = auditConcealed
    ? 0
    : (exportQuery.data?.pagination.total ?? total);
  const dateRangeError =
    filters.from && filters.to && filters.from > filters.to
      ? "The end date must be on or after the start date."
      : "";
  const dateTimezoneUnavailable =
    Boolean(filters.from || filters.to) && !workspaceQuery.data;
  // MD7: the list total is free, so Export says why before it opens.
  const exportBlocked = listQuery.data ? auditExportBlockedReason(total) : null;
  const canDownloadExport =
    Boolean(exportQuery.data) &&
    exportQuery.isSuccess &&
    !exportQuery.isFetching &&
    !downloadPending &&
    !auditConcealed &&
    !dateRangeError &&
    !dateTimezoneUnavailable;
  const searching = appliedSearch.trim() !== "";
  const entries = auditListEntries(logs, {
    showSystem,
    searching,
    entity: filters.entity,
  });
  // Relative times count from the moment this page was read.
  const readAt = new Date(listQuery.dataUpdatedAt);
  const unformatted = workspaceQuery.isPending
    ? "Loading date format…"
    : "Date format unavailable";
  const textFor = (log: ManageAuditLog): AuditRowText => ({
    person: displayActor(log),
    time: displayRegion
      ? auditRowTime(log.created_at, readAt, displayRegion)
      : unformatted,
    exactTime: displayRegion
      ? auditRowTime(log.created_at, readAt, displayRegion, { seconds: true })
      : unformatted,
    area: auditArea(log, departmentNames),
  });

  useEffect(
    () => () => {
      downloadController.current?.abort();
      downloadController.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!workspaceSuspended && historyActive) return;
    downloadController.current?.abort();
    downloadController.current = null;
    setDownloadPending(false);
    if (!historyActive) {
      setSelected(null);
      setExportOpen(false);
    }
  }, [historyActive, workspaceSuspended]);
  useEffect(() => {
    if (!auditRefused && !admissionRefused) return;
    if (auditRefused) {
      setManageAuditDenied(queryClient, true);
      setAuditDenied(true);
    }
    setSelected(null);
    setExportOpen(false);
    downloadController.current?.abort();
    downloadController.current = null;
    setDownloadPending(false);
    setNotice("");
    auditPurge.current = queryClient
      .cancelQueries({ queryKey: manageKeys.audit() })
      .then(() => {
        queryClient.removeQueries({ queryKey: manageKeys.audit() });
      });
    if (admissionRefused) {
      // AppPage conceals synchronously; dispatch after this React effect.
      queueMicrotask(requestSessionRecheck);
      setDownloadError(null);
    }
  }, [auditRefused, admissionRefused, queryClient]);
  useEffect(() => {
    const timer = setTimeout(
      () => setAppliedActorSearch(actorSearch.trim()),
      300,
    );
    return () => clearTimeout(timer);
  }, [actorSearch]);
  useEffect(() => {
    if (filters.query === appliedSearch) return;
    const timer = setTimeout(() => {
      setAppliedSearch(filters.query);
      setPageIndex(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [filters.query, appliedSearch]);

  useEffect(() => {
    if (listQuery.data && safePageIndex !== pageIndex)
      setPageIndex(safePageIndex);
  }, [listQuery.data, pageIndex, safePageIndex]);

  function updateFilter<Key extends keyof ActivityFilters>(
    key: Key,
    value: ActivityFilters[Key],
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
    if (key !== "query") setPageIndex(0);
    setNotice("");
  }

  /** Clears the Filters popover's filters; the search, kind and sort stay. */
  function clearFilters() {
    setFilters((current) => ({
      ...initialActivityFilters,
      query: current.query,
      kind: current.kind,
      order: current.order,
    }));
    setChosenActor(null);
    setPageIndex(0);
    setNotice("");
  }

  function toggleSystem() {
    const next = !showSystem;
    setShowSystem(next);
    writeShowSystemEvents(viewerId, next);
  }

  function openExport() {
    if (
      !exportAdmitted ||
      exportBlocked ||
      dateRangeError ||
      dateTimezoneUnavailable ||
      auditConcealed
    )
      return;
    setDownloadError(null);
    const request = auditFiltersFromRequest(
      auditRequestFromFilters(
        { ...filters, query: appliedSearch },
        pageSize,
        0,
        workspaceQuery.data?.timezone,
        departmentId,
      ),
    );
    const startedAt = new Date().toISOString();
    setExportRequest({
      ...request,
      createdBefore:
        request.createdBefore && request.createdBefore < startedAt
          ? request.createdBefore
          : startedAt,
    });
    setExportOpen(true);
  }

  function closeExport() {
    downloadController.current?.abort();
    downloadController.current = null;
    setDownloadPending(false);
    setDownloadError(null);
    setExportOpen(false);
  }

  async function retryAudit() {
    if (admissionRefused || workspaceSuspended) {
      requestSessionRecheck();
      return;
    }
    if (!auditRefused) {
      await listQuery.refetch();
      return;
    }
    await auditPurge.current;
    try {
      await queryClient.fetchQuery({
        ...manageAuditListOptions(listRequest),
        staleTime: 0,
      });
      setManageAuditDenied(queryClient, false);
      setDownloadError(null);
      setAuditDenied(false);
    } catch {
      /* The refusal remains until a fresh read is accepted. */
    }
  }

  async function downloadFilteredCsv() {
    if (!canDownloadExport || !exportRequest || downloadController.current)
      return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloadPending(true);
    setDownloadError(null);
    try {
      const csv = await downloadManageAuditCsv(
        exportRequest,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        downloadController.current !== controller
      )
        return;
      downloadActivityCsv(csv.blob, csv.filename);
      setExportOpen(false);
      setNotice(
        `Downloaded ${csv.count} filtered audit ${csv.count === 1 ? "entry" : "entries"}.`,
      );
    } catch (error) {
      if (
        !controller.signal.aborted &&
        downloadController.current === controller
      )
        setDownloadError(error);
    } finally {
      if (downloadController.current === controller) {
        downloadController.current = null;
        setDownloadPending(false);
      }
    }
  }

  const selectedText = selected ? textFor(selected) : null;
  const viewSwitch = securityEventsAdmitted ? (
    <TabsList aria-label="Audit view">
      <TabsTrigger value="history" className="min-h-11 xl:min-h-8">
        Activity
      </TabsTrigger>
      <TabsTrigger value="security" className="min-h-11 xl:min-h-8">
        Security events
      </TabsTrigger>
    </TabsList>
  ) : null;
  const exportButton =
    exportAdmitted && !securityActive ? (
      <DisabledReason reason={exportBlocked}>
        <Button
          ref={exportTrigger}
          variant="ghost"
          aria-label="Export audit preview"
          className="min-h-11 gap-2 px-3"
          onClick={openExport}
          disabled={Boolean(dateRangeError) || auditConcealed}
        >
          <Download data-icon="inline-start" /> Export
        </Button>
      </DisabledReason>
    ) : null;

  return (
    <Tabs
      className="manage-fill"
      value={
        securityEventsAdmitted && securityEventsSelected
          ? "security"
          : "history"
      }
      onValueChange={(value) => onSecurityEventsSelected(value === "security")}
    >
      <section
        aria-labelledby="audit-region-label"
        className="manage-fill flex min-w-0 flex-col gap-3"
      >
        <h2 id="audit-region-label" className="sr-only">
          {securityActive ? "Audit sections" : "Activity history"}
        </h2>
        {renderHeader(
          viewSwitch || exportButton ? (
            <>
              {viewSwitch}
              {exportButton}
            </>
          ) : null,
        )}

        {securityEventsAdmitted && securityEventsSelected ? (
          <TabsContent
            value="security"
            className="manage-fill flex min-w-0 flex-col gap-3"
          >
            <SecurityEventsView
              active={securityActive}
              admitted={securityEventsAdmitted && !workspaceSuspended}
              pending={workspaceSuspended}
              onReadChange={onSecurityReadChange}
            />
          </TabsContent>
        ) : (
          <TabsContent
            value="history"
            className="manage-fill flex min-w-0 flex-col gap-3"
          >
            <AuditToolbar
              filters={filters}
              onChange={updateFilter}
              onClearFilters={clearFilters}
              disabled={auditConcealed}
              region={displayRegion}
              dateRangeError={dateRangeError}
              people={{
                options: actorOptions,
                selectedLabel:
                  actorOptions.find((actor) => actor.id === filters.user)
                    ?.label ?? "Unknown person",
                search: actorSearch,
                onSearchChange: setActorSearch,
                loading:
                  peopleQuery.isPending ||
                  actorSearch.trim() !== appliedActorSearch,
                error: peopleQuery.isError
                  ? "People filters could not be loaded. Try again."
                  : undefined,
                onRetry: () => void peopleQuery.refetch(),
                onChoose: setChosenActor,
              }}
              areas={{
                entityTypes,
                loading: optionsQuery.isPending,
                error: optionsQuery.isError
                  ? "Areas could not be loaded. Try again."
                  : undefined,
                onRetry: () => void optionsQuery.refetch(),
              }}
              departments={
                managedDepartments && managedDepartments.length > 0
                  ? {
                      options: (managedByName ?? []).map((id) => ({
                        id,
                        label: departmentLabel(id),
                      })),
                      value: departmentId ?? "",
                      onChange: (id) => {
                        setChosenDepartment(id);
                        setChosenActor(null);
                        setFilters((current) => ({
                          ...current,
                          user: "",
                          entity: "",
                        }));
                        setPageIndex(0);
                      },
                    }
                  : null
              }
            />

            {optionsQuery.isError && !auditConcealed ? (
              <Alert role="alert" variant="destructive">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p>Audit filter options could not be loaded. Try again.</p>
                  <Button
                    variant="outline"
                    onClick={() => void optionsQuery.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              </Alert>
            ) : null}
            {workspaceQuery.isError ? (
              <Alert role="alert" variant="warning">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p>
                    Organization date settings could not be loaded. Retry to
                    format dates in your organization’s locale and timezone.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => void workspaceQuery.refetch()}
                  >
                    Retry date settings
                  </Button>
                </div>
              </Alert>
            ) : null}
            {notice ? <Alert variant="success">{notice}</Alert> : null}

            {listQuery.isError || auditConcealed ? (
              <Alert role="alert" variant="destructive">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p>
                    {auditRefused
                      ? refusalMessage(exportAdmitted)
                      : auditConcealed
                        ? "Verifying session access…"
                        : listErrorMessage(listQuery.error, exportAdmitted)}
                  </p>
                  <Button variant="outline" onClick={() => void retryAudit()}>
                    Retry
                  </Button>
                </div>
              </Alert>
            ) : (
              <LoadingRegion
                loading={listQuery.isPending}
                label="Loading audit entries…"
                skeleton={<TableSkeleton columns={4} />}
                className="manage-fill"
              >
                {total === 0 ? (
                  <Empty className="border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <FileSearch aria-hidden="true" />
                      </EmptyMedia>
                      <EmptyTitle>
                        No audit entries match these filters
                      </EmptyTitle>
                      <EmptyDescription>
                        Clear filters or search for another activity entry.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="manage-fill bg-card flex min-w-0 flex-col overflow-hidden rounded-md border">
                    <AuditRows
                      entries={entries}
                      textFor={textFor}
                      fieldNames={fieldNames}
                      names={knownNames}
                      selectedId={selected?.id ?? null}
                      onOpen={(log, opener) => {
                        detailTrigger.current = opener;
                        setSelected(log);
                      }}
                      onToggleSystem={toggleSystem}
                    />
                    <TablePagination
                      ariaLabel="Activity pages"
                      className="shrink-0 px-3 py-2 lg:py-2"
                      total={total}
                      offset={serverOffset}
                      rowCount={logs.length}
                      pageSize={pageSize}
                      onPageIndexChange={setPageIndex}
                      onPageSizeChange={(size) => {
                        setPageSize(size);
                        setPageIndex(0);
                      }}
                    />
                  </div>
                )}
              </LoadingRegion>
            )}

            <AuditEventSheet
              log={auditConcealed ? null : selected}
              person={selectedText?.person ?? ""}
              area={selectedText?.area ?? ""}
              fieldNames={fieldNames}
              names={knownNames}
              region={displayRegion}
              admin={exportAdmitted}
              onClose={() => setSelected(null)}
              finalFocus={() =>
                detailTrigger.current?.isConnected
                  ? detailTrigger.current
                  : null
              }
            />

            <AuditExportDialog
              open={exportOpen && !auditConcealed}
              onClose={closeExport}
              finalFocus={() => exportTrigger.current}
              count={exportCount}
              logs={exportLogs}
              preview={exportQuery}
              downloadError={downloadError}
              downloadPending={downloadPending}
              canDownload={canDownloadExport}
              onDownload={() => void downloadFilteredCsv()}
            />
          </TabsContent>
        )}
      </section>
    </Tabs>
  );
}
