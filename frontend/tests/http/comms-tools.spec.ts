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
import { installCommsLiveApi } from "./helpers/comms-live-api";
import { createMemoryCommsRuntime } from "../support/comms-memory/memory-client";
import { createMemorySeed } from "../support/comms-memory/memory/seed";
import { validateMemoryState } from "../support/comms-memory/memory/snapshot";

const freshPassword = "owned-synthetic-proof";

/**
 * Seeds the fixture server world, then serves it through the live /api routes.
 * A requester is Noah Tan, a member outside private-dispatch with no requests.
 */
async function seedTools(
  page: Page,
  member = false,
  scheduledAt = "2099-12-01T12:00:00Z",
  requester = false,
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
  const clock = () => Date.parse("2026-10-20T00:00:00Z") + tick++;
  const seeding = createMemoryCommsRuntime({ owner, initial }, { clock });
  let snapshot;
  let privateId = "";
  try {
    const client = seeding.client;
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
    snapshot = seeding.exportSnapshot();
    privateId = privateRoom.id;
    for (const [index, user_id] of (requester
      ? []
      : [root.author_id, reply.author_id]
    ).entries()) {
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
    seeding.dispose();
  }
  if (member) {
    snapshot.state.people[owner.user_id].role = "member";
    snapshot.state.members[room.id][owner.user_id].member_role = "manager";
  }
  validateMemoryState(snapshot.state, owner.org_id);
  const actor = requester ? root.author_id : owner.user_id;
  const runtime = createMemoryCommsRuntime(
    { owner: { ...owner, user_id: actor }, initial: snapshot.state },
    {
      clock,
      verifyConfirmation: async (password) => password === freshPassword,
    },
  );
  await signedInAs(page, {
    id: actor,
    role: member || requester ? "member" : "admin",
  });
  const server = await installCommsLiveApi(page, { userId: actor, runtime });
  return { owner, conversation: room.id, privateId, clock, runtime, server };
}
const seedRequester = (page: Page) => seedTools(page, false, undefined, true);
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
  await expect(
    tool.getByText("Scheduled message saved.", { exact: true }),
  ).toBeVisible();
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

/** Reads the stored instant from the fixture server, not the browser. */
async function savedSchedule(
  runtime: ReturnType<typeof createMemoryCommsRuntime>,
  body: string,
) {
  const rows = Object.values(runtime.exportSnapshot().state.schedules);
  return rows.find((row) => row.request.body === body)?.request.send_at;
}

test("a body-only edit of an existing fold schedule preserves its exact original instant", async ({
  page,
}) => {
  const original = "2026-11-01T05:30:45.123Z";
  const { tool, runtime } = await newYorkOutbox(page, original);
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
    await savedSchedule(runtime, "Body edited without changing the instant"),
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
  const { tool, runtime } = await newYorkOutbox(page, "2099-12-01T12:00:00Z");
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
  expect(await savedSchedule(runtime, "Deliver scheduled update")).toBe(
    "2099-12-01T12:00:00Z",
  );
  await offset.selectOption("-05:00");
  await tool.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    tool.getByText("Scheduled message saved.", { exact: true }),
  ).toBeVisible();
  expect(await savedSchedule(runtime, "Explicit later fold occurrence")).toBe(
    "2026-11-01T06:45:00Z",
  );
  await body.fill("Keep this draft after the nonexistent time");
  await input.fill("2027-03-14T02:30");
  await tool.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(tool.getByRole("alert")).toContainText("does not exist");
  await expect(input).toHaveValue("2027-03-14T02:30");
  await expect(body).toHaveValue("Keep this draft after the nonexistent time");
  expect(await savedSchedule(runtime, "Explicit later fold occurrence")).toBe(
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
    .getByLabel("Current password", { exact: true })
    .fill(freshPassword);
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
    .getByLabel("Current password", { exact: true })
    .fill(freshPassword);
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
    .getByLabel("Current password", { exact: true })
    .fill(freshPassword);
  await tool
    .getByRole("button", { name: "Preview impact", exact: true })
    .click();
  await tool
    .getByLabel("Current password", { exact: true })
    .fill(freshPassword);
  await tool
    .getByRole("button", { name: "Apply retention policy", exact: true })
    .click();
  await expect(
    tool.getByText("Retention policy saved.", { exact: true }),
  ).toBeVisible();
});

test("export starts a job with its format and dates and downloads its file", async ({
  page,
}) => {
  const { server } = await seedTools(page);
  await page.goto("/comms");
  const tool = await openTool(page, "Export messages");
  await tool.getByLabel("Export format", { exact: true }).selectOption("xlsx");
  await tool.getByLabel("From date", { exact: true }).fill("2026-01-01");
  await tool.getByLabel("Before date", { exact: true }).fill("2027-01-01");
  await tool.getByRole("button", { name: "Start export", exact: true }).click();
  const download = page.waitForEvent("download");
  await tool
    .getByRole("button", { name: "Download export", exact: true })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("opencomms-sample.csv");
  expect(await readFile((await file.path())!, "utf8")).toContain(
    '"OpenComms","Local sample export"',
  );
  expect(
    server.requests.filter(
      (request) => request.method === "POST" && request.path === "/exports",
    ),
  ).toHaveLength(1);
});

test("templates apply a saved preview before advanced authoring and preserve invalid JSON", async ({
  page,
}) => {
  const { server } = await seedTools(page);
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
  expect(
    server.requests.find((request) =>
      /^\/templates\/[^/]+\/applications$/.test(request.path),
    )?.ifMatch,
  ).toMatch(/^"[^"]+"$/);
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

test("a template changed by someone else refuses the stale save and keeps the draft", async ({
  page,
}) => {
  const { server } = await seedTools(page);
  await page.goto("/comms");
  const tool = await openTool(page, "Channel templates");
  await tool
    .getByLabel("Template", { exact: true })
    .selectOption({ label: "Dispatch defaults" });
  await tool.getByRole("button", { name: /Advanced settings/ }).click();
  const name = tool.getByLabel("Template name", { exact: true });
  await expect(name).toHaveValue("Dispatch defaults");
  await name.fill("Dispatch defaults, revised");
  server.conflictNextWrite(/^\/templates\/[^/]+$/);
  await tool
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(tool.getByRole("alert")).toContainText(
    "changed this after you opened it",
  );
  await expect(name).toHaveValue("Dispatch defaults, revised");
  const save = server.requests.find(
    (request) =>
      request.method === "PUT" && /^\/templates\/[^/]+$/.test(request.path),
  );
  expect(save?.ifMatch).toMatch(/^"[^"]+"$/);
});

test("a stale template preview is refused on apply and must be previewed again", async ({
  page,
}) => {
  const { server } = await seedTools(page);
  await page.goto("/comms");
  const tool = await openTool(page, "Channel templates");
  await tool
    .getByLabel("Template", { exact: true })
    .selectOption({ label: "Dispatch defaults" });
  await tool
    .getByRole("button", { name: "Preview changes", exact: true })
    .click();
  const apply = tool.getByRole("button", {
    name: "Apply selected settings",
    exact: true,
  });
  await expect(apply).toBeVisible();
  server.conflictNextWrite(/^\/templates\/[^/]+\/applications$/);
  await apply.click();
  await expect(tool.getByRole("alert")).toContainText(
    "Preview the current state again.",
  );
  await expect(apply).toHaveCount(0);
});

test("join requests approve and decline without opening the invitation editor", async ({
  page,
}) => {
  const { server } = await seedTools(page);
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
  const decisions = server.requests.filter((request) =>
    request.path.endsWith("/decision"),
  );
  expect(decisions.map((request) => request.ifMatch)).toEqual([
    expect.stringMatching(/^"[^"]+"$/),
    expect.stringMatching(/^"[^"]+"$/),
  ]);
});

test("join requests name a requester outside every loaded conversation through the authorized person card", async ({
  page,
  context,
}) => {
  const { owner, privateId, clock, runtime } = await seedTools(page);
  const state = runtime.exportSnapshot().state;
  await page.close();
  const outsider = "78000000-0000-4000-8000-000000000081";
  const refused = "78000000-0000-4000-8000-000000000082";
  for (const [index, user_id] of [outsider, refused].entries()) {
    state.people[user_id] = {
      user_id,
      org_id: owner.org_id,
      display_name: "Not from the card",
      role: "member",
      active: true,
      group_ids: [],
      department_levels: {},
      readable_module_ids: [],
    };
    state.users[user_id] = {
      personal: structuredClone(state.users[owner.user_id].personal),
      conversations: {},
      categories: {},
      last_read_seq: {},
      followed_thread_ids: [],
      notifications: [],
    };
    const id = `78000000-0000-4000-8000-00000000009${index}`;
    state.admissions[id] = {
      id,
      org_id: owner.org_id,
      created_at: "2026-10-19T02:00:00Z",
      updated_at: "2026-10-19T02:00:00Z",
      conversation_id: privateId,
      user_id,
      kind: "request",
      status: "pending",
      resolved_at: null,
    };
  }
  validateMemoryState(state, owner.org_id);
  const adminPage = await context.newPage();
  await signedInAs(adminPage, { id: owner.user_id, role: "admin" });
  await installCommsLiveApi(adminPage, {
    userId: owner.user_id,
    runtime: createMemoryCommsRuntime({ owner, initial: state }, { clock }),
  });
  const reads: { id: string; org: string | undefined }[] = [];
  const directory: string[] = [];
  adminPage.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/users")
      directory.push(request.url());
  });
  await adminPage.route("**/api/users/*/card", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    reads.push({ id, org: route.request().headers()["x-org"] });
    if (id !== outsider)
      return route.fulfill({ status: 404, json: { detail: "Not found" } });
    return route.fulfill({
      headers: { "Cache-Control": "private, no-store" },
      json: {
        display_name: "Ines Valdez",
        job_title: null,
        avatar_url: null,
        email: null,
        phone: null,
        bio: null,
      },
    });
  });
  await adminPage.goto("/comms");
  const tool = await openTool(adminPage, "Join requests");
  await expect(
    tool
      .getByRole("article", { name: "Request from Ines Valdez", exact: true })
      .filter({ hasText: "#private-dispatch" }),
  ).toBeVisible();
  await expect(
    tool.getByRole("article", {
      name: "Request from Unavailable person",
      exact: true,
    }),
  ).toBeVisible();
  // Loaded members keep their names without a card read.
  await expect(
    tool.getByRole("article", { name: "Request from Noah Tan", exact: true }),
  ).toBeVisible();
  await expect(tool.getByText(/Not from the card/)).toHaveCount(0);
  expect([...new Set(reads.map((read) => read.id))].sort()).toEqual([
    outsider,
    refused,
  ]);
  expect(reads.every((read) => read.org === owner.org_id)).toBe(true);
  expect(directory).toEqual([]);
});

