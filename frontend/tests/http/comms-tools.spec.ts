import { readFile } from "node:fs/promises";
import {
  expect,
  test,
  signedInAs,
  defaultOrganization,
  expectNoHorizontalScroll,
  type Page,
} from "./helpers/test";
import { profilePreferences } from "./helpers/profile-api";
import { createMemoryCommsRuntime } from "../../src/components/systems/comms/adapters/memory-client";
import { createMemorySeed } from "../../src/components/systems/comms/memory/seed";
import { validateMemoryState } from "../../src/components/systems/comms/memory/snapshot";
import { serializeSampleSessionSnapshot } from "../../src/components/systems/shared/runtime/sample-state";
import { workspaceSessionSnapshotStorageKey } from "../../src/components/systems/shared/runtime/workspace-identity";

async function seedTools(
  page: Page,
  member = false,
  scheduledAt = "2099-12-01T12:00:00Z",
) {
  const owner = {
    user_id: "00000000-0000-4000-8000-000000000101",
    org_id: defaultOrganization.org_id,
  };
  const initial = createMemorySeed(owner, {
    role: "admin",
    display_name: "Tools owner",
  });
  const room = Object.values(initial.conversations)[0];
  const root = Object.values(initial.messages).find(
    (message) => message.parent_id === null,
  )!;
  const reply = Object.values(initial.messages).find(
    (message) => message.parent_id !== null,
  )!;
  let tick = 0;
  const runtime = createMemoryCommsRuntime(
    { owner, initial },
    { clock: () => Date.parse("2026-10-20T00:00:00Z") + tick++ },
  );
  let snapshot;
  try {
    const client = runtime.client;
    await client.reportMessage(room.id, root.id, {
      reason: "Review dispatch wording",
    });
    await client.removeMessage(room.id, reply.id, {
      if_match: (await client.getMessage(room.id, reply.id)).etag,
    });
    await client.createTemplate({
      name: "Dispatch defaults",
      description: "Owned example",
      settings: { mention_limit: 4 },
    });
    const scope = { kind: "workspace" } as const;
    await client.updateSettings(
      scope,
      { formatting: false },
      { if_match: (await client.getSettings(scope)).etag },
    );
    for (const body of ["Deliver scheduled update", "Cancel this schedule"])
      await client.createSchedule({
        conversation_id: room.id,
        client_key: crypto.randomUUID(),
        body,
        attachment_ids: [],
        record_ids: [],
        mention_user_ids: [],
        mentions_channel: false,
        mentions_here: false,
        reply_to_id: null,
        parent_id: null,
        also_send_to_channel: false,
        send_at: scheduledAt,
      });
    const privateRoom = (
      await client.createChannel({
        name: "private-dispatch",
        topic: "Owned test",
        category_id: null,
        position: 1,
        scope: "members",
        member_ids: [owner.user_id],
      })
    ).data;
    await client.updateSettings(
      { kind: "channel", id: privateRoom.id },
      { join_rule: "request" },
      {
        if_match: (
          await client.getSettings({ kind: "channel", id: privateRoom.id })
        ).etag,
      },
    );
    snapshot = runtime.exportSnapshot();
    for (const [index, user_id] of [
      root.author_id,
      reply.author_id,
    ].entries()) {
      const id = `78000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      snapshot.state.admissions[id] = {
        id,
        org_id: owner.org_id,
        created_at: "2026-10-19T01:00:00Z",
        updated_at: "2026-10-19T01:00:00Z",
        conversation_id: privateRoom.id,
        user_id,
        kind: "request",
        status: "pending",
        resolved_at: null,
      };
    }
  } finally {
    runtime.dispose();
  }
  if (member) {
    snapshot.state.people[owner.user_id].role = "member";
    snapshot.state.members[room.id][owner.user_id].member_role = "manager";
  }
  validateMemoryState(snapshot.state, owner.org_id);
  await signedInAs(page, {
    id: owner.user_id,
    role: member ? "member" : "admin",
  });
  const key = workspaceSessionSnapshotStorageKey(owner.user_id, owner.org_id);
  const value = serializeSampleSessionSnapshot(
    owner.user_id,
    { "comms-memory-v1": snapshot },
    owner.org_id,
  );
  await page.addInitScript(
    ({ key, value }) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
    },
    { key, value },
  );
  return { owner, conversation: room.id, key };
}
async function openTool(page: Page, name: string) {
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  const admin = page.getByRole("menuitem", { name: /^Admin tools/ });
  await expect(admin).toBeVisible();
  await admin.click();
  const item = page.getByRole("menuitem", {
    name: new RegExp(`^${name}(?: |$)`),
  });
  await expect(item).toBeVisible();
  await item.click();
  const tool = page.getByRole("region", { name, exact: true });
  await expect(tool).toBeVisible();
  return tool;
}

test("admin tools use the main work region and guard a draft on Back and conversation navigation", async ({
  page,
}) => {
  await seedTools(page);
  await page.goto("/comms");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep the conversation draft");
  await openTool(page, "Channel templates");
  await expect(
    page.getByRole("dialog", { name: "Channel templates", exact: true }),
  ).toHaveCount(0);
  const tool = page.getByRole("region", {
    name: "Channel templates",
    exact: true,
  });
  await tool.getByRole("button", { name: /Advanced settings/ }).click();
  await tool
    .getByLabel("Template name", { exact: true })
    .fill("Unfinished template");
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  const discard = page.getByRole("alertdialog", {
    name: "Discard changes?",
    exact: true,
  });
  await expect(discard).toBeVisible();
  await discard
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(tool.getByLabel("Template name", { exact: true })).toHaveValue(
    "Unfinished template",
  );
  await tool
    .getByRole("button", { name: "Back to conversation", exact: true })
    .click();
  await discard
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(composer).toHaveValue("Keep the conversation draft");
});

test("scheduled messages expose Send Now Edit and Cancel on entry without bypassing confirmation", async ({
  page,
}) => {
  await seedTools(page);
  await page.goto("/comms");
  const tool = await openTool(page, "Scheduled messages");
  await expect(
    tool.getByRole("button", { name: "Send Now", exact: true }),
  ).toHaveCount(2);
  await expect(
    tool.getByRole("button", { name: /^Edit scheduled message:/ }),
  ).toHaveCount(2);
  await expect(
    tool.getByRole("button", { name: "Cancel scheduled message", exact: true }),
  ).toHaveCount(2);
  await tool
    .getByRole("group", {
      name: "Scheduled message: Deliver scheduled update",
      exact: true,
    })
    .getByRole("button", { name: "Send Now", exact: true })
    .click();
  await expect(
    tool.getByText("Scheduled message sent.", { exact: true }),
  ).toHaveCount(0);
  await tool
    .getByRole("button", { name: "Confirm Send Now", exact: true })
    .click();
  await expect(
    tool.getByText("Scheduled message sent.", { exact: true }),
  ).toBeVisible();
  await tool
    .getByRole("group", {
      name: "Scheduled message: Cancel this schedule",
      exact: true,
    })
    .getByRole("button", { name: "Cancel scheduled message", exact: true })
    .click();
  await expect(
    tool.getByText("Scheduled message cancelled.", { exact: true }),
  ).toBeVisible();
});

test("moderation starts with reports and recoverable restore, not advanced posting controls", async ({
  page,
}) => {
  await seedTools(page);
  await page.goto("/comms");
  const tool = await openTool(page, "Moderation");
  await expect(
    tool.getByText("Review dispatch wording", { exact: true }),
  ).toBeVisible();
  await expect(
    tool.getByLabel("Restrict person", { exact: true }),
  ).toBeHidden();
  await tool
    .getByRole("button", { name: "Resolve report", exact: true })
    .click();
  await expect(tool.getByText("resolved", { exact: true })).toBeVisible();
  await tool
    .getByRole("button", { name: "Restore message", exact: true })
    .click();
  await expect(
    tool.getByText("Message restored.", { exact: true }),
  ).toBeVisible();
  await expect(
    tool.getByRole("button", { name: "Restore message", exact: true }),
  ).toHaveCount(0);
  await tool.getByRole("button", { name: /Advanced settings/ }).click();
  await tool.getByLabel("Slow mode (seconds)", { exact: true }).fill("3");
  await tool
    .getByRole("button", { name: "Save slow mode", exact: true })
    .click();
  await expect(
    tool.getByText("Moderation settings saved.", { exact: true }),
  ).toBeVisible();
});

test("scheduled messages edit in the regional timezone then send now and cancel through the client", async ({
  page,
}) => {
  const data = await seedTools(page);
  const prefs = profilePreferences(data.owner.user_id);
  await page.route(`**/api/users/${data.owner.user_id}/preferences`, (route) =>
    route.fulfill({
      json: {
        ...prefs,
        appearance: {
          ...prefs.appearance,
          timezone: "America/New_York",
          time_format: "24h",
        },
      },
    }),
  );
  await page.goto("/comms");
  const tool = await openTool(page, "Scheduled messages");
  await tool.getByRole("button", { name: /Deliver scheduled update/ }).click();
  await expect(tool.getByLabel("Scheduled time", { exact: true })).toHaveValue(
    "2099-12-01T07:00",
  );
  await tool
    .getByLabel("Scheduled message", { exact: true })
    .fill("Updated scheduled delivery");
  await tool.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.reload();
  await tool
    .getByRole("button", { name: /Updated scheduled delivery/ })
    .click();
  await expect(tool.getByLabel("Scheduled time", { exact: true })).toHaveValue(
    "2099-12-01T07:00",
  );
  await tool
    .getByRole("button", { name: "Preview scheduled message", exact: true })
    .click();
  await tool
    .getByRole("button", { name: "Confirm Send Now", exact: true })
    .click();
  await expect(
    tool.getByText("Scheduled message sent.", { exact: true }),
  ).toBeVisible();
  await tool.getByRole("button", { name: /Cancel this schedule/ }).click();
  await tool
    .getByRole("group", {
      name: "Scheduled message: Cancel this schedule",
      exact: true,
    })
    .getByRole("button", { name: "Cancel scheduled message", exact: true })
    .click();
  await expect(
    tool.getByText("Scheduled message cancelled.", { exact: true }),
  ).toBeVisible();
});

async function newYorkOutbox(page: Page, scheduledAt: string) {
  const data = await seedTools(page, false, scheduledAt);
  const prefs = profilePreferences(data.owner.user_id);
  await page.route(`**/api/users/${data.owner.user_id}/preferences`, (route) =>
    route.fulfill({
      json: {
        ...prefs,
        appearance: {
          ...prefs.appearance,
          timezone: "America/New_York",
          time_format: "24h",
        },
      },
    }),
  );
  await page.goto("/comms");
  const tool = await openTool(page, "Scheduled messages");
  await tool.getByRole("button", { name: /Deliver scheduled update/ }).click();
  return { ...data, tool };
}

async function savedSchedule(page: Page, key: string, body: string) {
  return page.evaluate(
    ({ key, body }) => {
      const rows: { request: { body: string; send_at: string } }[] =
        Object.values(
          JSON.parse(sessionStorage.getItem(key)!).values["comms-memory-v1"]
            .state.schedules,
        );
      return rows.find((row) => row.request.body === body)?.request.send_at;
    },
    { key, body },
  );
}

test("a body-only edit of an existing fold schedule preserves its exact original instant", async ({
  page,
}) => {
  const original = "2026-11-01T05:30:45.123Z";
  const { tool, key } = await newYorkOutbox(page, original);
  await expect(tool.getByLabel("Scheduled time", { exact: true })).toHaveValue(
    "2026-11-01T01:30",
  );
  await tool
    .getByLabel("Scheduled message", { exact: true })
    .fill("Body edited without changing the instant");
  await tool.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    tool.getByText("Scheduled message saved.", { exact: true }),
  ).toBeVisible();
  expect(
    await savedSchedule(page, key, "Body edited without changing the instant"),
  ).toBe(original);
  await expect(
    tool.getByRole("button", { name: /Deliver scheduled update/ }),
  ).toHaveCount(0);
  await page.reload();
  await tool
    .getByRole("button", { name: /Body edited without changing the instant/ })
    .click();
  await expect(tool.getByLabel("Scheduled time", { exact: true })).toHaveValue(
    "2026-11-01T01:30",
  );
});

test("editing a schedule into a fold requires an offset and a gap refuses without losing the draft", async ({
  page,
}) => {
  const { tool, key } = await newYorkOutbox(page, "2099-12-01T12:00:00Z");
  const input = tool.getByLabel("Scheduled time", { exact: true });
  const body = tool.getByLabel("Scheduled message", { exact: true });
  await body.fill("Explicit later fold occurrence");
  await input.fill("2026-11-01T01:45");
  const offset = tool.getByRole("combobox", {
    name: "Scheduled UTC offset",
    exact: true,
  });
  await expect(offset).toBeVisible();
  await expect(offset).toHaveValue("");
  await tool.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(tool.getByRole("alert")).toContainText("occurs twice");
  expect(await savedSchedule(page, key, "Deliver scheduled update")).toBe(
    "2099-12-01T12:00:00Z",
  );
  await offset.selectOption("-05:00");
  await tool.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    tool.getByText("Scheduled message saved.", { exact: true }),
  ).toBeVisible();
  expect(await savedSchedule(page, key, "Explicit later fold occurrence")).toBe(
    "2026-11-01T06:45:00Z",
  );
  await body.fill("Keep this draft after the nonexistent time");
  await input.fill("2027-03-14T02:30");
  await tool.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(tool.getByRole("alert")).toContainText("does not exist");
  await expect(input).toHaveValue("2027-03-14T02:30");
  await expect(body).toHaveValue("Keep this draft after the nonexistent time");
  expect(await savedSchedule(page, key, "Explicit later fold occurrence")).toBe(
    "2026-11-01T06:45:00Z",
  );
});

test("retention previews the org policy before applying and keeps file overrides in Advanced", async ({
  page,
}) => {
  await seedTools(page);
  await page.goto("/comms");
  const tool = await openTool(page, "Message retention");
  await expect(
    tool.getByLabel("Retention scope", { exact: true }),
  ).toBeHidden();
  await expect(
    tool.getByRole("button", { name: "Preview impact", exact: true }),
  ).toBeDisabled();
  await tool
    .getByRole("checkbox", { name: /^Confirm sample operation/ })
    .check();
  await tool
    .getByLabel("Retention days (0 keeps everything)", { exact: true })
    .fill("7");
  await tool
    .getByRole("button", { name: "Preview impact", exact: true })
    .click();
  await expect(
    tool.getByText(/messages and .* files would be affected/),
  ).toBeVisible();
  await tool
    .getByRole("button", { name: "Apply retention policy", exact: true })
    .click();
  await expect(
    tool.getByText("Retention policy saved.", { exact: true }),
  ).toBeVisible();
  await tool.getByRole("button", { name: /Advanced settings/ }).click();
  await tool
    .getByLabel("File retention days (0 keeps everything)", { exact: true })
    .fill("14");
  await expect(
    tool.getByRole("button", { name: "Apply retention policy", exact: true }),
  ).toHaveCount(0);
  await tool
    .getByRole("button", { name: "Preview impact", exact: true })
    .click();
  await tool
    .getByRole("button", { name: "Apply retention policy", exact: true })
    .click();
  await expect(
    tool.getByText("Retention policy saved.", { exact: true }),
  ).toBeVisible();
});

test("export records format and dates but downloads honest fixed sample CSV and refuses lost bytes", async ({
  page,
}) => {
  await seedTools(page);
  await page.goto("/comms");
  const tool = await openTool(page, "Export messages");
  await expect(tool.getByText(/fixed sample CSV/)).toBeVisible();
  await tool.getByLabel("Export format", { exact: true }).selectOption("xlsx");
  await tool.getByLabel("From date", { exact: true }).fill("2026-01-01");
  await tool.getByLabel("Before date", { exact: true }).fill("2027-01-01");
  await tool.getByRole("button", { name: "Start export", exact: true }).click();
  const download = page.waitForEvent("download");
  await tool
    .getByRole("button", { name: "Download sample CSV", exact: true })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("opencomms-sample.csv");
  expect(await readFile((await file.path())!, "utf8")).toContain(
    '"OpenComms","Local sample export"',
  );
  await page.reload();
  await expect(tool).toBeVisible();
  await tool
    .getByRole("button", { name: "Download sample CSV", exact: true })
    .click();
  await expect(tool.getByRole("alert")).toBeVisible();
});

test("templates apply a saved preview before advanced authoring and preserve invalid JSON", async ({
  page,
}) => {
  await seedTools(page);
  await page.goto("/comms");
  const tool = await openTool(page, "Channel templates");
  await expect(tool.getByLabel("Template name", { exact: true })).toBeHidden();
  await tool
    .getByLabel("Template", { exact: true })
    .selectOption({ label: "Dispatch defaults" });
  await expect(
    tool.getByRole("button", { name: /Advanced settings/ }),
  ).toBeVisible();
  await tool
    .getByRole("button", { name: "Preview changes", exact: true })
    .click();
  await expect(tool.getByText(/mention limit: Inherited → 4/)).toBeVisible();
  await tool
    .getByRole("button", { name: "Apply selected settings", exact: true })
    .click();
  await expect(
    tool.getByText("Selected settings applied.", { exact: true }),
  ).toBeVisible();
  await tool.getByRole("button", { name: /Advanced settings/ }).click();
  await tool
    .getByLabel("Settings JSON", { exact: true })
    .fill('{"unsupported":true}');
  await tool
    .getByRole("button", { name: "Validate import", exact: true })
    .click();
  await expect(tool.getByRole("alert")).toContainText("unsupported fields");
  await expect(tool.getByLabel("Settings JSON", { exact: true })).toHaveValue(
    '{"unsupported":true}',
  );
});

test("join requests approve and decline without opening the invitation editor", async ({
  page,
}) => {
  await seedTools(page);
  await page.goto("/comms");
  const tool = await openTool(page, "Join requests");
  await expect(tool.getByLabel("Invite person", { exact: true })).toBeHidden();
  const noah = tool.getByRole("article", {
    name: "Request from Noah Tan",
    exact: true,
  });
  await noah.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(noah).toContainText("accepted");
  const sofia = tool.getByRole("article", {
    name: "Request from Sofia Garcia",
    exact: true,
  });
  await sofia.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(sofia).toContainText("declined");
});

test("settings history shows before and after then requires an advanced versioned restore preview", async ({
  page,
}) => {
  await seedTools(page);
  await page.goto("/comms");
  const tool = await openTool(page, "Settings history");
  await tool
    .getByRole("button", { name: "Before and after", exact: true })
    .first()
    .click();
  await expect(
    tool.getByText("Inherited → Disabled", { exact: true }),
  ).toBeVisible();
  await expect(
    tool.getByRole("button", { name: "Preview restoration", exact: true }),
  ).toHaveCount(0);
  await tool
    .getByRole("checkbox", { name: /^Confirm sample operation/ })
    .check();
  await tool.getByRole("button", { name: /Advanced settings/ }).click();
  await tool
    .getByLabel("Change to restore", { exact: true })
    .selectOption({ index: 1 });
  await tool
    .getByRole("button", { name: "Preview restoration", exact: true })
    .click();
  await tool
    .getByRole("button", { name: "Confirm restoration", exact: true })
    .click();
  await expect(
    tool.getByText("Configuration restored.", { exact: true }),
  ).toBeVisible();
});

test("a non-admin manager has no Admin tools menu entry", async ({ page }) => {
  await seedTools(page, true);
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Channel settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: /^Admin tools/ }),
  ).toHaveCount(0);
});

test("common admin tasks stay reachable on desktop and phone in light and dark", async ({
  page,
}, testInfo) => {
  const data = await seedTools(page);
  await page.route(`**/api/users/${data.owner.user_id}/preferences`, (route) =>
    route.fulfill({
      json: { ...profilePreferences(data.owner.user_id), theme: "system" },
    }),
  );
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      for (const name of [
        "Moderation",
        "Channel templates",
        "Export messages",
      ]) {
        await page.goto("/comms");
        const tool = await openTool(page, name);
        await expect(
          tool.getByRole("button", { name: /Advanced settings/ }),
        ).toHaveAttribute("aria-expanded", "false");
        await expectNoHorizontalScroll(page);
        if (width === 390) {
          const sizes = await tool.locator("button").evaluateAll((buttons) =>
            buttons
              .filter((button) => button.getClientRects().length > 0)
              .map((button) => ({
                width: button.getBoundingClientRect().width,
                height: button.getBoundingClientRect().height,
              })),
          );
          for (const size of sizes) {
            expect(size.width).toBeGreaterThanOrEqual(44);
            expect(size.height).toBeGreaterThanOrEqual(44);
          }
          if (name !== "Moderation")
            expect(
              await tool
                .getByText("#operations", { exact: true })
                .evaluate((label) => label.getBoundingClientRect().height),
            ).toBeGreaterThanOrEqual(44);
        }
        if (theme === "dark")
          await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
        await page.screenshot({
          path: testInfo.outputPath(`${name}-${width}-${theme}.png`),
          animations: "disabled",
        });
      }
    }
});
