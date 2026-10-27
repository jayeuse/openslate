"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  extendsRead,
  readStamp,
} from "@/components/systems/openview/adapters/openview-queries";
import { boardPeopleOptions } from "../adapters/board-kanban-queries";
import {
  listBoardPeople,
  type BoardPerson,
} from "../adapters/board-people-api";

const SEARCH_DELAY_MS = 250;
const UNAVAILABLE = "People could not be loaded. Retry.";

/** Pages after the cached first page, tied to the read that produced it. */
type Extension = {
  readAt: number;
  search: string;
  items: BoardPerson[];
  hasMore: boolean;
};

/**
 * Whom a writer can pick as a card's assignee: the people who can read the
 * board (`GET /boards/{id}/people`), narrowed by search and read in pages of
 * 100. Mounted only while a writer's card sheet is open.
 */
export function useAssigneePicker(boardId: string) {
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setApplied(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const first = useQuery(boardPeopleOptions(boardId, applied));
  const [extension, setExtension] = useState<Extension | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const more =
    extension &&
    extension.search === applied &&
    extendsRead(extension.readAt, first)
      ? extension
      : null;
  const people = first.data
    ? [
        ...first.data.items,
        ...(more?.items ?? []).filter(
          (person) => !first.data.items.some((item) => item.id === person.id),
        ),
      ]
    : [];
  const hasMore = more
    ? more.hasMore
    : (first.data?.pagination.hasMore ?? false);

  const loadMore = () => {
    if (!first.data || loadingMore) return;
    const readAt = readStamp(first);
    const forSearch = applied;
    const loaded = more?.items ?? [];
    setLoadingMore(true);
    setMoreError(false);
    void listBoardPeople(boardId, {
      offset: first.data.items.length + loaded.length,
      search: forSearch,
    })
      .then((page) =>
        setExtension({
          readAt,
          search: forSearch,
          items: [...loaded, ...page.items],
          hasMore: page.pagination.hasMore,
        }),
      )
      .catch(() => setMoreError(true))
      .finally(() => setLoadingMore(false));
  };

  return {
    people,
    search,
    setSearch: (value: string) => setSearch(value.slice(0, 100)),
    loading: first.isPending,
    error: first.isError || moreError ? UNAVAILABLE : undefined,
    retry: () => {
      setMoreError(false);
      void first.refetch();
    },
    hasMore,
    loadMore,
    loadingMore,
  };
}
