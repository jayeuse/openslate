"use client";

import { AccessSearchToolbar } from "./access-search-toolbar";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Network, Plus, Users } from "lucide-react";
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
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Select, SelectItem } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  completeCollection,
  pageCollection,
} from "../../shared/helpers/sample-collections";
import type { AccessController } from "../state/controller";
import type { EditorIntent } from "../helpers/editor-helpers";
import type { AccessGroup } from "../domain/policy";
import { GroupEditor } from "./role-group-editors";
import {
  readAccessGroupDraft,
  type AccessGroupDraft,
} from "../state/draft-journal";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import { OrganizationChart } from "./organization-chart";

export type GroupsViewProps = {
  controller: AccessController;
  onOpenRulesForGroup?: (groupId: string) => void;
};
const PAGE_SIZE = 5;

export function GroupsView({
  controller,
  onOpenRulesForGroup,
}: GroupsViewProps) {
  const userId = useVerifiedWorkspaceUserId();
  const [query, setQuery] = useState("");
  const [membershipFilter, setMembershipFilter] = useState<
    "all" | "with-members" | "empty"
  >("all");
  const [sortOrder, setSortOrder] = useState<"name" | "members">("name");
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<AccessGroup | null>(null);
  const [draftIntent, setDraftIntent] = useState<EditorIntent>("edit");
  const [restoredValues, setRestoredValues] = useState<
    AccessGroupDraft["values"] | null
  >(null);
  const [restoredUncertain, setRestoredUncertain] = useState(false);
  const [journalIssue, setJournalIssue] = useState("");
  const restoredUserId = useRef<string | null>(null);
  const groupEditorFocusTarget = useRef<string | null>(null);

  useEffect(() => {
    if (draft !== null || !groupEditorFocusTarget.current) return;
    const targetId = groupEditorFocusTarget.current;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      const fallback = document.getElementById("create-group-button");
      (target ?? fallback)?.focus();
      groupEditorFocusTarget.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draft]);

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
  const withMembersCount = controller.state.groups.filter(
    (group) => group.memberIds.length > 0,
  ).length;
  const emptyGroupCount = controller.state.groups.length - withMembersCount;
  const filtered = controller.state.groups
    .filter((group) =>
      `${group.name} ${group.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .filter((group) => {
      if (membershipFilter === "with-members")
        return group.memberIds.length > 0;
      if (membershipFilter === "empty") return group.memberIds.length === 0;
      return true;
    })
    .sort((left, right) =>
      sortOrder === "members"
        ? right.memberIds.length - left.memberIds.length ||
          left.name.localeCompare(right.name)
        : left.name.localeCompare(right.name),
    );
  const pageResult = pageCollection(
    completeCollection(
      filtered,
      JSON.stringify([
        "groups",
        query.trim().toLowerCase(),
        membershipFilter,
        sortOrder,
      ]),
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

  function editGroup(
    group: AccessGroup,
    focusTargetId = `group-edit-table-${group.id}`,
  ) {
    if (restoredUncertain) return;
    groupEditorFocusTarget.current = focusTargetId;
    setRestoredValues(null);
    setDraftIntent("edit");
    setDraft({ ...group, memberIds: [...group.memberIds] });
  }

  function createGroup() {
    if (restoredUncertain) return;
    groupEditorFocusTarget.current = "create-group-button";
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
              id={`group-name-table-${group.id}`}
              className="focus-visible:outline-ring min-h-11 max-w-md rounded-sm text-left outline-none focus-visible:outline-2"
              onClick={() => editGroup(group, `group-name-table-${group.id}`)}
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
          const memberNames = group.memberIds.slice(0, 2).map(identityName);
          const remainingMembers = group.memberIds.length - memberNames.length;
          return (
            <>
              <span className="block tabular-nums">
                {group.memberIds.length}
              </span>
              {memberNames.length ? (
                <span className="text-muted-foreground block max-w-56 text-xs">
                  {memberNames.join(", ")}
                  {remainingMembers > 0 ? ` +${remainingMembers} more` : ""}
                </span>
              ) : (
                <span className="text-muted-foreground block text-xs">
                  No members yet
                </span>
              )}
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
        header: "Actions",
        cell: ({ row }) => {
          const group = row.original;
          return (
            <div className="flex justify-end gap-1">
              <RulesShortcut groupId={group.id} onOpen={onOpenRulesForGroup} />
              <Button
                id={`group-edit-table-${group.id}`}
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
          id="create-group-button"
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
          <div className="bg-muted/40 flex items-start gap-3 rounded-md border p-3">
            <Users
              aria-hidden="true"
              className="text-muted-foreground mt-0.5 size-4 shrink-0"
            />
            <p className="text-muted-foreground text-sm">
              Manual groups gather internal people and guests so scoped rules
              can target them. Department membership is shown separately in the
              Organization chart.
            </p>
          </div>

          <AccessSearchToolbar
            searchLabel="Search groups"
            placeholder="Name or description"
            query={query}
            onQueryChange={(value) => {
              setQuery(value);
              setPage(0);
            }}
            sortLabel="Sort groups"
            sort={sortOrder}
            sortOptions={[
              { value: "name", label: "Name (A–Z)" },
              { value: "members", label: "Most members" },
            ]}
            onSortChange={(value) => {
              setSortOrder(value);
              setPage(0);
            }}
            activeFilterCount={membershipFilter === "all" ? 0 : 1}
          >
            <Field className="min-w-0">
              <FieldLabel htmlFor="group-membership-filter">
                Membership
              </FieldLabel>
              <Select
                id="group-membership-filter"
                value={membershipFilter}
                onValueChange={(value) => {
                  if (
                    value === "all" ||
                    value === "with-members" ||
                    value === "empty"
                  ) {
                    setMembershipFilter(value);
                    setPage(0);
                  }
                }}
              >
                <SelectItem value="all">
                  All groups ({controller.state.groups.length})
                </SelectItem>
                <SelectItem value="with-members">
                  With members ({withMembersCount})
                </SelectItem>
                <SelectItem value="empty">Empty ({emptyGroupCount})</SelectItem>
              </Select>
            </Field>
          </AccessSearchToolbar>

          {visible.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Users />
                </EmptyMedia>
                <EmptyTitle>
                  {controller.state.groups.length
                    ? "No matching groups"
                    : "No manual groups yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {controller.state.groups.length
                    ? "Adjust the search or choose a different membership filter."
                    : "Create a manual group to target people with scoped rules."}
                </EmptyDescription>
              </EmptyHeader>
              {controller.state.groups.length > 0 &&
              (query || membershipFilter !== "all") ? (
                <EmptyContent>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => {
                      setQuery("");
                      setMembershipFilter("all");
                      setPage(0);
                    }}
                  >
                    Clear search and filters
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          ) : (
            <div className="bg-card overflow-hidden rounded-lg border">
              <div className="hidden md:block">
                <DataTable
                  ariaLabel="Groups directory"
                  columns={groupColumns}
                  data={visible}
                  getRowId={(group) => group.id}
                />
              </div>

              <div className="grid gap-3 p-3 md:hidden">
                {visible.map((group) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    ruleCount={ruleCount(group.id)}
                    memberNames={group.memberIds.map(identityName)}
                    onOpenRules={onOpenRulesForGroup}
                    onEdit={() =>
                      editGroup(group, `group-edit-card-${group.id}`)
                    }
                    editFocusId={`group-edit-card-${group.id}`}
                  />
                ))}
              </div>
              <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-muted-foreground text-sm" aria-live="polite">
                  Showing {pageResult.total === 0 ? 0 : pageResult.offset + 1}–
                  {Math.min(
                    pageResult.offset + pageResult.limit,
                    pageResult.total,
                  )}{" "}
                  of {pageResult.total} groups
                </p>
                <PaginationControls
                  ariaLabel="Group pages"
                  className="w-auto"
                  pageCount={pageCount}
                  pageIndex={currentPage}
                  onPageIndexChange={setPage}
                />
              </div>
            </div>
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
  editFocusId,
}: {
  group: AccessGroup;
  ruleCount: number;
  memberNames: string[];
  onOpenRules?: (groupId: string) => void;
  onEdit: () => void;
  editFocusId: string;
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
        <Button
          id={editFocusId}
          variant="outline"
          className="min-h-11"
          onClick={onEdit}
        >
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
