import {
  expect,
  expectNoHorizontalScroll,
  signedInAs,
  defaultOrganization,
  test,
} from "./helpers/test";
import { profilePreferences } from "./helpers/profile-api";
import { wireWorkspace } from "../helpers/wire";
import type { Page } from "@playwright/test";
import { createMemorySeed } from "../support/comms-memory/memory/seed";
import { createMemoryCommsRuntime } from "../support/comms-memory/memory-client";
import { installCommsLiveApi } from "./helpers/comms-live-api";
import {
  createCommsTestClock,
  type CommsTestClock,
} from "./helpers/comms-world";

const userId = "00000000-0000-4000-8000-000000000101";
async function seedSidebar(
  page: Page,
  role: "admin" | "member" | "guest" = "admin",
  directAllowed = true,
  scenario?: "nonmembers" | "empty",
  options: { clock?: CommsTestClock; notifications?: boolean } = {},
) {
  await signedInAs(page, { id: userId, role });
  const owner = { user_id: userId, org_id: defaultOrganization.org_id };
  const initial = createMemorySeed(owner, {
    role,
    display_name: "Sidebar owner",
  });
  if (!directAllowed) initial.dm_rule = "none";
  const category = Object.values(initial.categories)[0];
  const channel = Object.values(initial.conversations)[0];
  if (channel.kind !== "channel") throw new Error("Expected the seed channel");
  const root = Object.values(initial.messages).find(
    (message) => !message.parent_id,
  )!;
  const second = "76000000-0000-4000-8000-000000000001";
  const secondCategory = "76000000-0000-4000-8000-000000000002";
  initial.categories[secondCategory] = {
    ...category,
    id: secondCategory,
    name: "Planning",
    position: 1,
  };
  initial.conversations[second] = {
    ...channel,
    id: second,
    name: "deliveries",
    category_id: secondCategory,
    position: 1,
  };
  initial.members[second] = structuredClone(initial.members[channel.id]);
  initial.high_water_seq[second] = 1;
  const secondMessage = {
    ...root,
    id: "76000000-0000-4000-8000-000000000003",
    client_key: "76000000-0000-4000-8000-000000000004",
    conversation_id: second,
    seq: 1,
    body: "Planning tomorrow's deliveries",
    record_links: [],
    mention_user_ids: [userId],
  };
  initial.messages[secondMessage.id] = secondMessage;
  initial.users[userId].notifications = [
    {
      id: "76000000-0000-4000-8000-000000000005",
      org_id: owner.org_id,
      subject_type: "comms_message",
      subject_id: secondMessage.id,
      kind: "comms-mention",
      conversation_id: second,
      message_id: secondMessage.id,
      status: "unread",
      scheduled_for: null,
      created_at: secondMessage.created_at,
      read_at: null,
    },
  ];
  if (scenario === "nonmembers") {
    // Department channels whose read roles alone make readers (D44).
    for (const person of Object.values(initial.people))
      for (const department of Object.keys(person.department_levels))
        person.department_levels[department] = "read";
    for (const id of Object.keys(initial.conversations))
      initial.members[id] = {};
    const hiddenId = "76000000-0000-4000-8000-000000000090";
    initial.people[hiddenId] = {
      ...initial.people[userId],
      user_id: hiddenId,
      display_name: "Hidden person",
      group_ids: [],
      department_levels: {},
    };
  } else if (scenario === "empty") {
    initial.conversations = {};
    initial.members = {};
    initial.messages = {};
    initial.threads = {};
    initial.high_water_seq = {};
    initial.users[userId].notifications = [];
  }
  const server = await installCommsLiveApi(page, {
    userId,
    organizationId: owner.org_id,
    runtime: createMemoryCommsRuntime(
      { owner, initial },
      options.clock ? { clock: options.clock.now } : {},
    ),
    clock: options.clock?.now,
    notifications: options.notifications,
  });
  return { channel: channel.id, second, server };
}
async function rowAction(page: Page, name: string, action: string) {
  await page
    .getByRole("button", { name: `Channel actions: ${name}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

for (const scenario of ["nonmembers", "empty"] as const) {
  test(`S06 correction starts a group with ${scenario} conversation membership`, async ({
    page,
  }) => {
    await seedSidebar(
      page,
      scenario === "empty" ? "admin" : "member",
      true,
      scenario,
    );
    await page.goto("/comms");
    await page
      .getByRole("button", { name: "Start direct message", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Start direct message",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Group message", exact: true })
      .click();
    const picker = dialog.getByRole("combobox", {
      name: "Add person",
      exact: true,
    });
    await expect(picker).toBeEnabled();
    for (const name of ["Noah Tan", "Sofia Garcia"]) {
      await picker.click();
      await page
        .getByRole("combobox", { name: "Search add person", exact: true })
        .fill(name);
      await expect(
        page.getByRole("option", { name: "Hidden person", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("option", { name: "Mara Santos", exact: true }),
      ).toHaveCount(0);
      await page.getByRole("option", { name, exact: true }).click();
    }
    await dialog
      .getByRole("textbox", { name: "Group name", exact: true })
      .fill("Eligible group");
    await dialog
      .getByRole("button", { name: "Start conversation", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Eligible group", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Members", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Members 3", exact: true }),
    ).toBeVisible();
  });
}

test("S06 correction tomorrow mute uses organization midnight rather than device or personal zone", async ({
  page,
}) => {
  // The fake server reads mutes on the same fixed time as the page.
  const clock = createCommsTestClock(page, "2026-10-19T12:00:00Z");
  await seedSidebar(page, "admin", true, undefined, { clock });
  await page.clock.setFixedTime(new Date("2026-10-19T12:00:00Z"));
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: wireWorkspace({
        id: defaultOrganization.org_id,
        display_name: "OpenSlate",
        locale: "en-US",
        timezone: "Asia/Manila",
        currency: "USD",
        today: "2026-10-19",
        purge_enabled: true,
      }),
    }),
  );
  const preferences = profilePreferences(userId);
  await page.route(`**/api/users/${userId}/preferences`, (route) =>
    route.fulfill({
      json: {
        ...preferences,
        appearance: { ...preferences.appearance, timezone: "America/New_York" },
      },
    }),
  );
  await page.goto("/comms");
  await rowAction(page, "operations", "Mute channel until tomorrow");
  await page
    .getByRole("button", { name: "Category actions: Planning", exact: true })
    .click();
  await page
    .getByRole("menuitem", {
      name: "Mute category until tomorrow",
      exact: true,
    })
    .click();
  for (const instant of ["2026-10-19T15:59:00Z", "2026-10-19T16:01:00Z"]) {
    await page.clock.setFixedTime(new Date(instant));
    clock.set(instant);
    await page.reload();
    for (const name of ["operations", "deliveries"]) {
      const row = page.getByRole("button", { name: new RegExp(`^${name},`) });
      if (instant.includes("15:59"))
        await expect(row).toHaveAccessibleName(/muted/);
      else await expect(row).not.toHaveAccessibleName(/muted/);
    }
  }
});

for (const surface of ["direct", "switcher"] as const) {
  test(`S06 correction mobile ${surface} portal controls meet 44px targets`, async ({
    page,
  }, testInfo) => {
    await seedSidebar(page);
    await page.route(`**/api/users/${userId}/preferences`, (route) =>
      route.fulfill({
        json: { ...profilePreferences(userId), theme: "system" },
      }),
    );
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/comms");
    await page
      .getByRole("button", {
        name:
          surface === "direct" ? "Start direct message" : /Switch conversation/,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name:
        surface === "direct" ? "Start direct message" : "Switch conversation",
      exact: true,
    });
    if (surface === "direct") {
      await dialog
        .getByRole("button", { name: "Group message", exact: true })
        .click();
      await dialog
        .getByRole("combobox", { name: "Add person", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "Search add person", exact: true })
        .fill("Noah Tan");
      await page.getByRole("option", { name: "Noah Tan", exact: true }).click();
    }
    const sizes = await dialog
      .getByRole("button")
      .or(dialog.getByRole("textbox"))
      .or(dialog.getByRole("combobox"))
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return {
            name: node.getAttribute("aria-label") ?? node.textContent,
            width: box.width,
            height: box.height,
          };
        }),
      );
    expect(sizes.filter((size) => size.width < 44 || size.height < 44)).toEqual(
      [],
    );
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      if (theme === "dark")
        await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
      const path = testInfo.outputPath(
        `s06-correction-${surface}-${theme}.png`,
      );
      await page.screenshot({ path, animations: "disabled" });
      await testInfo.attach(`${surface} ${theme}`, {
        path,
        contentType: "image/png",
      });
    }
  });
}

test("S06 correction Threads destination opens the selected thread", async ({
  page,
}) => {
  const ids = await seedSidebar(page);
  await page.goto("/comms");
  await page
    .getByRole("navigation", { name: "OpenComms views", exact: true })
    .getByRole("button", { name: "Threads", exact: true })
    .click();
  const threads = page.getByRole("region", { name: "Threads", exact: true });
  await threads.getByRole("button", { name: /Morning handover/ }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("conversation") === ids.channel &&
      url.searchParams.has("thread") &&
      !url.searchParams.has("view"),
  );
  await expect(
    page
      .getByRole("region", { name: "Thread conversation", exact: true })
      .getByText("Thanks. I will confirm the next update with Riverside.", {
        exact: true,
      }),
  ).toBeVisible();
});

test("Comms sidebar remains usable on desktop and phone in light and dark", async ({
  page,
}, testInfo) => {
  await seedSidebar(page);
  await page.route(`**/api/users/${userId}/preferences`, (route) =>
    route.fulfill({ json: { ...profilePreferences(userId), theme: "system" } }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(viewport.width < 640 ? "/comms" : "/comms?view=inbox");
      const sidebar = page.getByRole("complementary", {
        name: "Conversations",
        exact: true,
      });
      await expect(
        sidebar.getByRole("button", { name: /^operations, 2 unread/ }),
      ).toBeVisible();
      await expect(
        sidebar.getByLabel("1 mention", { exact: true }),
      ).toBeVisible();
      if (theme === "dark")
        await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
      await expectNoHorizontalScroll(page);
      const path = testInfo.outputPath(
        `s06-sidebar-${viewport.width}-${theme}.png`,
      );
      await page.screenshot({ path, animations: "disabled" });
      await testInfo.attach(`Sidebar ${viewport.width} ${theme}`, {
        path,
        contentType: "image/png",
      });
    }
  }
  expect(errors).toEqual([]);
});

test("Comms switcher searches authorized conversations and Starred keeps a real saved preference", async ({
  page,
}) => {
  const ids = await seedSidebar(page);
  await page.goto("/comms");
  await rowAction(page, "deliveries", "Add to favorites");
  const starred = page.getByRole("region", { name: "Starred", exact: true });
  await expect(
    starred.getByRole("button", { name: /^deliveries(,|$)/ }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  const switcher = page.getByRole("dialog", {
    name: "Switch conversation",
    exact: true,
  });
  await switcher
    .getByRole("textbox", { name: "Find a conversation", exact: true })
    .fill("does-not-exist");
  await expect(
    switcher.getByText("No conversations match.", { exact: true }),
  ).toBeVisible();
  await switcher
    .getByRole("textbox", { name: "Find a conversation", exact: true })
    .fill("deliver");
  await switcher
    .getByRole("button", { name: "deliveries", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`conversation=${ids.second}`));
  await page.reload();
  await expect(
    starred.getByRole("button", { name: /^deliveries(,|$)/ }),
  ).toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(switcher).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(switcher).toBeHidden();
});

test("Comms Inbox groups authoritative unread counts and category mute preserves mentions until unmuted", async ({
  page,
}) => {
  await seedSidebar(page);
  await page.clock.setFixedTime(new Date("2026-10-19T12:00:00Z"));
  await page.goto("/comms?view=inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(
    inbox.getByRole("button", { name: /^operations, 2 unread/ }),
  ).toHaveCount(1);
  await expect(
    inbox.getByRole("button", { name: /^deliveries, 1 unread, 1 mention/ }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Category actions: Planning", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Mute category for 8 hours", exact: true })
    .click();
  const sidebar = page.getByRole("complementary", {
    name: "Conversations",
    exact: true,
  });
  await expect(
    sidebar.getByRole("button", { name: /deliveries,.*muted/ }),
  ).toBeVisible();
  await expect(sidebar.getByLabel("1 mention", { exact: true })).toBeVisible();
  await page
    .getByRole("button", {
      name: "Category actions: Service delivery",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", {
      name: "Mute category until turned back on",
      exact: true,
    })
    .click();
  await expect(
    sidebar.getByRole("button", { name: /operations,.*muted/ }),
  ).toBeVisible();
  await expect(sidebar.getByLabel("2 unread", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(
    sidebar.getByRole("button", { name: /operations,.*muted/ }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Category actions: Service delivery",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Unmute category", exact: true })
    .click();
  await expect(sidebar.getByLabel("2 unread", { exact: true })).toBeVisible();
  await rowAction(page, "operations", "Mark read");
  await expect(
    inbox.getByRole("button", { name: /^operations(,|$)/ }),
  ).toHaveCount(0);
  await rowAction(page, "operations", "Mark unread");
  await expect(
    inbox.getByRole("button", { name: /operations, marked unread/ }),
  ).toBeVisible();
});

test("Comms starts a group from visible people, keeps the actor, and persists category order", async ({
  page,
}) => {
  await seedSidebar(page);
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Start direct message", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Start direct message",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Group message", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Group name", exact: true })
    .fill("Dispatch planning");
  await expect(
    dialog.getByRole("button", { name: "Start conversation", exact: true }),
  ).toBeDisabled();
  for (const name of ["Noah Tan", "Sofia Garcia"]) {
    await dialog
      .getByRole("combobox", { name: "Add person", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Search add person", exact: true })
      .fill(name);
    await page.getByRole("option", { name, exact: true }).click();
  }
  await dialog
    .getByRole("button", { name: "Start conversation", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Dispatch planning", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Members 3", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Category actions: Planning", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Move category up", exact: true })
    .click();
  const categories = page
    .getByRole("complementary", { name: "Conversations", exact: true })
    .getByRole("button", { name: /^(Planning|Service delivery).*Operations/ });
  // The move saves over HTTP; reload only after the saved order is shown.
  await expect(categories).toHaveText([/Planning/, /Service delivery/]);
  await page.reload();
  await expect(categories).toHaveText([/Planning/, /Service delivery/]);
  await expect(
    page.getByRole("heading", { name: "Dispatch planning", exact: true }),
  ).toBeVisible();
});

test("Comms Activity reads real stored notifications and removes a deleted source", async ({
  page,
}) => {
  await seedSidebar(page, "admin", true, undefined, { notifications: true });
  await page.goto("/comms");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await activity
    .getByRole("button", { name: "Mention in deliveries", exact: true })
    .click();
  const message = page
    .getByRole("article")
    .filter({ hasText: "Planning tomorrow's deliveries" });
  await expect(message).toBeInViewport();
  await message.getByRole("button", { name: /^Message actions:/ }).click();
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .click();
  await expect(
    page.getByText("Message removed", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(
    activity.getByText("No activity yet.", { exact: true }),
  ).toBeVisible();
});

test("Comms keeps a refused group draft and applies a newly admitted guest role", async ({
  page,
}) => {
  const { server } = await seedSidebar(page, "admin", true, "empty");
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Start direct message", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Start direct message",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Group message", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Group name", exact: true })
    .fill("Keep this group draft");
  for (const name of ["Noah Tan", "Sofia Garcia"]) {
    await dialog
      .getByRole("combobox", { name: "Add person", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Search add person", exact: true })
      .fill(name);
    await page.getByRole("option", { name, exact: true }).click();
  }
  // An administrator can choose these people without shared conversations.
  // Fresh member admission removes that eligibility while preserving the draft;
  // the search-first picker keeps the names it showed at selection.
  await signedInAs(page, { id: userId, role: "member" });
  server.setRole("member");
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(
    dialog.getByRole("button", { name: /^Remove (Noah Tan|Sofia Garcia)$/ }),
  ).toHaveCount(2);
  await dialog
    .getByRole("button", { name: "Start conversation", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Group name", exact: true }),
  ).toHaveValue("Keep this group draft");
  await expect(
    dialog.getByRole("button", { name: /^Remove (Noah Tan|Sofia Garcia)$/ }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("heading", { name: "Keep this group draft", exact: true }),
  ).toHaveCount(0);
  await signedInAs(page, { id: userId, role: "admin" });
  server.setRole("admin");
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(
    dialog.getByRole("button", { name: "Remove Noah Tan", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Remove Sofia Garcia", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await signedInAs(page, { id: userId, role: "guest" });
  server.setRole("guest");
  await page.reload();
  await page
    .getByRole("button", { name: "Start direct message", exact: true })
    .click();
  await expect(
    dialog.getByText("Guests cannot start conversations.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Start conversation", exact: true }),
  ).toBeDisabled();
});

test("Comms guest cannot create a group and the channel browser has useful no-match state", async ({
  page,
}) => {
  await seedSidebar(page, "guest");
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Start direct message", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Start direct message",
    exact: true,
  });
  await expect(
    dialog.getByText("Guests cannot start conversations.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Start conversation", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Browse channels", exact: true })
    .click();
  const browser = page.getByRole("region", {
    name: "Browse channels",
    exact: true,
  });
  await browser
    .getByRole("textbox", { name: "Find a channel", exact: true })
    .fill("does-not-exist");
  await expect(
    browser.getByText("No channels match.", { exact: true }),
  ).toBeVisible();
});
