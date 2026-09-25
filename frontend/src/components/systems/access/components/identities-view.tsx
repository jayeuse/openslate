"use client";

import { AccessSearchToolbar } from "./access-search-toolbar";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownAZ,
  Bot,
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
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { toast } from "@/components/ui/toast";
import {
  completeCollection,
  pageCollection,
} from "../../shared/helpers/sample-collections";
import type {
  AccessController,
  BulkIdentityUpdateInput,
} from "../state/controller";
import { IdentityEditor } from "./identity-editor";
import { IdentityPreview } from "./identity-preview";
import { readAccessIdentityDraft } from "../state/draft-journal";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import {
  displayIdentityStatus,
  type AccessDisplayStatus,
  type AccessIdentity,
} from "../domain/policy";

type IdentitiesViewProps = {
  controller: AccessController;
};

type KindFilter = AccessIdentity["kind"] | "all";
type StatusFilter = AccessDisplayStatus | "all";
type ExpiryFilter = "all" | "expired" | "next-30-days" | "no-expiry";
type SortOption = "name" | "kind" | "status" | "role" | "expiry";
type BulkAction = "disable" | "restore" | "role" | "add-group" | "remove-group";

const PAGE_SIZE_OPTIONS = [3, 5, 8] as const;

const kindLabels: Record<AccessIdentity["kind"], string> = {
  internal: "Internal",
  guest: "Guest",
  service: "Service",
};

const statusLabels: Record<AccessDisplayStatus, string> = {
  active: "Active",
  expired: "Expired",
  pending: "Pending",
  disabled: "Disabled",
  deleted: "Deleted",
  revoked: "Revoked",
  suspended: "Suspended",
};
const directoryStatusOptions = [
  "active",
  "expired",
  "pending",
  "disabled",
  "revoked",
] as const satisfies readonly AccessDisplayStatus[];

function isKindFilter(value: string | null): value is KindFilter {
  return (
    value === "all" ||
    value === "internal" ||
    value === "guest" ||
    value === "service"
  );
}

