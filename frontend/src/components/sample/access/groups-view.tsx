"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Building2,
  ChevronRight,
  Network,
  Plus,
  Search,
  Users,
} from "lucide-react";
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
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AccessController } from "./controller";
import type { AccessGroup, InternalIdentity } from "./policy";
import { GroupEditor } from "./role-group-editors";

export type GroupsViewProps = {
  controller: AccessController;
  onOpenRulesForGroup?: (groupId: string) => void;
};
const PAGE_SIZE = 5;

function departmentName(id: string): string {
  return id
    .replace(/^department:/, "")
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function OrganizationChart({ controller }: GroupsViewProps) {
  const internal = controller.state.identities.filter(
    (identity): identity is InternalIdentity => identity.kind === "internal",
  );
  const departmentIds = [
    ...new Set(internal.flatMap((identity) => identity.departmentIds)),
  ].sort((left, right) =>
    departmentName(left).localeCompare(departmentName(right)),
  );

  return (
    <div className="flex flex-col gap-4">
      <Card className="w-full">
        <CardHeader className="items-center text-center">
          <div className="bg-muted flex size-11 items-center justify-center rounded-lg">
            <Building2 aria-hidden />
          </div>
          <CardTitle>Organization</CardTitle>
          <CardDescription>
            {internal.length} internal identities across {departmentIds.length}{" "}
            departments
          </CardDescription>
        </CardHeader>
      </Card>
      <section
        aria-label="Department organization chart"
        className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
      >
        {departmentIds.map((departmentId) => {
          const members = internal.filter((identity) =>
            identity.departmentIds.includes(departmentId),
          );
          return (
            <Card key={departmentId} className="w-full">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>{departmentName(departmentId)}</CardTitle>
                  <Badge variant="secondary">{members.length}</Badge>
                </div>
                <CardDescription>Department membership</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2">
                  {members.map((identity) => (
                    <li
                      key={identity.id}
                      className="bg-muted/50 flex min-h-11 items-center justify-between gap-3 rounded-md px-3 py-2 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {identity.name}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {identity.title || "No title"}
                        </span>
                      </span>
                      {identity.primaryDepartmentId === departmentId && (
                        <Badge variant="outline">Primary</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </section>
    </div>
  );
}

export function GroupsView({
  controller,
  onOpenRulesForGroup,
}: GroupsViewProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<AccessGroup | null>(null);
  const filtered = controller.state.groups
    .filter((group) =>
      `${group.name} ${group.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const identityName = (id: string) =>
    controller.state.identities.find((identity) => identity.id === id)?.name ??
    "Unknown identity";
  const ruleCount = (groupId: string) =>
    controller.state.rules.filter(
      (rule) => rule.subject.kind === "group" && rule.subject.id === groupId,
    ).length;

  return (
    <section
      aria-labelledby="groups-heading"
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="groups-heading"
            className="text-xl font-semibold tracking-tight"
          >
            Groups & departments
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage non-nested manual groups or review the internal organization
            chart.
          </p>
        </div>
        <Button
          className="min-h-11"
          onClick={() =>
            setDraft({
              id: `draft:group:${crypto.randomUUID()}`,
              name: "",
              description: "",
              memberIds: [],
            })
          }
        >
          <Plus data-icon="inline-start" /> Create group
        </Button>
      </div>

      <Tabs defaultValue="groups">
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger className="min-h-11 flex-1 sm:flex-none" value="groups">
            <Users data-icon="inline-start" /> Manual groups
          </TabsTrigger>
          <TabsTrigger
            className="min-h-11 flex-1 sm:flex-none"
            value="organization"
          >
            <Network data-icon="inline-start" /> Organization chart
          </TabsTrigger>
        </TabsList>

        <TabsContent value="groups" className="flex flex-col gap-4">
          <Field className="w-full sm:max-w-sm">
            <FieldLabel htmlFor="group-search">Search groups</FieldLabel>
            <div className="relative">
              <Search
                aria-hidden
                className="text-muted-foreground pointer-events-none absolute top-3 left-3 size-4"
              />
              <Input
                id="group-search"
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

          {visible.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Users />
                </EmptyMedia>
                <EmptyTitle>No groups found</EmptyTitle>
                <EmptyDescription>
                  Create a manual group or adjust the search.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  className="min-h-11"
                  onClick={() =>
                    setDraft({
                      id: `draft:group:${crypto.randomUUID()}`,
                      name: "",
                      description: "",
                      memberIds: [],
                    })
                  }
                >
                  Create group
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-lg border md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Group</TableHead>
                      <TableHead>Members</TableHead>
                      <TableHead>Scoped rules</TableHead>
                      <TableHead className="w-56">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((group) => (
                      <TableRow key={group.id}>
                        <TableCell>
                          <button
                            className="focus-visible:outline-ring min-h-11 max-w-md rounded-sm text-left outline-none focus-visible:outline-2"
                            onClick={() =>
                              setDraft({
                                ...group,
                                memberIds: [...group.memberIds],
                              })
                            }
                          >
                            <span className="block font-medium">
                              {group.name}
                            </span>
                            <span className="text-muted-foreground block max-w-md truncate text-xs">
                              {group.description || "No description"}
                            </span>
                          </button>
                        </TableCell>
                        <TableCell>
                          <span className="block">
                            {group.memberIds.length}
                          </span>
                          <span className="text-muted-foreground block max-w-48 truncate text-xs">
                            {group.memberIds
                              .slice(0, 2)
                              .map(identityName)
                              .join(", ") || "No members"}
                          </span>
                        </TableCell>
                        <TableCell>{ruleCount(group.id)}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <RulesShortcut
                              groupId={group.id}
                              onOpen={onOpenRulesForGroup}
                            />
                            <Button
                              variant="outline"
                              className="min-h-11"
                              onClick={() =>
                                setDraft({
                                  ...group,
                                  memberIds: [...group.memberIds],
                                })
                              }
                            >
                              Edit
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="grid gap-3 md:hidden">
                {visible.map((group) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    ruleCount={ruleCount(group.id)}
                    memberNames={group.memberIds.map(identityName)}
                    onOpenRules={onOpenRulesForGroup}
                    onEdit={() =>
                      setDraft({ ...group, memberIds: [...group.memberIds] })
                    }
                  />
                ))}
              </div>
            </>
          )}

          {pageCount > 1 && (
            <Pagination aria-label="Group pages">
              <PaginationContent>
                {Array.from({ length: pageCount }, (_, index) => index).map(
                  (number) => (
                    <PaginationItem key={number}>
                      <Button
                        variant={number === currentPage ? "outline" : "ghost"}
                        className="min-h-11 min-w-11"
                        aria-current={
                          number === currentPage ? "page" : undefined
                        }
                        aria-label={`Page ${number + 1}`}
                        onClick={() => setPage(number)}
                      >
                        {number + 1}
                      </Button>
                    </PaginationItem>
                  ),
                )}
              </PaginationContent>
            </Pagination>
          )}
        </TabsContent>

        <TabsContent value="organization">
          <OrganizationChart controller={controller} />
        </TabsContent>
      </Tabs>

      <GroupEditor
        key={draft?.id ?? "closed-group"}
        controller={controller}
        draft={draft}
        onClose={() => setDraft(null)}
      />
    </section>
  );
}

function GroupCard({
  group,
  ruleCount,
  memberNames,
  onOpenRules,
  onEdit,
}: {
  group: AccessGroup;
  ruleCount: number;
  memberNames: string[];
  onOpenRules?: (groupId: string) => void;
  onEdit: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{group.name}</CardTitle>
            <CardDescription className="mt-1">
              {group.description || "No description"}
            </CardDescription>
          </div>
          <Badge variant="secondary">{group.memberIds.length} members</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div>
          <p className="text-muted-foreground text-xs">Affected identities</p>
          <p className="mt-1">
            {memberNames.slice(0, 3).join(", ") || "No members yet"}
            {memberNames.length > 3 ? ` +${memberNames.length - 3}` : ""}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">Scoped rule summary</p>
          <p className="mt-1">
            {ruleCount} {ruleCount === 1 ? "rule targets" : "rules target"} this
            group
          </p>
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        <Button variant="outline" className="min-h-11" onClick={onEdit}>
          Edit group
        </Button>
        <RulesShortcut groupId={group.id} onOpen={onOpenRules} showIcon />
      </CardFooter>
    </Card>
  );
}

function RulesShortcut({
  groupId,
  onOpen,
  showIcon = false,
}: {
  groupId: string;
  onOpen?: (groupId: string) => void;
  showIcon?: boolean;
}) {
  if (onOpen) {
    return (
      <Button
        variant="ghost"
        className="min-h-11"
        onClick={() => onOpen(groupId)}
      >
        View rules
        {showIcon && <ChevronRight data-icon="inline-end" />}
      </Button>
    );
  }
  return (
    <Button asChild variant="ghost" className="min-h-11">
      <Link href="/access?view=rules">
        View rules
        {showIcon && <ChevronRight data-icon="inline-end" />}
      </Link>
    </Button>
  );
}
