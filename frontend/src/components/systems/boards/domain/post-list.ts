import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";
import type { BoardAccessLevel } from "../adapters/board-management-api";
import type { BoardPost, BoardPostView } from "../adapters/board-posts-api";

/**
 * The Posts list's state filter (BR10). Readers see published posts only;
 * writers add Scheduled and Drafts; managers add Archived. The address keeps
 * the state as `show=` (absent for Published), so a reload and a phone's
 * Back reopen the same list.
 */
export type PostListState = "published" | "scheduled" | "drafts" | "archived";

export const POST_STATE_LABELS: Record<PostListState, string> = {
  published: "Published",
  scheduled: "Scheduled",
  drafts: "Drafts",
  archived: "Archived",
};

export function postStatesFor(level: BoardAccessLevel): PostListState[] {
  if (level === "read") return ["published"];
  if (level === "write") return ["published", "scheduled", "drafts"];
  return ["published", "scheduled", "drafts", "archived"];
}

/** The state an address asks for, when the viewer may see it; else Published. */
export function parsePostShow(
  value: string | null,
  level: BoardAccessLevel,
): PostListState {
  const states = postStatesFor(level);
  return states.find((state) => state !== "published" && state === value)
    ? (value as PostListState)
    : "published";
}

/** The server view that holds a state's posts. */
export function postViewForState(state: PostListState): BoardPostView {
  if (state === "published") return "published";
  if (state === "archived") return "archive";
  return "draft";
}

/** Scheduled and Drafts share one server view; each keeps its own status. */
export function postMatchesState(
  post: BoardPost,
  state: PostListState,
): boolean {
  if (state === "scheduled") return post.status === "scheduled";
  if (state === "drafts") return post.status === "draft";
  return true;
}

function shortDate(timestamp: string, region: WorkspaceRegion): string {
  return formatWorkspaceDateTime(timestamp, region, {
    month: "short",
    day: "numeric",
  });
}

function shortDateTime(timestamp: string, region: WorkspaceRegion): string {
  return formatWorkspaceDateTime(timestamp, region, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The second line of a list row (BR11): Pinned, the author, the date, then
 * the state words that apply (Edited, Expires or Expired, Publishes).
 */
export function postRowMeta(
  post: BoardPost,
  author: string,
  region: WorkspaceRegion | undefined,
  now: number,
): string[] {
  const parts: string[] = [];
  if (post.pinned) parts.push("Pinned");
  parts.push(author);
  if (!region) parts.push("Date unavailable");
  else if (post.status === "scheduled" && post.publishAt)
    parts.push(`Publishes ${shortDateTime(post.publishAt, region)}`);
  else
    parts.push(
      shortDate(
        post.status === "published" && post.publishedAt
          ? post.publishedAt
          : post.updatedAt,
        region,
      ),
    );
  if (post.status === "draft") parts.push("Draft");
  if (post.edited) parts.push("Edited");
  if (post.expiresAt && region)
    parts.push(
      Date.parse(post.expiresAt) <= now
        ? "Expired"
        : `Expires ${shortDate(post.expiresAt, region)}`,
    );
  return parts;
}

/** Why a reader of this board cannot post (role states table). */
export function postingReason(
  board: {
    scope: "company" | "department" | "project";
    name: string;
    status: "active" | "archived";
  },
  guest: boolean,
): string {
  if (board.status === "archived") return "Archived boards are read-only.";
  if (guest) return "Guests can read only.";
  if (board.scope === "company")
    return "Only admins post on the Company board.";
  if (board.scope === "department")
    return `Posting needs write access to ${board.name}.`;
  return "Posting needs write access through one of this board's groups.";
}

/** The one line beside Publish: who sees the post (BR13). */
export function postAudienceLine(board: {
  scope: "company" | "department" | "project";
  name: string;
}): string {
  return board.scope === "company"
    ? "Everyone in the organization sees this post."
    : `Everyone who reads ${board.name} sees this post.`;
}

/**
 * The empty list teaches in the list's own frame (BR15): it names the
 * state's reason, and a viewer who cannot post gets the board's reason.
 */
export function postListEmpty(
  state: PostListState,
  filtered: boolean,
  readerReason: string | null,
): { title: string; description: string } {
  if (filtered)
    return {
      title: "No posts match",
      description: "Change the search or filters to see more posts.",
    };
  if (state === "scheduled")
    return {
      title: "Nothing scheduled",
      description: "Posts you schedule wait here until they publish.",
    };
  if (state === "drafts")
    return {
      title: "No drafts",
      description: "Posts you save without publishing wait here.",
    };
  if (state === "archived")
    return {
      title: "No archived posts",
      description:
        "Archived posts leave the board until a manager restores them.",
    };
  return {
    title: "No published posts yet",
    description:
      readerReason ?? "Posts you publish show here for every reader.",
  };
}

export type PostViewer = {
  actorId: string;
  canWrite: boolean;
  canManage: boolean;
  boardActive: boolean;
};

export type PostMenuAction =
  "copy-link" | "history" | "unpublish" | "archive" | "restore" | "delete";

/** The author or a manager changes a post; the server decides at last. */
function mayChange(post: BoardPost, viewer: PostViewer): boolean {
  return (
    viewer.boardActive &&
    viewer.canWrite &&
    (viewer.canManage || post.authorId === viewer.actorId)
  );
}

/** Edit shows for the author or a manager, on a post that is not archived. */
export function canEditPost(post: BoardPost, viewer: PostViewer): boolean {
  return post.status !== "archived" && mayChange(post, viewer);
}

/**
 * Whether opening the post's menu reads its manage state: only Delete draft
 * needs it, on a post the viewer may change that is not published. Readers
 * and other writers send no read, which the server would refuse (403).
 */
export function readsPostManageState(
  post: BoardPost,
  viewer: PostViewer,
): boolean {
  return mayChange(post, viewer) && post.status !== "published";
}

/**
 * The More post actions a viewer may take on the open post (BR12, BR14):
 * only those, in menu order. `publishedBefore` comes from the post's manage
 * state, read when the menu opens: Delete draft shows only once that read
 * says the post was never published (null while it is unknown).
 */
export function postMenuActions(
  post: BoardPost,
  viewer: PostViewer,
  publishedBefore: boolean | null,
): PostMenuAction[] {
  const actions: PostMenuAction[] = [];
  const published = post.status === "published" && post.postRevision === null;
  if (published) actions.push("copy-link");
  if (published && post.edited) actions.push("history");
  if (!mayChange(post, viewer)) return actions;
  if (published) actions.push("unpublish");
  if (post.status === "archived") {
    if (viewer.canManage) actions.push("restore");
  } else actions.push("archive");
  if (post.status !== "published" && publishedBefore === false)
    actions.push("delete");
  return actions;
}
