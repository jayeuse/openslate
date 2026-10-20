import { expect, test } from "./helpers/test";
import { seedTimeline, timelineId } from "./helpers/comms-timeline-fixture";

test("ordinary conversations show current organization in the collapsed-shell and phone view", async ({
  page,
}) => {
  const data = await seedTimeline(page, 12);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/comms?conversation=${data.conversationId}`);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByLabel("Current organization", { exact: true }),
    ).toHaveText("OpenSlate");
    await expect(
      page.getByLabel("Current organization", { exact: true }),
    ).toBeInViewport();
  }
});

test("members are opt-in while deliberate opening and deep links remain usable", async ({
  page,
}) => {
  const data = await seedTimeline(page, 12);
  await page.goto(`/comms?conversation=${data.conversationId}`);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("region", { name: "Members with access", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Members with access", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Members with access", exact: true }),
  ).toBeVisible();
});

for (const count of [0, 12])
  test(`welcome introduction is empty-history only with ${count} messages`, async ({
    page,
  }) => {
    const data = await seedTimeline(page, count);
    await page.goto(`/comms?conversation=${data.conversationId}`);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("heading", {
        name: "Welcome to #operations",
        exact: true,
      }),
    ).toHaveCount(count === 0 ? 1 : 0);
  });

test("Jump to first unread appears only while its target is outside the actual viewport", async ({
  page,
}) => {
  await seedTimeline(page, 80, 30);
  await page.goto("/comms");
  const jump = page.getByRole("button", {
    name: "Jump to first unread",
    exact: true,
  });
  await jump.click();
  const unread = page.locator(`[id="${timelineId(31)}"]`);
  await expect(unread).toBeInViewport();
  await expect(jump).toHaveCount(0);
  const viewport = page.getByRole("region", { name: "Messages", exact: true });
  await viewport.hover();
  await page.mouse.wheel(0, 1500);
  await expect(unread).not.toBeInViewport();
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(
    page.getByRole("separator", { name: "New messages", exact: true }),
  ).toBeInViewport();
  await expect(jump).toHaveCount(0);
});
