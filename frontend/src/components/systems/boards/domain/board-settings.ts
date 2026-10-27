import type { StatusTone } from "@/components/ui/status-word";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";
import type {
  BoardAccessLevel,
  BoardManagementBoard,
} from "../adapters/board-management-api";
import type {
  BoardActivity,
  BoardAccessPreview,
} from "../adapters/board-tools-api";
import { postingReason } from "./post-list";

/** The three tabs of Board settings, in order (BR26). */
export const BOARD_SETTINGS_TABS = ["details", "access", "activity"] as const;
export type BoardSettingsTab = (typeof BOARD_SETTINGS_TABS)[number];

/**
 * The open tab of Board settings from the address (`settings=`), or null when
 * the sheet is closed. Anything but one known tab keeps it closed.
 */
export function boardSettingsTab(search: string): BoardSettingsTab | null {
  const values = new URLSearchParams(search).getAll("settings");
  if (values.length !== 1) return null;
  return BOARD_SETTINGS_TABS.find((tab) => tab === values[0]) ?? null;
}

const SCOPE_WORD: Record<BoardManagementBoard["scope"], string> = {
  company: "Company board",
  department: "Department board",
  project: "Project board",
};

/** The sheet's one meta line: the board's kind and status (BR26). */
export function boardSettingsMeta(
  board: Pick<BoardManagementBoard, "scope" | "status">,
): string {
  return `${SCOPE_WORD[board.scope]} · ${board.status === "archived" ? "Archived" : "Active"}`;
}

export type BoardLifecycleConfirmation = {
  title: string;
  description: string;
  action: string;
};

/**
 * Archive asks once, with its consequence and no typed name, because Restore
 * undoes it; Restore acts at once (BR27).
 */
export function boardLifecycleConfirmation(
  action: "archive" | "restore",
): BoardLifecycleConfirmation | null {
  return action === "archive"
    ? {
        title: "Archive board?",
        description: "Everyone can still read it; nobody can post.",
        action: "Archive board",
      }
    : null;
}

/** One row of the Access tab's read-only summary: who, and what they can do. */
export type BoardAccessSummaryRow = { who: string; can: string };

/**
 * Who reads, posts and manages a Company or department board, from the board
 * access rules (`access.py`). A project board lists its groups instead.
 */
export function boardAccessSummary(
  board: Pick<BoardManagementBoard, "scope" | "name">,
): BoardAccessSummaryRow[] {
  if (board.scope === "company")
    return [
      { who: "Everyone", can: "can read" },
      { who: "Admins", can: "can post and manage" },
    ];
  if (board.scope === "department")
    return [
      { who: `Read on ${board.name}`, can: "can read" },
      { who: `Write on some ${board.name} modules`, can: "can read" },
      { who: `Write on ${board.name}`, can: "can post" },
      { who: `Manage on ${board.name}`, can: "can manage" },
      { who: "Admins", can: "can manage" },
      { who: "Guests", can: "can read only" },
    ];
  return [
    { who: "Admins", can: "can manage" },
    { who: "Guests", can: "can read only" },
  ];
}

const LEVEL_WORD: Record<BoardAccessLevel, string> = {
  read: "Read",
  write: "Post",
  manage: "Manager",
};

export type CheckPersonResult = {
  /** The level word, as the level chip shows it; null when they cannot open it. */
  level: string | null;
  /** "can read · can post · cannot manage"; null when they cannot open it. */
  abilities: string | null;
  /** Why they stop where they do; null when nothing is missing. */
  reason: string | null;
};

/**
 * What Check a person shows for one person on this board (BR28). The read
 * reason is the level chip's own sentence (BR34); the preview cannot tell a
 * guest from a member, so a Read reason also names the guest cap.
 */
export function checkPersonResult(
  board: Pick<BoardManagementBoard, "scope" | "name" | "status">,
  preview: BoardAccessPreview,
): CheckPersonResult {
  const abilities = [
    preview.view ? "can read" : "cannot read",
    preview.edit ? "can post" : "cannot post",
    preview.manage ? "can manage" : "cannot manage",
  ].join(" · ");
  if (preview.level === null)
    return {
      level: null,
      abilities: null,
      reason:
        board.scope === "department"
          ? `No access to ${board.name}.`
          : board.scope === "project"
            ? "Not in any of this board's groups."
            : "Cannot open this board.",
    };
  return {
    level: LEVEL_WORD[preview.level],
    abilities,
    reason:
      preview.level === "read"
        ? `${postingReason({ ...board, status: "active" }, false)} Guests read only.`
        : null,
  };
}

export type BoardActivitySentence = { verb: string; tone: StatusTone };

/** The verb and dot of one Activity row (the Audit sentence row, BR29). */
export function boardActivitySentence(
  activity: Pick<BoardActivity, "kind" | "action">,
): BoardActivitySentence {
  if (activity.kind === "group")
    return { verb: "Changed groups", tone: "action" };
  if (activity.action === "create")
    return { verb: "Created board", tone: "flow" };
  if (activity.action === "delete")
    return { verb: "Deleted board", tone: "danger" };
  return { verb: "Changed details", tone: "action" };
}

/**
 * One Activity row's time (BR29): month, day and time in the workspace's
 * zone, with the year only when it is not the current one there, and no zone
 * name (as post rows, BF-11). `full` keeps the whole time for the tooltip.
 */
export function boardActivityTime(
  timestamp: string,
  region: WorkspaceRegion,
  now: Date,
): { text: string; full: string } {
  const year = (value: string) =>
    formatWorkspaceDateTime(value, region, { year: "numeric" });
  const thisYear = year(timestamp) === year(now.toISOString());
  return {
    text: formatWorkspaceDateTime(timestamp, region, {
      ...(thisYear ? {} : { year: "numeric" as const }),
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    full: formatWorkspaceDateTime(timestamp, region, {
      dateStyle: "full",
      timeStyle: "long",
    }),
  };
}
