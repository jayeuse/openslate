"use client";

import {
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Search, UserRoundPlus, UsersRound } from "lucide-react";

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

import {
  directoryPageOptions,
  statusCountOptions,
  userListOptions,
} from "../adapters/access-queries";
import {
  clearedDirectoryFilters,
  defaultDirectoryFilters,
  directoryFilterChips,
  directoryFiltersFromParams,
  directoryParams,
  directoryRows,
  directoryRequest,
  type DirectoryFilters,
  type DirectorySort,
} from "../helpers/people";
import type { AccessDirectoryUser } from "../state/api";
import { AccessHeaderActions } from "./access-header-actions";
import { AccessToolbar } from "./access-toolbar";
import { TableSkeleton } from "./table-skeleton";
import { hasKeptInvitation, InvitePersonDialog } from "./invite-person-dialog";
import { PeopleFilterRows, StatusStrip } from "./people-filters";
import { usePeopleSearch } from "../hooks/use-people-search";
import { usePeopleMemberships } from "../hooks/use-people-memberships";
import {
  useAccessCatalog,
  catalogDepartments,
  catalogGroups,
} from "../hooks/use-access-catalog";
import { PersonPanel } from "./person-panel";
import {
  DepartmentMarks,
  GroupChips,
  LastActive,
  RoleWord,
  StatusWord,
  TwoStepWord,
  useDepartmentOrder,
  type PeopleRow,
} from "./people-row-parts";
import {
  openRowClassName,
  RowOpenButton,
  tintRowClassName,
} from "./row-open-button";
import { PersonAvatar } from "@/components/person-avatar";

const sortOptions: readonly { value: DirectorySort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "email", label: "Email" },
  { value: "newest", label: "Newest first" },
  { value: "expiry", label: "Access ends soonest" },
];

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

