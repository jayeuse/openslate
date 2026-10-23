"use client";

import { useState, useSyncExternalStore } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Plus, UserRoundPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import { ApiError } from "@/lib/api";
import { formatWorkspaceDateTime } from "@/lib/date-time-display";

import {
  accessAdminSessionsOptions,
  accessSecurityEventsOptions,
  OVERVIEW_FEED_MAX_ROWS,
  overviewGroupsOptions,
  overviewSessionsRequest,
  overviewSignInRequests,
  groupListOptions,
  statusCountOptions,
  userListOptions,
  userSummaryOptions,
} from "../adapters/access-queries";
import { accessCatalogOptions } from "../hooks/use-access-catalog";
import {
  attentionItems,
  departmentAccess,
  lastSignInSegments,
  signedInNow,
  signInPage,
  signInWhen,
  type SignInCursor,
  type SignInRow,
} from "../helpers/overview-dashboard";
import { personName } from "../helpers/people";
import { catalogDepartments } from "../hooks/use-access-catalog";
import { useScrollCue } from "../hooks/use-scroll-cue";
import { AccessHeaderActions } from "./access-header-actions";
import { CreateGroupDialog } from "./create-group-dialog";
import { InvitePersonDialog } from "./invite-person-dialog";
import {
  AccessByDepartment,
  NeedsAttention,
  RecentSignIns,
  WhoIsHere,
  type BlockState,
  type FeedRow,
} from "./overview-blocks";

/** From 1280px the page is still and the feed shows the rows that fit. */
const stillQuery = "(min-width: 80rem)";
function subscribeStill(notify: () => void) {
  const query = window.matchMedia(stillQuery);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}
/** A feed row from 1280px; the body height divided by it is the page. */
const FEED_ROW_PX = 40;
/** Below 1280px the page scrolls, so the feed shows a fixed page. */
const FEED_PHONE_ROWS = 10;

/** The people one names lookup covers: the feed page and the first chips. */
function lookupIds(
  rows: readonly SignInRow[],
  roster: readonly { id: string }[] | null,
) {
  return [
    ...new Set([
      ...rows.flatMap((row) => (row.personId ? [row.personId] : [])),
      ...(roster ?? []).slice(0, 3).map((person) => person.id),
    ]),
  ].sort();
}
const namesOptions = (ids: string[]) =>
  userListOptions("include", {
    ids,
    limit: Math.max(1, ids.length),
    offset: 0,
  });

/** The department catalog page People rows use for their marks. */
const overviewDepartmentsOptions = () =>
  accessCatalogOptions("departments", {
    limit: 25,
    offset: 0,
    search: "",
    deleted: "exclude",
  });

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The Overview's line under the title: its group and department totals.
 * The reads are the Overview's own, so the line costs no request. A space
 * holds the line while they load, so nothing below it moves.
 */
export function useOverviewMeta(enabled: boolean): string {
  const groups = useQuery({ ...overviewGroupsOptions(), enabled });
  const departments = useQuery({ ...overviewDepartmentsOptions(), enabled });
  if (!enabled) return "";
  if (!groups.data || !departments.data) return " ";
  return `${plural(groups.data.pagination.total, "group", "groups")} · ${plural(
    departments.data.pagination.total,
    "department",
    "departments",
  )}`;
}

/** Retry only the reads of a block that failed. */
function retryFailed(queries: readonly UseQueryResult[]) {
  return () => {
    for (const query of queries) if (query.isError) void query.refetch();
  };
}

function blockState<Data>(
  queries: readonly UseQueryResult[],
  build: () => Data | null,
): BlockState<Data> {
  if (queries.some((query) => query.isError))
    return { status: "error", retry: retryFailed(queries) };
  const data = queries.every((query) => query.data !== undefined)
    ? build()
    : null;
  return data === null ? { status: "loading" } : { status: "ready", data };
}

/**
 * The administrator's dashboard: who is here, recent sign-ins, what needs
 * attention, and access by department. Every count comes from an existing
 * read; each block loads, fails and retries on its own.
 */
