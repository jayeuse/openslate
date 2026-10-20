import { expect, test, expectNoHorizontalScroll } from "./helpers/test";
import {
  seedTimeline,
  timelineId,
  timelineServer,
} from "./helpers/comms-timeline-fixture";
import { profilePreferences } from "./helpers/profile-api";
import type { MemorySnapshot } from "../../src/components/systems/comms/memory/store-types";
import { validateMemoryState } from "../../src/components/systems/comms/memory/snapshot";
import { serializeSampleSessionSnapshot } from "../../src/components/systems/shared/runtime/sample-state";
test("connection feedback uses live transport availability, delays reconnecting and retries without losing a draft", async ({
  page,
}) => {
  await seedTimeline(page, 12);
  const server = timelineServer(page);
  await page.clock.install();
  await page.goto("/comms");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  const status = page.getByRole("status", {
    name: "Conversation connection",
    exact: true,
  });
  await expect(status.getByText("Live", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Keep through client recovery");
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  server.pauseJoins(true);
  server.dropConnections();
  await expect(status).toHaveAttribute("aria-busy", "true");
  await page.clock.runFor(2999);
  await expect(status.getByText("Reconnecting", { exact: true })).toHaveCount(
    0,
  );
  await page.clock.runFor(1);
  await expect(status.getByText("Reconnecting", { exact: true })).toBeVisible();
  await expect(status).toHaveAttribute("aria-busy", "false");
  await page.clock.resume();
  server.setTokenStatus(503);
  await page.clock.runFor(240_000);
  await expect(status.getByText("Offline", { exact: true })).toBeVisible();
  server.setTokenStatus(200);
  server.pauseJoins(false);
  await status.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(status.getByText("Live", { exact: true })).toBeVisible();
  server.setTokenStatus(429);
  await page.clock.runFor(240_000);
  await expect(status).toContainText("Live updates paused in this tab");
  server.setTokenStatus(200);
  await status.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(status.getByText("Live", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Keep through client recovery");
});

test("feed articles have a single roving target and Page keys traverse loaded sequence without taking over native arrows", async ({
  page,
}) => {
  await seedTimeline(page, 80);
  await page.goto("/comms");
  const feed = page.getByRole("feed", {
    name: "Conversation messages",
    exact: true,
  });
  const last = page.locator(`[id="${timelineId(80)}"]`);
  await expect(last).toHaveAccessibleName(/^Message 80:/);
  await expect(feed.locator('article[tabindex="0"]')).toHaveCount(1);
  const viewport = page.getByRole("region", { name: "Messages", exact: true });
  await viewport.hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(feed.locator('article[tabindex="0"]')).toHaveCount(1);
  await page
    .getByRole("button", { name: "Jump to latest", exact: true })
    .click();
  await last.focus();
  await page.keyboard.press("PageUp");
  const previous = page.locator(`[id="${timelineId(79)}"]`);
  await expect(previous).toBeFocused();
  await expect(previous).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("PageDown");
  await expect(last).toBeFocused();
  for (const key of ["ArrowUp", "ArrowDown", "Home", "End"]) {
    await page.keyboard.press(key);
    await expect(last).toBeFocused();
  }
  await expect(feed.locator('article[tabindex="0"]')).toHaveCount(1);
});

test("Comms custom shortcuts are shared and profile-gated without changing composer typing", async ({
  page,
}) => {
  const data = await seedTimeline(page, 8);
  const prefs = profilePreferences(data.owner.user_id);
  let enabled = false;
  await page.route(`**/api/users/${data.owner.user_id}/preferences`, (route) =>
    route.fulfill({
      json: {
        ...prefs,
        appearance: { ...prefs.appearance, keyboard_shortcuts: enabled },
      },
    }),
  );
  await page.goto("/comms");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep typing");
  await composer.press("Alt+f");
  await expect(composer).toBeFocused();
  enabled = true;
  await page.reload();
  await expect(composer).toHaveValue("Keep typing");
  await composer.press("Alt+f");
  await expect(
    page.getByRole("textbox", { name: "Search messages", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Alt+n");
  await expect(composer).toBeFocused();
});

test("message announcements are throttled rather than repeated for a send burst", async ({
  page,
}) => {
  await seedTimeline(page, 8);
  await page.clock.install();
  await page.goto("/comms");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeEnabled();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const live = page.getByRole("status", {
    name: "Message announcements",
    exact: true,
  });
  await composer.fill("First throttled send");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect(live).toHaveText("");
  await composer.fill("Second throttled send");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(composer).toHaveValue("");
  await page.clock.runFor(500);
  await expect(live).toContainText("Message sent");
});

test("phone conversation keeps Back title and Details with reachable controls in light and dark", async ({
  page,
}, testInfo) => {
  const data = await seedTimeline(page, 12);
  await page.goto("/comms");
  const snapshot: MemorySnapshot = await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key)!).values["comms-memory-v1"],
    data.storageKey,
  );
  const record = Object.values(snapshot.state.records)[0];
  snapshot.state.configuration.workspace = {
    settings: { pinned_record_id: record.id },
    capabilities: {
      scope: { kind: "workspace" },
      everyone: {},
      group_grants: [],
    },
  };
  validateMemoryState(snapshot.state, data.owner.org_id);
  const pinnedState = serializeSampleSessionSnapshot(
    data.owner.user_id,
    { "comms-memory-v1": snapshot },
    data.owner.org_id,
  );
  await page.route(`**/api/users/${data.owner.user_id}/preferences`, (route) =>
    route.fulfill({
      json: { ...profilePreferences(data.owner.user_id), theme: "system" },
    }),
  );
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(
        ({ key, value }) => sessionStorage.setItem(key, value),
        {
          key: data.storageKey,
          value: pinnedState,
        },
      );
      await page.goto(`/comms?conversation=${data.conversationId}`);
      const conversation = page.getByRole("region", {
        name: "Conversation",
        exact: true,
      });
      await expect(
        conversation.getByRole("textbox", { name: "Message", exact: true }),
      ).toBeEnabled();
      const pinned = conversation.getByRole("link", {
        name: /^Pinned record ·/,
      });
      await expect(pinned).toBeVisible();
      await expect(pinned).toHaveAttribute(
        "href",
        `/openview?record=${record.id}`,
      );
      if (process.env.S13_CAPTURE)
        await page.screenshot({
          path: testInfo.outputPath(`header-${width}-${theme}.png`),
          animations: "disabled",
        });
      if (width === 390) {
        const header = conversation.locator("header").first();
        await expect(header.getByRole("button")).toHaveCount(2);
        await expect(
          header.getByRole("button", { name: "Conversations", exact: true }),
        ).toBeVisible();
        await header
          .getByRole("button", { name: "Details", exact: true })
          .click();
        await expect(
          header.getByRole("button", { name: "Members", exact: true }),
        ).toBeVisible();
        await expect(
          header.getByRole("textbox", { name: "Search messages", exact: true }),
        ).toBeVisible();
      }
      const sizes = await conversation
        .locator('button, input:not([type="hidden"]), textarea, a[href]')
        .evaluateAll((buttons) =>
          buttons
            .filter((button) => button.getClientRects().length)
            .map((button) => ({
              name: button.getAttribute("aria-label") ?? button.textContent,
              width: button.getBoundingClientRect().width,
              height: button.getBoundingClientRect().height,
            })),
        );
      for (const size of sizes) {
        expect(size.width, size.name ?? "control").toBeGreaterThanOrEqual(
          width === 390 ? 44 : 24,
        );
        expect(size.height, size.name ?? "control").toBeGreaterThanOrEqual(
          width === 390 ? 44 : 24,
        );
      }
      await expectNoHorizontalScroll(page);
      if (process.env.S13_CAPTURE)
        await page.screenshot({
          path: testInfo.outputPath(`states-${width}-${theme}.png`),
          animations: "disabled",
        });
      await pinned.focus();
      await expect(pinned).toBeFocused();
      await pinned.press("Enter");
      await expect(page).toHaveURL(`/openview?record=${record.id}`);
    }
});

test("forced colors retain message boundaries and reduced motion avoids smooth feed scrolling", async ({
  page,
}) => {
  await seedTimeline(page, 12);
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto("/comms");
  const article = page.getByRole("article").last();
  await expect(article).toBeVisible();
  const style = await article.evaluate((node) => ({
    border: getComputedStyle(node).borderTopWidth,
    color: getComputedStyle(node).borderTopColor,
  }));
  expect(parseFloat(style.border)).toBeGreaterThanOrEqual(1);
  expect(style.color).not.toBe("rgba(0, 0, 0, 0)");
  await expect(
    page.getByRole("region", { name: "Messages", exact: true }),
  ).toHaveCSS("scroll-behavior", "auto");
});
