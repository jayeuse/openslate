"use client";

import Link from "next/link";
import type { Route } from "next";
import { ArrowUpRight, Files, Search as SearchIcon } from "lucide-react";
import { SearchField } from "@/components/ui/search-field";
import { Panel } from "../../shared/components/ui";
import type {
  CompleteCollection,
  PageResult,
} from "../../shared/helpers/sample-collections";

type SearchItem = {
  id: string;
  title: string;
  href: string;
};

export type PlatformSearchGroup = {
  type: string;
  complete: CompleteCollection<SearchItem>;
  page: PageResult<SearchItem>;
};

type SearchProps = {
  query: string;
  onQueryChange: (query: string) => void;
  groups: readonly PlatformSearchGroup[];
  navigationPending: boolean;
  isNavigationPending: () => boolean;
  onOpenFile: (fileId: string) => void;
};

export default function Search({
  query,
  onQueryChange,
  groups,
  navigationPending,
  isNavigationPending,
  onOpenFile,
}: SearchProps) {
  return (
    <section className="space-y-6">
      <div className="max-w-2xl">
        <SearchField
          label="Search workspace"
          value={query}
          onValueChange={onQueryChange}
          placeholder="Search people, records, conversations and files…"
        />
      </div>
      <div className="grid items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => (
          <Panel
            key={group.type}
            title={`${group.type}${
              group.complete.items.length > group.page.items.length
                ? ` · showing ${group.page.items.length} of ${group.complete.items.length}`
                : ""
            }`}
          >
            {!group.complete.items.length && (
              <p className="text-muted-foreground text-sm">
                No matching {group.type.toLowerCase()}.
              </p>
            )}
            <ul className="divide-y">
              {group.page.items.map((item) => (
                <li key={item.id}>
                  {group.type === "Files" ? (
                    <button
                      className="flex min-h-11 w-full items-center justify-between gap-3 py-3 text-left text-sm hover:underline"
                      disabled={navigationPending}
                      onClick={(event) => {
                        if (isNavigationPending()) {
                          event.preventDefault();
                          return;
                        }
                        onOpenFile(item.id);
                      }}
                    >
                      {item.title}
                      <Files className="size-4 shrink-0" />
                    </button>
                  ) : (
                    <Link
                      href={item.href as Route}
                      className="flex min-h-11 items-center justify-between gap-3 py-3 text-sm hover:underline"
                    >
                      <span className="line-clamp-2">{item.title}</span>
                      <ArrowUpRight className="size-4 shrink-0" />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        ))}
      </div>
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <SearchIcon className="size-4" />
        Results are drawn from workspace content.
      </p>
    </section>
  );
}
