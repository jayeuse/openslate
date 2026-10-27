"use client";

import type { Route } from "next";
import type { ReactNode } from "react";
import {
  CalendarDays,
  ChartGantt,
  Kanban,
  Newspaper,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { DepartmentMark } from "@/components/sandbox/department-mark";
import { LevelBadge } from "@/components/systems/comms/components/member-level";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { postingReason } from "../domain/post-list";

/** A board's views, in order, each with its icon (BR50). */
const BOARD_TABS: readonly {
  id: BoardSection;
  label: string;
  icon: LucideIcon;
}[] = [
  { id: "posts", label: "Posts", icon: Newspaper },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "kanban", label: "Kanban", icon: Kanban },
  { id: "gantt", label: "Gantt", icon: ChartGantt },
];

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

/**
 * The viewer's level on a board: only Manager is tinted (BR6). A reader's
 * chip says why they cannot post (BR34), as its tooltip and description.
 */
export function BoardLevelChip({
  level,
  description,
}: {
  level: BoardAccessLevel;
  description?: string | null;
}) {
  return (
    <LevelBadge
      level={level === "write" ? "post" : level}
      description={description ?? undefined}
    />
  );
}

const quietControl = "min-h-11 xl:min-h-8";

/**
 * The one header of a board page (BR6, BR7, BR50): the department's mark,
 * the title, the level and Archived chips, one meta line that also carries a
 * refresh, the tab's one primary, a quiet Board settings (BR26), then the
 * tabs.
 */
export function BoardPageHeader({
  board,
  departmentIndex,
  section,
  status,
  primary,
  guest,
  onOpenSettings,
}: {
  board: BoardManagementBoard;
  /** The department's place in the Sandbox order, for its mark. */
  departmentIndex: number | null;
  section: BoardSection;
  status: ReactNode;
  primary: ReactNode;
  /** A guest reads only; their chip says so. */
  guest: boolean;
  /** Opens Board settings; managers only, so null hides the button. */
  onOpenSettings: (() => void) | null;
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
            <BoardLevelChip
              level={board.level}
              description={
                board.level === "read" ? postingReason(board, guest) : null
              }
            />
            {board.status === "archived" ? (
              <Badge variant="outline" className="shrink-0">
                Archived
              </Badge>
            ) : null}
          </>
        }
        description={
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {/* Phones keep two short rows over the tabs (BR31); the
                meta line waits for a wider screen. */}
            <span className="min-w-0 truncate max-sm:hidden">
              {boardAudience(board)}
              {board.description ? ` · ${board.description}` : ""}
            </span>
            {status}
          </span>
        }
        actions={
          <>
            {onOpenSettings ? (
              <Button
                type="button"
                variant="outline"
                className={cn(quietControl, "max-sm:min-w-11 max-sm:px-0")}
                aria-label="Board settings"
                onClick={onOpenSettings}
              >
                <Settings aria-hidden="true" />
                <span className="max-sm:hidden">Board settings</span>
              </Button>
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
