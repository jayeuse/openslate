import { expect, test, type Page } from "./helpers/test";
import {
  installKanbanApi,
  installRecordSheetApi,
  kanbanHref,
  labelIds,
  lockedCard,
  peopleIds,
  quoteRecordSummary,
  recordIds,
  stageIds,
  wireCard,
} from "./helpers/board-kanban-api";
import { boardId } from "./helpers/boards-api";
import { dummyFile } from "../helpers/dummy-files";

test.use({ trace: "off", screenshot: "off", video: "off" });

const board = (page: Page) =>
  page.getByRole("region", { name: "Kanban board" });
const stage = (page: Page, name: string) =>
  board(page).getByRole("region", { name, exact: true });
const cardPatches = (api: Awaited<ReturnType<typeof installKanbanApi>>) =>
  api.writes
    .filter(
      (write) => write.method === "PATCH" && /^\/cards\//.test(write.path),
    )
    .map((write) => write.body);

function documentScrollsAcross(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
}

test("a writer edits an objective's assignee, due date, labels and description, each with its revision", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [
      renewal,
      wireCard("Price list", stageIds.todo, 1024, {
        assignee_id: peopleIds.ana,
      }),
    ],
    extras: { [renewal.id]: { description: "Agree the terms." } },
  });
  await page.goto(kanbanHref());
  await stage(page, "Doing")
    .getByRole("button", { name: /^Renewal terms, objective/ })
    .click();
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  await expect(sheet.getByText("Objective", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Doing", { exact: true })).toBeVisible();
  await expect(
    sheet.getByRole("tablist", { name: "Card sections" }).getByRole("tab"),
  ).toHaveText(["Details", "Files", "Linked records", "Activity"]);
  await expect(page).toHaveURL(new RegExp(`card=${renewal.id}`));

  await sheet.getByRole("combobox", { name: "Assignee", exact: true }).click();
  await page.getByRole("option", { name: "Ana Santos", exact: true }).click();
  await expect(sheet.getByRole("status")).toHaveText("Assignee saved.");

  await sheet.getByLabel("Due", { exact: true }).fill("2026-10-30");
  await sheet.getByLabel("Due", { exact: true }).press("Enter");
  await expect(sheet.getByRole("status")).toHaveText("Due saved.");
  await expect(sheet.getByText("Doing · Due Oct 30")).toBeVisible();

  await sheet.getByRole("button", { name: /^(Add|Edit) labels$/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Expo" }).click();
  await page.keyboard.press("Escape");
  await expect(sheet.getByRole("status")).toHaveText("Labels saved.");

  await sheet
    .getByRole("textbox", { name: "Description" })
    .fill("Agree the 2027 terms before the expo.");
  await sheet.getByRole("button", { name: "Save description" }).click();
  await expect(sheet.getByRole("status")).toHaveText("Description saved.");

  expect(cardPatches(api)).toEqual([
    { revision: 1, assignee_id: peopleIds.ana },
    { revision: 2, due_on: "2026-10-30" },
    { revision: 3, label_ids: [labelIds.expo] },
    { revision: 4, description: "Agree the 2027 terms before the expo." },
  ]);
  await sheet.getByRole("button", { name: "Close card" }).click();
  await expect(page).not.toHaveURL(/card=/);
  const face = stage(page, "Doing").getByRole("button", {
    name: /^Renewal terms, objective/,
  });
  await expect(face).toContainText("Expo");
  await expect(face).toContainText("Oct 30");

  // Another card's typed edit starts from that card's own revision.
  await stage(page, "To do")
    .getByRole("button", { name: /^Price list, objective/ })
    .click();
  const other = page.getByRole("dialog", { name: "Price list", exact: true });
  await other
    .getByRole("textbox", { name: "Description" })
    .fill("Send the 2027 price list.");
  await other.getByRole("button", { name: "Save description" }).click();
  await expect(other.getByRole("status")).toHaveText("Description saved.");
  expect(cardPatches(api).at(-1)).toEqual({
    revision: 1,
    description: "Send the 2027 price list.",
  });
});

test("a writer assigns a board reader found by search who is neither assigned nor a post author", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [renewal],
  });
  await page.goto(kanbanHref());
  await stage(page, "Doing")
    .getByRole("button", { name: /^Renewal terms, objective/ })
    .click();
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });

  await sheet.getByRole("combobox", { name: "Assignee", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search assignee", exact: true })
    .fill("car");
  await expect(page.getByRole("option")).toHaveText(["Carla Diaz"]);
  await page.getByRole("option", { name: "Carla Diaz", exact: true }).click();
  await expect(sheet.getByRole("status")).toHaveText("Assignee saved.");
  await expect(
    sheet.getByRole("combobox", { name: "Assignee", exact: true }),
  ).toContainText("Carla Diaz");

  expect(cardPatches(api)).toEqual([
    { revision: 1, assignee_id: peopleIds.carla },
  ]);
  // The picker reads the board's readers in pages of 100, narrowed by search.
  const searched = api.peopleRequests.find(
    (query) => query.get("search") === "car",
  );
  expect(searched?.get("limit")).toBe("100");
});

