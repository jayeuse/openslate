"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownAZ,
  Bot,
  MoreHorizontal,
  Search,
  UserRound,
  UserRoundPlus,
  UsersRound,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { toast } from "@/components/ui/toast";
import { completeCollection, pageCollection } from "../sample-collections";
import { departments } from "./model";
import type { AccessController, BulkIdentityUpdateInput } from "./controller";
import { IdentityEditor } from "./identity-editor";
import type { AccessIdentity, AccessIdentityStatus } from "./policy";

type IdentitiesViewProps = {
  controller: AccessController;
};

type KindFilter = AccessIdentity["kind"] | "all";
type StatusFilter = AccessIdentityStatus | "all";
type ExpiryFilter = "all" | "expired" | "next-30-days" | "no-expiry";
type ActivityFilter = "all" | "active-session" | "recent-change" | "no-session";
type SortOption = "name" | "kind" | "status" | "role" | "expiry" | "activity";
type BulkAction = "disable" | "restore" | "role" | "add-group" | "remove-group";

const PAGE_SIZE_OPTIONS = [3, 5, 8] as const;

const kindLabels: Record<AccessIdentity["kind"], string> = {
  internal: "Internal",
  guest: "Guest",
  service: "Service",
};

const statusLabels: Record<AccessIdentityStatus, string> = {
  active: "Active",
  pending: "Pending",
  disabled: "Disabled",
  deleted: "Deleted",
  revoked: "Revoked",
  suspended: "Suspended",
};

function statusVariant(status: AccessIdentityStatus) {
  if (status === "active") return "success" as const;
  if (status === "pending") return "warning" as const;
  if (status === "disabled" || status === "revoked")
    return "secondary" as const;
  return "outline" as const;
}

function identityDetail(identity: AccessIdentity): string {
  if (identity.kind === "internal") return identity.email;
  if (identity.kind === "guest") return identity.email;
  return identity.purpose || "Service metadata";
}

function departmentId(name: string): string {
  return `department:${name.toLowerCase().replaceAll(" ", "-")}`;
}

