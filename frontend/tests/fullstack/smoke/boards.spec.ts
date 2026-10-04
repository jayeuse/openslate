import { asRole, expect, openWorkspace, test } from "./smoke-fixture";

asRole("manager");

test("A department Board post is written and published @boards", async ({
  page,
}) => {
  const title = `Smoke check: targets ${Date.now()}`;
  await openWorkspace(page, "/boards?section=posts");
  await page.getByRole("button", { name: "Switch board" }).click();
  await page.getByRole("combobox", { name: "Board", exact: true }).click();
  await page.getByRole("option", { name: "Sales" }).click();
  await expect(
    page.getByRole("heading", { name: "Sales", level: 1 }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Posts" })
    .click();
  await page.getByRole("button", { name: /New post/ }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Title").fill(title);
  await editor
    .getByRole("textbox", { name: "Message" })
    .fill("Targets are posted on the shared drive.");
  await editor.getByRole("button", { name: "Save draft" }).click();
  await editor.getByRole("button", { name: /^Publish/ }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});

type SeededEvent = {
  title: string;
  all_day: boolean;
  recurrence: string;
  start_date: string | null;
};

test("A Board calendar shows a seeded event in its month @boards", async ({
  page,
}) => {
  // Seeded events sit around the anchor date, so the test finds one through the API,
  // moves the calendar to that month, and waits for the event itself.
  await openWorkspace(page, "/boards?section=calendar");
  const boards = await page.request.get("/api/boards?search=Sales&limit=100");
  expect(boards.status()).toBe(200);
  const sales = (
    (await boards.json()) as { items: { id: string; name: string }[] }
  ).items.find((board) => board.name === "Sales");
  if (!sales) throw new Error("Harbor Small seeds a Sales Board");
  const events = await page.request.get(
    `/api/boards/${sales.id}/events?limit=100`,
  );
  expect(events.status()).toBe(200);
  const seeded = ((await events.json()) as { items: SeededEvent[] }).items.find(
    (event) => event.all_day && event.recurrence === "none" && event.start_date,
  );
  if (!seeded?.start_date)
    throw new Error("Harbor Small seeds one-day events on the Sales Board");
  const workspace = await page.request.get("/api/workspace");
  const { today } = (await workspace.json()) as { today: string };
  const monthIndex = (day: string) =>
    Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7));
  const steps = monthIndex(seeded.start_date) - monthIndex(today);
  const target = await page.evaluate(
    (day) =>
      new Intl.DateTimeFormat(undefined, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${day.slice(0, 7)}-01T12:00:00Z`)),
    seeded.start_date,
  );

  await openWorkspace(
    page,
    `/boards?board=${encodeURIComponent(sales.id)}&section=calendar`,
  );
  const calendar = page.getByRole("region", { name: "Board calendar" });
  await page.getByRole("button", { name: "Agenda" }).click();
  const move = page.getByRole("button", {
    name: steps < 0 ? "Previous month" : "Next month",
  });
  for (let step = 0; step < Math.abs(steps); step += 1) await move.click();
  await expect(
    calendar.getByRole("heading", { name: target, exact: true }),
  ).toBeVisible();
  await expect(calendar.getByText(seeded.title).first()).toBeVisible();
});
