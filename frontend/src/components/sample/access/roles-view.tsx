"use client";

import { useMemo, useState } from "react";
import {
  ArrowUpDown,
  Copy,
  MoreHorizontal,
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
import type { AccessController } from "./controller";
import type { Role } from "./model";
import { RoleEditor } from "./role-group-editors";

type RolesViewProps = { controller: AccessController };
type RoleFilter = "all" | "built-in" | "custom";
type RoleSort = "name" | "members" | "grants";
const PAGE_SIZE = 5;

function roleDescription(role: Role): string {
  if (role.description) return role.description;
  if (role.id === "sample-admin")
    return "Full protected administration of the workspace.";
  if (role.id === "sample-member")
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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RoleFilter>("all");
  const [sort, setSort] = useState<RoleSort>("name");
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Role | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");

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
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const compared = compareIds
    .map((id) => controller.state.roles.find((role) => role.id === id))
    .filter((role): role is Role => Boolean(role));

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

  function duplicate(role: Role) {
    const result = controller.actions.duplicateRole(role.id);
    setMessage(result.ok ? `Duplicated ${role.name}.` : result.error);
  }

  const roleColumns = useMemo<DataTableColumn<Role>[]>(
    () => [
      {
        id: "compare",
        header: () => <span className="sr-only">Compare</span>,
        cell: ({ row }) => {
          const role = row.original;
          return (
            <Checkbox
              aria-label={`Compare ${role.name}`}
              checked={compareIds.includes(role.id)}
              disabled={!compareIds.includes(role.id) && compareIds.length >= 4}
              onCheckedChange={(checked) =>
                toggleCompare(role.id, checked === true)
              }
            />
          );
        },
      },
      {
        id: "role",
        header: "Role",
        cell: ({ row }) => {
          const role = row.original;
          return (
            <button
              className="focus-visible:outline-ring min-h-11 max-w-md rounded-sm text-left outline-none focus-visible:outline-2"
              onClick={() => setDraft({ ...role, grants: [...role.grants] })}
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
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-11"
                      aria-label={`Role actions for ${role.name}`}
                    />
                  }
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onClick={() =>
                        setDraft({ ...role, grants: [...role.grants] })
                      }
                    >
                      Edit role
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => duplicate(role)}>
                      <Copy /> Duplicate role
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [compareIds, controller.state.identities, duplicate, memberCount],
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
            variant="outline"
            className="min-h-11"
            disabled={compareIds.length < 2}
            onClick={() => setCompareOpen(true)}
          >
            <Scale data-icon="inline-start" />
            Compare {compareIds.length || "roles"}
          </Button>
          <Button className="min-h-11" onClick={() => setTemplateOpen(true)}>
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

      {message && (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
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
        <div className="flex flex-wrap items-center gap-2">
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
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" className="min-h-11" />}
            >
              <ArrowUpDown data-icon="inline-start" /> Sort
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label="Sort roles">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => setSort("name")}>
                  Name
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSort("members")}>
                  Most members
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSort("grants")}>
                  Most grants
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
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
              Adjust the search or create a role from a template.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button className="min-h-11" onClick={() => setTemplateOpen(true)}>
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
              data={filtered}
              getRowId={(role) => role.id}
              pagination={{ pageIndex: currentPage, pageSize: PAGE_SIZE }}
              onPaginationChange={(next) => setPage(next.pageIndex)}
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
                    <Checkbox
                      aria-label={`Compare ${role.name}`}
                      checked={compareIds.includes(role.id)}
                      disabled={
                        !compareIds.includes(role.id) && compareIds.length >= 4
                      }
                      onCheckedChange={(checked) =>
                        toggleCompare(role.id, checked)
                      }
                    />
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
                    onClick={() =>
                      setDraft({ ...role, grants: [...role.grants] })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    onClick={() => duplicate(role)}
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
                  setDraft(draftFromTemplate(template));
                }}
              >
                <span className="font-medium">{template.name}</span>
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
                  <ul className="flex flex-col gap-2 text-sm">
                    {role.grants.length ? (
                      role.grants.map((grant) => (
                        <li
                          key={grant}
                          className="bg-muted rounded-md px-2 py-1"
                        >
                          {grant}
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
        onClose={() => setDraft(null)}
      />
    </section>
  );
}