test("a writer adds, ticks and reorders checklist items; the card counts them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [renewal],
    extras: { [renewal.id]: { checklist: [{ text: "Pull volumes" }] } },
  });
  await page.goto(kanbanHref(`card=${renewal.id}`));
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  const checklist = sheet.getByRole("region", { name: "Checklist" });
  await expect(checklist).toContainText("0/1");
  // An empty item cannot be added, and Add item says why.
  await expect(
    checklist.getByRole("button", { name: "Add item" }),
  ).toHaveAccessibleDescription("Type an item first.");

  await checklist
    .getByRole("textbox", { name: "New checklist item" })
    .fill("Draft volume tiers");
  await checklist.getByRole("button", { name: "Add item" }).click();
  await expect(
    checklist.getByRole("checkbox", { name: "Draft volume tiers" }),
  ).toBeVisible();
  await expect(checklist).toContainText("0/2");

  await checklist.getByRole("checkbox", { name: "Draft volume tiers" }).check();
  await expect(checklist).toContainText("1/2");

  await checklist
    .getByRole("button", { name: "Checklist item actions, Draft volume tiers" })
    .click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect(
    checklist.getByRole("listitem").first().getByRole("checkbox"),
  ).toHaveAccessibleName("Draft volume tiers");

  const added = api.writes.find(
    (write) => write.method === "POST" && write.path.endsWith("/checklist"),
  );
  expect(added?.body).toEqual({ text: "Draft volume tiers" });
  const order = api.writes.find((write) => write.path.endsWith("/order"));
  expect(order?.body).toEqual({
    item_ids: [
      api.checklists.get(renewal.id)?.find((item) => item.done)?.id,
      api.checklists.get(renewal.id)?.find((item) => !item.done)?.id,
    ],
  });
  await sheet.getByRole("button", { name: "Close card" }).click();
  await expect(
    stage(page, "Doing").getByRole("button", { name: /^Renewal terms/ }),
  ).toContainText("1/2");
});

test("a writer uploads a file to a card and removes it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [renewal],
  });
  await page.goto(kanbanHref(`card=${renewal.id}`));
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  await sheet.getByRole("tab", { name: "Files" }).click();
  await sheet
    .getByLabel("Add an attachment")
    .setInputFiles(dummyFile("terms.pdf"));
  await expect(sheet.getByText("terms.pdf attached.")).toBeVisible();
  await sheet.getByRole("button", { name: /Remove/ }).click();
  await expect(sheet.getByText("terms.pdf removed.")).toBeVisible();
  // Each change carried the board and card revisions it was made on.
  expect(
    api.writes
      .filter((write) => write.path.includes("/attachments"))
      .map((write) => [write.method, write.body]),
  ).toEqual([
    [
      "POST",
      { file_id: expect.any(String), board_revision: 1, content_revision: 1 },
    ],
    ["DELETE", { board_revision: 2, content_revision: 2 }],
  ]);

  // A file change moved the card's revision: the next field save uses it.
  await sheet.getByRole("tab", { name: "Details" }).click();
  const details = sheet.getByRole("tabpanel", { name: "Details" });
  await details.getByLabel("Due", { exact: true }).fill("2026-10-30");
  await details.getByLabel("Due", { exact: true }).press("Enter");
  await expect(details.getByRole("status")).toHaveText("Due saved.");
  expect(cardPatches(api)).toEqual([{ revision: 3, due_on: "2026-10-30" }]);
});

