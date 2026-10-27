import { expect, test, type Page } from "./helpers/test";
import {
  installKanbanApi,
  kanbanHref,
  labelIds,
  lockedCard,
  peopleIds,
  recordIds,
  stageIds,
  wireCard,
  wireStage,
} from "./helpers/board-kanban-api";

test.use({ trace: "off", screenshot: "off", video: "off" });

function documentScrolls(page: Page) {
  return page.evaluate(() => ({
    down: document.documentElement.scrollHeight > window.innerHeight + 1,
    across: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
}

const board = (page: Page) =>
  page.getByRole("region", { name: "Kanban board" });
const stage = (page: Page, name: string) =>
  board(page).getByRole("region", { name, exact: true });

/** A pointer drag that dnd-kit sees: down, past its 5px start, then up. */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.move(to.x, to.y + 2, { steps: 2 });
  await page.mouse.up();
}

test("a manager sets up stages from the empty board, adds, renames, limits and archives one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installKanbanApi(page, { stages: [] });
  await page.goto(kanbanHref());
  await expect(
    page.getByRole("link", { name: "Kanban", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("button", { name: "Start with To do · Doing · Done" })
    .click();
  await expect(stage(page, "To do")).toBeVisible();
  await expect(stage(page, "Doing")).toBeVisible();
  await expect(stage(page, "Done")).toBeVisible();
  expect(
    api.writes
      .filter((write) => write.path === "/stages")
      .map((write) => write.body),
  ).toEqual([
    { name: "To do", color: "chart-1" },
    // Not amber: amber is the WIP warn color.
    { name: "Doing", color: "chart-4" },
    { name: "Done", color: "chart-3" },
  ]);

  await board(page).getByRole("button", { name: "Add a stage" }).click();
  await page.getByRole("textbox", { name: "Stage name" }).fill("Blocked");
  await page.getByRole("textbox", { name: "Stage name" }).press("Enter");
  await expect(stage(page, "Blocked")).toBeVisible();

  await page
    .getByRole("button", { name: /^Blocked, 0 cards\. Stage settings$/ })
    .click();
  const settings = page.getByRole("dialog", { name: "Blocked stage" });
  await settings.getByRole("textbox", { name: "Name" }).fill("Waiting");
  await settings.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(stage(page, "Waiting")).toBeVisible();
  // The settings title follows the new name.
  const renamed = page.getByRole("dialog", { name: "Waiting stage" });
  // A swatch is the label of its radio, named beside its color (BR69).
  await renamed.getByTitle("Purple", { exact: true }).click();
  await expect(renamed.getByRole("radio", { name: "Purple" })).toBeChecked();
  await renamed.getByRole("spinbutton", { name: "WIP limit" }).fill("4");
  await renamed.getByRole("spinbutton", { name: "WIP limit" }).press("Enter");
  await expect(
    page.getByRole("button", {
      name: /^Waiting, 0 cards, limit 4\. Stage settings$/,
    }),
  ).toBeVisible();
  await renamed.getByRole("button", { name: "Move left" }).click();
  await expect
    .poll(
      () => api.writes.filter((write) => write.path === "/stages/order").length,
    )
    .toBe(1);
  expect(
    api.writes.find((write) => write.path === "/stages/order")?.body,
  ).toEqual({
    stage_ids: [0, 1, 3, 2].map((index) => api.stages[index].id),
  });

  await renamed.getByRole("button", { name: "Archive stage…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Archive Waiting?" });
  await confirm.getByRole("button", { name: "Archive stage" }).click();
  await expect(stage(page, "Waiting")).toHaveCount(0);
  expect(api.writes.at(-1)).toMatchObject({
    method: "POST",
    body: { cards: "move", target_stage_id: api.stages[0].id },
  });
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });
});

test("a writer adds a card and moves it by drag with Undo; nothing else changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [
      wireCard("Book the expo booth crew", stageIds.todo, 1024, {
        label_ids: [labelIds.expo],
        due_on: "2026-09-20",
        checklist: { done: 1, total: 3 },
        assignee_id: peopleIds.ana,
      }),
      wireCard("Renewal terms", stageIds.doing, 1024),
    ],
  });
  await page.goto(kanbanHref());
  // Writers see stage headers as text, with no stage menu.
  await expect(
    board(page).getByRole("button", { name: /Stage settings/ }),
  ).toHaveCount(0);
  await expect(
    board(page).getByRole("button", { name: "Add a stage" }),
  ).toHaveCount(0);
  const crew = stage(page, "To do").getByRole("button", {
    name: /^Book the expo booth crew, objective/,
  });
  await expect(crew).toContainText("Expo");
  await expect(crew).toContainText("Overdue · Sep 20");
  await expect(crew).toContainText("1/3");

  await stage(page, "To do")
    .getByRole("button", { name: "Add a card" })
    .click();
  await page
    .getByRole("textbox", { name: "Card title" })
    .fill("Order giveaways");
  await page.getByRole("button", { name: "Add card", exact: true }).click();
  await expect(
    stage(page, "To do").getByRole("button", {
      name: /^Order giveaways, objective/,
    }),
  ).toBeVisible();
  expect(api.writes.at(-1)).toEqual({
    method: "POST",
    path: "/cards",
    body: {
      kind: "objective",
      stage_id: stageIds.todo,
      title: "Order giveaways",
    },
  });
  await page.keyboard.press("Escape");

  const from = await crew.boundingBox();
  const target = await stage(page, "Doing")
    .getByRole("button", { name: /^Renewal terms, objective/ })
    .boundingBox();
  await drag(
    page,
    { x: from!.x + 40, y: from!.y + 20 },
    { x: target!.x + 40, y: target!.y + target!.height - 4 },
  );
  const toast = page.getByText("Moved to Doing");
  await expect(toast).toBeVisible();
  const move = api.writes.find((write) => write.method === "PATCH");
  expect(move?.body).toEqual({
    revision: 1,
    stage_id: stageIds.doing,
  });
  await expect(
    stage(page, "Doing").getByRole("button", {
      name: /^Book the expo booth crew/,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    stage(page, "To do").getByRole("button", {
      name: /^Book the expo booth crew/,
    }),
  ).toBeVisible();
  const undo = api.writes.filter((write) => write.method === "PATCH").at(-1);
  expect(undo?.body).toEqual({
    revision: 2,
    stage_id: stageIds.todo,
    position: 0,
  });
  // Only card PATCHes and the one POST: no record, stage or label write.
  expect(
    api.writes.map((write) => `${write.method} ${write.path.split("/")[1]}`),
  ).toEqual(["POST cards", "PATCH cards", "PATCH cards"]);
});