function replaceUserQuery(identityId: string | null) {
  const url = new URL(window.location.href);
  if (identityId) url.searchParams.set("user", identityId);
  else url.searchParams.delete("user");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export function IdentitiesView({ controller }: IdentitiesViewProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [roleId, setRoleId] = useState("all");
  const [groupId, setGroupId] = useState("all");
  const [department, setDepartment] = useState("all");
  const [expiry, setExpiry] = useState<ExpiryFilter>("all");
  const [activity, setActivity] = useState<ActivityFilter>("all");
  const [sort, setSort] = useState<SortOption>("name");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(3);
  const [selected, setSelected] = useState<string[]>([]);
  const [editorIdentityId, setEditorIdentityId] = useState<string | null>(null);
  const [createKind, setCreateKind] = useState<AccessIdentity["kind"] | null>(
    null,
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<BulkAction>("disable");
  const [bulkRoleId, setBulkRoleId] = useState(
    controller.state.defaults.defaultRoleId,
  );
  const [bulkGroupId, setBulkGroupId] = useState(
    controller.state.groups[0]?.id ?? "",
  );
  const [filterNow] = useState(() => Date.now());

  const directoryIdentities = [
    ...controller.state.identities,
    ...controller.state.deletedIdentities.map((item) => item.identity),
  ];

  useEffect(() => {
    const identityId = new URLSearchParams(window.location.search).get("user");
    if (!identityId) return;
    const valid = [
      ...controller.state.identities,
      ...controller.state.deletedIdentities.map((item) => item.identity),
    ].some((item) => item.id === identityId);
    if (!valid) {
      replaceUserQuery(null);
      return;
    }
    setEditorIdentityId(identityId);
    setCreateKind(null);
    setEditorOpen(true);
  }, [controller.state.deletedIdentities, controller.state.identities]);

  const normalizedQuery = query.trim().toLowerCase();
  const hasActiveSession = (identityId: string) =>
    controller.state.sessions.some(
      (session) =>
        session.identityId === identityId && session.status === "active",
    );
  const hasRecentChange = (identityId: string) =>
    controller.state.history.some((entry) => entry.target === identityId);
  const activityTime = (identityId: string) =>
    Math.max(
      0,
      ...controller.state.sessions
        .filter((session) => session.identityId === identityId)
        .map((session) => Date.parse(session.lastActiveAt ?? "") || 0),
      ...controller.state.history
        .filter((entry) => entry.target === identityId)
        .map((entry) => Date.parse(entry.occurredAt) || 0),
    );
  const filtered = directoryIdentities
    .filter((identity) => kind === "all" || identity.kind === kind)
    .filter((identity) => status === "all" || identity.status === status)
    .filter((identity) => roleId === "all" || identity.roleId === roleId)
    .filter((identity) =>
      groupId === "all"
        ? true
        : groupId === "none"
          ? identity.groupIds.length === 0
          : identity.groupIds.includes(groupId),
    )
    .filter(
      (identity) =>
        department === "all" ||
        (identity.kind === "internal" &&
          identity.departmentIds.includes(department)),
    )
    .filter((identity) => {
      if (expiry === "all") return true;
      if (expiry === "no-expiry") return identity.expiresAt === undefined;
      const expiresAt = Date.parse(identity.expiresAt ?? "");
      if (!Number.isFinite(expiresAt)) return false;
      if (expiry === "expired") return expiresAt <= filterNow;
      return (
        expiresAt > filterNow &&
        expiresAt <= filterNow + 30 * 24 * 60 * 60 * 1000
      );
    })
    .filter((identity) => {
      if (activity === "all") return true;
      if (activity === "active-session") return hasActiveSession(identity.id);
      if (activity === "recent-change") return hasRecentChange(identity.id);
      return !hasActiveSession(identity.id);
    })
    .filter((identity) =>
      `${identity.name} ${identityDetail(identity)}`
        .toLowerCase()
        .includes(normalizedQuery),
    )
    .sort((left, right) => {
      if (sort === "expiry") {
        const leftValue =
          Date.parse(left.expiresAt ?? "") || Number.MAX_SAFE_INTEGER;
        const rightValue =
          Date.parse(right.expiresAt ?? "") || Number.MAX_SAFE_INTEGER;
        return leftValue - rightValue || left.name.localeCompare(right.name);
      }
      if (sort === "activity")
        return (
          activityTime(right.id) - activityTime(left.id) ||
          left.name.localeCompare(right.name)
        );
      const leftValue =
        sort === "role"
          ? (controller.state.roles.find((item) => item.id === left.roleId)
              ?.name ?? "")
          : sort === "name"
            ? left.name
            : left[sort];
      const rightValue =
        sort === "role"
          ? (controller.state.roles.find((item) => item.id === right.roleId)
              ?.name ?? "")
          : sort === "name"
            ? right.name
            : right[sort];
      return (
        leftValue.localeCompare(rightValue) ||
        left.name.localeCompare(right.name)
      );
    });
  const pageResult = pageCollection(
    completeCollection(
      filtered,
      JSON.stringify([
        "identities",
        normalizedQuery,
        kind,
        status,
        roleId,
        groupId,
        department,
        expiry,
        activity,
        sort,
      ]),
    ),
    pageIndex * pageSize,
    pageSize,
  );
  const pageCount = Math.max(1, Math.ceil(pageResult.total / pageResult.limit));
  const safePageIndex = pageResult.offset / pageResult.limit;
  const visible = [...pageResult.items];
  const visibleIds = visible
    .filter((identity) => identity.status !== "deleted")
    .map((identity) => identity.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  const bulkPatch: BulkIdentityUpdateInput["patch"] =
    bulkAction === "role"
      ? { roleId: bulkRoleId }
      : bulkAction === "disable" || bulkAction === "restore"
        ? { status: bulkAction === "disable" ? "disabled" : "active" }
        : {};
  const bulkInput: BulkIdentityUpdateInput = {
    identityIds: selected,
    patch: bulkPatch,
    ...(bulkAction === "add-group" ? { addGroupId: bulkGroupId } : {}),
    ...(bulkAction === "remove-group" ? { removeGroupId: bulkGroupId } : {}),
  };
  const bulkPreview = controller.actions.previewBulkIdentityUpdate(bulkInput);

  const identityColumns = useMemo<DataTableColumn<AccessIdentity>[]>(
    () => [
      {
        id: "select",
        header: () => (
          <label className="flex size-11 items-center justify-center">
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={(checked) =>
                setSelected((current) =>
                  checked === true
                    ? [...new Set([...current, ...visibleIds])]
                    : current.filter((id) => !visibleIds.includes(id)),
                )
              }
            />
            <span className="sr-only">Select all identities on this page</span>
          </label>
        ),
        cell: ({ row }) => {
          const identity = row.original;
          const isSelected = selected.includes(identity.id);
          return (
            <label className="flex size-11 items-center justify-center">
              <Checkbox
                checked={isSelected}
                disabled={identity.status === "deleted"}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked === true
                      ? [...new Set([...current, identity.id])]
                      : current.filter((id) => id !== identity.id),
                  )
                }
              />
              <span className="sr-only">
                {identity.status === "deleted" ? "Deleted identity" : "Select"}{" "}
                {identity.name}
              </span>
            </label>
          );
        },
      },
      {
        id: "identity",
        header: "Identity",
        cell: ({ row }) => {
          const identity = row.original;
          return (
            <div className="max-w-72 min-w-0">
              <p className="truncate font-medium">{identity.name}</p>
              <p className="text-muted-foreground truncate text-xs">
                {identityDetail(identity)}
              </p>
            </div>
          );
        },
      },
      {
        id: "kind",
        header: "Kind",
        cell: ({ row }) => kindLabels[row.original.kind],
      },
      {
        id: "role",
        header: "Role",
        cell: ({ row }) =>
          controller.state.roles.find((item) => item.id === row.original.roleId)
            ?.name ?? "Unknown role",
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge variant={statusVariant(row.original.status)}>
            {statusLabels[row.original.status]}
          </Badge>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label={`Manage ${row.original.name}`}
              onClick={() => openIdentity(row.original.id)}
            >
              <MoreHorizontal />
            </Button>
          </div>
        ),
      },
    ],
    [
      allVisibleSelected,
      controller.state.roles,
      openIdentity,
      selected,
      visibleIds,
    ],
  );

  function resetFilters() {
    setQuery("");
    setKind("all");
    setStatus("all");
    setRoleId("all");
    setGroupId("all");
    setDepartment("all");
    setExpiry("all");
    setActivity("all");
    setSort("name");
    setPageIndex(0);
  }

  function openIdentity(identityId: string) {
    setEditorIdentityId(identityId);
    setCreateKind(null);
    setEditorOpen(true);
    replaceUserQuery(identityId);
  }

  function openCreate(nextKind: AccessIdentity["kind"]) {
    setEditorIdentityId(null);
    setCreateKind(nextKind);
    setEditorOpen(true);
    replaceUserQuery(null);
  }

  function updateEditorOpen(open: boolean) {
    setEditorOpen(open);
    if (!open) {
      setEditorIdentityId(null);
      setCreateKind(null);
      replaceUserQuery(null);
    }
  }

  async function applyBulk() {
    if (controller.isPending()) {
      toast.add({
        title: "Another Access change is in progress",
        description: "Wait for it to finish before applying this bulk update.",
        type: "error",
      });
      return;
    }
    const result = await controller.actions.bulkUpdateIdentities(bulkInput);
    if (!result.ok) {
      toast.add({
        title: "Bulk update blocked",
        description: result.error,
        type: "error",
      });
      return;
    }
    toast.add({ title: result.summary, type: "success" });
    setSelected([]);
    setBulkOpen(false);
  }

  const hasFilters =
    normalizedQuery !== "" ||
    kind !== "all" ||
    status !== "all" ||
    roleId !== "all" ||
    groupId !== "all" ||
    department !== "all" ||
    expiry !== "all" ||
    activity !== "all";

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 id="identity-directory" className="text-lg font-semibold">
            Identity directory
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Internal people, sponsored guests, and service metadata in one
            directory.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button className="min-h-11 w-full lg:w-auto" />}
          >
            <UserRoundPlus /> Add identity
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="min-h-11"
              onClick={() => openCreate("internal")}
            >
              <UserRound /> Internal identity
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11"
              onClick={() => openCreate("guest")}
            >
              <UsersRound /> Guest identity
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11"
              onClick={() => openCreate("service")}
            >
              <Bot /> Service metadata
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Card className="w-full" role="search" aria-label="Identity filters">
        <CardContent className="p-0">
          <div className="grid grid-cols-2 gap-3 p-3 lg:grid-cols-3 xl:grid-cols-5">
            <Field className="col-span-2 xl:col-span-1">
              <FieldLabel htmlFor="identity-search">
                Search identities
              </FieldLabel>
              <div className="relative">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  id="identity-search"
                  type="search"
                  className="min-h-11 pl-9"
                  placeholder="Name, email, or purpose"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPageIndex(0);
                  }}
                />
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="identity-kind">Kind</FieldLabel>
              <NativeSelect
                id="identity-kind"
                className="w-full [&_select]:min-h-11"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as KindFilter);
                  setPageIndex(0);
                }}
              >
                <NativeSelectOption value="all">All kinds</NativeSelectOption>
                <NativeSelectOption value="internal">
                  Internal
                </NativeSelectOption>
                <NativeSelectOption value="guest">Guest</NativeSelectOption>
                <NativeSelectOption value="service">Service</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="identity-status">Status</FieldLabel>
              <NativeSelect
                id="identity-status"
                className="w-full [&_select]:min-h-11"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as StatusFilter);
                  setPageIndex(0);
                }}
              >
                <NativeSelectOption value="all">
                  All statuses
                </NativeSelectOption>
                {Object.entries(statusLabels).map(([value, label]) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="identity-sort">Sort</FieldLabel>
              <NativeSelect
                id="identity-sort"
                className="w-full [&_select]:min-h-11"
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value as SortOption);
                  setPageIndex(0);
                }}
              >
                <NativeSelectOption value="name">Name</NativeSelectOption>
                <NativeSelectOption value="kind">Kind</NativeSelectOption>
                <NativeSelectOption value="status">Status</NativeSelectOption>
                <NativeSelectOption value="role">Role</NativeSelectOption>
                <NativeSelectOption value="expiry">
                  Expiry soonest
                </NativeSelectOption>
                <NativeSelectOption value="activity">
                  Recent activity
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="identity-page-size">
                Rows per page
              </FieldLabel>
              <NativeSelect
                id="identity-page-size"
                className="w-full [&_select]:min-h-11"
                value={String(pageSize)}
                onChange={(event) => {
                  const nextPageSize = Number(event.target.value);
                  if (
                    !PAGE_SIZE_OPTIONS.some((option) => option === nextPageSize)
                  )
                    return;
                  setPageSize(nextPageSize);
                  setPageIndex(0);
                }}
              >
                {PAGE_SIZE_OPTIONS.map((option) => (
                  <NativeSelectOption key={option} value={String(option)}>
                    {option}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>

          <details className="group border-t">
            <summary className="focus-visible:outline-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2">
              <span>Advanced filters</span>
              <Badge variant="outline">
                {
                  [roleId, groupId, department, expiry, activity].filter(
                    (value) => value !== "all",
                  ).length
                }{" "}
                active
              </Badge>
            </summary>
            <div className="grid gap-3 border-t p-3 sm:grid-cols-2 xl:grid-cols-5">
              <Field>
                <FieldLabel htmlFor="identity-role-filter">Role</FieldLabel>
                <NativeSelect
                  id="identity-role-filter"
                  className="w-full [&_select]:min-h-11"
                  value={roleId}
                  onChange={(event) => {
                    setRoleId(event.target.value);
                    setPageIndex(0);
                  }}
                >
                  <NativeSelectOption value="all">All roles</NativeSelectOption>
                  {controller.state.roles.map((role) => (
                    <NativeSelectOption key={role.id} value={role.id}>
                      {role.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="identity-group-filter">Group</FieldLabel>
                <NativeSelect
                  id="identity-group-filter"
                  className="w-full [&_select]:min-h-11"
                  value={groupId}
                  onChange={(event) => {
                    setGroupId(event.target.value);
                    setPageIndex(0);
                  }}
                >
                  <NativeSelectOption value="all">
                    All groups
                  </NativeSelectOption>
                  <NativeSelectOption value="none">
                    No groups
                  </NativeSelectOption>
                  {controller.state.groups.map((group) => (
                    <NativeSelectOption key={group.id} value={group.id}>
                      {group.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="identity-department-filter">
                  Department
                </FieldLabel>
                <NativeSelect
                  id="identity-department-filter"
                  className="w-full [&_select]:min-h-11"
                  value={department}
                  onChange={(event) => {
                    setDepartment(event.target.value);
                    setPageIndex(0);
                  }}
                >
                  <NativeSelectOption value="all">
                    All departments
                  </NativeSelectOption>
                  {departments.map((name) => (
                    <NativeSelectOption key={name} value={departmentId(name)}>
                      {name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="identity-expiry-filter">Expiry</FieldLabel>
                <NativeSelect
                  id="identity-expiry-filter"
                  className="w-full [&_select]:min-h-11"
                  value={expiry}
                  onChange={(event) => {
                    setExpiry(event.target.value as ExpiryFilter);
                    setPageIndex(0);
                  }}
                >
                  <NativeSelectOption value="all">
                    Any expiry
                  </NativeSelectOption>
                  <NativeSelectOption value="expired">
                    Expired
                  </NativeSelectOption>
                  <NativeSelectOption value="next-30-days">
                    Next 30 days
                  </NativeSelectOption>
                  <NativeSelectOption value="no-expiry">
                    No expiry
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="identity-activity-filter">
                  Activity
                </FieldLabel>
                <NativeSelect
                  id="identity-activity-filter"
                  className="w-full [&_select]:min-h-11"
                  value={activity}
                  onChange={(event) => {
                    setActivity(event.target.value as ActivityFilter);
                    setPageIndex(0);
                  }}
                >
                  <NativeSelectOption value="all">
                    Any activity
                  </NativeSelectOption>
                  <NativeSelectOption value="active-session">
                    Active session
                  </NativeSelectOption>
                  <NativeSelectOption value="recent-change">
                    Recent access change
                  </NativeSelectOption>
                  <NativeSelectOption value="no-session">
                    No active session
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
          </details>
        </CardContent>
      </Card>

      {selected.length > 0 && (
        <div className="bg-muted flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium" role="status">
            {selected.length}{" "}
            {selected.length === 1 ? "identity" : "identities"} selected
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              className="min-h-11"
              onClick={() => setSelected([])}
            >
              Clear selection
            </Button>
            <Button
              className="min-h-11"
              disabled={controller.isPending()}
              onClick={() => setBulkOpen(true)}
            >
              Review bulk action
            </Button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <Empty className="min-h-72 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {directoryIdentities.length === 0 ? <UsersRound /> : <Search />}
            </EmptyMedia>
            <EmptyTitle>
              {directoryIdentities.length === 0
                ? "No identities yet"
                : "No identities match"}
            </EmptyTitle>
            <EmptyDescription>
              {directoryIdentities.length === 0
                ? "Add an internal person, guest, or service metadata entry."
                : "Change the search or filters to see more identities."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {hasFilters ? (
              <Button
                variant="outline"
                className="min-h-11"
                onClick={resetFilters}
              >
                Clear filters
              </Button>
            ) : (
              <Button
                className="min-h-11"
                onClick={() => openCreate("internal")}
              >
                <UserRoundPlus /> Add internal identity
              </Button>
            )}
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-md border md:block">
            <DataTable
              ariaLabel="Identity directory"
              columns={identityColumns}
              data={visible}
              getRowId={(identity) => identity.id}
              rowState={(identity) =>
                selected.includes(identity.id) ? "selected" : undefined
              }
            />
          </div>

          <div className="grid gap-3 md:hidden">
            {visible.map((identity) => (
              <IdentityCard
                key={identity.id}
                identity={identity}
                controller={controller}
                selected={selected.includes(identity.id)}
                onSelect={(checked) =>
                  setSelected((current) =>
                    checked
                      ? [...new Set([...current, identity.id])]
                      : current.filter((id) => id !== identity.id),
                  )
                }
                onOpen={() => openIdentity(identity.id)}
              />
            ))}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground text-sm">
              Showing {pageResult.total === 0 ? 0 : pageResult.offset + 1}–
              {Math.min(pageResult.offset + pageResult.limit, pageResult.total)}{" "}
              of {pageResult.total} · {pageResult.limit} per page
            </p>
            <PaginationControls
              ariaLabel="Identity pages"
              className="w-auto justify-start sm:justify-end"
              pageCount={pageCount}
              pageIndex={safePageIndex}
              onPageIndexChange={setPageIndex}
              variant="compact"
            />
          </div>
        </>
      )}

      <IdentityEditor
        controller={controller}
        identityId={editorIdentityId}
        createKind={createKind}
        open={editorOpen}
        onOpenChange={updateEditorOpen}
      />

      <AlertDialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>Review bulk identity update</AlertDialogTitle>
          <AlertDialogDescription>
            Choose one controlled change, then review the calculated impact
            before applying it.
          </AlertDialogDescription>
          <Field>
            <FieldLabel htmlFor="bulk-action">Action</FieldLabel>
            <NativeSelect
              id="bulk-action"
              className="w-full [&_select]:min-h-11"
              value={bulkAction}
              onChange={(event) =>
                setBulkAction(event.target.value as BulkAction)
              }
            >
              <NativeSelectOption value="disable">
                Disable access
              </NativeSelectOption>
              <NativeSelectOption value="restore">
                Restore access
              </NativeSelectOption>
              <NativeSelectOption value="role">Change role</NativeSelectOption>
              <NativeSelectOption value="add-group">
                Add to group
              </NativeSelectOption>
              <NativeSelectOption value="remove-group">
                Remove from group
              </NativeSelectOption>
            </NativeSelect>
          </Field>
          {bulkAction === "role" && (
            <Field>
              <FieldLabel htmlFor="bulk-role">Role</FieldLabel>
              <NativeSelect
                id="bulk-role"
                className="w-full [&_select]:min-h-11"
                value={bulkRoleId}
                onChange={(event) => setBulkRoleId(event.target.value)}
              >
                {controller.state.roles.map((role) => (
                  <NativeSelectOption key={role.id} value={role.id}>
                    {role.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                Guest and service identities cannot receive the Administrator
                role.
              </FieldDescription>
            </Field>
          )}
          {(bulkAction === "add-group" || bulkAction === "remove-group") && (
            <Field>
              <FieldLabel htmlFor="bulk-group">Group</FieldLabel>
              <NativeSelect
                id="bulk-group"
                className="w-full [&_select]:min-h-11"
                value={bulkGroupId}
                onChange={(event) => setBulkGroupId(event.target.value)}
              >
                {controller.state.groups.length === 0 && (
                  <NativeSelectOption value="">
                    No groups available
                  </NativeSelectOption>
                )}
                {controller.state.groups.map((group) => (
                  <NativeSelectOption key={group.id} value={group.id}>
                    {group.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                Existing memberships are preserved. Service identities cannot
                join groups.
              </FieldDescription>
            </Field>
          )}
          <Alert variant={bulkPreview.ok ? "default" : "warning"}>
            <ArrowDownAZ className="size-4" />
            <p className="font-medium">
              {bulkPreview.ok ? "Impact ready" : "Action blocked"}
            </p>
            <div className="text-muted-foreground mt-1">
              {bulkPreview.error ?? bulkPreview.summary}
            </div>
          </Alert>
          <AlertDialogFooter>
            <AlertDialogCancel
              render={<Button variant="outline" className="min-h-11" />}
            >
              Cancel
            </AlertDialogCancel>
            <Button
              className="min-h-11"
              disabled={!bulkPreview.ok || controller.isPending()}
              onClick={applyBulk}
            >
              Apply to {bulkPreview.affected}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function IdentityCard({
  identity,
  controller,
  selected,
  onSelect,
  onOpen,
}: {
  identity: AccessIdentity;
  controller: AccessController;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  onOpen: () => void;
}) {
  const role = controller.state.roles.find(
    (item) => item.id === identity.roleId,
  );
  return (
    <Card className="w-full">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-start gap-3">
          <label className="flex size-11 shrink-0 items-center justify-center">
            <Checkbox
              checked={selected}
              disabled={identity.status === "deleted"}
              onCheckedChange={onSelect}
            />
            <span className="sr-only">
              {identity.status === "deleted" ? "Deleted identity" : "Select"}{" "}
              {identity.name}
            </span>
          </label>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{identity.name}</p>
            <p className="text-muted-foreground mt-0.5 truncate text-sm">
              {identityDetail(identity)}
            </p>
          </div>
          <Badge variant={statusVariant(identity.status)}>
            {statusLabels[identity.status]}
          </Badge>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-muted-foreground text-xs">Kind</dt>
            <dd>{kindLabels[identity.kind]}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Role</dt>
            <dd>{role?.name ?? "Unknown role"}</dd>
          </div>
        </dl>
        <Button variant="outline" className="min-h-11 w-full" onClick={onOpen}>
          Manage {identity.name}
        </Button>
      </CardContent>
    </Card>
  );
}
