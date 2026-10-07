"use client";

import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { ArrowUpRight, Search as SearchIcon } from "lucide-react";
import { SearchField } from "@/components/ui/search-field";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { ApiError } from "@/lib/api";
import { requestSessionRecheck } from "@/lib/auth-api";
import { Action, Panel } from "../../shared/components/ui";
import {
  SEARCH_KINDS,
  platformSearchOptions,
  searchDestination,
  type SearchKind,
} from "../adapters/platform-search-api";

type SearchProps = {
  query: string;
  onQueryChange: (query: string) => void;
};
const TITLES: Record<SearchKind, string> = {
  record: "Records",
  person: "People",
  post: "Posts",
  event: "Events",
};
export default function Search({ query, onQueryChange }: SearchProps) {
  const search = query.trim();
  const [settled, setSettled] = useState(search);
  const [pages, setPages] = useState<{
    search: string;
    offsets: Partial<Record<SearchKind, number>>;
  }>({ search, offsets: {} });
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const offsets = pages.search === search ? pages.offsets : {};
  const reads = useQueries({
    queries: SEARCH_KINDS.map((kind) =>
      platformSearchOptions(
        settled,
        kind,
        pages.search === settled ? (pages.offsets[kind] ?? 0) : 0,
      ),
    ),
  });
  const admissionDenied = reads.some(
    (read) =>
      read.error instanceof ApiError &&
      (read.error.code === "mfa_required" ||
        read.error.code === "ip_not_allowed"),
  );
  useEffect(() => {
    if (admissionDenied) requestSessionRecheck();
  }, [admissionDenied]);
  return (
    <section className="space-y-6">
      <div className="max-w-2xl">
        <SearchField
          label="Search workspace"
          value={query}
          onValueChange={onQueryChange}
          maxLength={100}
          placeholder="Search people, records, posts and events…"
        />
      </div>
      <div className="grid items-start gap-5 md:grid-cols-2">
        {SEARCH_KINDS.map((kind, index) => {
          const read = reads[index];
          const waiting = settled !== search;
          const data =
            !waiting && !read.isError && !admissionDenied
              ? read.data
              : undefined;
          const offset = offsets[kind] ?? 0;
          return (
            <section key={kind} aria-label={`${TITLES[kind]} search results`}>
              <Panel title={TITLES[kind]}>
                {!search ? (
                  <p className="text-muted-foreground text-sm">
                    Enter a search to find {TITLES[kind].toLowerCase()}.
                  </p>
                ) : waiting || read.isPending ? (
                  <p role="status" className="text-muted-foreground text-sm">
                    Searching {TITLES[kind].toLowerCase()}…
                  </p>
                ) : read.isError || admissionDenied ? (
                  <div className="space-y-3">
                    <p role="alert" className="text-destructive text-sm">
                      {admissionDenied
                        ? "Session access needs to be checked before continuing."
                        : read.error instanceof ApiError &&
                            read.error.status === 403
                          ? "You do not have permission to search these results."
                          : "Search could not be completed."}
                    </p>
                    <Action
                      onClick={() => void read.refetch()}
                      disabled={read.isFetching}
                    >
                      Retry
                    </Action>
                  </div>
                ) : data && !data.items.length ? (
                  <p className="text-muted-foreground text-sm">
                    No matching {TITLES[kind].toLowerCase()}.
                  </p>
                ) : null}
                {data ? (
                  <>
                    <ul className="divide-y">
                      {data.items.map((item) => {
                        const href = searchDestination(item);
                        const content = (
                          <>
                            <span className="min-w-0">
                              <span className="line-clamp-2">{item.title}</span>
                              <span className="text-muted-foreground mt-1 block text-xs">
                                {item.context_label}
                              </span>
                            </span>
                            {href ? (
                              <ArrowUpRight
                                aria-hidden="true"
                                className="size-4 shrink-0"
                              />
                            ) : null}
                          </>
                        );
                        return (
                          <li key={item.id}>
                            {href ? (
                              <GuardedWorkspaceLink
                                href={href}
                                className="flex min-h-11 items-center justify-between gap-3 py-3 text-sm hover:underline"
                              >
                                {content}
                              </GuardedWorkspaceLink>
                            ) : (
                              <div className="flex min-h-11 items-center gap-3 py-3 text-sm">
                                {content}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="text-muted-foreground text-xs">
                      {data.pagination.total} results · showing{" "}
                      {data.items.length}
                    </p>
                    {data.pagination.total > 10 ? (
                      <PaginationControls
                        ariaLabel={`${TITLES[kind]} result pages`}
                        pageCount={Math.ceil(data.pagination.total / 10)}
                        pageIndex={offset / 10}
                        onPageIndexChange={(page) =>
                          setPages({
                            search,
                            offsets: { ...offsets, [kind]: page * 10 },
                          })
                        }
                      />
                    ) : null}
                  </>
                ) : null}
              </Panel>
            </section>
          );
        })}
      </div>
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <SearchIcon aria-hidden="true" className="size-4" />
        Results include workspace content you can read.
      </p>
    </section>
  );
}
