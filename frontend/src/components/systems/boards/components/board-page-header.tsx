"use client";

import type { Route } from "next";
import type { ReactNode } from "react";
import {
  CalendarDays,
  ChevronDown,
  Newspaper,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { DepartmentMark } from "@/components/sandbox/department-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  linkTabsIndicatorClass,
  linkTabsListClass,
  linkTabsTriggerClass,
} from "@/components/ui/link-tabs";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { cn } from "@/lib/utils";
import type {
  BoardAccessLevel,
  BoardManagementBoard,
} from "../adapters/board-management-api";
import {
  canonicalBoardUrl,
  type BoardSection,
} from "../hooks/use-server-boards";

/**
 * A board's views, in order, each with its icon (BR50). Kanban and Gantt join
 * this list in P4; the row has room for them at 1280.
 */
const BOARD_TABS: readonly {
  id: BoardSection;
  label: string;
  icon: LucideIcon;
}[] = [
  { id: "posts", label: "Posts", icon: Newspaper },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
];

const LEVEL_LABELS: Record<BoardAccessLevel, string> = {
  read: "Read",
  write: "Post",
  manage: "Manager",
};

/** "Sales announcements", "Company announcements" (BR47). */
export function boardPageTitle(board: {
  scope: BoardManagementBoard["scope"];
  name: string;
}): string {
  return board.scope === "company"
    ? "Company announcements"
    : `${board.name} announcements`;
}

/** Who reads and who posts, for the meta line (BR45). */
export function boardAudience(board: {
  scope: BoardManagementBoard["scope"];
  name: string;
}): string {
  if (board.scope === "company") return "Everyone reads · admins post";
  if (board.scope === "department") return `${board.name} roles read and post`;
  return "Project groups read and post";
}

/** The viewer's level on a board: only Manager is tinted (BR6). */
export function BoardLevelChip({ level }: { level: BoardAccessLevel }) {
  return (
    <Badge
      variant={level === "manage" ? "default" : "outline"}
      className={cn(
        "h-[22px] shrink-0",
        level === "manage" && "bg-action-tint text-action-text",
      )}
    >
      {LEVEL_LABELS[level]}
    </Badge>
  );
}

const quietControl = "min-h-11 xl:min-h-8";

/**
 * The one header of a board page (BR6, BR7, BR50): the department's mark,
 * the title, the level and Archived chips, one meta line that also carries a
 * refresh, the tab's one primary, a quiet Board settings, then the tabs.
 */
export function BoardPageHeader({
  board,
  departmentIndex,
  section,
  status,
  primary,
  settings,
}: {
  board: BoardManagementBoard;
  /** The department's place in the Sandbox order, for its mark. */
  departmentIndex: number | null;
  section: BoardSection;
  status: ReactNode;
  primary: ReactNode;
  /** Board settings for managers; until P5 it opens the existing sheets. */
  settings: {
    onDetails: () => void;
    onAccess: () => void;
    onActivity: () => void;
  } | null;
}) {
  const title = boardPageTitle(board);
  return (
    <div className="slim-ui shrink-0">
      <PageHeader
        className="mb-3"
        title={title}
        leading={
          board.scope === "department" && departmentIndex !== null ? (
            <DepartmentMark
              departmentIndex={departmentIndex}
              className="size-2.5"
            />
          ) : undefined
        }
        badges={
          <>
            <BoardLevelChip level={board.level} />
            {board.status === "archived" ? (
              <Badge variant="outline" className="h-[22px] shrink-0">
                Archived
              </Badge>
            ) : null}
          </>
        }
        description={
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate">
              {boardAudience(board)}
              {board.description ? ` · ${board.description}` : ""}
            </span>
            {status}
          </span>
        }
        actions={
          <>
            {settings ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(
                        quietControl,
                        "max-sm:min-w-11 max-sm:px-0",
                      )}
                      aria-label="Board settings"
                    />
                  }
                >
                  <Settings aria-hidden="true" />
                  <span className="max-sm:hidden">Board settings</span>
                  <ChevronDown
                    aria-hidden="true"
                    className="text-muted-foreground max-sm:hidden"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="slim-ui min-w-48">
                  <DropdownMenuItem
                    className={quietControl}
                    onClick={settings.onDetails}
                  >
                    Details
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={quietControl}
                    onClick={settings.onAccess}
                  >
                    Check access
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={quietControl}
                    onClick={settings.onActivity}
                  >
                    Activity
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {primary}
          </>
        }
      />
      <nav
        aria-label={`${title} views`}
        data-slot="tabs-list"
        className={cn(linkTabsListClass, "mb-3")}
      >
        {BOARD_TABS.map((tab) => {
          const current = tab.id === section;
          const Icon = tab.icon;
          return (
            <GuardedWorkspaceLink
              key={tab.id}
              href={canonicalBoardUrl(board, tab.id) as Route}
              scroll={false}
              aria-current={current ? "page" : undefined}
              data-slot="tabs-trigger"
              data-active={current ? "" : undefined}
              className={linkTabsTriggerClass}
            >
              {current ? (
                <span
                  aria-hidden="true"
                  data-slot="tabs-indicator"
                  className={linkTabsIndicatorClass}
                />
              ) : null}
              <Icon aria-hidden="true" className="size-4 max-sm:hidden" />
              {tab.label}
            </GuardedWorkspaceLink>
          );
        })}
      </nav>
    </div>
  );
}
