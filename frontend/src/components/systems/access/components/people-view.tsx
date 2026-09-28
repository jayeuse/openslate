"use client";

import { useEffect, useMemo, useState } from "react";
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
import {
  completeCollection,
  pageCollection,
} from "@/components/systems/shared/helpers/sample-collections";

import {
  departmentListOptions,
  groupListOptions,
  userListOptions,
} from "../adapters/access-queries";
import {
  activeFilterCount,
  defaultDirectoryFilters,
  directoryFiltersFromParams,
  directoryRows,
  filterDirectory,
  formatDate,
  roleLabels,
  type DirectoryFilters,
  type DirectoryRow,
  type DirectorySort,
} from "../helpers/people";
import { AccessSearchToolbar } from "./access-search-toolbar";
import { InvitePersonDialog } from "./invite-person-dialog";
import { SelectField } from "./people-fields";
import { PersonPanel } from "./person-panel";
import { openRowClassName, RowOpenButton } from "./row-open-button";

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

function StatusBadges({ row }: { row: DirectoryRow }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant={row.state.tone}>{row.state.label}</Badge>
      {row.state.expiresSoon ? (
        <Badge variant="warning">Ends {formatDate(row.user.expires_at)}</Badge>
      ) : null}
    </span>
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

function DepartmentList({ row }: { row: DirectoryRow }) {
  if (row.allDepartments) return <span>All departments</span>;
  return <NameList items={row.departments} empty="None" />;
}

function OpenPersonButton({
  row,
  onOpen,
}: {
  row: DirectoryRow;
  onOpen: (id: string) => void;
}) {
  return (
    <RowOpenButton
      title={row.name}
      subtitle={row.user.username}
      onOpen={() => onOpen(row.user.id)}
    />
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
  const users = useQuery(userListOptions("include"));
  const groups = useQuery(groupListOptions("exclude"));
  const departments = useQuery(departmentListOptions("exclude"));
  // An Overview link can open the directory already filtered.
  const [filters, setFilters] = useState<DirectoryFilters>(() =>
    directoryFiltersFromParams(searchParams),
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TABLE_PAGE_SIZE);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [now] = useState(() => Date.now());

  const rows = useMemo(
    () =>
      users.data && groups.data && departments.data
        ? directoryRows(users.data, groups.data, departments.data, now)
        : null,
    [departments.data, groups.data, now, users.data],
  );
  const selectedId = searchParams.get("user");
  const selected = rows?.find((row) => row.user.id === selectedId) ?? null;

  // A link to a person who is not in the directory opens the list instead.
  useEffect(() => {
    if (rows && selectedId && !rows.some((row) => row.user.id === selectedId))
      replaceUserParam(null);
  }, [rows, selectedId]);

  const denied = [users.error, groups.error, departments.error].some(
    (error) => error instanceof ApiError && error.status === 403,
  );
  const failed = users.isError || groups.isError || departments.isError;
  const loading = !failed && rows === null;

  function changeFilters(patch: Partial<DirectoryFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPageIndex(0);
  }

  const filtered = rows ? filterDirectory(rows, filters) : [];
  const page = pageCollection(
    completeCollection(filtered, "access-people"),
    pageIndex * pageSize,
    pageSize,
  );
  const filterCount = activeFilterCount(filters);
  const narrowed = filterCount > 0 || filters.query.trim() !== "";

  const columns: DataTableColumn<DirectoryRow>[] = [
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
        <span className="break-all">{row.original.user.email}</span>
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
          <NameList items={row.original.groups} empty="None" />
        ),
    },
    {
      id: "departments",
      header: "Departments",
      cell: ({ row }) => <DepartmentList row={row.original} />,
    },
  ];

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
            if (groups.isError) void groups.refetch();
            if (departments.isError) void departments.refetch();
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
          {rows
            ? `${rows.filter((row) => row.state.id !== "deleted").length} people`
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
        <SelectField
          id="people-group-filter"
          label="Group"
          value={filters.groupId}
          options={[
            { value: "all", label: "All groups" },
            { value: "none", label: "In no group" },
            ...(groups.data ?? []).map((group) => ({
              value: group.id,
              label: group.name,
            })),
          ]}
          onChange={(groupId) => changeFilters({ groupId })}
        />
        <SelectField
          id="people-department-filter"
          label="Department"
          value={filters.departmentId}
          options={[
            { value: "all", label: "All departments" },
            ...(departments.data ?? []).map((department) => ({
              value: department.id,
              label: department.department_name,
            })),
          ]}
          onChange={(departmentId) => changeFilters({ departmentId })}
        />
      </AccessSearchToolbar>

      <LoadingRegion
        loading={loading}
        label="Loading people…"
        skeleton={<DirectorySkeleton />}
      >
        {filtered.length === 0 ? (
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
                            <NameList items={row.groups} empty="None" />
                          )}
                        </dd>
                        <dt className="text-muted-foreground">Departments</dt>
                        <dd className="min-w-0">
                          <DepartmentList row={row} />
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

      <PersonPanel
        row={selected}
        people={users.data ?? []}
        listFresh={!users.isFetching && !users.isError}
        onClose={() => replaceUserParam(null)}
      />
      <InvitePersonDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        people={users.data ?? []}
        groups={groups.data ?? []}
      />
    </div>
  );
}
