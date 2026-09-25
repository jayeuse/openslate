"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Ellipsis,
  LockKeyhole,
  Minus,
  PencilLine,
  Plus,
  Scale,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { AccessController } from "../state/controller";
import type { EditorIntent } from "../helpers/editor-helpers";
import type { Role } from "../domain/model";
import {
  readAccessRoleDraft,
  type AccessRoleDraft,
} from "../state/draft-journal";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import { RoleEditor } from "./role-group-editors";
import {
  completeCollection,
  pageCollection,
} from "../../shared/helpers/sample-collections";

type RolesViewProps = { controller: AccessController };
type RoleFilter = "all" | "built-in" | "custom";
type RoleSort = "name" | "members" | "grants";
type ComparisonPermission = { id: string; name: string };
const PAGE_SIZE = 5;

function roleDescription(role: Role): string {
  if (role.description) return role.description;
  if (role.name.toLowerCase() === "admin")
    return "Full protected administration of the workspace.";
  if (role.name.toLowerCase() === "member")
    return "Standard access to assigned workspace resources.";
  return "No description";
}

function draftFromTemplate(
  template: AccessController["state"]["templates"][number],
): Role {
  return {
    id: `draft:${template.id}`,
    name: template.id === "template:blank" ? "" : template.name,
    description: template.description,
    builtin: false,
    grants: [...template.grants],
  };
}

