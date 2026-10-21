import {
  expect,
  test,
  signedInAs,
  defaultOrganization,
  expectNoHorizontalScroll,
  type Page,
} from "./helpers/test";
import { profilePreferences } from "./helpers/profile-api";
import { createMemorySeed } from "../support/comms-memory/memory/seed";
import { createMemoryCommsRuntime } from "../support/comms-memory/memory-client";
import type { MemorySnapshot } from "../support/comms-memory/memory/store-types";
import { serializeSampleSessionSnapshot } from "../../src/components/systems/shared/runtime/sample-state";
import { workspaceSessionSnapshotStorageKey } from "../../src/components/systems/shared/runtime/workspace-identity";

async function setup(
  page: Page,
  permission: "granted" | "denied" | "error" | "unavailable" = "granted",
) {
  const owner = {
    user_id: "00000000-0000-4000-8000-000000000101",
    org_id: defaultOrganization.org_id,
  };
  await signedInAs(page, { id: owner.user_id, role: "admin" });
  const state = createMemorySeed(owner, {
    role: "admin",
    display_name: "Notification owner",
  });
  state.users[owner.user_id].personal.notifications.desktop_notifications =
    false;
  const key = workspaceSessionSnapshotStorageKey(owner.user_id, owner.org_id);
  const value = serializeSampleSessionSnapshot(
    owner.user_id,
    { "comms-memory-v1": { format: 1, owner, state } },
    owner.org_id,
  );
  await page.addInitScript(
    ({ key, value, permission }) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
      const count = (name: string) =>
        sessionStorage.setItem(
          name,
          String(Number(sessionStorage.getItem(name) ?? 0) + 1),
        );
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value:
          permission === "unavailable"
            ? undefined
            : class {
                static get permission() {
                  return (
                    sessionStorage.getItem("permission-result") ?? "default"
                  );
                }
                static async requestPermission() {
                  count("permission-requests");
                  if (permission === "error")
                    throw new Error("Private permission exception");
                  sessionStorage.setItem("permission-result", permission);
                  return permission;
                }
                constructor() {
                  count("desktop-emissions");
                }
              },
      });
      HTMLMediaElement.prototype.play = async () => {
        count("sound-emissions");
      };
    },
    { key, value, permission },
  );
  const prefs = profilePreferences(owner.user_id);
  await page.route(`**/api/users/${owner.user_id}/preferences`, (route) =>
    route.fulfill({
      json: {
        ...prefs,
        theme: "system",
        appearance: { ...prefs.appearance, timezone: "America/New_York" },
      },
    }),
  );
  return { owner, key, conversation: Object.keys(state.conversations)[0] };
}
async function openPreferences(page: Page) {
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: "My preferences", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "My preferences",
    exact: true,
  });
  await dialog.getByRole("tab", { name: "Notifications", exact: true }).click();
  const advanced = dialog.getByRole("button", { name: /Advanced settings/ });
  if ((await advanced.getAttribute("aria-expanded")) === "false")
    await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  return dialog;
}
const requests = (page: Page) =>
  page.evaluate(() =>
    Number(sessionStorage.getItem("permission-requests") ?? 0),
  );
const snapshot = (page: Page, key: string): Promise<MemorySnapshot> =>
  page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key)!).values["comms-memory-v1"],
    key,
  );
async function keywordCount(page: Page, key: string) {
  const saved = await snapshot(page, key);
  const sender = Object.values(saved.state.people).find(
    (person) => person.display_name === "Noah Tan",
  )!;
  const runtime = createMemoryCommsRuntime(
    {
      owner: { ...saved.owner, user_id: sender.user_id },
      initial: saved.state,
    },
    { clock: () => Date.parse("2026-10-20T12:00:00Z") },
  );
  try {
    await runtime.client.sendMessage(
      Object.keys(saved.state.conversations)[0],
      {
        client_key: crypto.randomUUID(),
        body: "DISPATCH update",
        attachment_ids: [],
        record_ids: [],
        mention_user_ids: [],
        mentions_channel: false,
        mentions_here: false,
        reply_to_id: null,
      },
    );
    return runtime
      .exportSnapshot()
      .state.users[saved.owner.user_id].notifications.filter(
        (notice) => notice.kind === "comms-keyword",
      ).length;
  } finally {
    runtime.dispose();
  }
}

test("desktop permission is requested only by explicit enable and never emits alerts or sound", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/comms");
  expect(await requests(page)).toBe(0);
  const dialog = await openPreferences(page);
  expect(await requests(page)).toBe(0);
  await dialog
    .getByRole("switch", { name: "Desktop notifications", exact: true })
    .check();
  await expect.poll(() => requests(page)).toBe(1);
  await expect(dialog.getByText(/Browser permission granted/)).toBeVisible();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    (await snapshot(page, data.key)).state.users[data.owner.user_id].personal
      .notifications.desktop_notifications,
  ).toBe(true);
  await page.reload();
  await openPreferences(page);
  expect(await requests(page)).toBe(1);
  expect(
    await page.evaluate(() => [
      sessionStorage.getItem("desktop-emissions"),
      sessionStorage.getItem("sound-emissions"),
    ]),
  ).toEqual([null, null]);
});

