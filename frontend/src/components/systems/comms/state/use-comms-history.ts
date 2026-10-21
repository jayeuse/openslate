"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { HistoryPage, HistoryRequest } from "../contract/types";
import { useCommsClient } from "./client-context";
import { useCommsWorkspaceView } from "./use-comms-workspace";
import { useCommsRead } from "./runtime";
import { loadQuotes, messageView } from "./message-view";
import { useCommsMessageAuthors } from "./use-comms-message-authors";

export function useCommsHistory(
  id: string,
  targetId: string,
  enabled: boolean,
  viewportRef: RefObject<HTMLDivElement | null>,
  root: string | null = null,
) {
  const { client, scope } = useCommsClient();
  const cache = useQueryClient();
  const workspace = useCommsWorkspaceView();
  const [position, setPosition] = useState<{
    id: string;
    following: boolean;
    resume?: HistoryRequest;
    restoreId?: string;
  }>({ id, following: true });
  const following = position.id !== id || position.following;
  const options = scope?.historyOptions(id, root) ?? {
    queryKey: [
      "comms",
      "unadmitted",
      "unadmitted",
      "conversation",
      id,
      "history",
      root,
    ] as const,
    initialPageParam: { limit: 50 } as HistoryRequest,
    queryFn: async (): Promise<HistoryPage> => {
      throw new Error("Organization is not admitted");
    },
    getPreviousPageParam: (): HistoryRequest | undefined => undefined,
    getNextPageParam: (): HistoryRequest | undefined => undefined,
    maxPages: 2,
  };
  const resource = useInfiniteQuery({
    ...options,
    initialPageParam:
      position.id === id && position.resume
        ? position.resume
        : options.initialPageParam,
    enabled: !!client && !!scope && enabled,
    meta: { commsFollowLatest: following },
  });
  const page = useMemo((): HistoryPage | undefined => {
    if (
      !client ||
      !enabled ||
      scope?.isRefused(id) ||
      !resource.data?.pages.length
    )
      return;
    const pages = resource.data.pages;
    const items = [
      ...new Map(
        pages.flatMap((page) => page.items).map((item) => [item.id, item]),
      ).values(),
    ].sort((a, b) => a.seq - b.seq);
    return {
      ...pages[0],
      items,
      pagination: {
        limit: 100,
        count: items.length,
        first_seq: items[0]?.seq ?? null,
        last_seq: items.at(-1)?.seq ?? null,
        high_water_seq: Math.min(
          ...pages.map((p) => p.pagination.high_water_seq),
        ),
        has_older: pages[0].pagination.has_older,
        has_newer: pages.at(-1)!.pagination.has_newer,
      },
    };
  }, [client, enabled, id, scope, resource.data]);
  const displayed = useRef<HistoryPage | undefined>(undefined);
  const anchor = useRef<{ id: string; top: number; page: HistoryPage } | null>(
    null,
  );
  useLayoutEffect(() => {
    displayed.current = page;
  }, [page]);
  const remember = useCallback(() => {
    const node = viewportRef.current,
      current = displayed.current;
    if (!node || !current) return;
    const box = node.getBoundingClientRect();
    const article = [...node.querySelectorAll<HTMLElement>("article")].find(
      (item) => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom;
      },
    );
    if (article) {
      anchor.current = {
        id: article.id,
        top: article.getBoundingClientRect().top - box.top,
        page: current,
      };
      return anchor.current;
    }
  }, [viewportRef]);
  useLayoutEffect(() => {
    const keepWindow = () => {
      if (!client || !scope || scope.signal.aborted || !enabled || following)
        return;
      const saved = remember();
      const seq = saved?.page.items.find(
        (message) => message.id === saved.id,
      )?.seq;
      if (saved && seq !== undefined)
        setPosition({
          id,
          following: false,
          resume: { limit: 50, around_seq: seq },
          restoreId: saved.id,
        });
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") keepWindow();
    };
    window.addEventListener("blur", keepWindow);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", keepWindow);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [client, scope, enabled, following, id, remember]);
  const replace = useCallback(
    async (request: HistoryRequest, signal?: AbortSignal) => {
      if (!client || !scope) return;
      await cache.cancelQueries({
        queryKey: scope.keys.history(id, root),
        exact: true,
      });
      const result = await scope.read(
        id,
        (signal) =>
          root
            ? client.getReplies(id, root, request, { signal })
            : client.getHistory(id, request, { signal }),
        signal,
      );
      cache.setQueryData(scope.keys.history(id, root), {
        pages: [result],
        pageParams: [request],
      });
    },
    [client, scope, cache, id, root],
  );
  useEffect(() => {
    if (!client || !scope || !enabled || !targetId || targetId === root) return;
    const abort = new AbortController();
    void scope
      .read(
        id,
        (signal) => client.getMessage(id, targetId, { signal }),
        abort.signal,
        false,
      )
      .then(async ({ data }) => {
        const target =
          data.parent_id && !root
            ? (
                await client.getMessage(id, data.parent_id, {
                  signal: abort.signal,
                })
              ).data
            : data;
        if (
          displayed.current?.items.some((message) => message.id === target.id)
        )
          return;
        remember();
        setPosition({ id, following: false });
        await replace({ around_seq: target.seq, limit: 50 }, abort.signal);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [client, scope, id, root, targetId, enabled, remember, replace]);
  const quoteIds =
    page?.items
      .flatMap((message) => (message.reply_to_id ? [message.reply_to_id] : []))
      .join(",") ?? "";
  const quotes = useCommsRead(
    `quotes:${id}:${root ?? ""}:${quoteIds}`,
    async (current, signal) => {
      const values = new Map(
        (page?.items ?? []).map((message) => [message.id, message]),
      );
      await loadQuotes(current, values, signal);
      return [...values.values()].filter((message) =>
        quoteIds.includes(message.id),
      );
    },
  );
  const authorMessages = useMemo(
    () => [...(page?.items ?? []), ...(quotes.data ?? [])],
    [page, quotes.data],
  );
  const authors = useCommsMessageAuthors(authorMessages, workspace.people);
  const projected = useMemo(() => {
    const records = new Map(
      workspace.records.map((record) => [record.id, record]),
    );
    const people = new Map(
      workspace.people.map((person) => [person.id, person]),
    );
    const project = (message: HistoryPage["items"][number]) => ({
      ...messageView(message, people, records),
      ...(authors.has(message.author_id)
        ? { author: authors.get(message.author_id)! }
        : {}),
    });
    return {
      messages: (page?.items ?? []).map(project),
      quotes: (quotes.data ?? []).map(project),
      records: [...records.values()],
    };
  }, [page, quotes.data, workspace.people, workspace.records, authors]);
  return {
    ...projected,
    page,
    followLatest: following,
    restoreId: position.id === id ? position.restoreId : undefined,
    error: resource.isError ? "History could not be loaded. Try again." : "",
    loading: enabled && resource.isPending,
    retry: () => {
      void resource.refetch();
    },
    latest: () => {
      anchor.current = null;
      setPosition({ id, following: true });
      void replace({ limit: 50 }).catch(() => {});
    },
    older: () => {
      remember();
      setPosition({ id, following: false });
      void resource.fetchPreviousPage().catch(() => {});
    },
    newer: () => {
      remember();
      setPosition({ id, following: false });
      void resource.fetchNextPage().catch(() => {});
    },
    pin: () => {
      anchor.current = null;
      setPosition({ id, following: false });
    },
    restore: (align: (id: string, top: number) => boolean) => {
      const saved = anchor.current;
      if (saved && saved.page !== page && saved.id !== targetId)
        align(saved.id, saved.top);
    },
  };
}
