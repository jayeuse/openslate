"use client";

import { useLayoutEffect, useState } from "react";

/**
 * What a panel body shows of its content (docs/specs/access-ui-ux-pass.md,
 * Phase 4b: a card that scrolls always shows that it does).
 */
export type ScrollCue = {
  /** The body's inner height in px, once measured. */
  height: number | null;
  /** Content waits below the visible end. The body then carries
   * `data-scroll-more`, which draws the bottom fade. */
  more: boolean;
  /** The rows (matching `rows`) that fit in full without scrolling. */
  fit: number | null;
};

const unmeasured: ScrollCue = { height: null, more: false, fit: null };

/**
 * One mechanism for every scrolling panel body. Pass the returned callback
 * as the body's `ref`; the cue follows resizes, content changes, and
 * scrolling. With `rows`, a CSS selector of the body's rows, it also counts
 * the rows that fit.
 */
export function useScrollCue(
  rows?: string,
): [(node: HTMLElement | null) => void, ScrollCue] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [cue, setCue] = useState<ScrollCue>(unmeasured);

  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => {
      const height = node.clientHeight;
      const more = node.scrollHeight - node.scrollTop - height > 1;
      let fit: number | null = null;
      if (rows) {
        // Positions in the content, so the count does not follow the scroll.
        const top =
          node.getBoundingClientRect().top + node.clientTop - node.scrollTop;
        fit = 0;
        for (const row of node.querySelectorAll(rows))
          if (row.getBoundingClientRect().bottom - top <= height + 0.5)
            fit += 1;
      }
      setCue((current) =>
        current.height === height &&
        current.more === more &&
        current.fit === fit
          ? current
          : { height, more, fit },
      );
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    const content = new MutationObserver(measure);
    content.observe(node, { childList: true, subtree: true });
    node.addEventListener("scroll", measure, { passive: true });
    return () => {
      resize.disconnect();
      content.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, [node, rows]);

  return [setNode, node ? cue : unmeasured];
}
