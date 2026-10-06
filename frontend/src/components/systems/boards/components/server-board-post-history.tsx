"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  listBoardPostRevisions,
  readBoardPostRevision,
  type BoardPostRevision,
  type BoardPostRevisionSummary,
} from "../adapters/board-posts-api";

type Loaded<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T };

function timeLabel(
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
  });
}

function useRevisions(boardId: string, postId: string, retryKey: number) {
  const [state, setState] = useState<{
    key: string;
    value: Loaded<BoardPostRevisionSummary[]>;
  } | null>(null);
  const key = `${boardId}:${postId}:${retryKey}`;
  useEffect(() => {
    const controller = new AbortController();
    listBoardPostRevisions(boardId, postId, controller.signal)
      .then((list) =>
        setState({ key, value: { status: "ready", data: list.items } }),
      )
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({
          key,
          value: { status: "error", error: "Edit history is unavailable." },
        });
      });
    return () => controller.abort();
  }, [boardId, postId, key]);
  return state?.key === key ? state.value : ({ status: "loading" } as const);
}

function useRevision(
  boardId: string,
  postId: string,
  revisionId: string | null,
) {
  const [state, setState] = useState<{
    id: string;
    value: Loaded<BoardPostRevision>;
  } | null>(null);
  useEffect(() => {
    if (!revisionId) return;
    const controller = new AbortController();
    readBoardPostRevision(boardId, postId, revisionId, controller.signal)
      .then((data) =>
        setState({ id: revisionId, value: { status: "ready", data } }),
      )
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({
          id: revisionId,
          value: { status: "error", error: "This version is unavailable." },
        });
      });
    return () => controller.abort();
  }, [boardId, postId, revisionId]);
  if (!revisionId) return null;
  return state?.id === revisionId
    ? state.value
    : ({ status: "loading" } as const);
}

function RevisionBody({ revision }: { revision: BoardPostRevision }) {
  return (
    <article aria-label={`Version ${revision.publicationNumber}`}>
      <h3 className="text-base font-semibold break-words">{revision.title}</h3>
      <p className="mt-2 max-w-prose leading-7 break-words whitespace-pre-wrap">
        {revision.body}
      </p>
      {revision.links.length > 0 && (
        <ul aria-label="Links in this version" className="mt-3 space-y-1">
          {revision.links.map((link, index) => (
            <li key={`${link.url}:${index}`}>
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                className="text-primary focus-visible:outline-ring inline-flex min-h-11 items-center gap-1 rounded-sm text-sm break-words underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {link.label}
                <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function PostHistoryContent({
  region,
  boardId,
  postId,
  authorLabels,
}: {
  boardId: string;
  region: WorkspaceRegion | undefined;
  postId: string;
  authorLabels: Record<string, string> | null;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const revisions = useRevisions(boardId, postId, retryKey);
  const [chosen, setChosen] = useState<string | null>(null);
  const items = revisions.status === "ready" ? revisions.data : [];
  const selectedId =
    chosen && items.some((item) => item.id === chosen)
      ? chosen
      : (items[0]?.id ?? null);
  const revision = useRevision(boardId, postId, selectedId);

  if (revisions.status === "loading")
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Loading edit history…
      </p>
    );
  if (revisions.status === "error")
    return (
      <Alert variant="destructive">
        <p>{revisions.error}</p>
        <Button
          type="button"
          variant="outline"
          className="mt-3 min-h-11"
          onClick={() => setRetryKey((value) => value + 1)}
        >
          Retry
        </Button>
      </Alert>
    );
  if (items.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        This post has no published versions.
      </p>
    );
  const latest = items[0].publicationNumber;
  return (
    <div className="mt-2 grid min-w-0 gap-5 md:grid-cols-[14rem_minmax(0,1fr)]">
      <ol aria-label="Versions" className="flex min-w-0 flex-col gap-1">
        {items.map((item) => {
          const selected = item.id === selectedId;
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => setChosen(item.id)}
                className={
                  "focus-visible:outline-ring flex min-h-11 w-full flex-col items-start rounded-md px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 " +
                  (selected ? "bg-secondary font-medium" : "hover:bg-muted")
                }
              >
                <span>
                  Version {item.publicationNumber}
                  {item.publicationNumber === latest ? " · current" : ""}
                </span>
                <span className="text-muted-foreground text-xs">
                  <time dateTime={item.publishedAt}>
                    {timeLabel(item.publishedAt, region)}
                  </time>
                  {" · "}
                  {authorLabels?.[item.authorId] ?? "Author unavailable"}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="min-w-0">
        {revision?.status === "ready" ? (
          <RevisionBody revision={revision.data} />
        ) : revision?.status === "error" ? (
          <Alert variant="destructive">{revision.error}</Alert>
        ) : (
          <p role="status" className="text-muted-foreground text-sm">
            Loading this version…
          </p>
        )}
      </div>
    </div>
  );
}

/** Lists every published version of a post and shows the chosen one. */
export function ServerBoardPostHistory({
  region,
  boardId,
  postId,
  title,
  authorLabels,
  onClose,
}: {
  boardId: string;
  region: WorkspaceRegion | undefined;
  postId: string;
  title: string;
  authorLabels: Record<string, string> | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl p-5 sm:p-7">
        <DialogHeader className="pr-10">
          <DialogTitle className="text-xl leading-snug break-words">
            Edit history
          </DialogTitle>
          <DialogDescription className="break-words">
            Every published version of “{title}”. Earlier versions cannot be
            changed.
          </DialogDescription>
        </DialogHeader>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close edit history"
          className="absolute top-3 right-3 size-11"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
        <PostHistoryContent
          region={region}
          boardId={boardId}
          postId={postId}
          authorLabels={authorLabels}
        />
      </DialogContent>
    </Dialog>
  );
}