test("a member requests to join a private channel from its link and the admin queue shows the request", async ({
  page,
  context,
}) => {
  const { owner, privateId, clock, runtime } = await seedRequester(page);
  await page.goto(`/comms?conversation=${privateId}`);
  await expect(
    page.getByText("This conversation is not available", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("form", { name: "Message composer", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Your role cannot post in this channel.", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Request to join", exact: true })
    .click();
  await expect(
    page.getByText(
      "Request sent. If this channel accepts requests, its managers will see it.",
      { exact: true },
    ),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Request to join", exact: true }),
  ).toHaveCount(0);
  const state = runtime.exportSnapshot().state;
  expect(
    Object.values(state.admissions).map(
      ({ conversation_id, kind, status }) => ({
        conversation_id,
        kind,
        status,
      }),
    ),
  ).toEqual([
    { conversation_id: privateId, kind: "request", status: "pending" },
  ]);
  await page.close();
  const adminPage = await context.newPage();
  await signedInAs(adminPage, { id: owner.user_id, role: "admin" });
  await installCommsLiveApi(adminPage, {
    userId: owner.user_id,
    runtime: createMemoryCommsRuntime({ owner, initial: state }, { clock }),
  });
  await adminPage.goto("/comms");
  const tool = await openTool(adminPage, "Join requests");
  await expect(
    tool.getByRole("article", { name: "Request from Noah Tan", exact: true }),
  ).toBeVisible();
});

test("a channel created with no group access takes join requests that its managers see", async ({
  page,
  context,
}) => {
  const { owner, clock, runtime } = await seedTools(page);
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create channel",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Channel name", exact: true })
    .fill("request-room");
  await dialog.getByRole("tab", { name: "Access", exact: true }).click();
  for (const row of ["Everyone", "Dispatch team"])
    await dialog
      .getByRole("radiogroup", { name: row, exact: true })
      .getByText("No access", { exact: true })
      .click();
  await dialog
    .getByRole("searchbox", { name: "Search settings", exact: true })
    .fill("Channel joining");
  await dialog
    .getByRole("combobox", { name: "Channel joining", exact: true })
    .selectOption("request");
  await dialog
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const created = runtime.exportSnapshot().state;
  const roomId = Object.values(created.conversations).find(
    (row) => row.kind === "channel" && row.name === "request-room",
  )!.id;
  const noah = Object.values(created.people).find(
    (person) => person.display_name === "Noah Tan",
  )!.user_id;
  await page.close();
  const requesterPage = await context.newPage();
  await signedInAs(requesterPage, { id: noah, role: "member" });
  const requester = createMemoryCommsRuntime(
    { owner: { ...owner, user_id: noah }, initial: created },
    { clock },
  );
  await installCommsLiveApi(requesterPage, {
    userId: noah,
    runtime: requester,
  });
  await requesterPage.goto(`/comms?conversation=${roomId}`);
  await requesterPage
    .getByRole("button", { name: "Request to join", exact: true })
    .click();
  await expect(
    requesterPage.getByText(
      "Request sent. If this channel accepts requests, its managers will see it.",
      { exact: true },
    ),
  ).toBeFocused();
  const requested = requester.exportSnapshot().state;
  await requesterPage.close();
  const adminPage = await context.newPage();
  await signedInAs(adminPage, { id: owner.user_id, role: "admin" });
  await installCommsLiveApi(adminPage, {
    userId: owner.user_id,
    runtime: createMemoryCommsRuntime({ owner, initial: requested }, { clock }),
  });
  await adminPage.goto("/comms");
  const tool = await openTool(adminPage, "Join requests");
  await expect(
    tool
      .getByRole("article", { name: "Request from Noah Tan", exact: true })
      .filter({ hasText: "#request-room" }),
  ).toBeVisible();
});