export function RolesView({ controller }: RolesViewProps) {
  const userId = useVerifiedWorkspaceUserId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RoleFilter>("all");
  const [sort, setSort] = useState<RoleSort>("name");
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Role | null>(null);
  const [draftIntent, setDraftIntent] = useState<EditorIntent>("edit");
  const [restoredValues, setRestoredValues] = useState<
    AccessRoleDraft["values"] | null
  >(null);
  const [restoredUncertain, setRestoredUncertain] = useState(false);
  const [journalIssue, setJournalIssue] = useState("");
  const restoredUserId = useRef<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const permissionNames = new Map(
    controller.permissionCatalog.map((permission) => [
      permission.id,
      permission.name,
    ]),
  );
  const roleCounts: Record<RoleFilter, number> = {
    all: controller.state.roles.length,
    "built-in": controller.state.roles.filter((role) => role.builtin).length,
    custom: controller.state.roles.filter((role) => !role.builtin).length,
  };

  useEffect(() => {
    if (restoredUserId.current === userId) return;
    restoredUserId.current = userId;
    const stored = readAccessRoleDraft(userId);
    if (stored.value) {
      setDraft(stored.value.baseline);
      setDraftIntent(stored.value.intent);
      setRestoredValues(stored.value.values);
    }
    setRestoredUncertain(stored.status === "uncertain");
    if (stored.status === "unavailable")
      setJournalIssue(
        "Browser draft storage is unavailable. Role changes may not survive reload.",
      );
    else if (stored.status === "invalid")
      setJournalIssue(
        "A saved role draft could not be safely restored. It was not applied.",
      );
  }, [userId]);

  const memberCount = (roleId: string) =>
    controller.state.identities.filter((identity) => identity.roleId === roleId)
      .length;
  const filtered = controller.state.roles
    .filter((role) => {
      const matchesQuery = `${role.name} ${roleDescription(role)}`
        .toLowerCase()
        .includes(query.trim().toLowerCase());
      const matchesFilter =
        filter === "all" ||
        (filter === "built-in" ? role.builtin : !role.builtin);
      return matchesQuery && matchesFilter;
    })
    .sort((left, right) => {
      if (sort === "members")
        return memberCount(right.id) - memberCount(left.id);
      if (sort === "grants") return right.grants.length - left.grants.length;
      return left.name.localeCompare(right.name);
    });
  const pageResult = pageCollection(
    completeCollection(
      filtered,
      JSON.stringify(["roles", query.trim().toLowerCase(), filter, sort]),
    ),
    page * PAGE_SIZE,
    PAGE_SIZE,
  );
  const pageCount = Math.max(1, Math.ceil(pageResult.total / pageResult.limit));
  const currentPage = pageResult.offset / pageResult.limit;
  const visible = [...pageResult.items];
  const compared = compareIds
    .map((id) => controller.state.roles.find((role) => role.id === id))
    .filter((role): role is Role => Boolean(role));
  const comparisonPermissions: ComparisonPermission[] = [
    ...controller.permissionCatalog.map(({ id, name }) => ({ id, name })),
    ...Array.from(new Set(compared.flatMap((role) => role.grants)))
      .filter((grant) => !permissionNames.has(grant))
      .map((id) => ({ id, name: id })),
  ];
  const recommendedTemplateId = controller.state.templates.some(
    (template) => template.id === "template:viewer",
  )
    ? "template:viewer"
    : undefined;
  const comparisonColumns = useMemo<DataTableColumn<ComparisonPermission>[]>(
    () => [
      {
        id: "permission",
        header: "Permission",
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      ...compared.map((role): DataTableColumn<ComparisonPermission> => ({
        id: role.id,
        header: () => (
          <div className="min-w-40 space-y-1 py-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-foreground font-medium">{role.name}</span>
              {role.builtin && <Badge variant="secondary">Built-in</Badge>}
            </div>
            <span className="text-muted-foreground block text-xs font-normal">
              {
                controller.state.identities.filter(
                  (identity) => identity.roleId === role.id,
                ).length
              }{" "}
              members · {role.grants.length} grants
            </span>
          </div>
        ),
        cell: ({ row }) => {
          const granted = role.grants.includes(row.original.id);
          const StatusIcon = granted ? Check : Minus;
          return (
            <span className="inline-flex min-w-28 items-center gap-2 text-sm">
              <StatusIcon
                aria-hidden="true"
                className="text-muted-foreground size-4 shrink-0"
              />
              {granted ? "Granted" : "Not granted"}
            </span>
          );
        },
      })),
    ],
    [compared, controller.state.identities],
  );

  function startCompare() {
    setMessage("");
    setCompareIds([]);
    setCompareMode(true);
  }

  function cancelCompare() {
    setMessage("");
    setCompareIds([]);
    setCompareMode(false);
  }

  function toggleCompare(roleId: string, checked: boolean) {
    setMessage("");
    setCompareIds((current) => {
      if (!checked) return current.filter((id) => id !== roleId);
      if (current.length >= 4) {
        setMessage("Compare supports up to four roles.");
        return current;
      }
      return [...current, roleId];
    });
  }

  async function duplicate(role: Role) {
    if (controller.isPending()) {
      setMessage("Another Access change is already in progress.");
      return;
    }
    const result = await controller.actions.duplicateRole(role.id);
    setMessage(result.ok ? `Duplicated ${role.name}.` : result.error);
  }

  function editRole(role: Role) {
    if (restoredUncertain) return;
    setRestoredValues(null);
    setDraftIntent("edit");
    setDraft({ ...role, grants: [...role.grants] });
  }

  function createRoleFromTemplate(template: Role) {
    if (restoredUncertain) return;
    setRestoredValues(null);
    setDraftIntent("create");
    setDraft(template);
  }

  function startCreateRole() {
    if (restoredUncertain) return;
    if (controller.state.templates.length) {
      setTemplateOpen(true);
      return;
    }
    createRoleFromTemplate({
      id: "draft:new-role",
      name: "",
      description: "",
      builtin: false,
      grants: [],
    });
  }

  const roleColumns = useMemo<DataTableColumn<Role>[]>(
    () => [
      ...(compareMode
        ? [
            {
              id: "compare",
              header: "Compare",
              cell: ({ row }: { row: { original: Role } }) => {
                const role = row.original;
                return (
                  <label className="flex min-h-11 items-center gap-2">
                    <Checkbox
                      aria-label={`Compare ${role.name}`}
                      checked={compareIds.includes(role.id)}
                      disabled={
                        !compareIds.includes(role.id) && compareIds.length >= 4
                      }
                      onCheckedChange={(checked) =>
                        toggleCompare(role.id, checked === true)
                      }
                    />
                    <span aria-hidden="true">Compare</span>
                  </label>
                );
              },
            } satisfies DataTableColumn<Role>,
          ]
        : []),
      {
        id: "role",
        header: "Role",
        cell: ({ row }) => {
          const role = row.original;
          return (
            <button
              className="focus-visible:outline-ring min-h-11 max-w-md rounded-sm text-left outline-none focus-visible:outline-2"
              onClick={() => editRole(role)}
            >
              <span className="flex items-center gap-2 font-medium">
                {role.name}
                {role.builtin && <Badge variant="secondary">Built-in</Badge>}
              </span>
              <span className="text-muted-foreground block truncate text-xs">
                {roleDescription(role)}
              </span>
            </button>
          );
        },
      },
      {
        id: "members",
        header: "Members",
        cell: ({ row }) => memberCount(row.original.id),
      },
      {
        id: "grants",
        header: "Permissions",
        cell: ({ row }) => row.original.grants.length,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const role = row.original;
          return (
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => editRole(role)}
              >
                {role.builtin ? "View role" : "Edit role"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0"
                      aria-label={`More actions for ${role.name}`}
                      disabled={controller.isPending()}
                    />
                  }
                >
                  <Ellipsis aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    className="min-h-11"
                    disabled={controller.isPending()}
                    onClick={() => void duplicate(role)}
                  >
                    <Copy aria-hidden="true" />
                    Duplicate
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [
      compareIds,
      compareMode,
      controller.isPending,
      controller.state.identities,
      duplicate,
      memberCount,
    ],
  );

  return (
    <section
      aria-labelledby="roles-heading"
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="roles-heading"
            className="text-xl font-semibold tracking-tight"
          >
            Roles
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Define reusable access baselines, then refine them with scoped
            rules.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            className="min-h-11"
            disabled={controller.isPending() || restoredUncertain}
            onClick={startCreateRole}
          >
            <Plus data-icon="inline-start" />
            Create role
          </Button>
        </div>
      </div>

      <section
        aria-label="Role guidelines"
        className="bg-muted/30 grid gap-3 rounded-lg border p-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1.2fr]"
      >
        <div className="flex min-w-0 items-start gap-3">
          <LockKeyhole
            aria-hidden="true"
            className="text-muted-foreground mt-0.5 size-4 shrink-0"
          />
          <div className="min-w-0">
            <p className="font-medium">Built-in roles</p>
            <p className="text-muted-foreground text-sm">
              Protected defaults. Duplicate one to create an editable custom
              role.
            </p>
          </div>
        </div>
        <div className="flex min-w-0 items-start gap-3 sm:border-l sm:pl-3 xl:border-l">
          <PencilLine
            aria-hidden="true"
            className="text-muted-foreground mt-0.5 size-4 shrink-0"
          />
          <div className="min-w-0">
            <p className="font-medium">Custom roles</p>
            <p className="text-muted-foreground text-sm">
              Set a reusable permission baseline for a team’s responsibilities.
            </p>
          </div>
        </div>
        <div className="flex min-w-0 items-start gap-3 border-t pt-3 sm:col-span-2 sm:pl-0 xl:col-span-1 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-3">
          <ShieldCheck
            aria-hidden="true"
            className="text-muted-foreground mt-0.5 size-4 shrink-0"
          />
          <div className="min-w-0">
            <p className="font-medium">Administrator protection</p>
            <p className="text-muted-foreground text-sm">
              Built-in roles cannot be changed or deleted. The last active
              Administrator cannot be reassigned or disabled.
            </p>
          </div>
        </div>
      </section>

      {journalIssue ? (
        <Alert role="alert" variant="warning">
          {journalIssue}
        </Alert>
      ) : null}

      {message && (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      )}

      <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <ToggleGroup
          aria-label="Filter roles"
          value={[filter]}
          onValueChange={(values) => {
            const value = values[0];
            if (value === "all" || value === "built-in" || value === "custom") {
              setFilter(value);
              setPage(0);
            }
          }}
          className="w-full sm:w-auto"
        >
          <ToggleGroupItem
            className="min-h-11 min-w-0 flex-1 gap-2 px-2 sm:flex-none sm:px-4"
            value="all"
            aria-label={`All ${roleCounts.all}`}
          >
            <span>All</span>
            <Badge variant="outline">{roleCounts.all}</Badge>
          </ToggleGroupItem>
          <ToggleGroupItem
            className="min-h-11 min-w-0 flex-1 gap-2 px-2 sm:flex-none sm:px-4"
            value="built-in"
            aria-label={`Built-in ${roleCounts["built-in"]}`}
          >
            <span>Built-in</span>
            <Badge variant="outline">{roleCounts["built-in"]}</Badge>
          </ToggleGroupItem>
          <ToggleGroupItem
            className="min-h-11 min-w-0 flex-1 gap-2 px-2 sm:flex-none sm:px-4"
            value="custom"
            aria-label={`Custom ${roleCounts.custom}`}
          >
            <span>Custom</span>
            <Badge variant="outline">{roleCounts.custom}</Badge>
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end xl:flex-1 xl:justify-end">
          <Field className="min-w-0 sm:max-w-sm">
            <FieldLabel htmlFor="role-search">Search roles</FieldLabel>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              />
              <Input
                id="role-search"
                type="search"
                className="min-h-11 pl-9"
                value={query}
                placeholder="Name or description"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="role-sort">Sort</FieldLabel>
            <NativeSelect
              id="role-sort"
              className="w-full [&_select]:min-h-11"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as RoleSort);
                setPage(0);
              }}
            >
              <NativeSelectOption value="name">Name</NativeSelectOption>
              <NativeSelectOption value="members">
                Most members
              </NativeSelectOption>
              <NativeSelectOption value="grants">
                Most grants
              </NativeSelectOption>
            </NativeSelect>
          </Field>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-3 xl:col-span-1">
            {compareMode ? (
              <>
                <Button
                  variant="outline"
                  className="min-h-11 flex-1 sm:flex-none"
                  onClick={cancelCompare}
                >
                  Cancel compare
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11 flex-1 sm:flex-none"
                  disabled={compareIds.length < 2}
                  onClick={() => setCompareOpen(true)}
                >
                  <Scale data-icon="inline-start" />
                  Compare roles ({compareIds.length})
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                onClick={startCompare}
              >
                <Scale data-icon="inline-start" /> Compare roles
              </Button>
            )}
          </div>
        </div>
      </div>

      {compareMode && (
        <p className="text-muted-foreground text-sm" role="status">
          Choose two to four roles to compare their permission baselines.
        </p>
      )}

      <div className="overflow-hidden rounded-lg border">
        {visible.length === 0 ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldCheck />
              </EmptyMedia>
              <EmptyTitle>No roles found</EmptyTitle>
              <EmptyDescription>
                Adjust the search or create a role.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                className="min-h-11"
                disabled={controller.isPending() || restoredUncertain}
                onClick={startCreateRole}
              >
                Create role
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable
                ariaLabel="Roles directory"
                columns={roleColumns}
                data={visible}
                getRowId={(role) => role.id}
              />
            </div>

            <div className="grid gap-3 border-b p-3 md:hidden">
              {visible.map((role) => (
                <Card key={role.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="flex flex-wrap items-center gap-2">
                          {role.name}
                          {role.builtin && (
                            <Badge variant="secondary">Built-in</Badge>
                          )}
                        </CardTitle>
                        <CardDescription className="mt-1">
                          {roleDescription(role)}
                        </CardDescription>
                      </div>
                      {compareMode && (
                        <label className="flex min-h-11 items-center gap-2">
                          <Checkbox
                            aria-label={`Compare ${role.name}`}
                            checked={compareIds.includes(role.id)}
                            disabled={
                              !compareIds.includes(role.id) &&
                              compareIds.length >= 4
                            }
                            onCheckedChange={(checked) =>
                              toggleCompare(role.id, checked === true)
                            }
                          />
                          <span aria-hidden="true">Compare</span>
                        </label>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-muted-foreground text-xs">Members</p>
                      <p className="mt-1 font-medium">{memberCount(role.id)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">
                        Permissions
                      </p>
                      <p className="mt-1 font-medium">{role.grants.length}</p>
                    </div>
                  </CardContent>
                  <CardFooter className="items-center">
                    <Button
                      variant="outline"
                      className="min-h-11 flex-1"
                      onClick={() => editRole(role)}
                    >
                      {role.builtin ? "View role" : "Edit role"}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11 shrink-0"
                            aria-label={`More actions for ${role.name}`}
                            disabled={controller.isPending()}
                          />
                        }
                      >
                        <Ellipsis aria-hidden="true" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="min-h-11"
                          disabled={controller.isPending()}
                          onClick={() => void duplicate(role)}
                        >
                          <Copy aria-hidden="true" />
                          Duplicate
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardFooter>
                </Card>
              ))}
            </div>
          </>
        )}
        <div className="bg-card flex flex-col gap-3 border-t p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-sm">
            Showing {pageResult.total === 0 ? 0 : pageResult.offset + 1}–
            {Math.min(
              pageResult.offset + pageResult.items.length,
              pageResult.total,
            )}{" "}
            of {pageResult.total}
          </p>
          <PaginationControls
            ariaLabel="Role pages"
            className="w-auto"
            pageCount={pageCount}
            pageIndex={currentPage}
            onPageIndexChange={setPage}
          />
        </div>
      </div>

      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Start a role draft</DialogTitle>
            <DialogDescription>
              Choosing a template only opens a draft. Nothing is saved until you
              review and apply it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {controller.state.templates.map((template) => (
              <button
                key={template.id}
                className="border-border hover:bg-muted focus-visible:outline-ring min-h-24 rounded-lg border p-4 text-left transition-colors outline-none focus-visible:outline-2 motion-reduce:transition-none"
                onClick={() => {
                  setTemplateOpen(false);
                  createRoleFromTemplate(draftFromTemplate(template));
                }}
              >
                <span className="flex items-center gap-2 font-medium">
                  {template.name}
                  {template.id === recommendedTemplateId && (
                    <Badge variant="secondary">Recommended</Badge>
                  )}
                </span>
                <span className="text-muted-foreground mt-1 block text-sm">
                  {template.description}
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent className="grid max-h-[90dvh] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Compare roles</DialogTitle>
            <DialogDescription>
              Compare the permission baselines of these roles. Not granted means
              there is no baseline grant for that permission.
            </DialogDescription>
          </DialogHeader>
          <div
            role="region"
            aria-label="Role permission comparison"
            tabIndex={0}
            className="focus-visible:outline-ring min-h-0 overflow-auto rounded-md border focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {comparisonPermissions.length ? (
              <div className="min-w-[40rem]">
                <DataTable
                  ariaLabel="Role permission comparison"
                  columns={comparisonColumns}
                  data={comparisonPermissions}
                  getRowId={(permission) => permission.id}
                  className="min-w-[40rem]"
                />
              </div>
            ) : (
              <p className="text-muted-foreground p-4 text-sm">
                No permissions are available to compare.
              </p>
            )}
          </div>
          <div className="mt-3 space-y-1">
            <p className="text-muted-foreground text-sm">
              These are role baselines. Detailed rules may affect actual access.
            </p>
            {compared.some((role) => role.name.toLowerCase() === "admin") && (
              <p className="text-muted-foreground text-sm">
                Protected Administrator management access is additional to these
                data permissions.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setCompareOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RoleEditor
        key={draft?.id ?? "closed-role"}
        controller={controller}
        draft={draft}
        intent={draftIntent}
        restoredValues={restoredValues}
        restoredUncertain={restoredUncertain}
        onClose={() => {
          setDraft(null);
          setRestoredValues(null);
          setRestoredUncertain(false);
        }}
      />
    </section>
  );
}