export function OverviewView() {
  const client = useQueryClient();
  const router = useRouter();
  const region = useWorkspaceDisplayRegion();
  const viewerId = useVerifiedWorkspaceUserId();
  const [now] = useState(() => Date.now());
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // One-row totals, shared with the People status filters.
  const administrators = useQuery(
    userListOptions("exclude", {
      role: "admin",
      status: "active",
      limit: 1,
      offset: 0,
    }),
  );
  const unassigned = useQuery(
    userListOptions("exclude", { group_id: "none", limit: 1, offset: 0 }),
  );
  const noAccess = useQuery(
    groupListOptions("exclude", { without_access: true, limit: 1, offset: 0 }),
  );
  const noMembers = useQuery(
    groupListOptions("exclude", { without_members: true, limit: 1, offset: 0 }),
  );
  const ending = useQuery(statusCountOptions("ending"));
  const pending = useQuery(statusCountOptions("pending"));
  const active = useQuery(statusCountOptions("active"));
  // Who's here leaves disabled people out and says how many (People's
  // Disabled total, the same one-row read).
  const disabled = useQuery(statusCountOptions("disabled"));
  // The activity windows: active people inactive for more than 1, 7, 30 days.
  const day = useQuery(userSummaryOptions(1));
  const week = useQuery(userSummaryOptions(7));
  const month = useQuery(userSummaryOptions(30));
  const sessions = useQuery(
    accessAdminSessionsOptions(client, overviewSessionsRequest),
  );
  // The sign-in feed pages by time from a cursor; each page's reads are
  // cached under their cursor.
  const still = useSyncExternalStore(
    subscribeStill,
    () => window.matchMedia(stillQuery).matches,
    () => false,
  );
  const [feedBody, feedCue] = useScrollCue();
  const pageSize = !still
    ? FEED_PHONE_ROWS
    : feedCue.height === null
      ? null
      : Math.min(
          OVERVIEW_FEED_MAX_ROWS,
          Math.max(1, Math.floor(feedCue.height / FEED_ROW_PX)),
        );
  const [cursor, setCursor] = useState<SignInCursor>(null);
  const [turning, setTurning] = useState(false);
  const [signInRequest, lockoutRequest] = overviewSignInRequests(cursor);
  const signIns = useQuery(accessSecurityEventsOptions(client, signInRequest));
  const lockouts = useQuery(
    accessSecurityEventsOptions(client, lockoutRequest),
  );
  const groups = useQuery(overviewGroupsOptions());
  const departments = useQuery(overviewDepartmentsOptions());
  // Guests are capped at Read; group members carry no role, so one bounded
  // read of the guests applies the cap.
  const guests = useQuery(
    userListOptions("exclude", { role: "guest", limit: 100, offset: 0 }),
  );

  // The viewer's own chip goes last, after the other people signed in.
  const signedIn = sessions.data ? signedInNow(sessions.data.items) : null;
  const roster = signedIn
    ? [
        ...signedIn.filter((person) => person.id !== viewerId),
        ...signedIn.filter((person) => person.id === viewerId),
      ]
    : null;
  const page =
    signIns.data && lockouts.data && pageSize !== null
      ? signInPage([signIns.data.items, lockouts.data.items], cursor, pageSize)
      : null;
  const feed = page?.rows ?? null;
  // One lookup names the people the feed and the roster show; it waits for
  // both reads to settle, so it runs once per page.
  const ids = lookupIds(feed ?? [], roster);
  const names = useQuery({
    ...namesOptions(ids),
    enabled: feed !== null && !sessions.isPending && ids.length > 0,
  });

  /**
   * Turn the feed a page. The next page's reads and names load first while
   * the current page stays, so no row shows without its name. Newer that
   * reaches the newest events lands on the first page.
   */
  async function turn(direction: "older" | "newer") {
    if (!page || turning || pageSize === null) return;
    const edge = direction === "older" ? page.rows.at(-1) : page.rows[0];
    if (!edge) return;
    const read = async (next: SignInCursor) => {
      const [events, locks] = await Promise.all(
        overviewSignInRequests(next).map((request) =>
          client.fetchQuery(accessSecurityEventsOptions(client, request)),
        ),
      );
      return signInPage([events.items, locks.items], next, pageSize);
    };
    let next: SignInCursor = { direction, at: edge.occurredAt, id: edge.id };
    setTurning(true);
    try {
      let target = await read(next);
      if (direction === "newer" && !target.hasNewer) {
        next = null;
        target = await read(next);
      }
      const named = lookupIds(target.rows, roster);
      if (named.length && !sessions.isPending)
        await client.fetchQuery(namesOptions(named));
    } catch {
      // The block shows the failed read with Retry.
    } finally {
      setCursor(next);
      setTurning(false);
    }
  }
  const people = new Map(
    (names.data?.items ?? []).map((user) => [user.id, user]),
  );

  const all = [
    administrators,
    unassigned,
    noAccess,
    noMembers,
    ending,
    pending,
    active,
    disabled,
    day,
    week,
    month,
    sessions,
    signIns,
    lockouts,
    groups,
    departments,
    guests,
  ];
  const denied = all.some(
    (query) =>
      query.error instanceof ApiError &&
      [401, 403].includes(query.error.status),
  );

  const presence = blockState(
    [day, week, month, active, pending, disabled, sessions],
    () =>
      day.data &&
      week.data &&
      month.data &&
      active.data &&
      pending.data &&
      disabled.data &&
      roster
        ? {
            bar: lastSignInSegments({
              active: active.data.pagination.total,
              pending: pending.data.pagination.total,
              signedInNow: roster.length,
              inactive: {
                1: day.data.inactive_people,
                7: week.data.inactive_people,
                30: month.data.inactive_people,
              },
              neverSignedIn: month.data.no_recorded_sign_in,
            }),
            disabled: disabled.data.pagination.total,
            roster: roster.map((person) => ({
              id: person.id,
              label: person.id === viewerId ? "You" : person.name,
              name: person.name,
              avatarUrl: people.get(person.id)?.avatar_url ?? null,
            })),
            partial: sessions.data?.pagination.has_more ?? false,
          }
        : null,
  );

  const feedState = blockState<FeedRow[]>(
    [signIns, lockouts, ...(ids.length ? [names] : [])],
    () => {
      if (!feed) return null;
      const online = new Set((roster ?? []).map((person) => person.id));
      return feed.map((row) => {
        const user = row.personId ? people.get(row.personId) : undefined;
        const name = user
          ? personName(user)
          : row.personId
            ? "Former member"
            : "Unknown account";
        return {
          id: row.id,
          ...signInWhen(row.occurredAt, now, region),
          dateTime: row.occurredAt,
          label: row.personId === viewerId ? "You" : name,
          name,
          person: row.personId
            ? {
                avatarUrl: user?.avatar_url ?? null,
                online: online.has(row.personId),
              }
            : null,
          address: row.address,
          result: row.result,
        };
      });
    },
  );

  const counts = [
    administrators,
    month,
    pending,
    unassigned,
    noAccess,
    noMembers,
    ending,
  ];
  const attention = blockState(counts, () =>
    administrators.data &&
    month.data &&
    pending.data &&
    unassigned.data &&
    noAccess.data &&
    noMembers.data &&
    ending.data
      ? attentionItems({
          administrators: administrators.data.pagination.total,
          adminsWithoutTwoStep: month.data.admins_without_mfa,
          adminsTwoStepUnknown: month.data.admins_mfa_unknown,
          pendingInvitations: pending.data.pagination.total,
          withoutGroup: unassigned.data.pagination.total,
          groupsWithoutAccess: noAccess.data.pagination.total,
          groupsWithoutMembers: noMembers.data.pagination.total,
          guestsEndingSoon: ending.data.pagination.total,
        })
      : null,
  );

  const byDepartment = blockState([groups, departments, guests], () => {
    if (!groups.data || !departments.data || !guests.data) return null;
    const catalog = catalogDepartments(departments.data.items).map(
      (department) => ({ id: department.id, name: department.department_name }),
    );
    const rows = departmentAccess(
      catalog,
      groups.data.items,
      new Set(guests.data.items.map((guest) => guest.id)),
    ).map((row, index) => ({ ...row, index }));
    const groupTotal = groups.data.pagination.total;
    const departmentTotal = departments.data.pagination.total;
    return {
      rows,
      administrators: administrators.data?.pagination.total ?? null,
      partial:
        groupTotal > groups.data.items.length
          ? `Counts from the first ${groups.data.items.length} of ${groupTotal} groups.`
          : departmentTotal > rows.length
            ? `Showing the first ${rows.length} of ${departmentTotal} departments.`
            : guests.data.pagination.total > guests.data.items.length
              ? `Guests capped at Read from the first ${guests.data.items.length} guests.`
              : null,
    };
  });

  if (denied)
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Only administrators can see the overview</EmptyTitle>
          <EmptyDescription>
            Ask an administrator if you need to check who has access.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <div className="access-overview flex min-w-0 flex-col gap-4">
      <AccessHeaderActions>
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => setCreateOpen(true)}
        >
          <Plus aria-hidden="true" />
          Create group
        </Button>
        <Button className="min-h-11" onClick={() => setInviteOpen(true)}>
          <UserRoundPlus aria-hidden="true" />
          Invite person
        </Button>
      </AccessHeaderActions>
      <WhoIsHere
        state={presence}
        asOf={
          month.data ? (
            <span className="text-muted-foreground text-sm tabular-nums">
              As of{" "}
              <time dateTime={month.data.as_of}>
                {region
                  ? formatWorkspaceDateTime(month.data.as_of, region, {
                      timeStyle: "short",
                    })
                  : new Intl.DateTimeFormat(undefined, {
                      timeStyle: "short",
                    }).format(new Date(month.data.as_of))}
              </time>
            </span>
          ) : null
        }
      />
      <RecentSignIns
        state={feedState}
        bodyRef={feedBody}
        rows={pageSize ?? FEED_PHONE_ROWS}
        pager={
          page
            ? {
                hasNewer: page.hasNewer,
                hasOlder: page.hasOlder,
                turning,
                onNewer: () => void turn("newer"),
                onOlder: () => void turn("older"),
              }
            : null
        }
      />
      <NeedsAttention state={attention} />
      <AccessByDepartment state={byDepartment} />
      <InvitePersonDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onFound={(userId) =>
          router.push(`/access?view=people&user=${userId}` as Route)
        }
      />
      <CreateGroupDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(group) =>
          router.push(`/access?view=groups&group=${group.id}` as Route)
        }
      />
    </div>
  );
}
