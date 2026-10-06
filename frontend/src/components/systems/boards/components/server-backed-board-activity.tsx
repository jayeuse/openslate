"use client";

import { createElement, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";
import type {
  BoardActivity,
  BoardToolsPage,
} from "../adapters/board-tools-api";
import { useServerBoardActivity } from "../hooks/use-server-board-activity";
import { BoardEmpty } from "./ui";

const PAGE_SIZE = 25;

function activityTime(
  timestamp: string,
  region: WorkspaceRegion | undefined,
): string {
  if (!region) return "Date unavailable";
  return formatWorkspaceDateTime(timestamp, region, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function ServerBoardActivityDisplay({
  region,
  page,
}: {
  page: BoardToolsPage<BoardActivity>;
  region?: WorkspaceRegion;
}) {
  const { offset, count, total } = page.pagination;
  return createElement(
    "section",
    { "aria-label": "Board activity", className: "min-w-0" },
    createElement(
      "div",
      { className: "mb-4 flex flex-wrap items-baseline justify-between gap-2" },
      createElement("h2", { className: "text-lg font-semibold" }, "Activity"),
      createElement(
        "p",
        { className: "text-muted-foreground text-sm", role: "status" },
        total === 0
          ? "No Board activity yet"
          : count === 0
            ? `No activity on this page · ${total} total`
            : `Showing ${offset + 1}–${offset + count} of ${total}`,
      ),
    ),
    count === 0
      ? createElement(
          "div",
          { className: "border-border rounded-xl border border-dashed p-6" },
          createElement(
            "h3",
            { className: "font-medium" },
            total === 0 ? "No Board activity yet" : "No activity on this page",
          ),
          createElement(
            "p",
            { className: "text-muted-foreground mt-2 text-sm" },
            total === 0
              ? "Changes to this Board will appear here."
              : "The list changed. Go to an earlier page or refresh.",
          ),
        )
      : createElement(
          "ol",
          { className: "flex min-w-0 flex-col gap-3" },
          ...page.items.map((item) =>
            createElement(
              "li",
              {
                key: item.id,
                className:
                  "border-border bg-card text-card-foreground min-w-0 rounded-xl border p-4 sm:p-5",
              },
              createElement(
                "p",
                { className: "font-medium break-words" },
                item.summary,
              ),
              createElement(
                "p",
                { className: "text-muted-foreground mt-2 text-sm break-words" },
                createElement(
                  "time",
                  { dateTime: item.createdAt },
                  activityTime(item.createdAt, region),
                ),
                item.actorLabel ? ` · ${item.actorLabel}` : null,
              ),
            ),
          ),
        ),
  );
}

export function ServerBackedBoardActivity({
  region,
  boardId,
  refreshKey,
  onAccessDenied,
}: {
  boardId: string;
  region: WorkspaceRegion | undefined;
  refreshKey: number;
  onAccessDenied: () => void;
}) {
  const [paging, setPaging] = useState({ boardId, offset: 0 });
  const offset = paging.boardId === boardId ? paging.offset : 0;
  const { state, retry } = useServerBoardActivity(
    boardId,
    offset,
    refreshKey,
    onAccessDenied,
  );
  const page = state.data;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Only activity available to your Board access is shown.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={state.status === "loading"}
          onClick={retry}
        >
          <RefreshCw data-icon="inline-start" /> Refresh activity
        </Button>
      </div>
      {state.error && (
        <Alert variant="destructive">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {page ? "Showing the last loaded activity. " : ""}
              {state.error}
            </span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={retry}
            >
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {page && <ServerBoardActivityDisplay page={page} region={region} />}
      {!page && state.status === "loading" && (
        <p role="status" className="text-muted-foreground py-8 text-sm">
          Loading Board activity…
        </p>
      )}
      {!page && state.status === "error" && (
        <BoardEmpty
          title="Board activity unavailable"
          description="No activity is shown. Retry or ask a Board manager to check your access."
        />
      )}
      {page && (page.pagination.total > PAGE_SIZE || offset > 0) && (
        <nav aria-label="Activity pages" className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={offset === 0 || state.status === "loading"}
            onClick={() =>
              setPaging({ boardId, offset: Math.max(0, offset - PAGE_SIZE) })
            }
          >
            Previous
          </Button>
          <span className="text-muted-foreground text-sm">
            Page {Math.floor(offset / PAGE_SIZE) + 1}
          </span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!page.pagination.hasMore || state.status === "loading"}
            onClick={() => setPaging({ boardId, offset: offset + PAGE_SIZE })}
          >
            Next
          </Button>
        </nav>
      )}
    </div>
  );
}
