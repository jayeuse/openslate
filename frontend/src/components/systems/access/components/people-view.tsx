"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Search, UserRoundPlus, UsersRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DEFAULT_TABLE_PAGE_SIZE,
  TablePagination,
} from "@/components/ui/table-pagination";
import { ApiError } from "@/lib/api";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";

import {
  directoryPageOptions,
  userListOptions,
} from "../adapters/access-queries";
import {
  activeFilterCount,
  defaultDirectoryFilters,
  directoryFiltersFromParams,
  directoryRows,
  directoryRequest,
  formatDate,
  formatDateTime,
  roleLabels,
  type DirectoryFilters,
  type DirectoryRow,
  type DirectorySort,
} from "../helpers/people";
import type { AccessDirectoryUser } from "../state/api";
import { AccessSearchToolbar } from "./access-search-toolbar";
import { InvitePersonDialog } from "./invite-person-dialog";
import { SelectField } from "./people-fields";
import { usePeopleSearch } from "../hooks/use-people-search";
import {
  usePeopleMemberships,
  type PersonMemberships,
} from "../hooks/use-people-memberships";
import {
  useAccessCatalog,
  catalogDepartments,
  catalogGroups,
} from "../hooks/use-access-catalog";
import { Input } from "@/components/ui/input";
import { PersonPanel } from "./person-panel";
import { openRowClassName } from "./row-open-button";
import { PersonCardPopover } from "@/components/person-card";

const sortOptions: readonly { value: DirectorySort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "email", label: "Email" },
  { value: "newest", label: "Newest first" },
  { value: "expiry", label: "Access ends soonest" },
];

const statusOptions = [
  { value: "current", label: "Everyone but deleted" },
  { value: "active", label: "Active" },
  { value: "pending", label: "Pending" },
  { value: "disabled", label: "Disabled" },
  { value: "expired", label: "Expired" },
  { value: "ending", label: "Access ends soon" },
  { value: "deleted", label: "Deleted" },
  { value: "all", label: "Everyone" },
] as const;

/** Replace the `user` parameter without a navigation or a history entry. */
function replaceUserParam(userId: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "people");
  if (userId) url.searchParams.set("user", userId);
  else url.searchParams.delete("user");
  // Next syncs useSearchParams only for calls without its own history state.
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

// Below 2xl the table drops the session count (the person panel shows it) and
// merges sign-in and activity, so names and emails keep whole words.
const wideQuery = "(min-width: 96rem)";
function subscribeWide(notify: () => void) {
  const query = window.matchMedia(wideQuery);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

function lastSeen(person: AccessDirectoryUser) {
  const { last_active_at: active, last_sign_in_at: signIn } = person;
  if (!active || !signIn) return active ?? signIn;
  return Date.parse(active) >= Date.parse(signIn) ? active : signIn;
}

function StatusBadges({ row }: { row: DirectoryRow }) {
  const region = useWorkspaceDisplayRegion();
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant={row.state.tone}>{row.state.label}</Badge>
      {row.state.expiresSoon ? (
        <Badge variant="warning">
          Ends {formatDate(row.user.expires_at, region)}
        </Badge>
      ) : null}
    </span>
  );
}

function MfaObservation({ person }: { person: AccessDirectoryUser }) {
  const region = useWorkspaceDisplayRegion();
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <Badge
        variant={person.mfa_verified_totp === true ? "success" : "outline"}
      >
        {person.mfa_verified_totp === null
          ? "Unknown"
          : person.mfa_verified_totp
            ? "Verified"
            : "Not verified"}
      </Badge>
      {person.mfa_observed_at ? (
        <span className="text-muted-foreground text-xs">
          Recorded{" "}
          <time dateTime={person.mfa_observed_at}>
            {formatDateTime(person.mfa_observed_at, region)}
          </time>
        </span>
      ) : null}
    </span>
  );
}

function RecordedHistory({
  value,
  empty,
}: {
  value: string | null;
  empty: string;
}) {
  const region = useWorkspaceDisplayRegion();
  return value === null ? (
    <span className="text-muted-foreground">{empty}</span>
  ) : (
    <time dateTime={value}>{formatDateTime(value, region)}</time>
  );
}

function NameList({
  items,
  empty,
}: {
  items: readonly { id: string; name: string }[];
  empty: string;
}) {
  if (!items.length)
    return <span className="text-muted-foreground">{empty}</span>;
  return (
    <span className="break-words">
      {items.map((item) => item.name).join(", ")}
    </span>
  );
}