/** Keep the directory filters in the URL, so a reload or a link keeps them. */
function replaceDirectoryParams(filters: DirectoryFilters) {
  const url = new URL(window.location.href);
  for (const key of [
    "role",
    "status",
    "group",
    "department",
    "sort",
    "mfa",
    "history",
    "inactive_days",
  ])
    url.searchParams.delete(key);
  url.searchParams.set("view", "people");
  for (const [key, value] of directoryParams(filters))
    url.searchParams.set(key, value);
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

// From 1440px the table shows every column; from 1280px it leaves out
// Departments so names keep their room; from 768px it keeps Person, Role,
// Status and Last active. The person sheet holds the rest.
const fullQuery = "(min-width: 80rem)";
const wideQuery = "(min-width: 90rem)";
function subscribeQuery(media: string) {
  return (notify: () => void) => {
    const query = window.matchMedia(media);
    query.addEventListener("change", notify);
    return () => query.removeEventListener("change", notify);
  };
}
const subscribeFull = subscribeQuery(fullQuery);
const subscribeWide = subscribeQuery(wideQuery);

type Column = {
  id: string;
  header: string;
  /** A fixed width from the Tailwind scale; the Person column takes the rest. */
  width?: string;
  full?: boolean;
  /** Shown only from 1440px. */
  wide?: boolean;
  cell: (row: PeopleRow) => ReactNode;
};

function OpenPerson({
  row,
  inline,
  onOpen,
}: {
  row: PeopleRow;
  inline: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <RowOpenButton
      title={row.name}
      subtitle={row.user.email}
      label={`Manage ${row.name}`}
      inline={inline}
      leading={
        <PersonAvatar
          name={row.name}
          avatarUrl={row.user.avatar_url}
          size={inline ? "sm" : "default"}
        />
      }
      onOpen={() => onOpen(row.user.id)}
    />
  );
}

export function PeopleView() {
  const searchId = useId();
  const searchParams = useSearchParams();
  // An Overview link, a reload or a shared link opens the directory filtered.
  const [filters, setFilters] = useState<DirectoryFilters>(() =>
    directoryFiltersFromParams(searchParams),
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TABLE_PAGE_SIZE);
  const signedInId = useVerifiedWorkspaceUserId();
  // An unsent invitation in the journal opens again on return, unless the
  // link opens a person.
  const [inviteOpen, setInviteOpen] = useState(
    () => !searchParams.get("user") && hasKeptInvitation(signedInId),
  );
  const [now] = useState(() => Date.now());
  const full = useSyncExternalStore(
    subscribeFull,
    () => window.matchMedia(fullQuery).matches,
    () => false,
  );
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(wideQuery).matches,
    () => false,
  );
  const position = useDepartmentOrder();
  const selectedId = searchParams.get("user");
  const request = directoryRequest(filters, pageSize, pageIndex * pageSize);
  const users = useQuery(directoryPageOptions(request));
  // The status quick filters show totals that do not follow the search.
  const counts = {
    current: useQuery(statusCountOptions(undefined)),
    active: useQuery(statusCountOptions("active")),
    pending: useQuery(statusCountOptions("pending")),
    ending: useQuery(statusCountOptions("ending")),
    disabled: useQuery(statusCountOptions("disabled")),
  };
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

  function applyFilters(next: DirectoryFilters) {
    setFilters(next);
    setPageIndex(0);
    replaceDirectoryParams(next);
  }
  function changeFilters(patch: Partial<DirectoryFilters>) {
    applyFilters({ ...filters, ...patch });
  }

  const page = {
    items: rows ?? [],
    total: users.data?.pagination.total ?? 0,
    offset: users.data?.pagination.offset ?? request.offset ?? 0,
  };
  const chips = directoryFilterChips(filters, {
    group: catalogGroups(groupFilter.combined).find(
      (group) => group.id === filters.groupId,
    )?.name,
    department: catalogDepartments(departmentFilter.combined).find(
      (department) => department.id === filters.departmentId,
    )?.department_name,
  }).map((chip) => ({
    key: chip.key,
    label: chip.label,
    value: chip.value,
    onRemove: () => changeFilters(chip.clear),
  }));
  const narrowed =
    chips.length > 0 ||
    filters.status !== "current" ||
    filters.query.trim() !== "";

  const allColumns: Column[] = [
    {
      id: "person",
      header: "Person",
      cell: (row) => <OpenPerson row={row} inline onOpen={replaceUserParam} />,
    },
    {
      id: "role",
      header: "Role",
      width: "w-36",
      cell: (row) => <RoleWord role={row.user.role} />,
    },
    {
      id: "status",
      header: "Status",
      width: "w-36",
      cell: (row) => <StatusWord row={row} now={now} />,
    },
    {
      id: "groups",
      header: "Groups",
      width: "w-48",
      full: true,
      cell: (row) => <GroupChips row={row} />,
    },
    {
      id: "departments",
      header: "Departments",
      width: "w-32",
      full: true,
      wide: true,
      cell: (row) => <DepartmentMarks row={row} position={position} />,
    },
    {
      id: "mfa",
      header: "Two-step",
      width: "w-24",
      full: true,
      cell: (row) => <TwoStepWord person={row.user} />,
    },
    {
      id: "last-active",
      header: "Last active",
      width: "w-32",
      cell: (row) => <LastActive person={row.user} now={now} />,
    },
  ];
  const columns = allColumns.filter(
    (column) => (full || !column.full) && (wide || !column.wide),
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
    <div className="access-fill flex min-w-0 flex-col gap-3">
      <h2 id="people-directory" className="sr-only">
        People directory
      </h2>
      <AccessHeaderActions>
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {/* The organization total; the table footer counts the filter. */}
          {counts.current.data
            ? `${counts.current.data.pagination.total} ${counts.current.data.pagination.total === 1 ? "person" : "people"}`
            : " "}
        </p>
        <DisabledReason reason={rows === null ? "Loading people…" : null}>
          <Button className="min-h-11" onClick={() => setInviteOpen(true)}>
            <UserRoundPlus aria-hidden="true" />
            Invite person
          </Button>
        </DisabledReason>
      </AccessHeaderActions>
      <AccessToolbar
        searchLabel="Search people"
        searchId={searchId}
        placeholder="Name, email, or job title"
        query={filters.query}
        onQueryChange={(query) => {
          setFilters((current) => ({ ...current, query }));
          setPageIndex(0);
        }}
        sort={filters.sort}
        sortOptions={sortOptions}
        onSortChange={(sort) => changeFilters({ sort })}
        chips={chips}
        onClearFilters={() => applyFilters(clearedDirectoryFilters(filters))}
        sortInFiltersBelowMd
        quickFilters={
          <StatusStrip
            status={filters.status}
            totals={{
              current: counts.current.data?.pagination.total,
              active: counts.active.data?.pagination.total,
              pending: counts.pending.data?.pagination.total,
              ending: counts.ending.data?.pagination.total,
              disabled: counts.disabled.data?.pagination.total,
            }}
            onChange={changeFilters}
          />
        }
      >
        <PeopleFilterRows
          filters={filters}
          groups={groupFilter}
          departments={departmentFilter}
          onChange={changeFilters}
        />
      </AccessToolbar>

      <LoadingRegion
        loading={loading}
        label="Loading people…"
        skeleton={<TableSkeleton columns={columns.length} />}
        className="access-fill"
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
                  onClick={() => applyFilters(defaultDirectoryFilters)}
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
          <div className="access-fill bg-card flex min-w-0 flex-col overflow-hidden rounded-md border">
            <div className="access-fill access-scroll-table hidden md:block">
              <Table aria-label="People" className="table-fixed">
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
                      key={row.user.id}
                      data-state={
                        row.user.id === selectedId ? "selected" : undefined
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
              aria-label="People"
              className="divide-border min-w-0 divide-y md:hidden"
            >
              {page.items.map((row) => (
                <li
                  key={row.user.id}
                  data-state={
                    row.user.id === selectedId ? "selected" : undefined
                  }
                  className={cn(
                    openRowClassName,
                    tintRowClassName,
                    "flex min-h-14 min-w-0 items-center justify-between gap-3 px-3 py-1.5",
                  )}
                >
                  <OpenPerson
                    row={row}
                    inline={false}
                    onOpen={replaceUserParam}
                  />
                  <span className="shrink-0 text-sm">
                    <StatusWord row={row} now={now} />
                  </span>
                </li>
              ))}
            </ul>
            <TablePagination
              ariaLabel="People pages"
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
        recorded={rows?.find((row) => row.user.id === selectedId)?.user}
        people={people}
        listFresh={
          !catalog.isFetching && !catalog.isError && !catalog.isPending
        }
        searchId={searchId}
        onClose={() => replaceUserParam(null)}
      />
      <InvitePersonDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onFound={replaceUserParam}
      />
    </div>
  );
}
