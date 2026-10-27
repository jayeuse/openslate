import { expect, test, type Page } from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { boardId } from "./helpers/boards-api";
import {
  ganttHref,
  installKanbanApi,
  labelIds,
  lockedCard,
  quoteRecordSummary,
  stageIds,
  wireCard,
  type WireCard,
} from "./helpers/board-kanban-api";

test.use({ trace: "off", screenshot: "off", video: "off" });

// The workspace day is Fri Sep 25, 2026. Month zoom shows Aug 31 – Oct 4.

function documentScrolls(page: Page) {
  return page.evaluate(() => ({
    down: document.documentElement.scrollHeight > window.innerHeight + 1,
    across: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
}

const gantt = (page: Page) => page.getByRole("region", { name: "Gantt" });
const bar = (page: Page, name: RegExp) =>
  gantt(page).getByRole("button", { name });
const batches = (api: { writes: { path: string; body: unknown }[] }) =>
  api.writes
    .filter((write) => write.path === "/cards/batch-dates")
    .map((write) => write.body);

function boardCards() {
  const booth = wireCard("Book the expo booth crew", stageIds.todo, 1024, {
    start_on: "2026-09-14",
    due_on: "2026-09-18",
    label_ids: [labelIds.expo],
    checklist: { done: 1, total: 2 },
  });
  const price = wireCard("Update the price list", stageIds.doing, 1024, {
    start_on: "2026-09-07",
    due_on: "2026-09-21",
    label_ids: [labelIds.pricing],
  });
  const quote = wireCard(null, stageIds.doing, 2048, {
    kind: "record",
    record: quoteRecordSummary,
    start_on: "2026-09-16",
    due_on: "2026-09-24",
  });
  const callback = wireCard("Call back Pacific Rim", stageIds.todo, 2048, {
    due_on: "2026-09-28",
  });
  const plan = wireCard("Plan the Q4 reviews", stageIds.todo, 3072);
  const locked: WireCard = {
    ...lockedCard(stageIds.doing, 3072),
    start_on: "2026-09-10",
    due_on: "2026-09-12",
  };
  return { booth, price, quote, callback, plan, locked };
}

/** A pointer drag along the axis: down, past the 4px start, then up. */
async function dragBy(page: Page, from: { x: number; y: number }, dx: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y, { steps: 3 });
  await page.mouse.move(from.x + dx, from.y, { steps: 10 });
  await page.mouse.up();
}

test("a writer drags a bar; its old place shows dashed until Save changes sends it, and the page stays still", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cards = boardCards();
  const api = await installKanbanApi(page, {
    level: "write",
    cards: Object.values(cards),
  });
  await page.goto(ganttHref("zoom=month"));
  await expect(
    page.getByRole("link", { name: "Gantt", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "September 2026" }),
  ).toBeVisible();
  await expect(gantt(page).getByRole("heading", { level: 3 })).toHaveText([
    "To do 2",
    "Doing 3",
    "Unscheduled 1",
  ]);
  await expect(
    gantt(page)
      .getByRole("list", { name: "Labels in use" })
      .getByRole("listitem"),
  ).toHaveText(["Expo", "Pricing"]);
  await expect(gantt(page).getByText("6 cards · 1 unscheduled")).toBeVisible();
  // A record card's name carries the record icon; its bar has no checklist.
  await expect(bar(page, /^Q-24112, Sep 16 to Sep 24$/)).toBeVisible();

  const booth = bar(
    page,
    /^Book the expo booth crew, Sep 14 to Sep 18, checklist 1 of 2 done$/,
  );
  const box = await booth.boundingBox();
  if (!box) throw new Error("The bar has no box");
  const day = box.width / 5;
  await dragBy(
    page,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    2 * day,
  );
  await expect(
    bar(page, /^Book the expo booth crew, Sep 16 to Sep 20/),
  ).toBeVisible();
  await expect(page.getByTestId("gantt-was")).toHaveCount(1);
  await expect(
    page.getByText("1 unsaved change", { exact: true }),
  ).toBeVisible();
  expect(batches(api)).toEqual([]);

  // Only the panel scrolls, with the save bar showing (EXIT-1).
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeInViewport();
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("1 unsaved change", { exact: true })).toHaveCount(
    0,
  );
  expect(batches(api)).toEqual([
    {
      items: [
        {
          card_id: cards.booth.id,
          revision: 1,
          start_on: "2026-09-16",
          due_on: "2026-09-20",
        },
      ],
    },
  ]);
  await expect(page.getByTestId("gantt-was")).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "Dates saved." }),
  ).toHaveCount(1);
  await expect(
    bar(page, /^Book the expo booth crew, Sep 16 to Sep 20/),
  ).toBeVisible();
});