type PeopleRow = DirectoryRow<AccessDirectoryUser> & {
  membership?: PersonMemberships;
};

function MembershipList({
  membership,
  departments = false,
}: {
  membership?: PersonMemberships;
  departments?: boolean;
}) {
  if (!membership || membership.loading)
    return (
      <span role="status" className="text-muted-foreground">
        Loading {departments ? "departments" : "groups"}…
      </span>
    );
  const partial = membership.hasMore || membership.loaded < membership.total;
  return (
    <div className="space-y-1">
      {!membership.denied && !(membership.error && !membership.loaded) ? (
        <>
          {departments && partial && !membership.departments.length ? null : (
            <NameList
              items={departments ? membership.departments : membership.groups}
              empty="None"
            />
          )}
          {partial ? (
            <p className="text-muted-foreground text-xs">
              {departments
                ? "Departments not fully loaded"
                : `${membership.loaded} of ${membership.total} groups`}
            </p>
          ) : null}
        </>
      ) : null}
      {membership.error ? (
        <p role="alert" className="text-muted-foreground text-sm">
          {membership.error}
        </p>
      ) : null}
      {!departments && membership.retryFirstPage ? (
        <Button
          type="button"
          variant="outline"
          className="relative z-10 min-h-11"
          disabled={membership.recovering}
          onClick={() => void membership.retry()}
        >
          Retry groups
        </Button>
      ) : null}
      {!departments && membership.hasMore ? (
        <Button
          type="button"
          variant="ghost"
          className="relative z-10 min-h-11 px-0"
          disabled={membership.loadingMore}
          onClick={() => void membership.loadMore()}
        >
          {membership.loadingMore ? "Loading more groups…" : "Load more groups"}
        </Button>
      ) : null}
    </div>
  );
}

function DepartmentList({ row }: { row: PeopleRow }) {
  if (row.allDepartments) return <span>All departments</span>;
  return <MembershipList membership={row.membership} departments />;
}

function OpenPersonButton({
  row,
  onOpen,
}: {
  row: DirectoryRow;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3">
      <div className="relative z-10 min-w-0">
        <PersonCardPopover
          personId={row.user.id}
          label={row.name}
          className="text-foreground font-medium"
          decoration="none"
        />
        <p className="text-muted-foreground text-xs break-words">
          {row.user.username}
        </p>
      </div>
      <button
        type="button"
        aria-label={`Manage ${row.name}`}
        className="text-primary focus-visible:outline-ring inline-flex min-h-11 items-center rounded-sm px-1 underline underline-offset-4 after:absolute after:inset-0 after:content-[''] focus-visible:outline-2"
        onClick={() => onOpen(row.user.id)}
      >
        Manage
      </button>
    </div>
  );
}

function DirectorySkeleton() {
  return (
    <div className="overflow-hidden rounded-md border">
      <Skeleton className="h-10 w-full rounded-none" />
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-center gap-4 border-t p-3">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="hidden h-5 w-48 md:block" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="hidden h-5 w-32 md:block" />
        </div>
      ))}
    </div>
  );
}

