"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Ellipsis, SquarePen } from "lucide-react";
import { PersonCardPopover } from "@/components/person-card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import type { BoardPost } from "../adapters/board-posts-api";
import type { PostMenuAction } from "../domain/post-list";
import { HydratedBoardAttachments } from "./server-backed-board-attachments";
import { HydratedBoardRecordLinks } from "./hydrated-board-record-links";

const MENU_LABELS: Record<PostMenuAction, string> = {
  "copy-link": "Copy link",
  history: "Edit history",
  unpublish: "Unpublish",
  archive: "Archive",
  restore: "Restore",
  delete: "Delete draft",
};

function fullDate(timestamp: string, region: WorkspaceRegion): string {
  return formatWorkspaceDateTime(timestamp, region, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function zonedDate(timestamp: string, region: WorkspaceRegion): string {
  return formatWorkspaceDateTime(timestamp, region, {
    dateStyle: "full",
    timeStyle: "long",
  });
}

export type PostPaneState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "unavailable"; retry: (() => void) | null }
  | { kind: "post"; post: BoardPost };

const backButton = "min-h-11 self-start px-2 lg:hidden";

/**
 * The reading pane (BR12, BR38): the title, one meta line, a quiet Edit and
 * a More post actions menu with only the viewer's actions, then the message
 * at the reading measure. Links, Files and Linked records show only when the
 * post has them. On a phone it is the post's own view, with Back.
 */
export function BoardPostPane({
  state,
  region,
  authorLabel,
  canEdit,
  actions,
  busy,
  onEdit,
  onAction,
  onBack,
}: {
  state: PostPaneState;
  region: WorkspaceRegion | undefined;
  authorLabel: string;
  canEdit: boolean;
  actions: readonly PostMenuAction[];
  /** An action on this post is under way. */
  busy: boolean;
  onEdit: () => void;
  onAction: (action: PostMenuAction) => void;
  onBack: () => void;
}) {
  const titleId = useId();
  const [now, setNow] = useState(() => Date.now());
  const post = state.kind === "post" ? state.post : null;
  useEffect(() => setNow(Date.now()), [post]);
  const back = (
    <Button
      type="button"
      variant="ghost"
      className={backButton}
      onClick={onBack}
    >
      <ArrowLeft aria-hidden="true" />
      Back to posts
    </Button>
  );

  if (state.kind === "none")
    return (
      <section
        aria-label="Post"
        className="bg-card text-muted-foreground hidden min-w-0 place-items-center rounded-lg border p-6 text-sm lg:grid lg:min-h-0 xl:flex-1"
      >
        Choose a post to read it.
      </section>
    );

  if (state.kind !== "post")
    return (
      <article
        aria-labelledby={titleId}
        aria-busy={state.kind === "loading"}
        className="bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-5 lg:min-h-0 xl:flex-1"
      >
        {back}
        {state.kind === "loading" ? (
          <>
            <h2 id={titleId} className="sr-only">
              Opening post
            </h2>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-24 w-full max-w-[42rem]" />
          </>
        ) : (
          <>
            <h2 id={titleId} className="text-lg font-semibold">
              This post is not available.
            </h2>
            <p className="text-muted-foreground text-sm">
              It may have been removed, or you may not have access.
            </p>
            {state.retry ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 self-start xl:min-h-8"
                onClick={state.retry}
              >
                Retry
              </Button>
            ) : null}
          </>
        )}
      </article>
    );

  const item = state.post;
  const meta: { key: string; node: ReactNode }[] = [
    {
      key: "author",
      node: (
        <PersonCardPopover
          personId={item.authorId}
          label={authorLabel}
          unavailableLabel="Author unavailable"
          decoration="none"
          className="text-foreground font-medium"
        />
      ),
    },
  ];
  const when =
    item.status === "published" && item.publishedAt
      ? item.publishedAt
      : item.status === "scheduled" && item.publishAt
        ? item.publishAt
        : item.updatedAt;
  meta.push({
    key: "date",
    node: region ? (
      <time dateTime={when} title={zonedDate(when, region)}>
        {item.status === "scheduled" ? "Publishes " : ""}
        {fullDate(when, region)}
      </time>
    ) : (
      "Date unavailable"
    ),
  });
  if (item.status === "draft") meta.push({ key: "draft", node: "Draft" });
  if (item.status === "archived")
    meta.push({ key: "archived", node: "Archived" });
  if (item.pinned) meta.push({ key: "pinned", node: "Pinned" });
  if (item.edited)
    meta.push({
      key: "edited",
      node: actions.includes("history") ? (
        <button
          type="button"
          className="focus-visible:outline-ring -my-3 inline-flex min-h-11 items-center rounded-sm hover:underline focus-visible:outline-2 xl:min-h-6"
          onClick={() => onAction("history")}
        >
          Edited
        </button>
      ) : (
        "Edited"
      ),
    });
  if (item.expiresAt && region)
    meta.push({
      key: "expires",
      node: (
        <time dateTime={item.expiresAt}>
          {Date.parse(item.expiresAt) <= now ? "Expired " : "Expires "}
          {fullDate(item.expiresAt, region)}
        </time>
      ),
    });
  const menu = actions;
  const published = item.status === "published" && item.postRevision === null;

  return (
    <article
      aria-labelledby={titleId}
      className="bg-card flex min-w-0 flex-col overflow-hidden rounded-lg border lg:min-h-0 xl:flex-1"
    >
      <header className="flex shrink-0 flex-col gap-2 border-b px-5 pt-3 pb-4">
        {back}
        <div className="flex min-w-0 items-start gap-2">
          <h2
            id={titleId}
            className="min-w-0 flex-1 pt-1 text-lg leading-snug font-semibold break-words"
          >
            {item.title}
          </h2>
          {canEdit ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0 xl:min-h-8"
              disabled={busy}
              onClick={onEdit}
            >
              <SquarePen aria-hidden="true" />
              Edit
            </Button>
          ) : null}
          {menu.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11 shrink-0 xl:size-8"
                    aria-label="More post actions"
                    disabled={busy}
                  />
                }
              >
                <Ellipsis aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="slim-ui min-w-44">
                {menu.map((action) => (
                  <DropdownMenuItem
                    key={action}
                    className={cn(
                      "min-h-11 xl:min-h-8",
                      action === "delete" && "text-danger-text",
                    )}
                    onClick={() => onAction(action)}
                  >
                    {MENU_LABELS[action]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <p className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {meta.map((part, index) => (
            <span key={part.key} className="contents">
              {index > 0 ? <span aria-hidden="true">·</span> : null}
              <span>{part.node}</span>
            </span>
          ))}
        </p>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-5 py-5">
        <p className="max-w-[42rem] text-sm leading-6 break-words whitespace-pre-wrap">
          {item.body}
        </p>
        {item.links.length > 0 ? (
          <section
            aria-label="Links"
            className="flex max-w-[42rem] flex-col gap-1"
          >
            <h3 data-slot="section-title" className="text-sm font-medium">
              Links
            </h3>
            <ul className="flex min-w-0 flex-col">
              {item.links.map((link, index) => (
                <li key={`${link.url}:${link.label}:${index}`}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                    className="text-action-text focus-visible:outline-ring inline-flex min-h-11 max-w-full items-center gap-1 rounded-sm text-sm break-words underline underline-offset-4 focus-visible:outline-2 xl:min-h-8"
                  >
                    {link.label}
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {published ? (
          <div className="flex max-w-[42rem] flex-col gap-6">
            <HydratedBoardAttachments
              key={`files:${item.id}:${item.publicationNumber}`}
              access="read"
              hideWhenEmpty
              target={{
                kind: "post",
                boardId: item.boardId,
                contentId: item.id,
                view: "published",
              }}
            />
            <HydratedBoardRecordLinks
              key={`records:${item.id}:${item.publicationNumber}`}
              access="read"
              hideWhenEmpty
              target={{
                kind: "post",
                boardId: item.boardId,
                contentId: item.id,
                view: "published",
              }}
            />
          </div>
        ) : null}
      </div>
    </article>
  );
}
