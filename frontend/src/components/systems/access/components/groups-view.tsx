"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, UsersRound } from "lucide-react";

import { Alert } from "@/components/ui/alert";
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
  memberCandidateListOptions,
  moduleListOptions,
  userListOptions,
} from "../adapters/access-queries";
import {
  defaultGroupFilters,
  filterGroups,
  groupFiltersFromParams,
  groupRows,
  memberOptionsFromCandidates,
  memberOptionsFromUsers,
  summaryLabel,
  type GroupFilters,
  type GroupGapFilter,
  type GroupRow,
  type GroupSort,
} from "../helpers/groups";
import { AccessSearchToolbar } from "./access-search-toolbar";
import { CreateGroupDialog } from "./create-group-dialog";
import type { GroupEditorTab } from "./group-editor";
import { GroupPanel } from "./group-panel";
import { SelectField } from "./people-fields";
import { openRowClassName, RowOpenButton } from "./row-open-button";

const sortOptions: readonly { value: GroupSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "members", label: "Most members" },
  { value: "newest", label: "Newest first" },
];

const gapOptions: readonly { value: GroupGapFilter; label: string }[] = [
  { value: "all", label: "All groups" },
  { value: "no-access", label: "Without access" },
  { value: "no-members", label: "Without members" },
];

/** A reach list shows this many departments, then "+N more". */
const REACH_SHOWN = 2;

/** Replace the `group` parameter without a navigation or a history entry. */
function replaceGroupParam(groupId: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "groups");
  if (groupId) url.searchParams.set("group", groupId);
  else url.searchParams.delete("group");
  // Next syncs useSearchParams only for calls without its own history state.
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function memberCount(count: number) {
  return `${count} ${count === 1 ? "member" : "members"}`;
}

function Reach({ row }: { row: GroupRow }) {
  if (!row.reach.length)
    return <span className="text-muted-foreground">No access</span>;
  const more = row.reach.length - REACH_SHOWN;
  return (
    <ul className="space-y-0.5">
      {row.reach.slice(0, REACH_SHOWN).map((item) => (
        <li key={item.departmentId} className="break-words">
          {summaryLabel(item)}
        </li>
      ))}
      {more > 0 ? (
        <li className="text-muted-foreground">+{more} more</li>
      ) : null}
    </ul>
  );
}

function GroupsSkeleton() {
  return (
    <div className="overflow-hidden rounded-md border">
      <Skeleton className="h-10 w-full rounded-none" />
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex items-center gap-4 border-t p-3">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="hidden h-5 w-48 md:block" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="hidden h-5 w-36 md:block" />
        </div>
      ))}
    </div>
  );
}

/**
 * The Groups tab. Administrators see and change every group; a department
 * manager sees only the groups whose access stays inside departments they
 * manage, and changes their members only (D13, D14).
 */