test("an unknown conversation link offers the same request and confirmation and retries a failed send", async ({
  page,
}) => {
  const { runtime, server } = await seedRequester(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let sends = 0;
  await page.route("**/api/comms/join-requests", async (route) => {
    sends += 1;
    if (sends === 1) return route.abort();
    await held;
    return route.fallback();
  });
  await page.goto(`/comms?conversation=${crypto.randomUUID()}`);
  await expect(
    page.getByText("This conversation is not available", { exact: true }),
  ).toBeVisible();
  const request = page.getByRole("button", {
    name: "Request to join",
    exact: true,
  });
  await request.click();
  await expect(
    page.getByText(
      "The request could not be sent. Select Request to join to try again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(request).toBeFocused();
  await request.click();
  await expect(request).toBeDisabled();
  await request.press("Enter");
  release();
  await expect(
    page.getByText(
      "Request sent. If this channel accepts requests, its managers will see it.",
      { exact: true },
    ),
  ).toBeFocused();
  expect(
    server.requests.filter((item) => item.path === "/join-requests"),
  ).toHaveLength(1);
  expect(runtime.exportSnapshot().state.admissions).toEqual({});
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
    .getByLabel("Current password", { exact: true })
    .fill(freshPassword);
  await tool.getByRole("button", { name: /Advanced settings/ }).click();
  await tool
    .getByLabel("Change to restore", { exact: true })
    .selectOption({ index: 1 });
  await tool
    .getByRole("button", { name: "Preview restoration", exact: true })
    .click();
  await tool
    .getByLabel("Current password", { exact: true })
    .fill(freshPassword);
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
