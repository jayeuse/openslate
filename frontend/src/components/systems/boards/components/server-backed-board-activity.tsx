"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-word";
import { TablePagination } from "@/components/ui/table-pagination";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";
import type {
  BoardActivity,
  BoardToolsPage,
} from "../adapters/board-tools-api";
import { boardActivitySentence } from "../domain/board-settings";
import { useServerBoardActivity } from "../hooks/use-server-board-activity";

const PAGE_SIZE = 25;
const control = "min-h-11 xl:min-h-8";

function activityTime(
  timestamp: string,
  region: WorkspaceRegion | undefined,
): string {
  if (!region) return "";
  return formatWorkspaceDateTime(timestamp, region, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/**
 * Activity rows (BR29), in the Audit sentence grammar: a dot, the verb at
 * weight 500, then who and when in muted ink. 40px one-line rows from 1280px.
 */
export function ServerBoardActivityDisplay({
  region,
  page,
}: {
  page: BoardToolsPage<BoardActivity>;
  region?: WorkspaceRegion;
}) {
  if (page.items.length === 0)
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-dashed p-5 text-sm">
        <p data-slot="empty-title" className="font-medium">
          {page.pagination.total === 0
            ? "No activity yet"
            : "No activity on this page"}
        </p>
        <p className="text-muted-foreground">
          {page.pagination.total === 0
            ? "Changes to this board's details and groups show here."
            : "The list changed. Go to an earlier page."}
        </p>
      </div>
    );
  return (
    <ol
      aria-label="Board activity"
      className="divide-border flex min-w-0 flex-col divide-y rounded-lg border"
    >
      {page.items.map((item) => {
        const { verb, tone } = boardActivitySentence(item);
        const time = activityTime(item.createdAt, region);
        return (
          <li
            key={item.id}
            className="flex min-h-14 min-w-0 items-start gap-1.5 px-3 py-2 text-sm xl:min-h-10 xl:items-center xl:py-0"
          >
            <span className="flex h-lh shrink-0 items-center xl:h-auto">
              <StatusDot tone={tone} />
            </span>
            <span className="min-w-0 break-words xl:truncate">
              <b className="font-medium">{verb}</b>
              <span className="text-muted-foreground">
                {item.actorLabel ? ` · ${item.actorLabel}` : ""}
                {time ? (
                  <>
                    {" · "}
                    <time dateTime={item.createdAt} className="tabular-nums">
                      {time}
                    </time>
                  </>
                ) : null}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Board settings › Activity: the board's own changes, newest first, from the
 * audit log. A board change in the live stream reads it again.
 */
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
    <section aria-label="Activity" className="flex min-w-0 flex-col gap-4">
      {state.error ? (
        <Alert
          variant="destructive"
          className="flex flex-wrap items-center justify-between gap-2"
        >
          <span>
            {page ? "Showing the last loaded activity. " : ""}
            {state.error}
          </span>
          <Button
            type="button"
            variant="outline"
            className={control}
            onClick={retry}
          >
            Retry
          </Button>
        </Alert>
      ) : null}
      {page ? (
        <ServerBoardActivityDisplay page={page} region={region} />
      ) : state.status === "loading" ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading activity…
        </p>
      ) : null}
      {page && (page.pagination.total > PAGE_SIZE || offset > 0) ? (
        <TablePagination
          ariaLabel="Activity pages"
          className="rounded-lg border p-3"
          total={page.pagination.total}
          offset={offset}
          rowCount={page.items.length}
          pageSize={PAGE_SIZE}
          disabled={state.status === "loading"}
          onPageIndexChange={(index) =>
            setPaging({ boardId, offset: Math.max(0, index * PAGE_SIZE) })
          }
        />
      ) : null}
    </section>
  );
}
