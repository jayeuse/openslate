"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  Copy,
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
  DropdownMenuGroup,
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
  const recommendedTemplateId = controller.state.templates.some(
    (template) => template.id === "template:viewer",
  )
    ? "template:viewer"
    : undefined;

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
                    <span>Compare</span>
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
        header: "Grants",
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
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={controller.isPending()}
                onClick={() => void duplicate(role)}
              >
                <Copy /> Duplicate
              </Button>
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
          {compareMode ? (
            <>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={cancelCompare}
              >
                Cancel compare
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={compareIds.length < 2}
                onClick={() => setCompareOpen(true)}
              >
                <Scale data-icon="inline-start" />
                Compare roles ({compareIds.length})
              </Button>
            </>
          ) : null}
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

      <Alert>
        <ShieldCheck />
        <div className="mt-2">
          <p className="font-medium">Administrator continuity is protected</p>
          <p className="mt-1">
            Built-in roles cannot be changed or deleted. The last active
            Administrator cannot be reassigned or disabled.
          </p>
        </div>
      </Alert>

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

      {compareMode && (
        <p className="text-muted-foreground text-sm" role="status">
          Choose two to four roles, then select Compare roles.
        </p>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <Field className="w-full lg:max-w-sm">
          <FieldLabel htmlFor="role-search">Search roles</FieldLabel>
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-3 left-3 size-4"
            />
            <Input
              id="role-search"
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ToggleGroup
            aria-label="Filter roles"
            value={[filter]}
            onValueChange={(values) => {
              const value = values[0];
              if (
                value === "all" ||
                value === "built-in" ||
                value === "custom"
              ) {
                setFilter(value);
                setPage(0);
              }
            }}
          >
            <ToggleGroupItem className="min-h-11" value="all">
              All
            </ToggleGroupItem>
            <ToggleGroupItem className="min-h-11" value="built-in">
              Built-in
            </ToggleGroupItem>
            <ToggleGroupItem className="min-h-11" value="custom">
              Custom
            </ToggleGroupItem>
          </ToggleGroup>
          <details className="group w-full rounded-md border sm:w-auto">
            <summary className="focus-visible:outline-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2">
              <span>More options</span>
              <ChevronDown
                className="size-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </summary>
            <div className="flex flex-wrap items-center gap-2 border-t p-2">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="outline" className="min-h-11" />}
                >
                  <ArrowUpDown data-icon="inline-start" /> Sort
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" aria-label="Sort roles">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onClick={() => {
                        setSort("name");
                        setPage(0);
                      }}
                    >
                      Name
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setSort("members");
                        setPage(0);
                      }}
                    >
                      Most members
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setSort("grants");
                        setPage(0);
                      }}
                    >
                      Most grants
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {!compareMode ? (
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={startCompare}
                >
                  <Scale data-icon="inline-start" /> Compare roles
                </Button>
              ) : null}
            </div>
          </details>
        </div>
      </div>

      {visible.length === 0 ? (
        <Empty className="border">
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
          <div className="hidden overflow-hidden rounded-lg border md:block">
            <DataTable
              ariaLabel="Roles directory"
              columns={roleColumns}
              data={visible}
              getRowId={(role) => role.id}
            />
          </div>

          <div className="grid gap-3 md:hidden">
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
                        <span>Compare</span>
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
                    <p className="text-muted-foreground text-xs">Grants</p>
                    <p className="mt-1 font-medium">{role.grants.length}</p>
                  </div>
                </CardContent>
                <CardFooter>
                  <Button
                    variant="outline"
                    className="min-h-11 flex-1"
                    onClick={() => editRole(role)}
                  >
                    {role.builtin ? "View role" : "Edit role"}
                  </Button>
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    disabled={controller.isPending()}
                    onClick={() => void duplicate(role)}
                  >
                    Duplicate
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        </>
      )}

      {pageCount > 1 && (
        <PaginationControls
          ariaLabel="Role pages"
          pageCount={pageCount}
          pageIndex={currentPage}
          onPageIndexChange={setPage}
        />
      )}

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
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Compare roles</DialogTitle>
            <DialogDescription>
              Review up to four role baselines side by side.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {compared.map((role) => (
              <Card key={role.id}>
                <CardHeader>
                  <CardTitle>{role.name}</CardTitle>
                  <CardDescription>
                    {memberCount(role.id)} members · {role.grants.length} grants
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {role.name.toLowerCase() === "admin" ? (
                    <p className="text-muted-foreground mb-3 text-xs">
                      Protected Administrator management access is additional to
                      these data permissions.
                    </p>
                  ) : null}
                  <ul className="flex flex-col gap-2 text-sm">
                    {role.grants.length ? (
                      role.grants.map((grant) => (
                        <li
                          key={grant}
                          className="bg-muted rounded-md px-2 py-1"
                        >
                          {permissionNames.get(grant) ?? grant}
                        </li>
                      ))
                    ) : (
                      <li className="text-muted-foreground">
                        Default deny; no baseline grants.
                      </li>
                    )}
                  </ul>
                </CardContent>
              </Card>
            ))}
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