test("Find a record adds a record card whose dates come from the record", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installKanbanApi(page, { level: "write" });
  await page.goto(kanbanHref());
  await stage(page, "Doing")
    .getByRole("button", { name: "Add a card" })
    .click();
  await page.getByRole("button", { name: "Find a record" }).click();
  await page.getByRole("searchbox", { name: "Find a record" }).fill("Q-241");
  await page.getByRole("button", { name: "Q-24112, Quotes" }).click();
  await expect(page.getByRole("combobox", { name: "Start" })).toHaveValue(
    recordIds.validFrom,
  );
  await expect(page.getByRole("combobox", { name: "Due" })).toHaveValue(
    recordIds.validUntil,
  );
  await page.getByRole("button", { name: "Add card", exact: true }).click();
  const card = stage(page, "Doing").getByRole("button", {
    name: /^Q-24112, Quotes record/,
  });
  await expect(card).toContainText("Pacific Rim Foods");
  await expect(card).toContainText("Sent");
  expect(api.writes.at(-1)?.body).toEqual({
    kind: "record",
    stage_id: stageIds.doing,
    record_id: recordIds.quote,
    start_on: "2026-09-20",
    due_on: "2026-10-13",
  });
});

test("a reader sees the board read-only; opening a card opens its sheet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installKanbanApi(page, {
    level: "read",
    cards: [wireCard("Renewal terms", stageIds.doing, 1024)],
  });
  await page.goto(kanbanHref());
  await expect(stage(page, "Doing")).toBeVisible();
  await expect(
    board(page).getByRole("button", { name: "Add a card" }),
  ).toHaveCount(0);
  await expect(
    board(page).getByRole("button", { name: "Add a stage" }),
  ).toHaveCount(0);
  await expect(
    board(page).getByRole("button", { name: /Card actions/ }),
  ).toHaveCount(0);
  await stage(page, "Doing")
    .getByRole("button", { name: /^Renewal terms, objective/ })
    .click();
  const summary = page.getByRole("dialog", { name: "Renewal terms" });
  await expect(summary).toContainText("Doing");
  await expect(page).toHaveURL(/card=/);
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/card=/);

  // Filters are the viewer's own and live in the URL.
  await page.getByRole("searchbox", { name: "Search cards" }).fill("nothing");
  await expect(page).toHaveURL(/search=nothing/);
  await expect(
    stage(page, "Doing").getByRole("button", { name: /objective/ }),
  ).toHaveCount(0);
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });
});