test("dragging a bar's end changes only its due date; Discard puts it back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cards = boardCards();
  const api = await installKanbanApi(page, {
    level: "write",
    cards: Object.values(cards),
  });
  await page.goto(ganttHref("zoom=month"));
  const booth = bar(page, /^Book the expo booth crew, Sep 14 to Sep 18/);
  const end = async () => {
    const box = await booth.boundingBox();
    if (!box) throw new Error("The bar has no box");
    return { box, at: { x: box.x + box.width - 2, y: box.y + box.height / 2 } };
  };
  const first = await end();
  await dragBy(page, first.at, 3 * (first.box.width / 5));
  await expect(
    bar(page, /^Book the expo booth crew, Sep 14 to Sep 21/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(
    bar(page, /^Book the expo booth crew, Sep 14 to Sep 18/),
  ).toBeVisible();
  await expect(page.getByText("1 unsaved change", { exact: true })).toHaveCount(
    0,
  );

  const again = await end();
  await dragBy(page, again.at, 3 * (again.box.width / 5));
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("1 unsaved change", { exact: true })).toHaveCount(
    0,
  );
  expect(batches(api)).toEqual([
    {
      items: [
        {
          card_id: cards.booth.id,
          revision: 1,
          start_on: "2026-09-14",
          due_on: "2026-09-21",
        },
      ],
    },
  ]);
});

test("arrows move a focused bar a day and Shift+arrows its due date; a live change and leaving keep the staged change", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installOpenViewEventSource(page);
  const cards = boardCards();
  const api = await installKanbanApi(page, {
    level: "write",
    cards: Object.values(cards),
  });
  await page.goto(ganttHref("zoom=month"));
  await sendOpenViewEvent(page, "resync");
  const live = page.getByRole("status").filter({ hasText: /unsaved/ });
  await bar(page, /^Book the expo booth crew, Sep 14 to Sep 18/).focus();
  await page.keyboard.press("ArrowRight");
  await expect(live).toHaveText(
    "Book the expo booth crew: Sep 15 to Sep 19. 1 unsaved change.",
  );
  await page.keyboard.press("Shift+ArrowRight");
  await expect(live).toHaveText(
    "Book the expo booth crew: Sep 15 to Sep 20. 1 unsaved change.",
  );
  await expect(
    bar(page, /^Book the expo booth crew, Sep 15 to Sep 20/),
  ).toBeFocused();

  // Another viewer renames a card: the Gantt reads it, the change stays.
  const price = api.cards.find((item) => item.id === cards.price.id);
  if (!price) throw new Error("No price card");
  price.title = "Update the Q4 price list";
  price.revision += 1;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "board_cards",
    board_id: boardId,
  });
  await expect(
    bar(page, /^Update the Q4 price list, Sep 7 to Sep 21/),
  ).toBeVisible();
  await expect(
    page.getByText("1 unsaved change", { exact: true }),
  ).toBeVisible();

  // Leaving with a staged change asks first.
  await page.getByRole("link", { name: "Kanban", exact: true }).click();
  const leave = page.getByRole("alertdialog", {
    name: "Discard unsaved Board changes?",
  });
  await expect(
    leave.getByText("Your staged date changes on the Gantt will be lost."),
  ).toBeVisible();
  await leave.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/section=gantt/);

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("1 unsaved change", { exact: true })).toHaveCount(
    0,
  );
  expect(batches(api)).toEqual([
    {
      items: [
        {
          card_id: cards.booth.id,
          revision: 1,
          start_on: "2026-09-15",
          due_on: "2026-09-20",
        },
      ],
    },
  ]);
});

test("a card another person changed first says so and shows its latest dates; the others save", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cards = boardCards();
  const api = await installKanbanApi(page, {
    level: "write",
    cards: Object.values(cards),
  });
  await page.goto(ganttHref("zoom=month"));
  await bar(page, /^Book the expo booth crew, Sep 14 to Sep 18/).focus();
  await page.keyboard.press("ArrowRight");
  await bar(page, /^Update the price list, Sep 7 to Sep 21/).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByText("2 unsaved changes", { exact: true }),
  ).toBeVisible();
  api.staleDates.add(cards.price.id);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Someone changed" }),
  ).toHaveText("Update the price list: Someone changed this card first.");
  // The changed card is read again; the saved one keeps its new place.
  await expect(
    bar(page, /^Update the price list, Sep 21 to Sep 23$/),
  ).toBeVisible();
  await expect(
    bar(page, /^Book the expo booth crew, Sep 15 to Sep 19/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(
    0,
  );
  // The next change clears the last save's results.
  await bar(page, /^Update the price list, Sep 21 to Sep 23$/).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("alert").filter({ hasText: "Someone changed" }),
  ).toHaveCount(0);
});

