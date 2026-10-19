"use client";
import { useEffect, useRef, type RefObject } from "react";
import { useCommsClient } from "./client-context";
import type { ConversationSummary } from "../contract/types";

export function useVisibleCommsRead(
  viewport: RefObject<HTMLDivElement | null>,
  summary: ConversationSummary | undefined,
  enabled: boolean,
  revision: unknown,
) {
  const { client } = useCommsClient();
  const sent = useRef<{ id: string; seq: number } | undefined>(undefined);
  const engagement = useRef(false);
  useEffect(() => {
    sent.current = undefined;
    engagement.current = false;
  }, [client, summary?.conversation.id]);
  useEffect(() => {
    const node = viewport.current;
    if (!node || !client || !summary || !enabled) return;
    const abort = new AbortController();
    let frame = 0;
    const read = () => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        getComputedStyle(node).visibility !== "visible" ||
        !node.getClientRects().length ||
        document.querySelector('[role="dialog"][data-open]')
      )
        return;
      const box = node.getBoundingClientRect();
      let seq = summary.last_read_seq;
      for (const wrapper of node.querySelectorAll<HTMLElement>(
        "[data-comms-seq]",
      )) {
        const bounds = wrapper.getBoundingClientRect();
        if (bounds.bottom > box.top && bounds.top < box.bottom)
          seq = Math.max(seq, Number(wrapper.dataset.commsSeq));
      }
      const id = summary.conversation.id;
      const engaged = engagement.current;
      engagement.current = false;
      const seen = sent.current?.id === id;
      if (seen && summary.preferences.manual_unread && !engaged) return;
      if (
        seen &&
        sent.current!.seq >= seq &&
        !(engaged && summary.preferences.manual_unread)
      )
        return;
      // Observing an already-read page is still an engagement, not permission
      // for a later preference refresh to clear a newly set reminder.
      sent.current = { id, seq };
      if (seq <= summary.last_read_seq && !summary.preferences.manual_unread)
        return;
      void client
        .markRead(id, { last_read_seq: seq }, { signal: abort.signal })
        .catch(() => {
          if (!abort.signal.aborted) sent.current = undefined;
        });
    };
    const schedule = (event?: Event) => {
      if (event && event.type !== "scroll") engagement.current = true;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    const engagements = ["pointerdown", "keydown", "wheel", "touchstart"];
    for (const type of engagements)
      node.addEventListener(type, schedule, { passive: true });
    node.addEventListener("scroll", schedule);
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      abort.abort();
      cancelAnimationFrame(frame);
      node.removeEventListener("scroll", schedule);
      for (const type of engagements) node.removeEventListener(type, schedule);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [client, summary, enabled, viewport, revision]);
}
