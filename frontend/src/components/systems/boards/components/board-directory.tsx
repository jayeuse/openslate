"use client";

import { useEffect, useState } from "react";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";
import { Building2, FolderKanban, Plus, Search } from "lucide-react";
import { departmentNavigationOptions } from "@/components/department-navigation";
import { isRefusal } from "@/components/department-navigation-model";
import { PageHeader } from "@/components/page-header";
import { DepartmentMark } from "@/components/sandbox/department-mark";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
import type {
  BoardManagementBoard,
  BoardScope,
} from "../adapters/board-management-api";
import {
  boardDirectoryOptions,
  boardsNavigationOptions,
} from "../adapters/boards-queries";
import {
  announcementsHref,
  companyBoardHref,
  projectBoardHref,
} from "@/components/boards-navigation-model";
import { tintRowClassName } from "@/components/systems/access/components/row-open-button";
import { cn } from "@/lib/utils";
import { BoardLevelChip } from "./board-page-header";
import { BoardEmpty } from "./ui";

const KIND_WORDS: Record<BoardScope, string> = {
  company: "Company",
  department: "Department",
  project: "Project",
};

const SEARCH_DELAY_MS = 250;

/** The empty list's words for each reason it is empty (BR15). */
export function boardDirectoryEmptyCopy(
  status: "active" | "archived",
  search: string,
): { title: string; description: string } {
  if (search)
    return {
      title: "No boards match",
      description: "Change the search to see more boards.",
    };
  return status === "archived"
    ? {
        title: "No archived boards",
        description: "Admins archive a board when its work ends.",
      }
    : {
        title: "No boards yet",
        description: "Ask an administrator for access to a board.",
      };
}

/**
 * All boards (BR3): every board the person reads, Active or Archived, with
 * a search. Rows are one line: the department's mark or the kind's glyph,
 * the name, the kind, and the person's level.
 */
export function BoardDirectory({
  isAdmin,
  onCreate,
}: {
  isAdmin: boolean;
  onCreate: () => void;
}) {
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(
      () => setSearch(draft.trim().slice(0, 100)),
      SEARCH_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [draft]);
  // Active boards without a search are the list the sidebar already holds.
  const firstPage = status === "active" && !search;
  const navigation = useQuery({
    ...boardsNavigationOptions(),
    enabled: firstPage,
  });
  const filtered = useQuery({
    ...boardDirectoryOptions(status, search),
    enabled: !firstPage,
  });
  const read = firstPage ? navigation : filtered;
  // A change to any board reads a searched or archived page again, in place;
  // the Boards page already reads the first page again (BR7).
  const { refetch: refetchFiltered } = filtered;
  useEffect(() => {
    if (firstPage) return;
    return subscribeWorkspaceInvalidations((event) => {
      if (event.type === "resync" || event.entity === "boards")
        void refetchFiltered();
    });
  }, [firstPage, refetchFiltered]);
  const departments = useQuery({
    ...departmentNavigationOptions(),
    enabled: false,
  });
  const departmentIndex = new Map(
    (isRefusal(departments.error) ? [] : (departments.data?.items ?? [])).map(
      (entry, index) => [entry.id, index],
    ),
  );
  const boards: readonly BoardManagementBoard[] = read.data?.items ?? [];
  const empty = boardDirectoryEmptyCopy(status, search);

  return (
    <div className="slim-ui flex min-w-0 flex-col gap-3 xl:min-h-0 xl:flex-1">
      <PageHeader
        className="mb-3 shrink-0"
        title="All boards"
        description="Every board you can read."
        actions={
          isAdmin ? (
            <Button className="min-h-11 xl:min-h-8" onClick={onCreate}>
              <Plus aria-hidden="true" />
              New project board
            </Button>
          ) : null
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <InputGroup className="min-h-11 w-full sm:w-64 xl:min-h-8">
          <InputGroupAddon aria-hidden="true">
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search boards"
            placeholder="Search boards"
            maxLength={100}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </InputGroup>
        <ToggleGroup
          aria-label="Show"
          variant="segmented"
          multiple={false}
          value={[status]}
          className="w-full sm:w-fit"
          onValueChange={(selection) => {
            const next = selection[0];
            if (next === "active" || next === "archived") setStatus(next);
          }}
        >
          <ToggleGroupItem value="active" className="flex-none px-3 text-sm">
            Active
          </ToggleGroupItem>
          <ToggleGroupItem value="archived" className="flex-none px-3 text-sm">
            Archived
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <LoadingRegion
        loading={read.isPending}
        label="Loading boards…"
        className="flex min-w-0 flex-col *:flex *:min-w-0 *:flex-col *:gap-3 xl:min-h-0 xl:flex-1 xl:*:min-h-0 xl:*:flex-1"
        skeleton={
          <div className="flex flex-col gap-px rounded-md border">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-10" />
            ))}
          </div>
        }
      >
        {read.isError && !read.data ? (
          <Alert
            variant="destructive"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <span>Boards could not be loaded.</span>
            <Button
              variant="outline"
              className="min-h-11 xl:min-h-8"
              onClick={() => void read.refetch()}
            >
              Retry
            </Button>
          </Alert>
        ) : boards.length === 0 ? (
          <BoardEmpty
            title={empty.title}
            description={empty.description}
            icon={<FolderKanban aria-hidden="true" />}
          >
            {search ? (
              <Button
                variant="outline"
                className="min-h-11 xl:min-h-8"
                onClick={() => setDraft("")}
              >
                Clear search
              </Button>
            ) : null}
          </BoardEmpty>
        ) : (
          <div className="bg-card relative min-w-0 overflow-y-auto overscroll-contain rounded-md border xl:min-h-0 xl:flex-initial">
            <ul aria-label="All boards" className="divide-y">
              {boards.map((board) => {
                const index = board.departmentId
                  ? departmentIndex.get(board.departmentId)
                  : undefined;
                return (
                  <li key={board.id}>
                    <GuardedWorkspaceLink
                      href={
                        (board.scope === "company"
                          ? companyBoardHref
                          : board.scope === "department" && board.departmentId
                            ? announcementsHref(board.departmentId)
                            : projectBoardHref(board.id)) as Route
                      }
                      className={cn(
                        tintRowClassName,
                        "focus-visible:outline-ring flex min-h-11 items-center gap-3 px-3 text-sm outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 xl:min-h-10",
                      )}
                    >
                      <span className="text-muted-foreground grid size-4 shrink-0 place-items-center">
                        {board.scope === "department" ? (
                          index === undefined ? null : (
                            <DepartmentMark departmentIndex={index} />
                          )
                        ) : board.scope === "company" ? (
                          <Building2 aria-hidden="true" className="size-4" />
                        ) : (
                          <FolderKanban aria-hidden="true" className="size-4" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {board.scope === "company" ? "Company" : board.name}
                      </span>
                      <span className="text-muted-foreground shrink-0">
                        {KIND_WORDS[board.scope]}
                      </span>
                      <BoardLevelChip level={board.level} />
                    </GuardedWorkspaceLink>
                  </li>
                );
              })}
            </ul>
            {read.data?.pagination.hasMore ? (
              <p className="text-muted-foreground border-t px-3 py-2 text-sm">
                Showing the first {boards.length} boards.
              </p>
            ) : null}
          </div>
        )}
      </LoadingRegion>
    </div>
  );
}