test("Unscheduled lists undated cards; Add dates opens the card sheet on its start date", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cards = boardCards();
  const api = await installKanbanApi(page, {
    level: "write",
    cards: Object.values(cards),
  });
  await page.goto(ganttHref("zoom=month"));
  await expect(
    gantt(page).getByText("No dates", { exact: true }),
  ).toBeVisible();
  await gantt(page)
    .getByRole("button", { name: "Add dates to Plan the Q4 reviews" })
    .click();
  const sheet = page.getByRole("dialog", {
    name: "Plan the Q4 reviews",
    exact: true,
  });
  await expect(sheet.getByLabel("Start", { exact: true })).toBeFocused();
  await sheet.getByLabel("Start", { exact: true }).fill("2026-09-28");
  await sheet.getByLabel("Start", { exact: true }).press("Enter");
  await expect(sheet.getByRole("status")).toHaveText("Start saved.");
  expect(
    api.writes.find((write) => write.path === `/cards/${cards.plan.id}`)?.body,
  ).toEqual({ revision: 1, start_on: "2026-09-28" });
  await sheet.getByRole("button", { name: "Close card" }).click();
  await expect(bar(page, /^Plan the Q4 reviews, Sep 28$/)).toBeVisible();
  await expect(
    gantt(page).getByRole("heading", { name: /^Unscheduled/ }),
  ).toHaveCount(0);
});

test("a reader sees the quarter read-only: no handles, no Add dates, a bar opens the card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cards = boardCards();
  const api = await installKanbanApi(page, {
    level: "read",
    cards: Object.values(cards),
  });
  await page.goto(ganttHref());
  await expect(page.getByRole("heading", { name: "Q3 2026" })).toBeVisible();
  await page.getByRole("button", { name: "Next quarter" }).click();
  await expect(page.getByRole("heading", { name: "Q4 2026" })).toBeVisible();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Q3 2026" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Quarter", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  for (const month of ["July", "August", "September"])
    await expect(gantt(page).getByText(month, { exact: true })).toBeVisible();
  await expect(page.locator("[data-gantt-resize]")).toHaveCount(0);
  await expect(
    gantt(page).getByRole("button", { name: /^Add dates/ }),
  ).toHaveCount(0);
  // A locked card keeps its row with no name and nothing to open.
  await expect(gantt(page).getByText("No access to this record")).toBeVisible();
  await expect(
    gantt(page).getByRole("button", { name: /No access to this record/ }),
  ).toHaveCount(0);

  const booth = bar(page, /^Book the expo booth crew, Sep 14 to Sep 18/);
  await booth.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText(/unsaved change/)).toHaveCount(0);
  await booth.click();
  await expect(
    page.getByRole("dialog", { name: "Book the expo booth crew", exact: true }),
  ).toBeVisible();
  expect(batches(api)).toEqual([]);
});

test("Group by Label draws a group per label with its summary, kept in the address", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cards = boardCards();
  await installKanbanApi(page, { level: "write", cards: Object.values(cards) });
  await page.goto(ganttHref("zoom=month"));
  await page.getByRole("button", { name: "Group by: Stage" }).click();
  await page.getByRole("menuitemradio", { name: "Label" }).click();
  await expect(page).toHaveURL(/group=label/);
  await expect(page).toHaveURL(/zoom=month/);
  await expect(gantt(page).getByRole("heading", { level: 3 })).toHaveText([
    "Expo 1",
    "Pricing 1",
    "No label 3",
    "Unscheduled 1",
  ]);
  await expect(
    gantt(page).getByRole("img", {
      name: "Expo, Sep 14 to Sep 18, 50% of the checklist done",
    }),
  ).toBeVisible();
  await expect(
    gantt(page).getByRole("img", { name: /^No label, Sep 10 to Sep 28$/ }),
  ).toBeVisible();
});

test("on a phone the bars stay, only the panel scrolls sideways, and a tap on a row opens its card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const cards = boardCards();
  await installKanbanApi(page, { level: "write", cards: Object.values(cards) });
  await page.goto(ganttHref());
  await expect(
    page.getByRole("button", { name: "Month", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect((await documentScrolls(page)).across).toBe(false);
  // Today is in view, inside the sideways panel.
  await expect(page.getByTestId("gantt-today")).toBeInViewport();
  expect((await documentScrolls(page)).across).toBe(false);
  await expect(page.locator("[data-gantt-resize]")).toHaveCount(0);
  // The row is the target: the bar is not one.
  const row = gantt(page).getByRole("button", {
    name: /^Book the expo booth crew, Sep 14 to Sep 18/,
  });
  await expect(row).toHaveCount(1);
  const box = await row.boundingBox();
  if (!box) throw new Error("The row has no box");
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeLessThanOrEqual(120);
  // A tap on the row's track, right of the sticky names.
  await page.mouse.click(box.x + box.width + 60, box.y + box.height / 2);
  await expect(
    page.getByRole("dialog", { name: "Book the expo booth crew", exact: true }),
  ).toBeVisible();
});

test("a board with stages but no cards says where cards are added", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installKanbanApi(page, { level: "write", cards: [] });
  await page.goto(ganttHref());
  await expect(gantt(page).getByText("No cards yet")).toBeVisible();
  await gantt(page).getByRole("link", { name: "Open the Kanban" }).click();
  await expect(page).toHaveURL(/section=kanban/);
});