for (const permission of ["denied", "error", "unavailable"] as const)
  test(`desktop ${permission} reports the browser limitation without losing eligible preferences`, async ({
    page,
  }) => {
    const data = await setup(page, permission);
    await page.goto("/comms");
    const dialog = await openPreferences(page);
    await dialog
      .getByRole("switch", { name: "Desktop notifications", exact: true })
      .check();
    await expect(
      dialog.getByText(
        permission === "denied"
          ? /Browser permission denied/
          : permission === "error"
            ? /Browser permission could not be requested/
            : /Browser notification permission is unavailable/,
      ),
    ).toBeVisible();
    expect(await requests(page)).toBe(permission === "unavailable" ? 0 : 1);
    await expect(
      dialog.getByText("Private permission exception", { exact: true }),
    ).toHaveCount(0);
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    expect(
      (await snapshot(page, data.key)).state.users[data.owner.user_id].personal
        .notifications.desktop_notifications,
    ).toBe(true);
  });

test("regional quiet hours and keyword preferences persist while conversation notify and mute use existing eligibility", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/comms");
  const dialog = await openPreferences(page);
  await expect(
    dialog.getByText(/Quiet hours use America\/New_York/),
  ).toBeVisible();
  await dialog
    .getByLabel("Notify me about", { exact: true })
    .selectOption("mentions");
  await dialog
    .getByLabel("Notification keywords", { exact: true })
    .fill("dispatch");
  await dialog.getByLabel("Quiet hours start", { exact: true }).fill("22:00");
  await dialog.getByLabel("Quiet hours end", { exact: true }).fill("06:00");
  for (const name of [
    "Notify followed threads",
    "Notification sound",
    "Notification badges",
    "Message notification previews",
  ])
    await dialog.getByRole("switch", { name, exact: true }).uncheck();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    (await snapshot(page, data.key)).state.users[data.owner.user_id].personal
      .notifications,
  ).toMatchObject({
    notification_mode: "mentions",
    keywords: ["dispatch"],
    quiet_hours_start: "22:00",
    quiet_hours_end: "06:00",
    notification_sound: false,
    notification_badges: false,
    notification_preview: false,
    notify_followed_threads: false,
  });
  expect(await keywordCount(page, data.key)).toBe(1);
  for (const [label, value] of [
    ["Mentions", "mentions"],
    ["Mute", "mute"],
    ["All", "all"],
  ]) {
    await page
      .getByRole("button", { name: "Channel actions: operations", exact: true })
      .click();
    await page.getByRole("menuitem", { name: /^Notify:/ }).click();
    await page.getByRole("menuitemradio", { name: label, exact: true }).click();
    await expect
      .poll(
        async () =>
          (await snapshot(page, data.key)).state.users[data.owner.user_id]
            .conversations[data.conversation]?.notify,
      )
      .toBe(value);
    if (value === "mute") expect(await keywordCount(page, data.key)).toBe(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("menu", {
        name: "Channel actions: operations",
        exact: true,
      }),
    ).toBeHidden();
  }
  await page.reload();
  await openPreferences(page);
  await expect(
    dialog.getByLabel("Quiet hours start", { exact: true }),
  ).toHaveValue("22:00");
  await expect(
    dialog.getByLabel("Notification keywords", { exact: true }),
  ).toHaveValue("dispatch");
  expect(await requests(page)).toBe(0);
});

test("notification preference feedback stays usable on phone and desktop in both themes", async ({
  page,
}, testInfo) => {
  await setup(page, "unavailable");
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/comms");
      await page
        .getByRole("button", { name: "OpenComms menu", exact: true })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: "My preferences", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "My preferences",
        exact: true,
      });
      if (width === 390)
        await dialog
          .getByLabel("Settings section", { exact: true })
          .selectOption("notifications");
      else
        await dialog
          .getByRole("tab", { name: "Notifications", exact: true })
          .click();
      await expect(
        dialog.getByText(/Browser notification permission is unavailable/),
      ).toBeVisible();
      const browserStatus = dialog.getByText(
        /Browser notification permission is unavailable/,
      );
      await browserStatus.scrollIntoViewIfNeeded();
      await expect(browserStatus).toBeInViewport();
      await expectNoHorizontalScroll(page);
      if (theme === "dark")
        await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
      await page.screenshot({
        path: testInfo.outputPath(`notifications-${width}-${theme}.png`),
        animations: "disabled",
      });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page
        .getByRole("button", {
          name: "Channel actions: operations",
          exact: true,
        })
        .click();
      await page.getByRole("menuitem", { name: /^Notify:/ }).click();
      await expect(
        page.getByRole("menuitemradio", { name: "Mentions", exact: true }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`notification-level-${width}-${theme}.png`),
        animations: "disabled",
      });
    }
});