function statusVariant(status: AccessDisplayStatus) {
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
  const userId = useVerifiedWorkspaceUserId();
  const restoredUserId = useRef<string | null>(null);
  const [journalIssue, setJournalIssue] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [roleId, setRoleId] = useState("all");
  const [groupId, setGroupId] = useState("all");
  const [department, setDepartment] = useState("all");
  const [expiry, setExpiry] = useState<ExpiryFilter>("all");
  const [sort, setSort] = useState<SortOption>("name");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(3);
  const [selected, setSelected] = useState<string[]>([]);
  const [editorIdentityId, setEditorIdentityId] = useState<string | null>(null);
  const [previewIdentityId, setPreviewIdentityId] = useState<string | null>(
    null,
  );
  const previewTriggerIdRef = useRef<string | null>(null);
  const suppressPreviewFocusRestoreRef = useRef(false);
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
  const kindCounts: Record<KindFilter, number> = {
    all: directoryIdentities.length,
    internal: directoryIdentities.filter(
      (identity) => identity.kind === "internal",
    ).length,
    guest: directoryIdentities.filter((identity) => identity.kind === "guest")
      .length,
    service: directoryIdentities.filter(
      (identity) => identity.kind === "service",
    ).length,
  };
  const previewIdentity = previewIdentityId
    ? (directoryIdentities.find(
        (identity) => identity.id === previewIdentityId,
      ) ?? null)
    : null;

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

  useEffect(() => {
    if (restoredUserId.current === userId) return;
    restoredUserId.current = userId;
    const stored = readAccessIdentityDraft(userId);
    if (stored.value) {
      if (stored.value.mode === "create") {
        setEditorIdentityId(null);
        setCreateKind(stored.value.draft.kind);
      } else {
        setEditorIdentityId(stored.value.draft.id);
        setCreateKind(null);
      }
      setEditorOpen(true);
    }
    if (stored.status === "unavailable")
      setJournalIssue(
        "Browser draft storage is unavailable. Identity changes may not survive reload.",
      );
    else if (stored.status === "invalid")
      setJournalIssue(
        "A saved identity draft could not be safely restored. It was not applied.",
      );
  }, [userId]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = directoryIdentities
    .filter((identity) => kind === "all" || identity.kind === kind)
    .filter(
      (identity) =>
        status === "all" || displayIdentityStatus(identity) === status,
    )
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
      const leftValue =
        sort === "role"
          ? (controller.state.roles.find((item) => item.id === left.roleId)
              ?.name ?? "")
          : sort === "name"
            ? left.name
            : sort === "status"
              ? displayIdentityStatus(left)
              : left[sort];
      const rightValue =
        sort === "role"
          ? (controller.state.roles.find((item) => item.id === right.roleId)
              ?.name ?? "")
          : sort === "name"
            ? right.name
            : sort === "status"
              ? displayIdentityStatus(right)
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

  const identityColumns = useMemo<DataTableColumn<AccessIdentity>[]>(() => {
    const columns: DataTableColumn<AccessIdentity>[] = [
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
          const KindIcon =
            identity.kind === "internal"
              ? UserRound
              : identity.kind === "guest"
                ? UsersRound
                : Bot;
          return (
            <div className="flex min-w-0 items-center gap-3">
              <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full">
                <KindIcon className="size-4" aria-hidden="true" />
              </span>
              <div className="max-w-72 min-w-0">
                <p className="font-medium break-words">{identity.name}</p>
                <p className="text-muted-foreground text-xs break-words">
                  {identityDetail(identity)}
                </p>
              </div>
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
          <Badge variant={statusVariant(displayIdentityStatus(row.original))}>
            {statusLabels[displayIdentityStatus(row.original)]}
          </Badge>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              variant="outline"
              className="min-h-11 shrink-0"
              id={`identity-preview-trigger-desktop-${row.original.id}`}
              aria-label={`View details for ${row.original.name}`}
              onClick={(event) =>
                openIdentityPreview(row.original.id, event.currentTarget)
              }
            >
              View details
            </Button>
          </div>
        ),
      },
    ];
    return controller.availability.bulkIdentityUpdates
      ? columns
      : columns.filter((column) => column.id !== "select");
  }, [
    allVisibleSelected,
    controller.availability.bulkIdentityUpdates,
    controller.state.roles,
    openIdentityPreview,
    selected,
    visibleIds,
  ]);

  function resetFilters() {
    setQuery("");
    setKind("all");
    setStatus("all");
    setRoleId("all");
    setGroupId("all");
    setDepartment("all");
    setExpiry("all");
    setSort("name");
    setPageSize(PAGE_SIZE_OPTIONS[0]);
    setPageIndex(0);
  }

  function openIdentity(identityId: string) {
    setEditorIdentityId(identityId);
    setCreateKind(null);
    setEditorOpen(true);
    replaceUserQuery(identityId);
  }

  function openIdentityPreview(identityId: string, trigger: HTMLElement) {
    previewTriggerIdRef.current = trigger.id;
    suppressPreviewFocusRestoreRef.current = false;
    setPreviewIdentityId(identityId);
  }

  function managePreviewIdentity(identityId: string) {
    suppressPreviewFocusRestoreRef.current = true;
    setPreviewIdentityId(null);
    openIdentity(identityId);
  }

  function getPreviewFinalFocus(): HTMLElement | null | false {
    if (suppressPreviewFocusRestoreRef.current) return false;
    const triggerId = previewTriggerIdRef.current;
    return triggerId ? document.getElementById(triggerId) : null;
  }

  function updatePreviewOpen(open: boolean) {
    if (!open) setPreviewIdentityId(null);
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

  const activeDirectorySettingsCount = [
    query !== "",
    kind !== "all",
    status !== "all",
    roleId !== "all",
    groupId !== "all",
    department !== "all",
    expiry !== "all",
    sort !== "name",
    pageSize !== PAGE_SIZE_OPTIONS[0],
  ].filter((isActive) => isActive).length;
  const hasNonDefaultDirectorySettings = activeDirectorySettingsCount > 0;

  return (
    <div className="space-y-3">
      {journalIssue ? (
        <Alert role="alert" variant="warning">
          {journalIssue}
        </Alert>
      ) : null}
      <h2 id="identity-directory" className="sr-only">
        Identity directory
      </h2>
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button className="min-h-11 w-full sm:w-auto" />}
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

      <Tabs
        value={kind}
        onValueChange={(value) => {
          if (!isKindFilter(value)) return;
          setKind(value);
          setPageIndex(0);
        }}
        className="gap-3"
      >
        <TabsList
          aria-label="Filter by identity type"
          className="grid h-auto w-full grid-cols-4 sm:w-fit"
        >
          {(
            [
              ["all", "All"],
              ["internal", "Internal"],
              ["guest", "Guests"],
              ["service", "Services"],
            ] as const
          ).map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              aria-label={`${label} ${kindCounts[value]}`}
              className="min-h-11 min-w-0 gap-1 px-2 sm:min-w-24 sm:gap-2 sm:px-4"
            >
              <span className="truncate">{label}</span>
              <Badge variant="outline" className="shrink-0 px-1.5">
                {kindCounts[value]}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={kind} className="space-y-3">
          <AccessSearchToolbar
            searchLabel="Search identities"
            placeholder="Name, email, or purpose"
            query={query}
            onQueryChange={(value) => {
              setQuery(value);
              setPageIndex(0);
            }}
            sort={sort}
            sortOptions={[
              { value: "name", label: "Name" },
              { value: "kind", label: "Kind" },
              { value: "status", label: "Status" },
              { value: "role", label: "Role" },
              { value: "expiry", label: "Expiry soonest" },
            ]}
            onSortChange={(value) => {
              setSort(value);
              setPageIndex(0);
            }}
            activeFilterCount={
              [
                status !== "all",
                roleId !== "all",
                groupId !== "all",
                department !== "all",
                expiry !== "all",
              ].filter(Boolean).length
            }
          >
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
                {directoryStatusOptions.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {statusLabels[value]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
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
                <NativeSelectOption value="all">All groups</NativeSelectOption>
                <NativeSelectOption value="none">No groups</NativeSelectOption>
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
                {controller.departmentCatalog.map((department) => (
                  <NativeSelectOption key={department.id} value={department.id}>
                    {department.name}
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
                <NativeSelectOption value="all">Any expiry</NativeSelectOption>
                <NativeSelectOption value="expired">Expired</NativeSelectOption>
                <NativeSelectOption value="next-30-days">
                  Next 30 days
                </NativeSelectOption>
                <NativeSelectOption value="no-expiry">
                  No expiry
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          </AccessSearchToolbar>

          {controller.availability.bulkIdentityUpdates &&
            selected.length > 0 && (
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
                    disabled={
                      controller.isPending() ||
                      !controller.availability.bulkIdentityUpdates
                    }
                    title="Bulk identity updates are not available yet."
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
                  {directoryIdentities.length === 0 ? (
                    <UsersRound />
                  ) : (
                    <Search />
                  )}
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
                {hasNonDefaultDirectorySettings ? (
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
            <div className="overflow-hidden rounded-md border">
              <div className="hidden md:block">
                <DataTable
                  ariaLabel="Identity directory"
                  columns={identityColumns}
                  data={visible}
                  cellClassName="py-3"
                  getRowId={(identity) => identity.id}
                  rowState={(identity) =>
                    selected.includes(identity.id) ? "selected" : undefined
                  }
                />
              </div>

              <div className="grid min-w-0 gap-3 p-3 md:hidden">
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
                    onOpen={(trigger) =>
                      openIdentityPreview(identity.id, trigger)
                    }
                  />
                ))}
              </div>

              <div className="bg-card flex flex-col gap-3 border-t p-4 lg:flex-row lg:items-center lg:justify-between">
                <p className="text-muted-foreground text-sm">
                  Showing {pageResult.total === 0 ? 0 : pageResult.offset + 1}–
                  {Math.min(
                    pageResult.offset + pageResult.limit,
                    pageResult.total,
                  )}{" "}
                  of {pageResult.total}
                </p>
                <div className="flex flex-wrap items-center gap-3 lg:justify-end">
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="identity-page-size"
                      className="text-muted-foreground text-sm"
                    >
                      Rows per page
                    </label>
                    <NativeSelect
                      id="identity-page-size"
                      className="w-20 [&_select]:min-h-11"
                      value={String(pageSize)}
                      onChange={(event) => {
                        const nextPageSize = Number(event.target.value);
                        if (
                          !PAGE_SIZE_OPTIONS.some(
                            (option) => option === nextPageSize,
                          )
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
                  </div>
                  <PaginationControls
                    ariaLabel="Identity pages"
                    className="w-auto"
                    pageCount={pageCount}
                    pageIndex={safePageIndex}
                    onPageIndexChange={setPageIndex}
                  />
                </div>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <IdentityPreview
        identity={previewIdentity}
        identities={directoryIdentities}
        roles={controller.state.roles}
        groups={controller.state.groups}
        departments={controller.departmentCatalog}
        open={previewIdentityId !== null}
        finalFocus={getPreviewFinalFocus}
        onOpenChange={updatePreviewOpen}
        onManage={managePreviewIdentity}
      />

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
  onOpen: (trigger: HTMLElement) => void;
}) {
  const role = controller.state.roles.find(
    (item) => item.id === identity.roleId,
  );
  return (
    <Card className="w-full min-w-0">
      <CardContent className="min-w-0 space-y-4 p-4">
        <div className="flex items-start gap-3">
          {controller.availability.bulkIdentityUpdates ? (
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
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{identity.name}</p>
            <p className="text-muted-foreground mt-0.5 truncate text-sm">
              {identityDetail(identity)}
            </p>
          </div>
          <Badge variant={statusVariant(displayIdentityStatus(identity))}>
            {statusLabels[displayIdentityStatus(identity)]}
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
        <Button
          variant="outline"
          className="min-h-11 w-full"
          id={`identity-preview-trigger-mobile-${identity.id}`}
          aria-label={`View details for ${identity.name}`}
          onClick={(event) => onOpen(event.currentTarget)}
        >
          View details
        </Button>
      </CardContent>
    </Card>
  );
}
