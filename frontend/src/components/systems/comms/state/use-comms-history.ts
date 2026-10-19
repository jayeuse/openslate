"use client";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { CommsClient } from "../contract/client";
import type {
  HistoryPage,
  HistoryRequest,
  Message as WireMessage,
} from "../contract/types";
import { useCommsClient } from "./client-context";
import { useCommsWorkspaceView } from "./use-comms-workspace";
import { isCommsReadRefusal, useCommsRead } from "./runtime";
import { loadQuotes, messageView } from "./message-view";

export function useCommsHistory(
  id: string,
  targetId: string,
  enabled: boolean,
  viewportRef: RefObject<HTMLDivElement | null>,
) {
  const { client } = useCommsClient();
  const workspace = useCommsWorkspaceView();
  const base =
    workspace.client === client ? workspace.historyPages[id] : undefined;
  const [cursor, setCursor] = useState<{
    id: string;
    request: HistoryRequest;
    latest: boolean;
  }>();
  const active = cursor?.id === id ? cursor : undefined;
  type Result = { page: HistoryPage; quotes: WireMessage[] };
  const [good, setGood] = useState<{
    client: CommsClient;
    id: string;
    result: Result;
  }>();
  const [refused, setRefused] = useState(false);
  const anchor = useRef<{ id: string; top: number; page: HistoryPage } | null>(
    null,
  );
  const displayedPageRef = useRef<HistoryPage | undefined>(undefined);
  function remember() {
    const page = displayedPageRef.current;
    const node = viewportRef.current;
    if (!node || !page) return;
    const box = node.getBoundingClientRect();
    const article = [...node.querySelectorAll<HTMLElement>("article")].find(
      (item) => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom;
      },
    );
    if (article)
      anchor.current = {
        id: article.id,
        top: article.getBoundingClientRect().top - box.top,
        page,
      };
  }
  const resource = useCommsRead(
    `history:${id}:${JSON.stringify(active)}`,
    async (current, signal) => {
      if (!enabled || !active) {
        if (!signal.aborted) setRefused(false);
        return null;
      }
      try {
        if (active.latest) anchor.current = null;
        else remember();
        const page = await current.getHistory(id, active.request, { signal });
        const quotes = new Map(
          page.items.map((message) => [message.id, message]),
        );
        await loadQuotes(current, quotes, signal);
        const result = { page, quotes: [...quotes.values()] };
        if (!signal.aborted) {
          setGood({ client: current, id, result });
          setRefused(false);
        }
        return result;
      } catch (error) {
        if (!signal.aborted && isCommsReadRefusal(error)) setRefused(true);
        throw error;
      }
    },
  );
  const result =
    !refused && client && enabled
      ? active
        ? (resource.data ??
          (good?.client === client && good.id === id ? good.result : undefined))
        : base
          ? { page: base, quotes: base.items }
          : undefined
      : undefined;
  const page = result?.page;
  useLayoutEffect(() => {
    displayedPageRef.current = page;
  }, [page]);
  function request(next: HistoryRequest, latest = false) {
    if (latest) anchor.current = null;
    else remember();
    if (result && client) setGood({ client, id, result });
    const nextCursor = { id, request: next, latest };
    if (JSON.stringify(nextCursor) === JSON.stringify(cursor))
      resource.reload();
    else setCursor(nextCursor);
  }
  useEffect(() => {
    if (
      !client ||
      !enabled ||
      !targetId ||
      base?.items.some((message) => message.id === targetId)
    )
      return;
    const abort = new AbortController();
    void client
      .getMessage(id, targetId, { signal: abort.signal })
      .then(async ({ data }) => {
        const seq = data.parent_id
          ? (
              await client.getMessage(id, data.parent_id, {
                signal: abort.signal,
              })
            ).data.seq
          : data.seq;
        if (!abort.signal.aborted)
          setCursor({
            id,
            request: { around_seq: seq, limit: 50 },
            latest: false,
          });
      })
      .catch(() => {});
    return () => abort.abort();
  }, [client, id, targetId, enabled, base]);
  const projected = useMemo(() => {
    const records = new Map(
      workspace.records.map((record) => [record.id, record]),
    );
    const people = new Map(
      workspace.people.map((person) => [person.id, person]),
    );
    return {
      messages: (page?.items ?? []).map((message) =>
        messageView(message, people, records),
      ),
      quotes: (result?.quotes ?? []).map((message) =>
        messageView(message, people, records),
      ),
      records: [...records.values()],
    };
  }, [page, result?.quotes, workspace.people, workspace.records]);
  return {
    ...projected,
    page,
    followLatest: active?.latest ?? true,
    error: resource.error,
    loading: !!active && !resource.data && !resource.error,
    retry: resource.reload,
    latest: () => request({ limit: 50 }, true),
    older: () => {
      const pivot = page?.items[Math.min(50, page.items.length) - 1];
      if (pivot) request({ before_seq: pivot.seq + 1, limit: 100 });
    },
    newer: () => {
      const pivot = page?.items[Math.max(0, page.items.length - 50)];
      if (pivot) request({ after_seq: pivot.seq - 1, limit: 100 });
    },
    pin: () => {
      anchor.current = null;
      if (!active && page?.items.length)
        request({ after_seq: page.items[0].seq - 1, limit: page.items.length });
    },
    restore: (align: (id: string, top: number) => boolean) => {
      const saved = anchor.current;
      if (
        saved &&
        saved.page !== page &&
        resource.data?.page === page &&
        saved.id !== targetId
      )
        align(saved.id, saved.top);
    },
  };
}
