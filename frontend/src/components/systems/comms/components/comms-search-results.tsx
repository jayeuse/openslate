"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
import { formatWorkspaceDateTime } from "@/lib/date-time-display";
import type { Page, SearchHit } from "../contract/types";

function PlainExcerpt({ hit }: { hit: SearchHit }) {
  const points = Array.from(hit.excerpt);
  const ranges: { start: number; end: number }[] = [];
  for (const match of [...hit.matches].sort((a, b) => a.start - b.start)) {
    const last = ranges.at(-1);
    if (last && match.start <= last.end)
      last.end = Math.max(last.end, match.end);
    else ranges.push({ ...match });
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    parts.push(points.slice(cursor, range.start).join(""));
    parts.push(
      <mark
        key={`${range.start}:${range.end}`}
        className="bg-accent text-accent-foreground rounded-sm"
      >
        {points.slice(range.start, range.end).join("")}
      </mark>,
    );
    cursor = range.end;
  }
  parts.push(points.slice(cursor).join(""));
  return (
    <p dir="auto" className="line-clamp-3 text-sm font-normal wrap-anywhere">
      {parts}
    </p>
  );
}

/** Bounded server page; rendering never interprets excerpts as HTML or filters authority. */
export function CommsSearchResults({
  page,
  refreshing,
  onOpen,
  onPage,
}: {
  page: Page<SearchHit>;
  refreshing: boolean;
  onOpen: (hit: SearchHit) => void;
  onPage: (offset: number) => void;
}) {
  const region = useWorkspaceDisplayRegion();
  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <p className="text-muted-foreground">{page.pagination.total} results</p>
        {refreshing && <span role="status">Updating results…</span>}
      </div>
      {!page.items.length ? (
        <p className="text-muted-foreground py-6 text-sm">
          No messages match these filters.
        </p>
      ) : (
        <ul
          aria-label="Search results"
          className="max-h-[42dvh] overflow-y-auto rounded-[var(--radius)] border"
        >
          {page.items.map((hit) => (
            <li key={hit.message_id} className="border-b last:border-b-0">
              <button
                type="button"
                aria-label={`Open message from ${hit.author_name} in ${hit.conversation_name}`}
                onClick={() => onOpen(hit)}
                className="hover:bg-muted focus-visible:outline-ring flex min-h-11 w-full flex-col gap-1.5 px-3 py-3 text-left outline-offset-[-2px] focus-visible:outline-2"
              >
                <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
                  <span className="min-w-0 truncate font-medium">
                    <bdi>{hit.author_name}</bdi>
                    <span className="text-muted-foreground font-normal">
                      {" "}
                      · <bdi>{hit.conversation_name}</bdi>
                    </span>
                  </span>
                  <time
                    dateTime={hit.created_at}
                    className="text-muted-foreground"
                  >
                    {region
                      ? formatWorkspaceDateTime(hit.created_at, region)
                      : hit.created_at.slice(0, 10)}
                  </time>
                </span>
                <PlainExcerpt hit={hit} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex justify-between gap-3">
        <Button
          variant="outline"
          disabled={!page.pagination.offset || refreshing}
          className="min-h-11 sm:min-h-10"
          onClick={() =>
            onPage(Math.max(0, page.pagination.offset - page.pagination.limit))
          }
        >
          Previous results
        </Button>
        <Button
          variant="outline"
          disabled={!page.pagination.has_more || refreshing}
          className="min-h-11 sm:min-h-10"
          onClick={() => onPage(page.pagination.offset + page.pagination.count)}
        >
          Next results
        </Button>
      </div>
    </>
  );
}
