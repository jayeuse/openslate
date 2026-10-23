"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, UsersRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { LoadingRegion } from "@/components/ui/loading-region";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DEFAULT_TABLE_PAGE_SIZE,
  TablePagination,
} from "@/components/ui/table-pagination";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";

import { groupListOptions } from "../adapters/access-queries";
import { getAccessGroup } from "../state/api";
import {
  defaultGroupFilters,
  groupFiltersFromParams,
  groupRows,
  summaryLabel,
  type GroupFilters,
  type GroupGapFilter,
  type GroupRow,
  type GroupSort,
} from "../helpers/groups";
import { AccessHeaderActions } from "./access-header-actions";
import { AccessToolbar, FilterSelect } from "./access-toolbar";
import { TableSkeleton } from "./table-skeleton";
import { CreateGroupDialog, hasKeptNewGroup } from "./create-group-dialog";
import { DepartmentReach } from "./group-access-editor";
import type { GroupEditorTab } from "./group-editor";
import { GroupPanel } from "./group-panel";
import { ReadError } from "./read-error";
import { useDepartmentOrder } from "./people-row-parts";
import {
  openRowClassName,
  RowOpenButton,
  tintRowClassName,
} from "./row-open-button";

const sortOptions: readonly { value: GroupSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "members", label: "Most members" },
  { value: "newest", label: "Newest first" },
];

const gapOptions: readonly { value: GroupGapFilter; label: string }[] = [
  { value: "all", label: "Any group" },
  { value: "no-access", label: "Without access" },
  { value: "no-members", label: "Without members" },
];

/** A reach list shows this many departments, then "+N more". */
const REACH_SHOWN = 2;

const editorTabs: readonly GroupEditorTab[] = ["details", "members", "access"];

function editorTabFrom(value: string | null): GroupEditorTab | null {
  return editorTabs.find((tab) => tab === value) ?? null;
}

/**
 * Replace the `group` and `tab` parameters without a navigation or a history
 * entry. A link may name the tab a group opens on (`tab=members`).
 */
function replaceGroupParam(groupId: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "groups");
  url.searchParams.delete("tab");
  if (groupId) url.searchParams.set("group", groupId);
  else url.searchParams.delete("group");
  // Next syncs useSearchParams only for calls without its own history state.
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

/**
 * Keep the gap filter in the URL, so a removed chip stays removed after a
 * reload and an Overview link's filter can be cleared.
 */
function replaceGapParam(filter: GroupGapFilter) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "groups");
  if (filter === "all") url.searchParams.delete("filter");
  else url.searchParams.set("filter", filter);
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function memberCount(count: number) {
  return `${count} ${count === 1 ? "member" : "members"}`;
}

/**
 * Departments a group reaches, on one line: each with its mark and level
 * chip, then "+n more".
 */
function Reach({
  row,
  position,
}: {
  row: GroupRow;
  position: (id: string) => number | null;
}) {
  if (!row.reach.length)
    return <span className="text-muted-foreground">No access</span>;
  const more = row.reach.length - REACH_SHOWN;
  return (
    <span
      className="flex min-w-0 items-center gap-3 overflow-hidden"
      title={row.reach.map(summaryLabel).join(", ")}
    >
      {row.reach.slice(0, REACH_SHOWN).map((item) => (
        <span key={item.departmentId} className="flex min-w-0">
          <DepartmentReach summary={item} position={position} />
        </span>
      ))}
      {more > 0 ? (
        <span className="text-muted-foreground shrink-0">+{more} more</span>
      ) : null}
    </span>
  );
}

/**
 * The Groups tab. Administrators see and change every group; a department
 * manager sees only the groups whose access stays inside departments they
 * manage, and changes their members only (D13, D14).
 */