test("a locked record card keeps its place with no name; a writer moves it from its menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [lockedCard(stageIds.todo, 1024)],
  });
  await page.goto(kanbanHref());
  const locked = stage(page, "To do").getByRole("group", {
    name: "No access to this record",
  });
  await expect(locked).toBeVisible();
  await expect(
    locked.getByRole("button", { name: /objective|record,/ }),
  ).toHaveCount(0);
  await locked
    .getByRole("button", { name: "Card actions for No access to this record" })
    .click();
  await page.getByRole("menuitemradio", { name: "Done" }).click();
  await expect(
    stage(page, "Done").getByRole("group", {
      name: "No access to this record",
    }),
  ).toBeVisible();
  expect(api.writes.at(-1)?.body).toEqual({
    revision: 1,
    stage_id: stageIds.done,
  });
});

test("Space lifts a card, arrows move it, Space drops it; the live region says each step", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [
      wireCard("Book the expo booth crew", stageIds.todo, 1024),
      wireCard("Renewal terms", stageIds.doing, 1024),
    ],
  });
  await page.goto(kanbanHref());
  const crew = stage(page, "To do").getByRole("button", {
    name: /^Book the expo booth crew, objective/,
  });
  await crew.focus();
  await page.keyboard.press("Space");
  const live = page.getByRole("status").filter({ hasText: "Lifted" });
  await expect(live).toHaveText(
    "Lifted Book the expo booth crew. To do, position 1 of 1. Arrow keys move it, Space drops it, Escape cancels.",
  );
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Doing, position 1 of 2.")).toBeAttached();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(
    page.getByText(
      "Dropped Book the expo booth crew in Doing, position 2 of 2.",
    ),
  ).toBeAttached();
  await expect(page.getByText("Moved to Doing")).toBeVisible();
  expect(api.writes.at(-1)?.body).toEqual({
    revision: 1,
    stage_id: stageIds.doing,
  });
  // Focus stays on the moved card.
  await expect(
    stage(page, "Doing").getByRole("button", {
      name: /^Book the expo booth crew/,
    }),
  ).toBeFocused();

  // Escape puts a lifted card back.
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Escape");
  await expect(
    page.getByText("Move cancelled. Book the expo booth crew stays in Doing."),
  ).toBeAttached();
  expect(api.writes.filter((write) => write.method === "PATCH")).toHaveLength(
    1,
  );
});

test("over its WIP limit a stage reads 6 / 5 in warn; a long stage pages by 25", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cards = [
    ...Array.from({ length: 6 }, (_, index) =>
      wireCard(`Waiting card ${index + 1}`, stageIds.doing, (index + 1) * 1024),
    ),
    ...Array.from({ length: 41 }, (_, index) =>
      wireCard(`Done card ${index + 1}`, stageIds.done, (index + 1) * 1024),
    ),
  ];
  await installKanbanApi(page, {
    stages: [
      wireStage(stageIds.todo, "To do", 0),
      wireStage(stageIds.doing, "Doing", 1, { wip_limit: 5 }),
      wireStage(stageIds.done, "Done", 2),
    ],
    cards,
  });
  await page.goto(kanbanHref());
  const header = page.getByRole("button", {
    name: "Doing, 6 cards, over its limit of 5. Stage settings",
  });
  await expect(header).toContainText("6 / 5");
  await expect(header).toHaveAttribute("data-over", "");
  const done = stage(page, "Done");
  // The page stays still: the board ends inside the window, and only the
  // long stage scrolls, with its page line and Add a card in view.
  await expect(done.getByText("25 of 41")).toBeInViewport();
  await expect(
    done.getByRole("button", { name: "Add a card" }),
  ).toBeInViewport();
  const surface = await board(page).boundingBox();
  expect(surface!.y + surface!.height).toBeLessThanOrEqual(900);
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });
  await expect(done.getByRole("button", { name: /^Done card/ })).toHaveCount(
    25,
  );
  await done.getByRole("button", { name: "Show 16 more" }).click();
  await expect(done.getByRole("button", { name: /^Done card/ })).toHaveCount(
    41,
  );
});

test("a move another person beat says so and reads the board again", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [wireCard("Book the expo booth crew", stageIds.todo, 1024)],
  });
  await page.goto(kanbanHref());
  const crew = stage(page, "To do").getByRole("button", {
    name: /^Book the expo booth crew, objective/,
  });
  await expect(crew).toBeVisible();
  const reads = api.cardReads;
  api.staleNext = true;
  await page
    .getByRole("button", { name: "Card actions for Book the expo booth crew" })
    .click();
  await page.getByRole("menuitemradio", { name: "Done" }).click();
  await expect(
    page.getByRole("heading", { name: "Someone changed this card first." }),
  ).toBeVisible();
  await expect.poll(() => api.cardReads).toBeGreaterThan(reads);
  await expect(
    stage(page, "To do").getByRole("button", {
      name: /^Book the expo booth crew/,
    }),
  ).toBeVisible();
});