test("a writer links a record they can read to a card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [renewal],
  });
  await installRecordSheetApi(page);
  await page.goto(kanbanHref(`card=${renewal.id}`));
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  await sheet.getByRole("tab", { name: "Linked records" }).click();
  await sheet
    .getByRole("combobox", { name: "Record module" })
    .selectOption({ label: "Quotes" });
  await sheet
    .getByRole("combobox", { name: "Record to link" })
    .selectOption({ label: "Q-24112" });
  await sheet.getByRole("button", { name: "Link record" }).click();
  await expect(sheet.getByRole("link", { name: "Q-24112" })).toBeVisible();
  expect(
    api.writes.find((write) => write.path.endsWith("/record-links"))?.body,
  ).toEqual({
    record_id: recordIds.quote,
    board_revision: 1,
    content_revision: 1,
  });
});

test("a reader opens a card's sheet read-only, with the same tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024, {
    due_on: "2026-10-30",
    assignee_id: peopleIds.ana,
  });
  const api = await installKanbanApi(page, {
    level: "read",
    cards: [renewal],
    extras: {
      [renewal.id]: {
        description: "Agree the terms.",
        checklist: [{ text: "Pull volumes", done: true }],
        activity: [
          {
            id: "00000000-0000-4000-8000-0000000ea001",
            created_at: "2026-10-20T09:00:00Z",
            kind: "card",
            action: "update",
            summary: "Dates changed",
            actor_label: "ana",
          },
        ],
      },
    },
  });
  await page.goto(kanbanHref());
  await stage(page, "Doing")
    .getByRole("button", { name: /^Renewal terms, objective/ })
    .click();
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  await expect(
    sheet.getByRole("tablist", { name: "Card sections" }).getByRole("tab"),
  ).toHaveText(["Details", "Files", "Linked records", "Activity"]);
  await expect(sheet).toContainText("Ana Santos");
  await expect(sheet).toContainText("Agree the terms.");
  await expect(
    sheet.getByRole("checkbox", { name: "Pull volumes" }),
  ).toBeDisabled();
  for (const control of [
    sheet.getByRole("textbox"),
    sheet.getByRole("combobox"),
    sheet.getByRole("button", { name: "Move to stage" }),
    sheet.getByRole("button", { name: /^(Add|Edit) labels$/ }),
  ])
    await expect(control).toHaveCount(0);
  await sheet.getByRole("button", { name: "More card actions" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Copy link"]);
  await page.keyboard.press("Escape");
  await sheet.getByRole("tab", { name: "Activity" }).click();
  await expect(sheet.getByText("Dates changed")).toBeVisible();
  await sheet.getByRole("tab", { name: "Files" }).click();
  await expect(sheet.getByText("No attachments yet.")).toBeVisible();
  await expect(sheet.getByLabel("Add an attachment")).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

test("a record card opens the shared record sheet with On this board first; its stage saves on the card only", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const quote = wireCard(null, stageIds.doing, 1024, {
    kind: "record",
    record: quoteRecordSummary,
  });
  const api = await installKanbanApi(page, { level: "write", cards: [quote] });
  await installRecordSheetApi(page);
  await page.goto(kanbanHref());
  await stage(page, "Doing")
    .getByRole("button", { name: /^Q-24112, Quotes record/ })
    .click();
  const sheet = page.getByRole("dialog", { name: "Q-24112", exact: true });
  const tabs = sheet.getByRole("tablist", { name: "Record sections" });
  await expect(tabs.getByRole("tab").first()).toHaveText("On this board");
  await expect(tabs.getByRole("tab").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(tabs.getByRole("tab", { name: "Details" })).toBeVisible();

  await sheet.getByRole("button", { name: "More record actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Open in Quotes" }),
  ).toHaveAttribute(
    "href",
    `/openview?module=${recordIds.module}&record=${recordIds.quote}`,
  );
  await page.keyboard.press("Escape");

  await sheet
    .getByRole("combobox", { name: "Stage" })
    .selectOption({ label: "Done" });
  await expect(sheet.getByRole("status")).toHaveText("Moved to Done.");
  await expect(sheet.getByRole("combobox", { name: "Stage" })).toHaveValue(
    stageIds.done,
  );
  // Only the card changed: no record request wrote anything.
  expect(api.writes.map((write) => [write.method, write.path])).toEqual([
    ["PATCH", `/cards/${quote.id}`],
  ]);
  expect(cardPatches(api)).toEqual([{ revision: 1, stage_id: stageIds.done }]);
});

test("a card link opens its sheet and Copy link copies the card's own address", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copied = text;
        },
      },
    }),
  );
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  await installKanbanApi(page, { level: "write", cards: [renewal] });
  // A filtered address: the copied link names the card only.
  await page.goto(kanbanHref(`search=renewal&card=${renewal.id}`));
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  await sheet.getByRole("button", { name: "More card actions" }).click();
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.copied ?? ""),
    )
    .toBe(
      `${new URL(page.url()).origin}/boards?board=${boardId}&section=kanban&card=${renewal.id}`,
    );
});

