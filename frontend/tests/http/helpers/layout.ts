import type { Locator } from "./test";

// Layout probes for the phone and tablet journeys (Manage relayout MD19):
// targets under the 44px floor, text an ellipsis cuts, and toolbar controls
// that wrapped alone.

/**
 * The visible interactive targets under 44px on their shorter side. A
 * visually hidden control (the file input behind Choose logo, a look radio
 * inside its tile) has a 1px box and is skipped; its visible target counts.
 */
export async function smallTargets(scope: Locator) {
  return scope.evaluate((root) =>
    [
      ...root.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, summary, [role="tab"], [role="combobox"]',
      ),
    ].flatMap((element) => {
      const box = element.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) return [];
      if (getComputedStyle(element).visibility === "hidden") return [];
      const size = Math.round(Math.min(box.width, box.height));
      if (size >= 44) return [];
      const name =
        element.getAttribute("aria-label") ||
        element.textContent?.trim() ||
        element.tagName;
      return [`${name} (${size}px)`];
    }),
  );
}

/** The text an ellipsis cuts inside the scope. */
export async function cutTexts(scope: Locator) {
  return scope.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>("*")]
      .filter(
        (element) =>
          element.getBoundingClientRect().width > 0 &&
          getComputedStyle(element).textOverflow === "ellipsis" &&
          element.scrollWidth > element.clientWidth,
      )
      .map((element) => element.textContent?.trim() ?? ""),
  );
}

/**
 * How many toolbar controls share each line of the toolbar row. A line of
 * one is a control that wrapped alone (the lone Filters or Sort).
 */
export async function toolbarLines(toolbar: Locator) {
  return toolbar.evaluate((section) => {
    const row = section.firstElementChild!;
    // The row aligns its controls at the bottom; bottoms within 6px share
    // a line.
    const lines: { bottom: number; count: number }[] = [];
    for (const part of row.children) {
      const box = part.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      const line = lines.find((item) => Math.abs(item.bottom - box.bottom) < 6);
      if (line) line.count += 1;
      else lines.push({ bottom: box.bottom, count: 1 });
    }
    return lines.map((line) => line.count);
  });
}