test("on a phone one stage shows at a time, with a switcher and Move to stage", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [
      wireCard("Book the expo booth crew", stageIds.todo, 1024),
      wireCard("Renewal terms", stageIds.doing, 1024),
      wireCard("Price list", stageIds.doing, 2048),
    ],
  });
  await page.goto(kanbanHref());
  const switcher = page.getByRole("navigation", { name: "Stages" });
  await expect(
    switcher.getByRole("button", { name: "To do, 1 card" }),
  ).toHaveAttribute("aria-current", "true");
  await expect(stage(page, "Doing")).toHaveCount(0);
  const doing = switcher.getByRole("button", { name: "Doing, 2 cards" });
  const box = await doing.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await doing.click();
  await expect(stage(page, "Doing")).toBeVisible();
  await expect(stage(page, "To do")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Card actions for Price list" })
    .click();
  await page.getByRole("menuitemradio", { name: "To do" }).click();
  await expect(page.getByText("Moved to To do")).toBeVisible();
  expect(api.writes.at(-1)?.body).toEqual({
    revision: 1,
    stage_id: stageIds.todo,
  });
  expect(await documentScrolls(page)).toMatchObject({ across: false });
});

test("on a phone Filters opens a sheet with Labels and Due, and the board follows each choice", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installKanbanApi(page, {
    level: "write",
    cards: [
      wireCard("Book the expo booth crew", stageIds.todo, 1024, {
        label_ids: [labelIds.expo],
      }),
      wireCard("Price list", stageIds.todo, 2048, {
        label_ids: [labelIds.pricing],
      }),
    ],
  });
  await page.goto(kanbanHref());
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "Filters", exact: true });
  // The 44px row is the target; the box inside is drawn, not native.
  await filters.getByText("Expo", { exact: true }).click();
  await expect(
    filters.getByRole("checkbox", { name: "Expo", exact: true }),
  ).toBeChecked();
  await expect(page).toHaveURL(new RegExp(`label=${labelIds.expo}`));
  await filters.getByLabel("Due", { exact: true }).selectOption("overdue");
  await expect(page).toHaveURL(/due=overdue/);
  const heights = await filters.evaluate((root) =>
    [...root.querySelectorAll("button, select, label:has(input)")].map(
      (node) => node.getBoundingClientRect().height,
    ),
  );
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
  await filters.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(page).not.toHaveURL(/label=|due=/);
  await page.keyboard.press("Escape");
  await expect(stage(page, "To do")).toContainText("Price list");
  expect(await documentScrolls(page)).toMatchObject({ across: false });
});

test("a lifted card is put back when focus leaves it, so another card can be lifted", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [
      wireCard("Book the expo booth crew", stageIds.todo, 1024),
      wireCard("Renewal terms", stageIds.doing, 1024),
    ],
  });
  await page.goto(kanbanHref());
  const crew = stage(page, "To do").getByRole("button", {
    name: /^Book the expo booth crew, objective/,
  });
  await crew.focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByText(/^Lifted Book the expo booth crew/),
  ).toBeAttached();
  // Its own menu button keeps the lift; the next card does not.
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", {
      name: "Card actions for Book the expo booth crew",
    }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByText("Move cancelled. Book the expo booth crew stays in To do."),
  ).toBeAttached();
  // Focus went on to the stage's Add a card; any other card lifts now.
  await expect(
    stage(page, "To do").getByRole("button", { name: "Add a card" }),
  ).toBeFocused();
  await stage(page, "Doing")
    .getByRole("button", { name: /^Renewal terms/ })
    .focus();
  await page.keyboard.press("Space");
  await expect(page.getByText(/^Lifted Renewal terms/)).toBeAttached();
  expect(api.writes).toEqual([]);
});

test("stages keep a readable width, and Add a card follows the last card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installKanbanApi(page, {
    level: "write",
    cards: [wireCard("Book the expo booth crew", stageIds.todo, 1024)],
  });
  await page.goto(kanbanHref());
  const todo = stage(page, "To do");
  // Three stages at 1440 stop at 17rem, not a third of the board each.
  const width = (await todo.boundingBox())!.width;
  expect(width).toBeLessThanOrEqual(272 + 1);
  const last = await todo
    .getByRole("button", { name: /^Book the expo booth crew/ })
    .boundingBox();
  const add = await todo
    .getByRole("button", { name: "Add a card" })
    .boundingBox();
  // On a short stage the block sits under the last card, not at the foot.
  expect(add!.y - (last!.y + last!.height)).toBeGreaterThanOrEqual(0);
  expect(add!.y - (last!.y + last!.height)).toBeLessThan(24);
});