test("an unknown card says it is not available, with no Retry; a locked card never opens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const locked = lockedCard(stageIds.todo, 1024);
  await installKanbanApi(page, { level: "write", cards: [locked] });
  await page.goto(kanbanHref("card=00000000-0000-4000-8000-00000000dead"));
  const sheet = page.getByRole("dialog", {
    name: "This card is not available.",
  });
  await expect(sheet).toContainText(
    "It may have been removed, or you may not have access.",
  );
  await expect(sheet.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Close card" }).click();
  await expect(page).not.toHaveURL(/card=/);
  // A malformed id is the same answer: a Retry could never succeed.
  await page.goto(kanbanHref("card=not-a-card"));
  await expect(
    page.getByRole("dialog", { name: "This card is not available." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close card" }).click();
  await expect(page).not.toHaveURL(/card=/);

  await page.goto(kanbanHref(`card=${locked.id}`));
  await expect(
    page.getByRole("dialog", { name: "This card is not available." }),
  ).toBeVisible();
  await expect(
    page.getByText("No access to this record").first(),
  ).toBeVisible();
});

test("Archive card asks nothing, closes the sheet, and Undo puts the card back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [renewal, wireCard("Price list", stageIds.doing, 2048)],
  });
  await page.goto(kanbanHref(`card=${renewal.id}`));
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  await sheet.getByRole("button", { name: "More card actions" }).click();
  await page.getByRole("menuitem", { name: "Archive card" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(sheet).toHaveCount(0);
  await expect(page).not.toHaveURL(/card=/);
  await expect(
    stage(page, "Doing").getByRole("button", { name: /^Renewal terms/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    stage(page, "Doing").getByRole("button", { name: /^Renewal terms/ }),
  ).toBeVisible();
  expect(api.writes.map((write) => write.path)).toEqual([
    `/cards/${renewal.id}/archive`,
    `/cards/${renewal.id}/restore`,
  ]);
});

test("a save another person beat says so and shows the latest card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [renewal],
  });
  await page.goto(kanbanHref(`card=${renewal.id}`));
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  await expect(sheet.getByLabel("Due", { exact: true })).toBeVisible();
  // Another person changed the card while it was open.
  renewal.due_on = "2026-11-02";
  api.staleNext = true;
  await sheet.getByLabel("Due", { exact: true }).fill("2026-10-30");
  await sheet.getByLabel("Due", { exact: true }).press("Enter");
  await expect(sheet.getByRole("alert")).toHaveText(
    "Someone changed this card first.",
  );
  // The sheet reads the card again and shows the other person's date.
  await expect(sheet.getByLabel("Due", { exact: true })).toHaveValue(
    "2026-11-02",
  );
});

test("on a phone the card sheet fills the screen, with Move to stage and 44px targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [renewal],
  });
  await page.goto(kanbanHref(`card=${renewal.id}`));
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  const box = await sheet.boundingBox();
  expect(box).toMatchObject({ x: 0, width: 390 });
  for (const target of [
    sheet.getByRole("button", { name: "Move to stage" }),
    sheet.getByRole("button", { name: "More card actions" }),
    sheet.getByRole("button", { name: "Close card" }),
    sheet.getByRole("tab", { name: "Details" }),
  ]) {
    const size = await target.boundingBox();
    expect(size!.height).toBeGreaterThanOrEqual(44);
  }
  await sheet.getByRole("button", { name: "Move to stage" }).click();
  await page.getByRole("menuitemradio", { name: "Done" }).click();
  await expect(sheet.getByRole("status")).toHaveText("Moved to Done.");
  await expect(sheet.getByText("Done", { exact: true })).toBeVisible();
  expect(cardPatches(api)).toEqual([{ revision: 1, stage_id: stageIds.done }]);
  // The assignee search opens above the full-screen sheet.
  await sheet.getByRole("combobox", { name: "Assignee", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Search assignee", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Carla Diaz", exact: true }),
  ).toBeInViewport();
  await page.keyboard.press("Escape");
  expect(await documentScrollsAcross(page)).toBe(false);
});