export function GroupsView({ mode }: { mode: "admin" | "manager" }) {
  const admin = mode === "admin";
  const searchId = useId();
  const searchParams = useSearchParams();
  // Marks follow the whole department catalog, which administrators read.
  const position = useDepartmentOrder(admin);
  const [filters, setFilters] = useState<GroupFilters>(() =>
    groupFiltersFromParams(searchParams),
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TABLE_PAGE_SIZE);
  const signedInId = useVerifiedWorkspaceUserId();
  // A new group's unsaved form in the journal opens again on return, unless
  // the link opens a group.
  const [createOpen, setCreateOpen] = useState(
    () => admin && !searchParams.get("group") && hasKeptNewGroup(signedInId),
  );
  const [openTab, setOpenTab] = useState<GroupEditorTab | null>(null);
  const [appliedSearch, setAppliedSearch] = useState(filters.query.trim());
  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(filters.query.trim()), 300);
    return () => clearTimeout(timer);
  }, [filters.query]);
  const request = {
    limit: pageSize,
    offset: pageIndex * pageSize,
    search: appliedSearch,
    sort_by:
      filters.sort === "members"
        ? ("member_count" as const)
        : filters.sort === "newest"
          ? ("created_at" as const)
          : ("name" as const),
    sort_order: filters.sort === "name" ? ("asc" as const) : ("desc" as const),
    ...(filters.filter === "no-access" ? { without_access: true } : {}),
    ...(filters.filter === "no-members" ? { without_members: true } : {}),
  };
  const groups = useQuery(groupListOptions("exclude", request));
  // The header counts every group the viewer can see, like People; the
  // table footer counts the filter. An unfiltered page already has it.
  const listNarrowed = filters.filter !== "all" || appliedSearch !== "";
  const allGroups = useQuery({
    ...groupListOptions("exclude", { limit: 1, offset: 0, search: "" }),
    enabled: listNarrowed,
  });
  const groupTotal = listNarrowed
    ? allGroups.data?.pagination.total
    : groups.data?.pagination.total;
  const rows = useMemo(
    () => (groups.data ? groupRows(groups.data.items) : null),
    [groups.data],
  );
  const selectedId = searchParams.get("group");
  const linkedTab = editorTabFrom(searchParams.get("tab"));
  const selectedRead = useQuery({
    queryKey: ["access", "groups", "detail", selectedId],
    queryFn: ({ signal }) => getAccessGroup(selectedId ?? "", { signal }),
    enabled:
      Boolean(selectedId) && !rows?.some((row) => row.group.id === selectedId),
  });
  const selected =
    rows?.find((row) => row.group.id === selectedId) ??
    (selectedRead.data
      ? (groupRows([selectedRead.data.data])[0] ?? null)
      : null);
  const denied = [groups.error, selectedRead.error].some(
    (error) => error instanceof ApiError && [401, 403].includes(error.status),
  );
  const failed = groups.isError;
  const loading = !failed && rows === null;
  useEffect(() => {
    if (
      selectedRead.error instanceof ApiError &&
      selectedRead.error.status === 404
    )
      replaceGroupParam(null);
  }, [selectedRead.error]);
  useEffect(() => {
    if (!groups.data) return;
    const lastPage = Math.max(
      0,
      Math.ceil(groups.data.pagination.total / pageSize) - 1,
    );
    setPageIndex((current) => Math.min(current, lastPage));
  }, [groups.data, pageSize]);

  function changeFilters(patch: Partial<GroupFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPageIndex(0);
    if (patch.filter) replaceGapParam(patch.filter);
  }

  function openGroup(groupId: string, tab: GroupEditorTab | null = null) {
    setOpenTab(tab);
    replaceGroupParam(groupId);
  }

  const filtered = rows ?? [];
  const page = {
    items: filtered,
    total: groups.data?.pagination.total ?? 0,
    offset: groups.data?.pagination.offset ?? request.offset,
  };
  const narrowed = filters.filter !== "all" || filters.query.trim() !== "";

  // Description shows only when a group on this page has one.
  const described = page.items.some((row) => row.group.description.trim());
  const columns: {
    id: string;
    header: string;
    width?: string;
    cell: (row: GroupRow) => ReactNode;
  }[] = [
    {
      id: "name",
      header: "Name",
      cell: (row) => (
        <RowOpenButton
          title={row.group.name}
          label={`Manage ${row.group.name}`}
          inline
          onOpen={() => openGroup(row.group.id)}
        />
      ),
    },
    ...(described
      ? [
          {
            id: "description",
            header: "Description",
            width: "w-[30%]",
            cell: (row: GroupRow) =>
              row.group.description ? (
                <span
                  className="text-muted-foreground block truncate"
                  title={row.group.description}
                >
                  {row.group.description}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  <span aria-hidden="true">—</span>
                  <span className="sr-only">No description</span>
                </span>
              ),
          },
        ]
      : []),
    {
      id: "members",
      header: "Members",
      width: "w-28",
      cell: (row) => (
        <span className="tabular-nums">{row.group.member_ids.length}</span>
      ),
    },
    {
      id: "departments",
      header: "Departments reached",
      width: "w-[34%]",
      cell: (row) => <Reach row={row} position={position} />,
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
      <ReadError
        className="max-w-lg"
        message="Groups could not be loaded."
        retry={() => {
          if (groups.isError) void groups.refetch();
        }}
      />
    );

  return (
    <div className="access-fill flex min-w-0 flex-col gap-3">
      <h2 className="sr-only">Group list</h2>
      <AccessHeaderActions>
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {groupTotal === undefined
            ? " "
            : `${groupTotal} ${groupTotal === 1 ? "group" : "groups"}`}
        </p>
        {admin ? (
          <DisabledReason reason={rows === null ? "Loading groups…" : null}>
            <Button className="min-h-11" onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" />
              Create group
            </Button>
          </DisabledReason>
        ) : null}
      </AccessHeaderActions>
      <AccessToolbar
        searchLabel="Search groups"
        searchId={searchId}
        placeholder="Name, description, or department"
        query={filters.query}
        onQueryChange={(query) => changeFilters({ query })}
        sort={filters.sort}
        sortOptions={sortOptions}
        onSortChange={(sort) => changeFilters({ sort })}
        chips={
          filters.filter === "all"
            ? []
            : [
                {
                  key: "filter",
                  label: "Show",
                  value:
                    gapOptions.find((item) => item.value === filters.filter)
                      ?.label ?? "",
                  onRemove: () => changeFilters({ filter: "all" }),
                },
              ]
        }
        onClearFilters={() => changeFilters({ filter: "all" })}
        sortInFiltersBelowMd
      >
        <FilterSelect
          id="groups-gap-filter"
          label="Show"
          value={filters.filter}
          options={gapOptions}
          onChange={(filter) => changeFilters({ filter })}
        />
      </AccessToolbar>

      <LoadingRegion
        loading={loading}
        label="Loading groups…"
        skeleton={<TableSkeleton columns={3} />}
        className="access-fill"
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
          <div className="access-fill access-hug bg-card flex min-w-0 flex-col overflow-hidden rounded-md border">
            <div className="access-fill access-scroll-table hidden md:block">
              <Table aria-label="Groups" className="table-fixed">
                <colgroup>
                  {columns.map((column) => (
                    <col key={column.id} className={column.width} />
                  ))}
                </colgroup>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {columns.map((column) => (
                      <TableHead
                        key={column.id}
                        className="text-muted-foreground h-9 px-3 text-xs"
                      >
                        {column.header}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.items.map((row) => (
                    <TableRow
                      key={row.group.id}
                      data-state={
                        row.group.id === selectedId ? "selected" : undefined
                      }
                      className={cn(openRowClassName, tintRowClassName, "h-10")}
                    >
                      {columns.map((column) => (
                        <TableCell
                          key={column.id}
                          className="h-10 overflow-hidden px-3 py-0 align-middle whitespace-nowrap"
                        >
                          {column.cell(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul
              aria-label="Groups"
              className="divide-border min-w-0 divide-y md:hidden"
            >
              {page.items.map((row) => (
                <li
                  key={row.group.id}
                  data-state={
                    row.group.id === selectedId ? "selected" : undefined
                  }
                  className={cn(
                    openRowClassName,
                    tintRowClassName,
                    "flex min-h-14 min-w-0 items-center justify-between gap-3 px-3 py-1.5",
                  )}
                >
                  <RowOpenButton
                    title={row.group.name}
                    label={`Manage ${row.group.name}`}
                    subtitle={
                      row.reach.length ? (
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          {row.reach.map((item, index) => (
                            <span key={item.departmentId} className="min-w-0">
                              <DepartmentReach
                                summary={item}
                                position={position}
                              />
                              {index < row.reach.length - 1 ? (
                                <span className="sr-only">, </span>
                              ) : null}
                            </span>
                          ))}
                        </span>
                      ) : (
                        "No access"
                      )
                    }
                    onOpen={() => openGroup(row.group.id)}
                  />
                  <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
                    {memberCount(row.group.member_ids.length)}
                  </span>
                </li>
              ))}
            </ul>
            <TablePagination
              ariaLabel="Group pages"
              className="shrink-0 px-3 py-2 lg:py-2"
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
        listFresh={!groups.isFetching && !groups.isError}
        initialTab={openTab ?? linkedTab}
        searchId={searchId}
        onClose={() => {
          setOpenTab(null);
          replaceGroupParam(null);
        }}
      />
      {admin ? (
        <CreateGroupDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(group) => openGroup(group.id, "access")}
        />
      ) : null}
    </div>
  );
}