export function PeopleView() {
  const searchParams = useSearchParams();
  // An Overview link can open the directory already filtered.
  const [filters, setFilters] = useState<DirectoryFilters>(() =>
    directoryFiltersFromParams(searchParams),
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TABLE_PAGE_SIZE);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [now] = useState(() => Date.now());
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(wideQuery).matches,
    () => false,
  );
  const selectedId = searchParams.get("user");
  const request = directoryRequest(filters, pageSize, pageIndex * pageSize);
  const users = useQuery(directoryPageOptions(request));
  // Existing person/invitation editors need the complete sponsor catalog.
  // The closed directory never loads this collection to mask server paging.
  const catalogRequested = Boolean(selectedId);
  const catalog = useQuery({
    ...userListOptions("include", {
      ids: selectedId ? [selectedId] : [],
      limit: 1,
      offset: 0,
    }),
    enabled: Boolean(selectedId),
  });

  useEffect(() => {
    const pagination = users.data?.pagination;
    if (!pagination) return;
    // A confirmed edit can shrink the matching population. Keep a valid page;
    // move only an out-of-range page, without changing the selected person.
    const lastPage = Math.max(0, Math.ceil(pagination.total / pageSize) - 1);
    setPageIndex((current) => Math.min(current, lastPage));
  }, [pageSize, users.data?.pagination]);

  const memberships = usePeopleMemberships([
    ...(users.data?.items ?? []),
    ...(catalog.data?.items ?? []),
  ]);
  const prepareRows = (items: readonly AccessDirectoryUser[]): PeopleRow[] =>
    directoryRows(items, [], [], now).map((row) => {
      const membership = memberships.get(row.user.id);
      return {
        ...row,
        groups: membership?.groups ?? [],
        departments: membership?.departments ?? [],
        membership,
      };
    });
  const rows = users.data ? prepareRows(users.data.items) : null;
  const catalogRows = catalog.data ? prepareRows(catalog.data.items) : null;
  // The include-deleted catalog also preserves offpage Restore: singular
  // detail GET intentionally returns 404 for deleted users. Loading never removes the URL.
  const selected =
    catalogRows?.find((row) => row.user.id === selectedId) ?? null;

  const sponsorNames = usePeopleSearch({
    selectedIds: selected?.user.sponsor_user_id
      ? [selected.user.sponsor_user_id]
      : [],
    enabled: Boolean(selected),
  });
  const groupFilter = useAccessCatalog({
    kind: "groups",
    selectedIds: !["all", "none"].includes(filters.groupId)
      ? [filters.groupId]
      : [],
  });
  const departmentFilter = useAccessCatalog({
    kind: "departments",
    selectedIds: filters.departmentId === "all" ? [] : [filters.departmentId],
  });
  const people = [
    ...(catalog.data?.items ?? []),
    ...sponsorNames.selectedItems.filter(
      (item): item is AccessDirectoryUser => "is_deleted" in item,
    ),
  ];

  const denied = [users.error, catalogRequested ? catalog.error : null].some(
    (error) => error instanceof ApiError && error.status === 403,
  );
  const failed = users.isError || (catalogRequested && catalog.isError);
  const loading = !failed && rows === null;

  function changeFilters(patch: Partial<DirectoryFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPageIndex(0);
  }

  const page = {
    items: rows ?? [],
    total: users.data?.pagination.total ?? 0,
    offset: users.data?.pagination.offset ?? request.offset ?? 0,
  };
  const filterCount = activeFilterCount(filters);
  const narrowed = filterCount > 0 || filters.query.trim() !== "";

  const columns = useMemo<DataTableColumn<PeopleRow>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => (
          <OpenPersonButton row={row.original} onOpen={replaceUserParam} />
        ),
      },
      {
        id: "email",
        header: "Email",
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{row.original.user.email}</span>
        ),
      },
      {
        id: "role",
        header: "Role",
        cell: ({ row }) => roleLabels[row.original.user.role],
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadges row={row.original} />,
      },
      {
        id: "groups",
        header: "Groups",
        cell: ({ row }) =>
          row.original.user.role === "admin" ? (
            <span className="text-muted-foreground">Not needed</span>
          ) : (
            <MembershipList membership={row.original.membership} />
          ),
      },
      {
        id: "departments",
        header: "Departments",
        cell: ({ row }) => <DepartmentList row={row.original} />,
      },
      {
        id: "mfa",
        header: "Two-step verification",
        cell: ({ row }) => <MfaObservation person={row.original.user} />,
      },
      ...(wide
        ? ([
            {
              id: "sessions",
              header: "Active sessions",
              cell: ({ row }) => (
                <span className="tabular-nums">
                  {row.original.user.active_session_count}
                </span>
              ),
            },
            {
              id: "last-sign-in",
              header: "Last sign-in",
              cell: ({ row }) => (
                <RecordedHistory
                  value={row.original.user.last_sign_in_at}
                  empty="No recorded sign-in"
                />
              ),
            },
            {
              id: "last-activity",
              header: "Last activity",
              cell: ({ row }) => (
                <RecordedHistory
                  value={row.original.user.last_active_at}
                  empty="No recorded activity"
                />
              ),
            },
          ] satisfies DataTableColumn<PeopleRow>[])
        : ([
            {
              id: "last-seen",
              header: "Last seen",
              cell: ({ row }) => (
                <RecordedHistory
                  value={lastSeen(row.original.user)}
                  empty="No recorded sign-in"
                />
              ),
            },
          ] satisfies DataTableColumn<PeopleRow>[])),
    ],
    [wide],
  );

  if (denied)
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Only administrators can see people</EmptyTitle>
          <EmptyDescription>
            Ask an administrator if you need to invite or change someone.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  if (failed)
    return (
      <div role="alert" className="max-w-lg space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-base font-semibold">
            People could not be loaded
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Check your connection and try again.
          </p>
        </div>
        <Button
          className="min-h-11"
          onClick={() => {
            if (users.isError) void users.refetch();
            if (catalogRequested && catalog.isError) void catalog.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="people-directory" className="sr-only">
          People directory
        </h2>
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {users.data
            ? `${users.data.pagination.total} ${users.data.pagination.total === 1 ? "person" : "people"}`
            : " "}
        </p>
        <Button
          className="min-h-11 w-full sm:w-auto"
          disabled={rows === null}
          onClick={() => setInviteOpen(true)}
        >
          <UserRoundPlus aria-hidden="true" />
          Invite person
        </Button>
      </div>

      {filters.history && filters.history !== "all" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <p className="text-muted-foreground">
            {filters.history === "no-recorded-sign-in"
              ? "Showing active people with no recorded sign-in."
              : `Showing active people with recorded activity older than ${filters.inactiveDays} days.`}
          </p>
          <Button
            variant="ghost"
            className="text-primary min-h-11 px-0 underline underline-offset-4 hover:bg-transparent"
            onClick={() => changeFilters({ history: "all" })}
          >
            Clear history filter
          </Button>
        </div>
      ) : null}

      <AccessSearchToolbar
        searchLabel="Search people"
        placeholder="Name, email, username, or job title"
        query={filters.query}
        onQueryChange={(query) => changeFilters({ query })}
        sort={filters.sort}
        sortOptions={sortOptions}
        onSortChange={(sort) => changeFilters({ sort })}
        activeFilterCount={filterCount}
        sortInFiltersBelowMd
      >
        <SelectField
          id="people-role-filter"
          label="Role"
          value={filters.role}
          options={[
            { value: "all", label: "All roles" },
            { value: "admin", label: roleLabels.admin },
            { value: "member", label: roleLabels.member },
            { value: "guest", label: roleLabels.guest },
          ]}
          onChange={(role) => {
            if (
              role === "all" ||
              role === "admin" ||
              role === "member" ||
              role === "guest"
            )
              changeFilters({ role });
          }}
        />
        <SelectField
          id="people-status-filter"
          label="Status"
          value={filters.status}
          options={statusOptions}
          onChange={(status) => {
            const option = statusOptions.find((item) => item.value === status);
            if (option) changeFilters({ status: option.value });
          }}
        />
        <div className="space-y-2">
          <Input
            type="search"
            aria-label="Search group filters"
            className="min-h-11"
            value={groupFilter.search}
            onChange={(event) => groupFilter.onSearchChange(event.target.value)}
          />
          <SelectField
            id="people-group-filter"
            label="Group"
            value={filters.groupId}
            options={[
              { value: "all", label: "All groups" },
              { value: "none", label: "In no group" },
              ...catalogGroups(groupFilter.combined).map((group) => ({
                value: group.id,
                label: group.name,
              })),
            ]}
            onChange={(groupId) => changeFilters({ groupId })}
          />
          {groupFilter.error ? (
            <div role="alert">
              <p>{groupFilter.error}</p>
              <Button
                type="button"
                className="min-h-11"
                variant="outline"
                onClick={() => void groupFilter.retry()}
              >
                Retry groups
              </Button>
            </div>
          ) : null}
          {groupFilter.hasMore ? (
            <Button
              type="button"
              className="min-h-11"
              variant="outline"
              disabled={groupFilter.loadingMore}
              onClick={() => void groupFilter.loadMore()}
            >
              Load more groups
            </Button>
          ) : null}
        </div>
        <div className="space-y-2">
          <Input
            type="search"
            aria-label="Search department filters"
            className="min-h-11"
            value={departmentFilter.search}
            onChange={(event) =>
              departmentFilter.onSearchChange(event.target.value)
            }
          />
          <SelectField
            id="people-department-filter"
            label="Department"
            value={filters.departmentId}
            options={[
              { value: "all", label: "All departments" },
              ...catalogDepartments(departmentFilter.combined).map(
                (department) => ({
                  value: department.id,
                  label: department.department_name,
                }),
              ),
            ]}
            onChange={(departmentId) => changeFilters({ departmentId })}
          />
          {departmentFilter.error ? (
            <div role="alert">
              <p>{departmentFilter.error}</p>
              <Button
                type="button"
                className="min-h-11"
                variant="outline"
                onClick={() => void departmentFilter.retry()}
              >
                Retry departments
              </Button>
            </div>
          ) : null}
          {departmentFilter.hasMore ? (
            <Button
              type="button"
              className="min-h-11"
              variant="outline"
              disabled={departmentFilter.loadingMore}
              onClick={() => void departmentFilter.loadMore()}
            >
              Load more departments
            </Button>
          ) : null}
        </div>
        <SelectField
          id="people-mfa-filter"
          label="Administrator two-step verification"
          value={filters.mfa ?? "all"}
          options={[
            { value: "all", label: "Any status" },
            { value: "without", label: "Not set up" },
            { value: "unknown", label: "Unknown" },
          ]}
          onChange={(mfa) => {
            if (mfa === "all" || mfa === "without" || mfa === "unknown")
              changeFilters({ mfa });
          }}
        />
      </AccessSearchToolbar>

      <LoadingRegion
        loading={loading}
        label="Loading people…"
        skeleton={<DirectorySkeleton />}
      >
        {page.items.length === 0 ? (
          <Empty className="min-h-64 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {narrowed ? <Search /> : <UsersRound />}
              </EmptyMedia>
              <EmptyTitle>
                {narrowed ? "No one matches" : "No people yet"}
              </EmptyTitle>
              <EmptyDescription>
                {narrowed
                  ? "Change the search or filters to see more people."
                  : "Invite the first person to your workspace."}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {narrowed ? (
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    setFilters(defaultDirectoryFilters);
                    setPageIndex(0);
                  }}
                >
                  Clear search and filters
                </Button>
              ) : (
                <Button
                  className="min-h-11"
                  onClick={() => setInviteOpen(true)}
                >
                  <UserRoundPlus aria-hidden="true" />
                  Invite person
                </Button>
              )}
            </EmptyContent>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <div className="hidden md:block">
              <DataTable
                ariaLabel="People"
                columns={columns}
                data={[...page.items]}
                cellClassName="py-2 align-top whitespace-normal"
                getRowId={(row) => row.user.id}
                rowClassName={() => openRowClassName}
              />
            </div>
            <ul
              aria-label="People"
              className="grid min-w-0 gap-3 p-3 md:hidden"
            >
              {page.items.map((row) => (
                <li key={row.user.id} className="min-w-0">
                  <Card className={`min-w-0 ${openRowClassName}`}>
                    <CardContent className="min-w-0 space-y-3 p-4">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <OpenPersonButton row={row} onOpen={replaceUserParam} />
                        <StatusBadges row={row} />
                      </div>
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-muted-foreground">Email</dt>
                        <dd className="min-w-0 break-all">{row.user.email}</dd>
                        <dt className="text-muted-foreground">Role</dt>
                        <dd>{roleLabels[row.user.role]}</dd>
                        <dt className="text-muted-foreground">Groups</dt>
                        <dd className="min-w-0">
                          {row.user.role === "admin" ? (
                            <span className="text-muted-foreground">
                              Not needed
                            </span>
                          ) : (
                            <MembershipList membership={row.membership} />
                          )}
                        </dd>
                        <dt className="text-muted-foreground">Departments</dt>
                        <dd className="min-w-0">
                          <DepartmentList row={row} />
                        </dd>
                        <dt className="text-muted-foreground">
                          Two-step verification
                        </dt>
                        <dd className="min-w-0">
                          <MfaObservation person={row.user} />
                        </dd>
                        <dt className="text-muted-foreground">Last seen</dt>
                        <dd className="min-w-0">
                          <RecordedHistory
                            value={lastSeen(row.user)}
                            empty="No recorded sign-in"
                          />
                        </dd>
                      </dl>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
            <TablePagination
              ariaLabel="People pages"
              total={page.total}
              offset={page.offset}
              rowCount={page.items.length}
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

      {selectedId && !selected ? (
        <p role="status" className="text-muted-foreground text-sm">
          {catalog.isPending || catalog.isFetching
            ? "Loading selected person…"
            : "This person is not available in the directory."}
        </p>
      ) : null}

      <PersonPanel
        row={selected}
        membership={selected?.membership}
        people={people}
        listFresh={
          !catalog.isFetching && !catalog.isError && !catalog.isPending
        }
        onClose={() => replaceUserParam(null)}
      />
      <InvitePersonDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}