test("a writer's card title reads as the sheet title, with a field only on hover and focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  await installKanbanApi(page, { level: "read", cards: [renewal] });
  await page.goto(kanbanHref(`card=${renewal.id}`));
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  const heading = sheet.getByRole("heading", { name: "Renewal terms" });
  await expect(heading).toBeVisible();
  const type = (node: Element) => {
    const style = getComputedStyle(node);
    return { size: style.fontSize, weight: style.fontWeight };
  };
  const readerTitle = await heading.evaluate(type);

  await installKanbanApi(page, { level: "write", cards: [renewal] });
  await page.reload();
  const field = sheet.getByRole("textbox", { name: "Card title" });
  await expect(field).toHaveValue("Renewal terms");
  expect(await field.evaluate(type)).toEqual(readerTitle);
  // At rest it is text: no fill and no edge; focus shows the field.
  const look = () =>
    field.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        fill: style.backgroundColor,
        edges: [
          style.borderTopColor,
          style.borderRightColor,
          style.borderBottomColor,
          style.borderLeftColor,
        ],
      };
    });
  const none = "rgba(0, 0, 0, 0)";
  expect(await look()).toEqual({ fill: none, edges: [none, none, none, none] });
  await field.focus();
  expect((await look()).edges).not.toContain(none);
});

test("a manager on a board with no labels creates them from the card's Labels row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  await installKanbanApi(page, {
    level: "manage",
    cards: [renewal],
    labels: [],
  });
  await page.goto(kanbanHref(`card=${renewal.id}`));
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  await sheet
    .getByRole("button", { name: "Create labels", exact: true })
    .click();
  const labels = page.getByRole("dialog", { name: "Labels", exact: true });
  await expect(labels.getByLabel("New label name")).toBeVisible();
});

test("a writer's long card title wraps in its field, and Enter saves it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  const api = await installKanbanApi(page, {
    level: "write",
    cards: [renewal],
  });
  await page.goto(kanbanHref(`card=${renewal.id}`));
  // The sheet takes the new title as its name, so find it by its field.
  const sheet = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("textbox", { name: "Card title" }) });
  const field = sheet.getByRole("textbox", { name: "Card title" });
  const long =
    "Renewal terms for the 2027 harbor services contract, with the expo crew rates";
  await field.fill(long);
  // The whole title shows: the field grows a line instead of scrolling.
  expect(
    await field.evaluate(
      (node) =>
        node.scrollWidth <= node.clientWidth &&
        node.scrollHeight <= node.clientHeight + 1,
    ),
  ).toBe(true);
  await field.press("Enter");
  await expect(sheet.getByRole("status")).toHaveText("Title saved.");
  await expect(field).toHaveValue(long);
  // One save: the field locking while it saves does not send it again.
  expect(cardPatches(api)).toEqual([{ revision: 1, title: long }]);
});

test("from 1280 a card's Description keeps an 8rem box while its other fields stay slim", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const renewal = wireCard("Renewal terms", stageIds.doing, 1024);
  await installKanbanApi(page, { level: "write", cards: [renewal] });
  await page.goto(kanbanHref(`card=${renewal.id}`));
  const sheet = page.getByRole("dialog", {
    name: "Renewal terms",
    exact: true,
  });
  const description = sheet.getByRole("textbox", { name: "Description" });
  await expect(description).toBeVisible();
  expect((await description.boundingBox())!.height).toBeGreaterThanOrEqual(128);
  const item = sheet.getByRole("textbox", { name: "New checklist item" });
  expect((await item.boundingBox())!.height).toBe(32);
});
