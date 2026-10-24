"use client";
import { useDisplayRegion } from "@/components/use-display-region";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import { X } from "lucide-react";
import { z } from "zod";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { LoadingRegion } from "@/components/ui/loading-region";
import {
  DEFAULT_TABLE_PAGE_SIZE,
  TablePagination,
} from "@/components/ui/table-pagination";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { usePeopleSearch } from "../hooks/use-people-search";
import { ApiError } from "@/lib/api";
import { type WorkspaceRegion } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import { workspaceCalendarQueryOptions } from "../../manage/adapters/workspace-api";
import {
  accessKeys,
  accessSecurityEventsOptions,
  isAccessSecurityDenied,
  readAccessSecurityEvent,
  setAccessSecurityDenied,
} from "../adapters/access-queries";
import {
  defaultSecurityEventsRequest,
  type AccessSecurityEvent,
} from "../adapters/security-events-api";
import {
  securityEventSentence,
  type PersonNames,
} from "../helpers/security-event-sentences";
import { openRowClassName, tintRowClassName } from "./row-open-button";
import {
  EventTime,
  OutcomeWord,
  SecurityEventFacts,
  eventName,
  localTime,
} from "./security-event-facts";
import {
  SecurityEventsToolbar,
  initialSecurityEventFilters as initialFilters,
  type SecurityEventFilters as Filters,
} from "./security-events-toolbar";
import { TableSkeleton } from "./table-skeleton";

type Detail =
  | { id: string; status: "loading" | "error" }
  | { id: string; status: "ready"; event: AccessSecurityEvent };
type SecurityEventsViewProps = {
  active: boolean;
  admitted: boolean;
  pending: boolean;
  onReadChange: () => void;
};