export function GroupsView({ mode }: { mode: "admin" | "manager" }) {
  const admin = mode === "admin";
  const searchParams = useSearchParams();
  const groups = useQuery(groupListOptions("exclude"));
  const departments = useQuery(departmentListOptions("exclude"));
  const modules = useQuery(moduleListOptions("exclude"));
  // Administrators pick members from the directory (it also knows when a
  // guest's access ended); managers from the candidates route.
  const users = useQuery({ ...userListOptions("include"), enabled: admin });
  const candidates = useQuery({
    ...memberCandidateListOptions(),
    enabled: !admin,
  });
  const [filters, setFilters] = useState<GroupFilters>(() =>
    groupFiltersFromParams(searchParams),
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TABLE_PAGE_SIZE);
  const [createOpen, setCreateOpen] = useState(false);
  const [openTab, setOpenTab] = useState<GroupEditorTab | null>(null);
  const [now] = useState(() => Date.now());

  const rows = useMemo(
    () =>
      groups.data && departments.data && modules.data
        ? groupRows(groups.data, departments.data, modules.data)
        : null,
    [departments.data, groups.data, modules.data],
  );
  const memberOptions = useMemo(
    () =>
      admin
        ? memberOptionsFromUsers(users.data ?? [], now)
        : memberOptionsFromCandidates(candidates.data ?? []),
    [admin, candidates.data, now, users.data],
  );
  const members = admin ? users : candidates;
  const selectedId = searchParams.get("group");
  const selected = rows?.find((row) => row.group.id === selectedId) ?? null;

  // A link to a group that is not in the list opens the list instead.
  useEffect(() => {
    if (rows && selectedId && !rows.some((row) => row.group.id === selectedId))
      replaceGroupParam(null);
  }, [rows, selectedId]);

  const denied = [groups.error, departments.error, modules.error].some(
    (error) => error instanceof ApiError && error.status === 403,
  );
  const failed = groups.isError || departments.isError || modules.isError;
  const loading = !failed && rows === null;

  function changeFilters(patch: Partial<GroupFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPageIndex(0);
  }

  function openGroup(groupId: string, tab: GroupEditorTab | null = null) {
    setOpenTab(tab);
    replaceGroupParam(groupId);
  }

  const filtered = rows ? filterGroups(rows, filters) : [];
  const page = pageCollection(
    completeCollection(filtered, "access-groups"),
    pageIndex * pageSize,
    pageSize,
  );
  const narrowed = filters.filter !== "all" || filters.query.trim() !== "";

  const columns: DataTableColumn<GroupRow>[] = [
    {
      id: "name",
      header: "Name",
      cell: ({ row }) => (
        <RowOpenButton
          title={row.original.group.name}
          onOpen={() => openGroup(row.original.group.id)}
        />
      ),
    },
    {
      id: "description",
      header: "Description",
      cell: ({ row }) =>
        row.original.group.description ? (
          <span className="line-clamp-2 break-words">
            {row.original.group.description}
          </span>
        ) : (
          <span className="text-muted-foreground">None</span>
        ),
    },
    {
      id: "members",
      header: "Members",
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.group.member_ids.length}
        </span>
      ),
    },
    {
      id: "departments",
      header: "Departments reached",
      cell: ({ row }) => <Reach row={row.original} />,
    },
  ];

  if (denied)
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>You cannot see groups</EmptyTitle>
          <EmptyDescription>
            Administrators and department managers can see groups. Ask an
            administrator if you need to change one.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  if (failed)
    return (
      <div role="alert" className="max-w-lg space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-base font-semibold">
            Groups could not be loaded
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Check your connection and try again.
          </p>
        </div>
        <Button
          className="min-h-11"
          onClick={() => {
            if (groups.isError) void groups.refetch();
            if (departments.isError) void departments.refetch();
            if (modules.isError) void modules.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="sr-only">Group list</h2>
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {rows
            ? `${rows.length} ${rows.length === 1 ? "group" : "groups"}`
            : " "}
        </p>
        {admin ? (
          <Button
            className="min-h-11 w-full sm:w-auto"
            disabled={rows === null}
            onClick={() => setCreateOpen(true)}
          >
            <Plus aria-hidden="true" />
            Create group
          </Button>
        ) : null}
      </div>

      {members.isError ? (
        <Alert variant="warning" role="status">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              The people who can join groups could not be loaded, so members
              show without names.
            </span>
            <Button
              variant="outline"
              className="min-h-11 shrink-0"
              onClick={() => void members.refetch()}
            >
              Retry
            </Button>
          </div>
        </Alert>
      ) : null}

      <AccessSearchToolbar
        searchLabel="Search groups"
        placeholder="Name, description, or department"
        query={filters.query}
        onQueryChange={(query) => changeFilters({ query })}
        sort={filters.sort}
        sortOptions={sortOptions}
        onSortChange={(sort) => changeFilters({ sort })}
        activeFilterCount={filters.filter === "all" ? 0 : 1}
      >
        <SelectField
          id="groups-gap-filter"
          label="Show"
          value={filters.filter}
          options={gapOptions}
          onChange={(value) => {
            const option = gapOptions.find((item) => item.value === value);
            if (option) changeFilters({ filter: option.value });
          }}
        />
      </AccessSearchToolbar>

      <LoadingRegion
        loading={loading}
        label="Loading groups…"
        skeleton={<GroupsSkeleton />}
      >
        {filtered.length === 0 ? (
          <Empty className="min-h-64 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {narrowed ? <Search /> : <UsersRound />}
              </EmptyMedia>
              <EmptyTitle>
                {narrowed
                  ? "No groups match"
                  : admin
                    ? "No groups yet"
                    : "No groups to manage"}
              </EmptyTitle>
              <EmptyDescription>
                {narrowed
                  ? "Change the search or filters to see more groups."
                  : admin
                    ? "Create a group, choose its access, and add people to it."
                    : "You can change the members of a group when all of its access is in departments you manage."}
              </EmptyDescription>
            </EmptyHeader>
            {narrowed || admin ? (
              <EmptyContent>
                {narrowed ? (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => {
                      setFilters(defaultGroupFilters);
                      setPageIndex(0);
                    }}
                  >
                    Clear search and filters
                  </Button>
                ) : (
                  <Button
                    className="min-h-11"
                    onClick={() => setCreateOpen(true)}
                  >
                    <Plus aria-hidden="true" />
                    Create group
                  </Button>
                )}
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <div className="hidden md:block">
              <DataTable
                ariaLabel="Groups"
                columns={columns}
                data={[...page.items]}
                cellClassName="py-2 align-top whitespace-normal"
                getRowId={(row) => row.group.id}
                rowClassName={() => openRowClassName}
              />
            </div>
            <ul
              aria-label="Groups"
              className="grid min-w-0 gap-3 p-3 md:hidden"
            >
              {page.items.map((row) => (
                <li key={row.group.id} className="min-w-0">
                  <Card className={`min-w-0 ${openRowClassName}`}>
                    <CardContent className="min-w-0 space-y-3 p-4">
                      <RowOpenButton
                        title={row.group.name}
                        subtitle={row.group.description || null}
                        onOpen={() => openGroup(row.group.id)}
                      />
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-muted-foreground">Members</dt>
                        <dd className="tabular-nums">
                          {memberCount(row.group.member_ids.length)}
                        </dd>
                        <dt className="text-muted-foreground">Departments</dt>
                        <dd className="min-w-0">
                          <Reach row={row} />
                        </dd>
                      </dl>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
            <TablePagination
              ariaLabel="Group pages"
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

      <GroupPanel
        row={selected}
        mode={mode}
        departments={departments.data ?? []}
        modules={modules.data ?? []}
        memberOptions={memberOptions}
        listFresh={!groups.isFetching && !groups.isError}
        initialTab={openTab}
        onClose={() => {
          setOpenTab(null);
          replaceGroupParam(null);
        }}
      />
      {admin ? (
        <CreateGroupDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          memberOptions={memberOptions}
          onCreated={(group) => openGroup(group.id, "access")}
        />
      ) : null}
    </div>
  );
}
