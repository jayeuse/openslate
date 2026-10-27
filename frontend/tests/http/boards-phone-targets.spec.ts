import { expect, test, type Page } from "./helpers/test";
import {
  boardId,
  installBoardDirectory,
  installPublishedPost,
  openPublishedPost,
} from "./helpers/boards-api";
import {
  ganttHref,
  installKanbanApi,
  kanbanHref,
  labelIds,
  stageIds,
  wireCard,
} from "./helpers/board-kanban-api";
import { calendarHref, installCalendarApi } from "./helpers/board-calendar-api";
import {
  installMyCalendarApi,
  myCalendarHref,
} from "./helpers/my-calendar-api";
import { pageOf } from "../helpers/pagination";

test.use({ trace: "off", screenshot: "off", video: "off" });

// EXIT-2 at 390: every target a person can reach on a Boards screen is at
// least 44px both ways, and the document never scrolls sideways (the Gantt
// panel scrolls inside itself). Hidden and aria-hidden parts are not
// targets; Gantt bars are aria-hidden on phones (BR76).

type Small = { name: string; width: number; height: number };

/** Every reachable target under 44px, and whether the page scrolls sideways. */
function phoneProblems(page: Page) {
  return page.evaluate(() => {
    const selector = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "summary",
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="combobox"]',
      '[role^="menuitem"]',
      '[role="option"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    // The page body, plus the sheets, menus and lists that open in a portal.
    // The shell header and sidebar keep their own sizes (DESIGN.md Navigation).
    const roots = [
      document.querySelector("main#main-content"),
      ...document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"]',
      ),
    ].filter((root): root is Element => root !== null);
    const seen = new Set<Element>();
    const small: Small[] = [];
    for (const root of roots)
      for (const found of root.querySelectorAll(selector)) {
        if (seen.has(found)) continue;
        seen.add(found);
        if (found.closest('[aria-hidden="true"], [inert], [hidden]')) continue;
        let target: Element | null = found;
        let box = target.getBoundingClientRect();
        // A visually hidden input is reached through its label.
        if (box.width <= 1 && box.height <= 1) {
          target = found.closest("label");
          if (!target) continue;
          box = target.getBoundingClientRect();
        }
        if (box.width === 0 || box.height === 0) continue;
        if (getComputedStyle(target).visibility === "hidden") continue;
        if (box.width + 0.5 < 44 || box.height + 0.5 < 44)
          small.push({
            name: (
              target.getAttribute("aria-label") ??
              target.textContent ??
              target.tagName
            )
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, 48),
            width: Math.round(box.width),
            height: Math.round(box.height),
          });
      }
    const main = document.querySelector("main#main-content");
    return {
      small,
      across:
        document.documentElement.scrollWidth >
          document.documentElement.clientWidth ||
        (main !== null && main.scrollWidth > main.clientWidth),
    };
  });
}

