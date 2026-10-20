"use client";
import {
  useLayoutEffect,
  useState,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { Message } from "../domain/view-model";
const estimatedRowHeight = 72;

export function VirtualMessageList({
  messages,
  children,
  header,
  footer,
  viewportRef,
  restoreAnchor,
  restoreId = "",
  targetId = "",
  retainedId = "",
  followLatest = true,
}: {
  messages: Message[];
  children: (index: number, tabIndex: number) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  viewportRef: RefObject<HTMLDivElement | null>;
  restoreAnchor?: (align: (id: string, top: number) => boolean) => void;
  restoreId?: string;
  targetId?: string;
  retainedId?: string;
  followLatest?: boolean;
}) {
  "use no memo"; // TanStack's mutable virtualizer must be read on every range update.
  const [focusedId, setFocusedId] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    setMargin(listRef.current?.offsetTop ?? 0);
  }, [header]);
  const count = messages.length;
  const targetIndex = messages.findIndex((message) => message.id === targetId);
  const focusedIndex = messages.findIndex(
    (message) => message.id === focusedId,
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- This component explicitly opts out above; no virtualizer method is memoized or passed to memoized children.
  const virtual = useVirtualizer({
    count,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => estimatedRowHeight,
    getItemKey: (index) => messages[index].id,
    scrollMargin: margin,
    initialRect: { width: 0, height: 600 },
    initialOffset: () =>
      (targetIndex >= 0 ? targetIndex : followLatest ? count : 0) *
      estimatedRowHeight,
    anchorTo: targetId ? "start" : "end",
    followOnAppend: followLatest && !targetId,
    scrollEndThreshold: 120,
    overscan: 2,
    rangeExtractor: (range) =>
      [
        ...new Set([
          ...defaultRangeExtractor(range),
          ...[retainedId, restoreId, focusedId, targetId].flatMap((id) => {
            const index = messages.findIndex((message) => message.id === id);
            return index < 0 ? [] : [index];
          }),
        ]),
      ].sort((a, b) => a - b),
  });
  const tabStop =
    focusedIndex >= 0
      ? focusedIndex
      : targetIndex >= 0
        ? targetIndex
        : (virtual.range?.endIndex ?? count - 1);
  const lastId = messages.at(-1)?.id;
  const positionRef = useRef({ targetId, lastId, followLatest });
  const alignedTarget = useRef("");
  useLayoutEffect(() => {
    restoreAnchor?.((id, top) => {
      const viewport = viewportRef.current,
        article = document.getElementById(id);
      if (!viewport || !article) return false;
      const delta =
        article.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        top;
      if (Math.abs(delta) > 0.5)
        virtual.scrollToOffset(viewport.scrollTop + delta);
      return true;
    });
  });
  useLayoutEffect(() => {
    const previous = positionRef.current;
    positionRef.current = { targetId, lastId, followLatest };
    if (!targetId) {
      alignedTarget.current = "";
      // Mount starts at the estimated end. Only subsequent explicit latest/send
      // transitions need a command; measurements preserve the end themselves.
      if (
        followLatest &&
        (previous.targetId ||
          !previous.followLatest ||
          previous.lastId !== lastId)
      )
        virtual.scrollToOffset(virtual.getTotalSize() + margin);
      return;
    }
    if (targetIndex < 0 || alignedTarget.current === targetId) return;
    virtual.scrollToIndex(targetIndex, { align: "center" });
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (target) alignedTarget.current = targetId;
      target?.focus({ preventScroll: true });
      // Align the mounted, measured article after WebKit's deferred scroll write.
      target?.scrollIntoView({ block: "center", behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [targetId, targetIndex, lastId, followLatest, count, margin, virtual]);
  return (
    <>
      {header}
      <div
        ref={listRef}
        role="feed"
        aria-label="Conversation messages"
        className="relative min-w-0"
        style={{ height: virtual.getTotalSize() }}
        onKeyDown={(event) => {
          if (
            !["PageUp", "PageDown"].includes(event.key) ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          )
            return;
          const article = (event.target as HTMLElement).closest("article");
          if (event.target !== article) return;
          const id =
            article?.closest<HTMLElement>("[data-message-id]")?.dataset
              .messageId;
          const index = messages.findIndex((message) => message.id === id);
          if (index < 0) return;
          const next = Math.max(
            0,
            Math.min(count - 1, index + (event.key === "PageDown" ? 1 : -1)),
          );
          if (next === index) return;
          event.preventDefault();
          const nextId = messages[next].id;
          setFocusedId(nextId);
          virtual.scrollToIndex(next, { align: "center" });
          requestAnimationFrame(() =>
            viewportRef.current
              ?.querySelector<HTMLElement>(
                `[data-message-id="${CSS.escape(nextId)}"] article`,
              )
              ?.focus({ preventScroll: true }),
          );
        }}
        onFocusCapture={(event) => {
          const article = (event.target as HTMLElement).closest("article");
          if (article)
            setFocusedId(
              article.closest<HTMLElement>("[data-message-id]")?.dataset
                .messageId ?? article.id,
            );
        }}
      >
        {virtual.getVirtualItems().map((item) => (
          <div
            key={item.key}
            ref={virtual.measureElement}
            data-index={item.index}
            className="absolute top-0 left-0 flow-root w-full"
            style={{ transform: `translateY(${item.start - margin}px)` }}
          >
            {children(item.index, item.index === tabStop ? 0 : -1)}
          </div>
        ))}
      </div>
      {footer}
    </>
  );
}
