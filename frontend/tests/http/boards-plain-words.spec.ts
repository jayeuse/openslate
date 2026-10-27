import { expect, test, type Page } from "./helpers/test";
import {
  board,
  boardId,
  installBoardDirectory,
  installPublishedPost,
  openPublishedPost,
} from "./helpers/boards-api";
import {
  ganttHref,
  installKanbanApi,
  kanbanHref,
  stageIds,
  wireCard,
} from "./helpers/board-kanban-api";
import {
  calendarHref,
  installCalendarApi,
  reviewEventId,
} from "./helpers/board-calendar-api";
import {
  installMyCalendarApi,
  myCalendarHref,
} from "./helpers/my-calendar-api";
import { pageOf } from "../helpers/pagination";

test.use({ trace: "off", screenshot: "off", video: "off" });

// The words on Boards screens are customer words (BR39, BF-30, the critique
// word rows; DESIGN.md Few Words Rule). Engineering words and retired names
// never show: "occurrences", widgets, Timeline (BR49: Gantt), purge words
// (BR27: Delete forever), server talk, and the access words of the removed
// preview. Common nouns are lower case inside a sentence: "this board",
// "linked records", "an event". "Boards" the workspace and "Board settings"
// start a label, so they never follow a lower-case word.

const BANNED =
  /\b(occurrences?|widgets?|timeline|board-level|permissions|purge|permanently delete|permanent deletion|with the server|to the server)\b/i;
const MID_SENTENCE_CAPITAL =
  /[a-z][,;:]?[  ]+(Boards?|Records?|Events?|Workspace)\b/;

/** The words of the page body and of what opens above it, with their names. */
function shownWords(page: Page) {
  return page.evaluate(() => {
    const roots = [
      document.querySelector("main#main-content"),
      ...document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"]',
      ),
    ].filter((root): root is HTMLElement => root instanceof HTMLElement);
    const words: string[] = [];
    for (const root of roots) {
      words.push(root.innerText);
      for (const node of [root, ...root.querySelectorAll("*")])
        for (const name of ["aria-label", "title", "aria-description"]) {
          const value = node.getAttribute(name);
          if (value) words.push(value);
        }
    }
    return words;
  });
}

async function expectPlainWords(page: Page, state: string) {
  const found = (await shownWords(page)).flatMap((text) =>
    text
      .split("\n")
      .filter((line) => BANNED.test(line) || MID_SENTENCE_CAPITAL.test(line)),
  );
  expect(found, state).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("Posts, Kanban, the card sheet, Gantt and All boards use plain words", async ({
  page,
}) => {
  const card = wireCard("Book the expo booth crew", stageIds.todo, 1024, {
    due_on: "2026-09-28",
  });
  await installKanbanApi(page, { level: "manage", cards: [card] });
  await installPublishedPost(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const row = page
    .getByRole("region", { name: "Posts", exact: true })
    .getByRole("button", { name: /^Use the new loading bay/ });
  await openPublishedPost(page, row);
  await expect(
    page.getByRole("article", { name: "Use the new loading bay" }),
  ).toBeVisible();
  await expectPlainWords(page, "Post view");

  await page.goto(kanbanHref());
  await expect(
    page.getByRole("button", {
      name: "Card actions for Book the expo booth crew",
    }),
  ).toBeVisible();
  await expectPlainWords(page, "Kanban");
  await page.goto(kanbanHref(`card=${card.id}`));
  const sheet = page.getByRole("dialog", {
    name: "Book the expo booth crew",
    exact: true,
  });
  await expect(
    sheet.getByRole("button", { name: "Move to stage" }),
  ).toBeVisible();
  await expectPlainWords(page, "Card sheet");
  await sheet.getByRole("tab", { name: "Linked records" }).click();
  await expect(
    sheet.getByRole("tabpanel", { name: "Linked records" }),
  ).toBeVisible();
  await expectPlainWords(page, "Card sheet linked records");

  await page.goto(ganttHref());
  await expect(
    page
      .getByRole("region", { name: "Gantt" })
      .getByRole("heading", { level: 3 })
      .first(),
  ).toBeVisible();
  await expectPlainWords(page, "Gantt");

  await installBoardDirectory(page);
  await page.goto("/boards?section=all");
  await expect(
    page.getByRole("link", { name: /^Fleet Reliability/ }).first(),
  ).toBeVisible();
  await expectPlainWords(page, "All boards");
});

test("Board settings uses plain words, and the purge reads Delete forever", async ({
  page,
}) => {
  await installKanbanApi(page, { level: "manage" });
  const archived = { ...board, status: "archived" };
  await page.route(`**/api/boards/${boardId}`, (route) =>
    route.fulfill({ json: archived }),
  );
  await page.route(`**/api/boards/${boardId}/groups`, (route) =>
    route.fulfill({ json: { board_id: boardId, revision: 1, groups: [] } }),
  );
  await page.route(`**/api/boards/${boardId}/preview-users?*`, (route) =>
    route.fulfill({ json: pageOf([], { limit: 25 }) }),
  );
  await page.route(`**/api/boards/${boardId}/activity?*`, (route) =>
    route.fulfill({ json: pageOf([], { limit: 25 }) }),
  );
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(
    page
      .getByRole("button", { name: "Archived", exact: true })
      .and(page.locator("[aria-describedby]")),
  ).toHaveAccessibleDescription("Archived boards are read-only.");
  await expectPlainWords(page, "Archived board");

  await page.goto(`/boards?board=${boardId}&section=posts&settings=details`);
  const sheet = page.getByRole("dialog").filter({
    has: page.getByRole("tablist", { name: "Board settings", exact: true }),
  });
  await sheet.getByRole("button", { name: /^Advanced/ }).click();
  await expect(sheet.getByRole("button", { name: /^Restore/ })).toBeVisible();
  await expectPlainWords(page, "Board settings Details");
  await expect(
    sheet.getByRole("button", { name: "Delete forever", exact: true }),
  ).toBeVisible();

  await sheet.getByRole("tab", { name: "Access", exact: true }).click();
  await expect(sheet.getByText(/^No groups yet\./)).toBeVisible();
  await expectPlainWords(page, "Board settings Access");
});

test("the calendars use plain words, archive dialog included", async ({
  page,
}) => {
  await installCalendarApi(page);
  await page.goto(calendarHref(`&event=${reviewEventId}`));
  const sheet = page.getByRole("dialog", { name: "Customer account review" });
  await expect(sheet).toBeVisible();
  await expectPlainWords(page, "Event sheet");
  await sheet.getByRole("button", { name: "More event actions" }).click();
  await page.getByRole("menuitem", { name: "Archive event" }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Archive event?" }),
  ).toBeVisible();
  await expectPlainWords(page, "Archive event dialog");
  await page.keyboard.press("Escape");

  await page.goto(calendarHref("&view=upcoming"));
  await expect(
    page.getByRole("button", { name: /^Customer account review/ }).first(),
  ).toBeVisible();
  await expectPlainWords(page, "Upcoming");

  await installMyCalendarApi(page);
  await page.goto(myCalendarHref());
  await expect(page.getByText("4 boards", { exact: true })).toBeVisible();
  await expectPlainWords(page, "My calendar");
});

test("a person with no board sees plain words", async ({ page }) => {
  await installKanbanApi(page, { level: "manage" });
  await page.route(
    (url) => url.pathname === "/api/boards",
    (route) => route.fulfill({ json: pageOf([], { limit: 25 }) }),
  );
  await page.goto("/boards");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/^No active boards$/i)).toBeVisible();
  await expectPlainWords(page, "No boards");
});
