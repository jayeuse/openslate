"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_TABLE_PAGE_SIZE,
  TABLE_PAGE_SIZE_OPTIONS,
} from "@/components/ui/table-pagination";
import {
  ChevronDown,
  Copy,
  Ellipsis,
  LockKeyhole,
  Network,
  Plus,
  Scale,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { PaginationControls } from "@/components/ui/pagination-controls";
import type { Role } from "../domain/model";
import type {
  AccessGroup,
  AccessIdentity,
  AccessSubjectRef,
} from "../domain/policy";
import type { AccessController } from "../state/controller";
import { AccessSearchToolbar } from "./access-search-toolbar";
import {
  GroupManagement,
  type GroupManagementControls,
} from "./group-management";
import { OrganizationChart } from "./organization-chart";
import {
  PermissionRules,
  type PermissionRulesContext,
} from "./permission-rules";
import { RoleManagement, type RoleManagementControls } from "./role-management";

export type PermissionSubjectFilter =
  "shared" | "all" | "roles" | "groups" | "identities";
type DirectorySort = "name" | "name-desc" | "members" | "rules" | "grants";
type MembershipFilter = "all" | "with-members" | "empty";

type DirectoryEntry = {
  key: string;
  subject: AccessSubjectRef;
  name: string;
  description: string;
  members: AccessIdentity[];
  ruleCount: number;
} & (
  | { kind: "everyone" }
  | { kind: "role"; role: Role }
  | { kind: "group"; group: AccessGroup }
  | { kind: "identity"; identity: AccessIdentity }
);

function subjectKey(subject: AccessSubjectRef): string {
  return subject.kind === "everyone"
    ? "everyone"
    : `${subject.kind}:${subject.id}`;
}

function entryType(entry: DirectoryEntry): string {
  if (entry.kind === "role")
    return entry.role.builtin ? "Built-in role" : "Custom role";
  if (entry.kind === "identity")
    return entry.identity.kind === "service" ? "Service" : "Person";
  return entry.kind === "group" ? "Group" : "Everyone";
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function directoryEntries(controller: AccessController): DirectoryEntry[] {
  const { identities, roles, groups, rules } = controller.state;
  const ruleCount = (subject: AccessSubjectRef) =>
    rules.filter((rule) => subjectKey(rule.subject) === subjectKey(subject))
      .length;
  return [
    {
      kind: "everyone",
      key: "everyone",
      subject: { kind: "everyone" },
      name: "Everyone",
      description: "Rules that apply across the workspace.",
      members: identities,
      ruleCount: ruleCount({ kind: "everyone" }),
    },
    ...roles.map((role): DirectoryEntry => ({
      kind: "role",
      role,
      key: `role:${role.id}`,
      subject: { kind: "role", id: role.id },
      name: role.name,
      description: role.description ?? "Reusable standard permissions.",
      members: identities.filter((identity) => identity.roleId === role.id),
      ruleCount: ruleCount({ kind: "role", id: role.id }),
    })),
    ...groups.map((group): DirectoryEntry => ({
      kind: "group",
      group,
      key: `group:${group.id}`,
      subject: { kind: "group", id: group.id },
      name: group.name,
      description: group.description || "No description",
      members: identities.filter((identity) =>
        group.memberIds.includes(identity.id),
      ),
      ruleCount: ruleCount({ kind: "group", id: group.id }),
    })),
    ...identities.map((identity): DirectoryEntry => ({
      kind: "identity",
      identity,
      key: `identity:${identity.id}`,
      subject: { kind: "identity", id: identity.id },
      name: identity.name,
      description:
        identity.kind === "service" ? identity.purpose : identity.email,
      members: [identity],
      ruleCount: ruleCount({ kind: "identity", id: identity.id }),
    })),
  ];
}

export function PermissionsView({
  controller,
  initialFilter = "shared",
  initialOpen = false,
  routeIntent,
}: {
  controller: AccessController;
  initialFilter?: PermissionSubjectFilter;
  initialOpen?: boolean;
  routeIntent: string;
}) {
  return (
    <RoleManagement controller={controller}>
      {(roles) => (
        <GroupManagement
          controller={controller}
          restoreEnabled={roles.ready && !roles.dialogOpen}
        >
          {(groups) => (
            <PermissionRules controller={controller}>
              {(rules) => (
                <PermissionsDirectory
                  controller={controller}
                  roles={roles}
                  groups={groups}
                  rules={rules}
                  initialFilter={initialFilter}
                  initialOpen={initialOpen}
                  routeIntent={routeIntent}
                />
              )}
            </PermissionRules>
          )}
        </GroupManagement>
      )}
    </RoleManagement>
  );
}

function PermissionsDirectory({
  controller,
  roles,
  groups,
  rules,
  initialFilter,
  initialOpen,
  routeIntent,
}: {
  controller: AccessController;
  roles: RoleManagementControls;
  groups: GroupManagementControls;
  rules: PermissionRulesContext;
  initialFilter: PermissionSubjectFilter;
  initialOpen: boolean;
  routeIntent: string;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DirectorySort>("name");
  const [type, setType] = useState<PermissionSubjectFilter>(initialFilter);
  const [roleType, setRoleType] = useState<"all" | "builtin" | "custom">("all");
  const [membership, setMembership] = useState<MembershipFilter>("all");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TABLE_PAGE_SIZE);
  const [expanded, setExpanded] = useState(initialOpen);
  const [chartOpen, setChartOpen] = useState(false);
  const [pendingTransition, setPendingTransition] = useState<
    (() => void) | null
  >(null);
  const [notice, setNotice] = useState("");
  const appliedRouteIntent = useRef(routeIntent);

  useEffect(() => {
    if (routeIntent === appliedRouteIntent.current || !rules.ready) return;
    if (controller.isPending() || rules.blocked || rules.hasDraft) return;

    appliedRouteIntent.current = routeIntent;
    setQuery("");
    setType(initialFilter);
    setRoleType("all");
    setMembership("all");
    setPageIndex(0);
    setExpanded(initialOpen);
    if (initialOpen) rules.requestSubjectChange({ kind: "everyone" });
  }, [controller, initialFilter, initialOpen, routeIntent, rules]);

  const entries = directoryEntries(controller);
  const selectedKey = subjectKey(rules.subject);
  const selected = entries.find((entry) => entry.key === selectedKey);
  const showEditor = rules.ready && (expanded || rules.hasDraft);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = entries
    .filter((entry) => {
      if (type === "shared" && entry.kind === "identity") return false;
      if (type === "roles" && entry.kind !== "role") return false;
      if (type === "groups" && entry.kind !== "group") return false;
      if (type === "identities" && entry.kind !== "identity") return false;
      if (
        roleType !== "all" &&
        (entry.kind !== "role" ||
          entry.role.builtin !== (roleType === "builtin"))
      )
        return false;
      if (membership === "with-members" && !entry.members.length) return false;
      if (membership === "empty" && entry.members.length) return false;
      return `${entry.name} ${entry.description} ${entryType(entry)}`
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .sort((left, right) => {
      if (left.kind === "everyone") return -1;
      if (right.kind === "everyone") return 1;
      if (sort === "members")
        return (
          right.members.length - left.members.length ||
          left.name.localeCompare(right.name)
        );
      if (sort === "rules")
        return (
          right.ruleCount - left.ruleCount ||
          left.name.localeCompare(right.name)
        );
      if (sort === "grants")
        return (
          (right.kind === "role" ? right.role.grants.length : 0) -
            (left.kind === "role" ? left.role.grants.length : 0) ||
          left.name.localeCompare(right.name)
        );
      return (sort === "name" ? 1 : -1) * left.name.localeCompare(right.name);
    });
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(pageIndex, pageCount - 1);
  const offset = safePage * pageSize;
  const visible = filtered.slice(offset, offset + pageSize);
  const selectedVisible = visible.some((entry) => entry.key === selectedKey);
  const controlsDisabled = !rules.ready || controller.isPending();

  function transition(action: () => void) {
    if (controller.isPending() || rules.blocked) {
      setNotice(
        "Finish or resolve the current Access change before changing this view.",
      );
      return;
    }
    if (rules.hasDraft) {
      setPendingTransition(() => action);
      return;
    }
    setNotice("");
    action();
  }

  function filter(action: () => void) {
    transition(() => {
      action();
      setPageIndex(0);
      setExpanded(false);
    });
  }

  function configure(entry: DirectoryEntry) {
    if (entry.key === selectedKey && showEditor) {
      transition(() => setExpanded(false));
      return;
    }
    if (controller.isPending() || rules.blocked) {
      setNotice(
        "Finish or resolve the current Access change before changing this view.",
      );
      return;
    }
    rules.requestSubjectChange(entry.subject);
    setExpanded(true);
  }

  function rowActions(entry: DirectoryEntry) {
    if (entry.kind !== "role" && entry.kind !== "group") return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label={`More actions for ${entry.name}`}
              disabled={controlsDisabled}
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {entry.kind === "role" ? (
            <>
              <DropdownMenuItem
                className="min-h-11"
                onClick={() => roles.editRole(entry.role)}
              >
                {entry.role.builtin ? "View role" : "Edit role"}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11"
                onClick={() => void roles.duplicateRole(entry.role)}
              >
                <Copy aria-hidden="true" /> Duplicate
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem
              className="min-h-11"
              onClick={() => groups.editGroup(entry.group)}
            >
              Edit group
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  function configureButton(entry: DirectoryEntry) {
    return (
      <Button
        id={`configure-subject-${entry.key}`}
        variant="ghost"
        className="min-h-11 gap-1 px-2 text-xs sm:gap-2 sm:px-3 sm:text-sm"
        aria-label={`Configure ${entry.name}`}
        aria-expanded={showEditor && selectedKey === entry.key}
        aria-controls={
          showEditor && selectedKey === entry.key
            ? "permission-subject-editor"
            : undefined
        }
        disabled={controlsDisabled}
        onClick={() => configure(entry)}
      >
        <span>Configure</span>
        <ChevronDown
          aria-hidden="true"
          className={
            showEditor && selectedKey === entry.key ? "rotate-180" : ""
          }
        />
      </Button>
    );
  }

  function summary(entry: DirectoryEntry) {
    const Icon =
      entry.kind === "role"
        ? ShieldCheck
        : entry.kind === "identity"
          ? UserRound
          : UsersRound;
    return (
      <div className="flex min-w-0 items-start gap-3">
        <Icon
          aria-hidden="true"
          className="text-muted-foreground mt-1 size-5 shrink-0"
        />
        <div className="min-w-0">
          <p className="font-medium wrap-anywhere">{entry.name}</p>
          <p className="text-muted-foreground mt-1 text-xs wrap-anywhere">
            {entry.description}
          </p>
          <p className="text-muted-foreground mt-2 text-xs lg:hidden">
            {entryType(entry)} · {entry.members.length}{" "}
            {entry.members.length === 1 ? "member" : "members"} ·{" "}
            {entry.ruleCount} rules
          </p>
        </div>
      </div>
    );
  }

  function renderEditor(entry: DirectoryEntry | undefined) {
    return (
      <div
        id="permission-subject-editor"
        className="bg-card grid min-w-0 gap-5 border-t p-4 sm:p-5 xl:grid-cols-[minmax(12rem,15rem)_minmax(0,1fr)]"
      >
        <aside className="min-w-0 space-y-5 xl:border-r xl:pr-5">
          <div className="flex items-center justify-between gap-2">
            <h3 data-slot="section-title" className="font-semibold">
              {entry?.kind === "identity" ? "Person or service" : "Members"}
              {entry && entry.kind !== "identity"
                ? ` (${entry.members.length})`
                : ""}
            </h3>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label="Close configuration"
              onClick={() => transition(() => setExpanded(false))}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          {entry ? (
            <>
              <ul className="space-y-3" aria-label={`Members of ${entry.name}`}>
                {entry.members.slice(0, 4).map((identity) => (
                  <li
                    key={identity.id}
                    className="flex min-w-0 items-center gap-3"
                  >
                    <span
                      aria-hidden="true"
                      className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-medium"
                    >
                      {initials(identity.name)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {identity.name}
                      </p>
                      <p className="text-muted-foreground truncate text-xs">
                        {identity.kind === "service"
                          ? "Service"
                          : identity.email}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              {entry.members.length > 4 ? (
                <p className="text-muted-foreground text-xs">
                  +{entry.members.length - 4} more
                </p>
              ) : null}
              {!entry.members.length ? (
                <p className="text-muted-foreground text-sm">No members yet.</p>
              ) : null}
              {entry.kind === "group" ? (
                <div className="space-y-3">
                  <Button
                    id={`group-edit-table-${entry.group.id}`}
                    variant="outline"
                    className="min-h-11 w-full"
                    disabled={controller.isPending()}
                    onClick={() => groups.editGroup(entry.group)}
                  >
                    <UsersRound aria-hidden="true" /> Manage members
                  </Button>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    Groups gather people. Rules define access for this group.
                  </p>
                </div>
              ) : null}
              {entry.kind === "role" ? (
                <div className="space-y-3 border-t pt-4">
                  <h4 className="text-sm font-medium">Standard permissions</h4>
                  <p className="text-muted-foreground text-sm">
                    {entry.role.grants.length}{" "}
                    {entry.role.grants.length === 1 ? "grant" : "grants"} from
                    this role.
                  </p>
                  <Button
                    variant="outline"
                    className="min-h-11 w-full"
                    disabled={controller.isPending()}
                    onClick={() => roles.editRole(entry.role)}
                  >
                    {entry.role.builtin && <LockKeyhole aria-hidden="true" />}
                    {entry.role.builtin ? "View role" : "Edit role"}
                  </Button>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    {entry.role.builtin
                      ? "Built-in roles are protected. Duplicate this role to create an editable copy."
                      : "Standard permissions belong to the role. Custom rules can change access."}
                  </p>
                </div>
              ) : null}
              {entry.kind === "everyone" ? (
                <p className="text-muted-foreground text-xs leading-relaxed">
                  These rules apply workspace-wide. Protected Administrator
                  access is unchanged.
                </p>
              ) : null}
              {entry.kind === "identity" ? (
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Rules target this{" "}
                  {entry.identity.kind === "service"
                    ? "service. Services cannot sign in yet"
                    : "person"}
                  .
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              This saved subject is no longer available. Review the saved draft
              before discarding it.
            </p>
          )}
        </aside>
        <div className="min-w-0">{rules.editor}</div>
      </div>
    );
  }

  const columns: DataTableColumn<DirectoryEntry>[] = [
    { id: "who", header: "Who", cell: ({ row }) => summary(row.original) },
    {
      id: "type",
      header: "Type",
      cell: ({ row }) => (
        <Badge variant="secondary">{entryType(row.original)}</Badge>
      ),
    },
    {
      id: "members",
      header: "People",
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.members.length}</span>
      ),
    },
    {
      id: "setup",
      header: "Setup",
      cell: ({ row }) => (
        <div className="space-y-1 text-sm">
          {row.original.kind === "role" ? (
            <p>
              {row.original.role.grants.length} standard{" "}
              {row.original.role.grants.length === 1
                ? "permission"
                : "permissions"}
            </p>
          ) : null}
          <p className="text-muted-foreground">
            {row.original.ruleCount}{" "}
            {row.original.ruleCount === 1 ? "rule" : "rules"}
          </p>
        </div>
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <div className="flex items-center justify-end">
          {configureButton(row.original)}
          <div className="flex w-11 shrink-0 justify-end">
            {rowActions(row.original)}
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">
          Open a row to see its members and configure permissions in place.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            disabled={controlsDisabled}
            onClick={() => setChartOpen(true)}
          >
            <Network aria-hidden="true" /> Organization chart
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={controlsDisabled}
            onClick={roles.compareRoles}
          >
            <Scale aria-hidden="true" /> Compare roles
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  id="permissions-create-button"
                  className="min-h-11"
                  disabled={controlsDisabled}
                />
              }
            >
              <Plus aria-hidden="true" /> Create{" "}
              <ChevronDown aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                id="create-role-button"
                className="min-h-11"
                onClick={roles.createRole}
              >
                <ShieldCheck aria-hidden="true" /> Create role
              </DropdownMenuItem>
              <DropdownMenuItem
                id="create-group-button"
                className="min-h-11"
                onClick={groups.createGroup}
              >
                <UsersRound aria-hidden="true" /> Create group
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {notice || roles.notice ? (
        <Alert role="status">{notice || roles.notice}</Alert>
      ) : null}
      <fieldset className="min-w-0" disabled={controlsDisabled}>
        <AccessSearchToolbar
          searchLabel="Search permissions directory"
          placeholder={
            type === "identities"
              ? "Search people or services"
              : type === "all"
                ? "Search roles, groups, or people"
                : "Search roles or groups"
          }
          query={query}
          onQueryChange={(value) => filter(() => setQuery(value))}
          sortLabel="Sort permissions"
          sort={sort}
          sortOptions={[
            { value: "name", label: "Name (A–Z)" },
            { value: "name-desc", label: "Name (Z–A)" },
            { value: "members", label: "Most members" },
            { value: "rules", label: "Most rules" },
            { value: "grants", label: "Most standard permissions" },
          ]}
          onSortChange={(value) => filter(() => setSort(value))}
          activeFilterCount={
            Number(type !== "shared") +
            Number(roleType !== "all") +
            Number(membership !== "all")
          }
        >
          <Field>
            <FieldLabel htmlFor="permission-subject-type">
              Subject type
            </FieldLabel>
            <NativeSelect
              id="permission-subject-type"
              value={type}
              className="w-full [&_select]:min-h-11"
              onChange={(event) => {
                const value = event.target.value as PermissionSubjectFilter;
                filter(() => {
                  setType(value);
                  setRoleType("all");
                });
              }}
            >
              <NativeSelectOption value="shared">
                Workspace, roles & groups
              </NativeSelectOption>
              <NativeSelectOption value="roles">Roles</NativeSelectOption>
              <NativeSelectOption value="groups">Groups</NativeSelectOption>
              <NativeSelectOption value="identities">
                People & services
              </NativeSelectOption>
              <NativeSelectOption value="all">All subjects</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="permission-role-type">Role type</FieldLabel>
            <NativeSelect
              id="permission-role-type"
              value={roleType}
              className="w-full [&_select]:min-h-11"
              onChange={(event) => {
                const value = event.target.value as typeof roleType;
                filter(() => {
                  setRoleType(value);
                  if (value !== "all") setType("roles");
                });
              }}
            >
              <NativeSelectOption value="all">All roles</NativeSelectOption>
              <NativeSelectOption value="builtin">Built-in</NativeSelectOption>
              <NativeSelectOption value="custom">Custom</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="permission-membership">Membership</FieldLabel>
            <NativeSelect
              id="permission-membership"
              value={membership}
              className="w-full [&_select]:min-h-11"
              onChange={(event) => {
                const value = event.target.value as MembershipFilter;
                filter(() => setMembership(value));
              }}
            >
              <NativeSelectOption value="all">All subjects</NativeSelectOption>
              <NativeSelectOption value="with-members">
                With members
              </NativeSelectOption>
              <NativeSelectOption value="empty">No members</NativeSelectOption>
            </NativeSelect>
          </Field>
        </AccessSearchToolbar>
      </fieldset>
      {showEditor && !selectedVisible ? (
        <section
          aria-label="Selected permission subject"
          className="overflow-hidden rounded-lg border"
        >
          <div className="bg-muted/40 flex items-center justify-between gap-3 p-4">
            <p className="font-medium">
              {selected?.name ?? "Saved rule draft"}
            </p>
            <Badge variant="outline">
              {rules.hasDraft ? "Staged changes" : "Selected subject"}
            </Badge>
          </div>
          {renderEditor(selected)}
        </section>
      ) : null}
      <div className="min-w-0 overflow-hidden rounded-lg border">
        <div>
          <DataTable
            ariaLabel="Permissions directory"
            columns={columns}
            data={visible}
            getRowId={(entry) => entry.key}
            className="w-full table-fixed [&>tbody>tr>td:nth-child(2)]:hidden lg:[&>tbody>tr>td:nth-child(2)]:table-cell [&>tbody>tr>td:nth-child(3)]:hidden lg:[&>tbody>tr>td:nth-child(3)]:table-cell [&>tbody>tr>td:nth-child(4)]:hidden lg:[&>tbody>tr>td:nth-child(4)]:table-cell [&>thead>tr>th:first-child]:w-1/2 lg:[&>thead>tr>th:first-child]:w-[32%] [&>thead>tr>th:last-child]:w-1/2 lg:[&>thead>tr>th:last-child]:w-[20%] [&>thead>tr>th:nth-child(2)]:hidden lg:[&>thead>tr>th:nth-child(2)]:table-cell lg:[&>thead>tr>th:nth-child(2)]:w-[16%] [&>thead>tr>th:nth-child(3)]:hidden lg:[&>thead>tr>th:nth-child(3)]:table-cell lg:[&>thead>tr>th:nth-child(3)]:w-[10%] [&>thead>tr>th:nth-child(4)]:hidden lg:[&>thead>tr>th:nth-child(4)]:table-cell"
            cellClassName="px-4 py-3 whitespace-normal"
            rowState={(entry) =>
              showEditor && selectedKey === entry.key ? "selected" : undefined
            }
            renderExpandedRow={(entry) =>
              showEditor && selectedKey === entry.key
                ? renderEditor(entry)
                : null
            }
            emptyState={
              <p className="text-muted-foreground px-4 py-10 text-center">
                No subjects match these filters. Try another search or filter.
              </p>
            }
          />
        </div>
        <div className="bg-card flex flex-wrap items-center justify-between gap-3 border-t p-3">
          <p className="text-muted-foreground text-sm">
            Showing {filtered.length ? offset + 1 : 0}–{offset + visible.length}{" "}
            of {filtered.length}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor="permissions-page-size"
              className="text-muted-foreground text-sm"
            >
              Rows per page
            </label>
            <NativeSelect
              id="permissions-page-size"
              value={pageSize}
              className="w-20 [&_select]:min-h-11"
              disabled={controlsDisabled}
              onChange={(event) => {
                const value = Number(event.target.value);
                filter(() => setPageSize(value));
              }}
            >
              {TABLE_PAGE_SIZE_OPTIONS.map((size) => (
                <NativeSelectOption key={size} value={size}>
                  {size}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <PaginationControls
              ariaLabel="Permissions directory pages"
              className="w-auto justify-end"
              pageCount={pageCount}
              pageIndex={safePage}
              onPageIndexChange={(page) =>
                transition(() => {
                  setPageIndex(page);
                  setExpanded(false);
                })
              }
            />
          </div>
        </div>
      </div>
      <Dialog open={chartOpen} onOpenChange={setChartOpen}>
        <DialogContent className="max-w-[96vw] p-4 sm:max-w-[90rem] sm:p-6">
          <DialogHeader className="mb-4">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>Organization chart</DialogTitle>
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                aria-label="Close organization chart"
                onClick={() => setChartOpen(false)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <DialogDescription>
              Explore department membership. Connections show membership, not
              reporting lines.
            </DialogDescription>
          </DialogHeader>
          <OrganizationChart controller={controller} />
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={pendingTransition !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTransition(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard staged rule changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your changes for {selected?.name ?? "this subject"} have not been
              applied. Keep editing or discard them before changing the
              directory.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setPendingTransition(null)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={controller.isPending() || rules.blocked}
              onClick={() => {
                if (
                  !pendingTransition ||
                  controller.isPending() ||
                  rules.blocked
                )
                  return;
                if (!rules.discardDraft()) {
                  setPendingTransition(null);
                  return;
                }
                const action = pendingTransition;
                setPendingTransition(null);
                action();
              }}
            >
              Discard and continue
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
