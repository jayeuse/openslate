import { readFileSync } from "node:fs";

import { dummyFile } from "../../helpers/dummy-files";
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

type SeededAttachment = { id: string; filename: string };

test("A seeded Board post shows its attachment and downloads it @boards", async ({
  page,
}) => {
  // Seeded attachments can sit on any Board the manager reads, so the test finds
  // one through the API and opens its post by URL.
  await openWorkspace(page, "/boards?section=posts");
  const boards = await page.request.get("/api/boards?limit=100");
  expect(boards.status()).toBe(200);
  let found:
    | { boardId: string; postId: string; title: string; file: SeededAttachment }
    | undefined;
  for (const board of ((await boards.json()) as { items: { id: string }[] })
    .items) {
    const posts = await page.request.get(
      `/api/boards/${board.id}/posts?view=published&limit=100&offset=0`,
    );
    expect(posts.status()).toBe(200);
    for (const post of (
      (await posts.json()) as { items: { id: string; title: string }[] }
    ).items) {
      const attachments = await page.request.get(
        `/api/boards/${board.id}/posts/${post.id}/attachments?view=published&limit=25&offset=0`,
      );
      expect(attachments.status()).toBe(200);
      const [file] = (
        (await attachments.json()) as {
          items: SeededAttachment[];
        }
      ).items;
      if (file) {
        found = { boardId: board.id, postId: post.id, title: post.title, file };
        break;
      }
    }
    if (found) break;
  }
  if (!found)
    throw new Error("Harbor Small seeds a published post with an attachment");

  await openWorkspace(
    page,
    `/boards?board=${encodeURIComponent(found.boardId)}&section=posts&post=${encodeURIComponent(found.postId)}`,
  );
  const reader = page.getByRole("dialog", { name: found.title });
  await expect(reader).toBeVisible();
  const attachments = reader.getByRole("region", { name: "Post attachments" });
  await attachments
    .getByRole("button", { name: "Attachments", exact: true })
    .click();
  const downloadButton = attachments.getByRole("button", {
    name: `Download ${found.file.filename}`,
    exact: true,
  });
  await expect(downloadButton).toBeVisible();
  await expect(
    attachments.getByRole("button", { name: /^Remove / }),
  ).toHaveCount(0);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    downloadButton.click(),
  ]);
  expect(download.suggestedFilename()).toBe(found.file.filename);
  // The seeder uploads the shared blank file, so the bytes prove the round trip.
  expect(
    readFileSync(await download.path()).equals(
      dummyFile(found.file.filename).buffer,
    ),
  ).toBe(true);
});
