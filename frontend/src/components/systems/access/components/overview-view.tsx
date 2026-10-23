"use client";

import { useState } from "react";
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
import {
  formatWorkspaceDateTime,
  type WorkspaceRegion,
} from "@/lib/date-time-display";

import {
  accessAdminSessionsOptions,
  accessSecurityEventsOptions,
  OVERVIEW_SIGN_IN_ROWS,
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
  recentSignIns,
  signedInNow,
} from "../helpers/overview-dashboard";
import { personName } from "../helpers/people";
import { catalogDepartments } from "../hooks/use-access-catalog";
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

function sameDay(left: Date, right: Date, region: WorkspaceRegion | undefined) {
  const day = (value: Date) =>
    region
      ? formatWorkspaceDateTime(value.toISOString(), region, {
          dateStyle: "short",
        })
      : value.toDateString();
  return day(left) === day(right);
}

/** "7:51 AM" today, "Yesterday", or "Oct 3" before. */
function signInWhen(
  value: string,
  now: number,
  region: WorkspaceRegion | undefined,
) {
  const date = new Date(value);
  const format = (options: Intl.DateTimeFormatOptions) =>
    region
      ? formatWorkspaceDateTime(value, region, options)
      : new Intl.DateTimeFormat(undefined, options).format(date);
  if (sameDay(date, new Date(now), region))
    return format({ timeStyle: "short" });
  if (sameDay(date, new Date(now - 86_400_000), region)) return "Yesterday";
  return format({ month: "short", day: "numeric" });
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
  // The activity windows: active people inactive for more than 1, 7, 30 days.
  const day = useQuery(userSummaryOptions(1));
  const week = useQuery(userSummaryOptions(7));
  const month = useQuery(userSummaryOptions(30));
  const sessions = useQuery(
    accessAdminSessionsOptions(client, overviewSessionsRequest),
  );
  const signIns = useQuery(
    accessSecurityEventsOptions(client, overviewSignInRequests[0]),
  );
  const lockouts = useQuery(
    accessSecurityEventsOptions(client, overviewSignInRequests[1]),
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
  const feed =
    signIns.data && lockouts.data
      ? recentSignIns(
          [signIns.data.items, lockouts.data.items],
          OVERVIEW_SIGN_IN_ROWS,
        )
      : null;
  // One lookup names the people the feed and the roster show; it waits for
  // both reads to settle, so it runs once.
  const ids = [
    ...new Set([
      ...(feed ?? []).flatMap((row) => (row.personId ? [row.personId] : [])),
      ...(roster ?? []).slice(0, 3).map((person) => person.id),
    ]),
  ].sort();
  const names = useQuery({
    ...userListOptions("include", {
      ids,
      limit: Math.max(1, ids.length),
      offset: 0,
    }),
    enabled: feed !== null && !sessions.isPending && ids.length > 0,
  });
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
    [day, week, month, active, pending, sessions],
    () =>
      day.data &&
      week.data &&
      month.data &&
      active.data &&
      pending.data &&
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
          when: signInWhen(row.occurredAt, now, region),
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
      <RecentSignIns state={feedState} />
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