/** The instant a calendar day starts in the workspace (or this device's) zone. */
function dayStart(day: string, region: WorkspaceRegion | undefined, add = 0) {
  const timeZone =
    region?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Temporal.PlainDate.from(day)
    .add({ days: add })
    .toZonedDateTime({ timeZone })
    .toInstant()
    .toString();
}
/** Read-only child: the Audit host retains admission and refusal ownership. */
export function SecurityEventsView({
  active,
  admitted,
  pending,
  onReadChange,
}: SecurityEventsViewProps) {
  const client = useQueryClient();
  const id = useId();
  const [filters, setFilters] = useState(initialFilters);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_TABLE_PAGE_SIZE);
  const [directoryRequested, setDirectoryRequested] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const detailOpener = useRef<HTMLElement | null>(null);
  const fallbackFocus = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);
  const refreshOwner = useRef<{
    queryKey: ReturnType<typeof accessKeys.securityEventList>;
  } | null>(null);
  const notifiedDenied = useRef(false);
  const authority = useRef({ active, admitted });
  const denied = isAccessSecurityDenied(client, "events");
  const region = useQuery({
    ...workspaceCalendarQueryOptions(),
    enabled: active && admitted,
  }).data;
  const displayRegion = useDisplayRegion(region);
  const typeError =
    filters.type === "other" && !filters.exactType.trim()
      ? "Enter an exact event type."
      : "";
  const dayError =
    (filters.from && !z.iso.date().safeParse(filters.from).success) ||
    (filters.through && !z.iso.date().safeParse(filters.through).success)
      ? "Enter a valid date."
      : filters.from && filters.through && filters.from > filters.through
        ? "Through must be on or after From."
        : "";
  const invalid = Boolean(typeError || dayError);
  const nextDay =
    filters.through && !dayError ? dayStart(filters.through, region, 1) : "";
  const request = {
    ...defaultSecurityEventsRequest,
    limit,
    offset,
    search: filters.search.trim(),
    event_type:
      filters.type === "other" ? filters.exactType.trim() : filters.type,
    outcome: filters.outcome,
    person_id: filters.person,
    occurred_after:
      filters.from && !dayError ? dayStart(filters.from, region) : "",
    occurred_before: nextDay,
    sort_by:
      filters.sort === "event"
        ? ("event_type" as const)
        : filters.sort === "outcome"
          ? ("outcome" as const)
          : ("occurred_at" as const),
    sort_order:
      filters.sort === "oldest" ||
      filters.sort === "event" ||
      filters.sort === "outcome"
        ? ("asc" as const)
        : ("desc" as const),
  };
  const stamp = JSON.stringify(request);
  const currentStamp = useRef(stamp);
  const events = useQuery({
    ...accessSecurityEventsOptions(client, request),
    enabled: active && admitted && !denied && !invalid,
  });
  const labelIds = (events.data?.items ?? [])
    .flatMap((event) => [event.actor_id, event.subject_id])
    .filter((value): value is string => Boolean(value));
  if (filters.person) labelIds.push(filters.person);
  const people = usePeopleSearch({
    selectedIds: labelIds,
    enabled: active && admitted && !denied,
  });
  const names: PersonNames = useMemo(
    () =>
      new Map(
        [...people.items, ...people.selectedItems].map((person) => [
          person.id,
          person.display_name || person.username,
        ]),
      ),
    [people.items, people.selectedItems],
  );
  const page = denied || invalid ? undefined : events.data;
  const narrowed = Boolean(
    filters.search.trim() ||
    filters.type ||
    filters.outcome ||
    filters.person ||
    filters.from ||
    filters.through,
  );
  const personOptions = [
    { value: "", label: "All people" },
    ...people.items.map((person) => ({
      value: person.id,
      label: person.display_name || person.username,
    })),
  ];
  const selectedPerson = people.selectedItems.find(
    (person) => person.id === filters.person,
  );
  const selectedPersonOption = filters.person
    ? {
        value: filters.person,
        label: selectedPerson
          ? selectedPerson.display_name || selectedPerson.username
          : people.selectedLoading
            ? "Loading person…"
            : `Person ${filters.person.slice(0, 8)}`,
      }
    : undefined;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshOwner.current = null;
      detailController.current?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    authority.current = { active, admitted };
    currentStamp.current = stamp;
    if (pending && refreshOwner.current) {
      const owner = refreshOwner.current;
      refreshOwner.current = null;
      setRefreshing(false);
      void client.cancelQueries({ queryKey: owner.queryKey, exact: true });
    }
    if (!active || !admitted || denied) {
      detailController.current?.abort();
      detailController.current = null;
      setDetail(null);
    }
  }, [active, admitted, client, denied, pending, stamp]);
  useEffect(() => {
    if (!denied) {
      notifiedDenied.current = false;
      return;
    }
    if (!active || !admitted || notifiedDenied.current) return;
    if (
      events.error instanceof ApiError &&
      (events.error.status === 401 || events.error.status === 403)
    ) {
      notifiedDenied.current = true;
      onReadChange();
    }
  }, [active, admitted, denied, events.error, onReadChange]);

  function changeFilters(patch: Partial<Filters>) {
    if (pending) return;
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  }
  function closeDetail() {
    detailController.current?.abort();
    detailController.current = null;
    setDetail(null);
  }
  const loadDetail = useCallback(
    async (eventId: string, opener?: MouseEvent<HTMLElement>) => {
      if (pending || denied || !active || !admitted) return;
      detailController.current?.abort();
      const controller = new AbortController();
      detailController.current = controller;
      if (opener) detailOpener.current = opener.currentTarget;
      setDetail({ id: eventId, status: "loading" });
      const owns = () =>
        mounted.current &&
        detailController.current === controller &&
        authority.current.active &&
        authority.current.admitted &&
        !controller.signal.aborted;
      try {
        const event = await readAccessSecurityEvent(
          client,
          eventId,
          controller.signal,
        );
        if (owns()) setDetail({ id: eventId, status: "ready", event });
      } catch (error) {
        if (!owns()) return;
        setDetail({ id: eventId, status: "error" });
        if (
          isAccessSecurityDenied(client, "events") &&
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        )
          onReadChange();
      }
    },
    [active, admitted, client, denied, onReadChange, pending],
  );
  async function refresh(retry: boolean) {
    if (pending || refreshing || invalid || !active || !admitted) return;
    const options = accessSecurityEventsOptions(client, request);
    const owner = { queryKey: options.queryKey };
    refreshOwner.current = owner;
    const readStamp = stamp;
    setRefreshing(true);
    try {
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      await client.fetchQuery({ ...options, staleTime: 0 });
      if (
        mounted.current &&
        refreshOwner.current === owner &&
        authority.current.active &&
        authority.current.admitted &&
        currentStamp.current === readStamp &&
        retry
      ) {
        setAccessSecurityDenied(client, "events", false);
        onReadChange();
      }
    } catch {
      // The query owns the safe same-key failure state. No raw server text.
    } finally {
      if (mounted.current && refreshOwner.current === owner) {
        refreshOwner.current = null;
        setRefreshing(false);
      }
    }
  }
  if (!active || !admitted) return null;
  const selectedEvent = detail?.status === "ready" ? detail.event : null;
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="manage-fill flex min-w-0 flex-col gap-3 outline-none"
      ref={fallbackFocus}
      tabIndex={-1}
    >
      <h3 id={`${id}-heading`} className="sr-only">
        Security events
      </h3>
      <fieldset disabled={pending} className="min-w-0 shrink-0">
        <SecurityEventsToolbar
          filters={filters}
          onChange={changeFilters}
          onClearFilters={() =>
            changeFilters({
              type: "",
              exactType: "",
              person: "",
              from: "",
              through: "",
            })
          }
          region={displayRegion}
          pending={pending}
          denied={denied}
          refreshDisabled={pending || refreshing || invalid || denied}
          onRefresh={() => void refresh(false)}
          people={people}
          personOptions={personOptions}
          selectedPersonOption={selectedPersonOption}
          onDirectoryRequested={() => setDirectoryRequested(true)}
          directoryRequested={directoryRequested}
          errors={{ type: typeError, day: dayError }}
        />
      </fieldset>
      {denied || events.isError ? (
        <Alert role="alert" variant="destructive" className="space-y-3">
          <p>
            {denied
              ? "Only administrators can review security events. Check your access, then retry."
              : page
                ? "Security events could not be refreshed. The previous results for these filters are still shown."
                : "Security events could not be loaded. Try again."}
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={pending || refreshing || invalid}
            onClick={() => void refresh(true)}
            aria-label="Retry security events"
          >
            Retry
          </Button>
        </Alert>
      ) : null}
      {invalid ? (
        <p className="text-muted-foreground text-sm">
          Check the filter values to review security events.
        </p>
      ) : (
        <LoadingRegion
          loading={!denied && events.isPending}
          label="Loading security events…"
          skeleton={<TableSkeleton columns={3} />}
          className="manage-fill"
        >
          {page && page.items.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>
                  {narrowed
                    ? "No security events match these filters"
                    : "No security events recorded"}
                </EmptyTitle>
                <EmptyDescription>
                  {narrowed
                    ? "Change or clear the filters to review other recorded events."
                    : "Recorded security activity will appear here. Use Refresh to check for new events."}
                </EmptyDescription>
              </EmptyHeader>
              {narrowed ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={pending}
                  onClick={() => {
                    setFilters(initialFilters);
                    setOffset(0);
                  }}
                  aria-label="Clear event filters"
                >
                  Clear search and filters
                </Button>
              ) : null}
            </Empty>
          ) : page ? (
            <div className="manage-fill bg-card flex min-w-0 flex-col overflow-hidden rounded-md border">
              <div className="manage-scroll">
                <div
                  aria-hidden="true"
                  className="bg-card text-muted-foreground sticky top-0 z-10 hidden h-9 grid-cols-[10rem_minmax(0,1fr)_7rem] items-center gap-3 border-b px-3 text-xs font-medium md:grid"
                >
                  <span>When</span>
                  <span>What happened</span>
                  <span>Outcome</span>
                </div>
                <ul aria-label="Security events" className="divide-y">
                  {page.items.map((event) => (
                    <li
                      key={event.id}
                      data-state={
                        detail?.id === event.id ? "selected" : undefined
                      }
                      className={cn(
                        openRowClassName,
                        tintRowClassName,
                        "grid min-h-14 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 text-sm md:grid-cols-[10rem_minmax(0,1fr)_7rem] xl:h-10 xl:min-h-10 xl:py-0",
                      )}
                    >
                      <EventTime
                        className="text-muted-foreground order-3 col-span-2 truncate text-xs tabular-nums md:order-none md:col-span-1 md:text-sm"
                        value={event.occurred_at}
                        region={displayRegion}
                      />
                      <button
                        type="button"
                        className="focus-visible:outline-ring -mx-1 flex min-h-11 min-w-0 items-center rounded-md px-1 text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 xl:min-h-8"
                        aria-label={`Details for ${eventName(event)} at ${localTime(event.occurred_at, displayRegion)}`}
                        onClick={(opener) => void loadDetail(event.id, opener)}
                      >
                        {/* Below 1280px the sentence wraps, so it reads
                            in full on tablets and phones (MD19). */}
                        <span className="break-words xl:truncate">
                          {securityEventSentence(event, names)}
                        </span>
                      </button>
                      <span className="min-w-0">
                        <OutcomeWord outcome={event.outcome} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {/* The shared table footer, as on Activity (Phase 8). */}
              <TablePagination
                ariaLabel="Security event pages"
                className="shrink-0 px-3 py-2 lg:py-2"
                total={page.pagination.total}
                offset={page.pagination.offset}
                rowCount={page.pagination.count}
                pageSize={page.pagination.limit}
                disabled={pending}
                onPageIndexChange={(index) => {
                  if (!pending) setOffset(index * page.pagination.limit);
                }}
                onPageSizeChange={(size) => {
                  if (pending) return;
                  setLimit(size);
                  setOffset(0);
                }}
              />
            </div>
          ) : null}
        </LoadingRegion>
      )}
      <Sheet
        open={Boolean(detail) && !denied}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
      >
        <SheetContent
          className="slim-ui flex w-full max-w-none flex-col gap-0 overflow-hidden p-0 sm:w-[min(92vw,32rem)]"
          finalFocus={() =>
            detailOpener.current?.isConnected
              ? detailOpener.current
              : fallbackFocus.current
          }
        >
          <SheetHeader className="shrink-0 border-b p-5 pr-16">
            <SheetTitle className="text-lg">Security event details</SheetTitle>
            <SheetDescription>
              What happened, when, and who it involved.
            </SheetDescription>
          </SheetHeader>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-3 right-3 size-11"
            aria-label="Close security event details"
            onClick={closeDetail}
          >
            <X aria-hidden="true" />
          </Button>
          <div className="min-h-0 flex-1 overflow-y-auto px-5">
            {detail?.status === "error" ? (
              <Alert
                role="alert"
                variant="destructive"
                className="my-4 space-y-3"
              >
                <p>Details could not be loaded. Try again.</p>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={pending}
                  onClick={() => void loadDetail(detail.id)}
                  aria-label="Retry event details"
                >
                  Retry
                </Button>
              </Alert>
            ) : (
              <LoadingRegion
                loading={detail?.status === "loading"}
                label="Loading event details…"
                skeleton={
                  <div className="space-y-3 py-4">
                    <Skeleton className="h-8 w-2/3" />
                    <Skeleton className="h-36 w-full" />
                  </div>
                }
              >
                {selectedEvent ? (
                  <SecurityEventFacts
                    event={selectedEvent}
                    names={names}
                    region={displayRegion}
                    disabled={pending}
                    onPersonFilter={(person) => {
                      if (pending) return;
                      closeDetail();
                      changeFilters({ person });
                    }}
                  />
                ) : null}
              </LoadingRegion>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
