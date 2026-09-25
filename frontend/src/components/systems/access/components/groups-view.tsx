"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  ChevronRight,
  Network,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
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
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  completeCollection,
  pageCollection,
} from "../../shared/helpers/sample-collections";
import type { AccessController } from "../state/controller";
import type { EditorIntent } from "../helpers/editor-helpers";
import type { AccessGroup, InternalIdentity } from "../domain/policy";
import { GroupEditor } from "./role-group-editors";
import {
  readAccessGroupDraft,
  type AccessGroupDraft,
} from "../state/draft-journal";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";

export type GroupsViewProps = {
  controller: AccessController;
  onOpenRulesForGroup?: (groupId: string) => void;
};
const PAGE_SIZE = 5;

function OrganizationChart({ controller }: GroupsViewProps) {
  const internal = controller.state.identities.filter(
    (identity): identity is InternalIdentity => identity.kind === "internal",
  );
  const departmentIds = [
    ...new Set(internal.flatMap((identity) => identity.departmentIds)),
  ].sort((left, right) =>
    (
      controller.departmentCatalog.find((item) => item.id === left)?.name ??
      left
    ).localeCompare(
      controller.departmentCatalog.find((item) => item.id === right)?.name ??
        right,
    ),
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
                  <CardTitle>
                    {controller.departmentCatalog.find(
                      (item) => item.id === departmentId,
                    )?.name ?? "Unknown department"}
                  </CardTitle>
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
  const userId = useVerifiedWorkspaceUserId();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<AccessGroup | null>(null);
  const [draftIntent, setDraftIntent] = useState<EditorIntent>("edit");
  const [restoredValues, setRestoredValues] = useState<
    AccessGroupDraft["values"] | null
  >(null);
  const [restoredUncertain, setRestoredUncertain] = useState(false);
  const [journalIssue, setJournalIssue] = useState("");
  const restoredUserId = useRef<string | null>(null);

  useEffect(() => {
    if (restoredUserId.current === userId) return;
    restoredUserId.current = userId;
    const stored = readAccessGroupDraft(userId);
    if (stored.value) {
      setDraft(stored.value.baseline);
      setDraftIntent(stored.value.intent);
      setRestoredValues(stored.value.values);
    }
    setRestoredUncertain(stored.status === "uncertain");
    if (stored.status === "unavailable")
      setJournalIssue(
        "Browser draft storage is unavailable. Group changes may not survive reload.",
      );
    else if (stored.status === "invalid")
      setJournalIssue(
        "A saved group draft could not be safely restored. It was not applied.",
      );
  }, [userId]);
  const filtered = controller.state.groups
    .filter((group) =>
      `${group.name} ${group.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const pageResult = pageCollection(
    completeCollection(
      filtered,
      JSON.stringify(["groups", query.trim().toLowerCase()]),
    ),
    page * PAGE_SIZE,
    PAGE_SIZE,
  );
  const pageCount = Math.max(1, Math.ceil(pageResult.total / pageResult.limit));
  const currentPage = pageResult.offset / pageResult.limit;
  const visible = [...pageResult.items];
  const identityName = (id: string) =>
    controller.state.identities.find((identity) => identity.id === id)?.name ??
    "Unknown identity";

  function editGroup(group: AccessGroup) {
    if (restoredUncertain) return;
    setRestoredValues(null);
    setDraftIntent("edit");
    setDraft({ ...group, memberIds: [...group.memberIds] });
  }

  function createGroup() {
    if (restoredUncertain) return;
    setRestoredValues(null);
    setDraftIntent("create");
    setDraft({
      id: `draft:group:${crypto.randomUUID()}`,
      name: "",
      description: "",
      memberIds: [],
    });
  }
  const ruleCount = (groupId: string) =>
    controller.state.rules.filter(
      (rule) => rule.subject.kind === "group" && rule.subject.id === groupId,
    ).length;
  const groupColumns = useMemo<DataTableColumn<AccessGroup>[]>(
    () => [
      {
        id: "group",
        header: "Group",
        cell: ({ row }) => {
          const group = row.original;
          return (
            <button
              className="focus-visible:outline-ring min-h-11 max-w-md rounded-sm text-left outline-none focus-visible:outline-2"
              onClick={() => editGroup(group)}
            >
              <span className="block font-medium">{group.name}</span>
              <span className="text-muted-foreground block max-w-md truncate text-xs">
                {group.description || "No description"}
              </span>
            </button>
          );
        },
      },
      {
        id: "members",
        header: "Members",
        cell: ({ row }) => {
          const group = row.original;
          return (
            <>
              <span className="block">{group.memberIds.length}</span>
              <span className="text-muted-foreground block max-w-48 truncate text-xs">
                {group.memberIds.slice(0, 2).map(identityName).join(", ") ||
                  "No members"}
              </span>
            </>
          );
        },
      },
      {
        id: "rules",
        header: "Scoped rules",
        cell: ({ row }) => ruleCount(row.original.id),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const group = row.original;
          return (
            <div className="flex justify-end gap-1">
              <RulesShortcut groupId={group.id} onOpen={onOpenRulesForGroup} />
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => editGroup(group)}
              >
                Edit
              </Button>
            </div>
          );
        },
      },
    ],
    [identityName, onOpenRulesForGroup, ruleCount],
  );

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
          disabled={controller.isPending() || restoredUncertain}
          onClick={createGroup}
        >
          <Plus data-icon="inline-start" /> Create group
        </Button>
      </div>

      {journalIssue ? (
        <Alert role="alert" variant="warning">
          {journalIssue}
        </Alert>
      ) : null}

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
                  disabled={controller.isPending() || restoredUncertain}
                  onClick={createGroup}
                >
                  Create group
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-lg border md:block">
                <DataTable
                  ariaLabel="Groups directory"
                  columns={groupColumns}
                  data={visible}
                  getRowId={(group) => group.id}
                />
              </div>

              <div className="grid gap-3 md:hidden">
                {visible.map((group) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    ruleCount={ruleCount(group.id)}
                    memberNames={group.memberIds.map(identityName)}
                    onOpenRules={onOpenRulesForGroup}
                    onEdit={() => editGroup(group)}
                  />
                ))}
              </div>
            </>
          )}

          {pageCount > 1 && (
            <PaginationControls
              ariaLabel="Group pages"
              pageCount={pageCount}
              pageIndex={currentPage}
              onPageIndexChange={setPage}
            />
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