async function expectPhoneTargets(page: Page, screen: string) {
  expect(await phoneProblems(page), screen).toEqual({
    small: [],
    across: false,
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test("Posts list and post view keep 44px targets at 390", async ({ page }) => {
  await installKanbanApi(page, { level: "manage" });
  await installPublishedPost(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const row = page
    .getByRole("region", { name: "Posts", exact: true })
    .getByRole("button", { name: /^Use the new loading bay/ });
  await expect(row).toBeVisible();
  await expectPhoneTargets(page, "Posts list");
  await openPublishedPost(page, row);
  const post = page.getByRole("article", {
    name: "Use the new loading bay",
    exact: true,
  });
  await expect(
    post.getByRole("button", { name: "Back to posts", exact: true }),
  ).toBeVisible();
  await expect(post.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expectPhoneTargets(page, "Post view");
});

test("Calendar Month, Week day list and Upcoming keep 44px targets at 390", async ({
  page,
}) => {
  await installCalendarApi(page);
  for (const [view, item] of [
    ["month", "Logistics expo"],
    ["week", "Logistics expo"],
    ["upcoming", "Customer account review"],
  ] as const) {
    await page.goto(calendarHref(`&view=${view}`));
    await expect(
      page.getByRole("button", { name: new RegExp(`^${item}`) }).first(),
    ).toBeVisible();
    await expectPhoneTargets(page, `Calendar ${view}`);
  }
});

test("My calendar keeps 44px targets at 390", async ({ page }) => {
  await installMyCalendarApi(page);
  await page.goto(myCalendarHref());
  await expect(
    page
      .getByRole("region", { name: "Selected day" })
      .getByRole("button", { name: /^Forklift breakdown review,/ }),
  ).toBeVisible();
  await expectPhoneTargets(page, "My calendar");
});

test("Kanban and its card sheet keep 44px targets at 390", async ({ page }) => {
  const card = wireCard("Book the expo booth crew", stageIds.todo, 1024, {
    due_on: "2026-09-28",
    label_ids: [labelIds.expo],
  });
  await installKanbanApi(page, { level: "write", cards: [card] });
  await page.goto(kanbanHref());
  await expect(
    page.getByRole("button", {
      name: "Card actions for Book the expo booth crew",
    }),
  ).toBeVisible();
  await expectPhoneTargets(page, "Kanban");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Filters", exact: true })
      .getByRole("checkbox", { name: "Expo" }),
  ).toBeAttached();
  await expectPhoneTargets(page, "Kanban filters");
  await page.keyboard.press("Escape");
  await page.goto(kanbanHref(`card=${card.id}`));
  await expect(
    page
      .getByRole("dialog", { name: "Book the expo booth crew", exact: true })
      .getByRole("button", { name: "Move to stage" }),
  ).toBeVisible();
  await expectPhoneTargets(page, "Kanban card sheet");
});

test("Gantt keeps 44px targets at 390, and only its panel scrolls sideways", async ({
  page,
}) => {
  await installKanbanApi(page, {
    level: "write",
    cards: [
      wireCard("Book the expo booth crew", stageIds.todo, 1024, {
        start_on: "2026-09-14",
        due_on: "2026-09-18",
        label_ids: [labelIds.expo],
      }),
      wireCard("Plan the Q4 reviews", stageIds.todo, 2048),
    ],
  });
  await page.goto(ganttHref());
  await expect(
    page
      .getByRole("region", { name: "Gantt" })
      .getByRole("button", { name: /^Book the expo booth crew/ }),
  ).toBeVisible();
  await expectPhoneTargets(page, "Gantt");
});

test("Board settings keeps 44px targets at 390 on each tab", async ({
  page,
}) => {
  await installKanbanApi(page, { level: "manage" });
  const groupId = "00000000-0000-4000-8000-00000000d801";
  await page.route(`**/api/boards/${boardId}/groups`, (route) =>
    route.fulfill({
      json: {
        board_id: boardId,
        revision: 1,
        groups: [{ group_id: groupId, name: "Dispatch leads", level: "write" }],
      },
    }),
  );
  await page.route("**/api/access/groups?*", (route) =>
    route.fulfill({
      json: pageOf([{ id: groupId, name: "Dispatch leads" }], { limit: 25 }),
    }),
  );
  await page.route(`**/api/boards/${boardId}/preview-users?*`, (route) =>
    route.fulfill({ json: pageOf([], { limit: 25 }) }),
  );
  await page.route(`**/api/boards/${boardId}/activity?*`, (route) =>
    route.fulfill({
      json: pageOf(
        [
          {
            id: "00000000-0000-4000-8000-00000000d802",
            created_at: "2026-09-24T09:30:00Z",
            kind: "board",
            action: "update",
            summary: "Board updated",
            actor_label: "ho-admin",
            group: null,
          },
        ],
        { limit: 25 },
      ),
    }),
  );
  const sheet = page.getByRole("dialog").filter({
    has: page.getByRole("tablist", { name: "Board settings", exact: true }),
  });
  await page.goto(`/boards?board=${boardId}&section=posts&settings=details`);
  await sheet.getByRole("button", { name: /^Advanced/ }).click();
  await expect(
    sheet.getByRole("button", { name: /^Archive/ }).first(),
  ).toBeVisible();
  await expectPhoneTargets(page, "Board settings Details");
  await sheet.getByRole("tab", { name: "Access", exact: true }).click();
  await expect(sheet.getByText("Dispatch leads").first()).toBeVisible();
  await expect(
    sheet.getByRole("combobox", { name: "Add a group" }),
  ).toBeVisible();
  await expectPhoneTargets(page, "Board settings Access");
  await sheet.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(
    sheet.getByRole("list", { name: "Board activity", exact: true }),
  ).toBeVisible();
  await expectPhoneTargets(page, "Board settings Activity");
});

test("All boards keeps 44px targets at 390", async ({ page }) => {
  await installKanbanApi(page, { level: "manage" });
  await installBoardDirectory(page);
  await page.goto("/boards?section=all");
  await expect(
    page.getByRole("link", { name: /^Fleet Reliability/ }).first(),
  ).toBeVisible();
  await expectPhoneTargets(page, "All boards");
});
