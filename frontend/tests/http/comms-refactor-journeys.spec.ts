import {
  authMeBody,
  defaultOrganization,
  expect,
  heldResponse,
  signedInAs,
  test,
} from "./helpers/test";
import { wireWorkspace } from "../helpers/wire";
import {
  commsDraftTextKey,
  ownedCommsDraftTextId,
} from "../../src/components/systems/comms/state/draft-text";
import { installCommsLiveApi } from "./helpers/comms-live-api";
import { installCommsWorld } from "./helpers/comms-world";
import { createMemorySeed } from "../support/comms-memory/memory/seed";
import { createMemoryCommsRuntime } from "../support/comms-memory/memory-client";
import type { Page } from "@playwright/test";

async function installOwnedJourneyApi(page: Page) {
  const owner = {
    user_id: "00000000-0000-4000-8000-000000000101",
    org_id: defaultOrganization.org_id,
  };
  const runtime = createMemoryCommsRuntime({
    owner,
    initial: createMemorySeed(owner, {
      role: "admin",
      display_name: "Journey owner",
    }),
  });
  return installCommsLiveApi(page, {
    userId: owner.user_id,
    organizationId: owner.org_id,
    runtime,
  });
}

async function createWorkshop(page: Page) {
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: "New channel", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Create channel",
    exact: true,
  });
  await editor
    .getByRole("textbox", { name: "Channel name", exact: true })
    .fill("workshop");
  await editor
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
}

async function populateHistory(page: Page) {
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  for (let index = 0; index < 6; index++) {
    const text = `History ${index}. ${"Retained conversation context. ".repeat(30)}`;
    await input.fill(text);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      page.getByRole("article").filter({ hasText: text }),
    ).toHaveCount(1);
  }
}

test.beforeEach(async ({ page }) => {
  await signedInAs(page, {
    id: "00000000-0000-4000-8000-000000000101",
    role: "admin",
  });
});

test("Comms binds drafts to the admitted organization while the next organization is being verified", async ({
  page,
}) => {
  const userId = "00000000-0000-4000-8000-000000000101";
  const orgA = { ...defaultOrganization, role: "admin" as const };
  const orgB = {
    org_id: "00000000-0000-4000-8000-000000000202",
    name: "Second organization",
    slug: "second",
    role: "admin" as const,
  };
  let current: typeof orgA | typeof orgB = orgA;
  const verification = heldResponse();
  let holdVerification = false;
  const identity = () =>
    authMeBody({
      id: userId,
      role: "admin",
      memberships: [orgA, orgB],
      current_organization: { ...current, access: [] },
    });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: identity() }),
  );
  await page.route("**/api/auth/session", async (route) => {
    if (holdVerification) {
      verification.enter();
      await verification.released;
    }
    await route.fulfill({
      json: {
        authenticated: true,
        user_id: userId,
        organization_id: current.org_id,
        default_organization_blocked: null,
        setup_required: false,
      },
    });
  });
  await page.route("**/api/auth/session/organization", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ org_id: orgB.org_id });
    current = orgB;
    holdVerification = true;
    await route.fulfill({ json: identity() });
  });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: wireWorkspace({
        id: current.org_id,
        display_name: current.name,
        locale: "en-US",
        timezone: "UTC",
        currency: "USD",
        today: "2026-10-19",
        purge_enabled: true,
      }),
    }),
  );
  const serverA = await installCommsLiveApi(page, {
    userId,
    organizationId: orgA.org_id,
    messagePrefix: "Organization A message",
  });
  const serverB = await installCommsLiveApi(page, {
    userId,
    organizationId: orgB.org_id,
    channelName: "second-live-room",
    messagePrefix: "Organization B message",
  });
  serverA.setPresence(userId, "online");
  serverB.setPresence(userId, "away");
  const lateAuthor = "98000000-0000-4000-8000-000000000081";
  serverA.appendQuietly().author_id = lateAuthor;
  serverB.appendQuietly().author_id = lateAuthor;
  const authorReads: string[] = [];
  await page.route(`**/api/users/${lateAuthor}/card`, (route) => {
    const org = route.request().headers()["x-org"];
    authorReads.push(org);
    return org === orgA.org_id
      ? route.fulfill({
          json: {
            display_name: "Scoped late author",
            job_title: null,
            avatar_url: null,
            email: null,
            phone: null,
            bio: null,
          },
        })
      : route.fulfill({ status: 404, json: { detail: "Unavailable" } });
  });
  try {
    await page.goto("/comms");
    const composer = page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill("Organization A private draft");
    await expect(
      page.getByRole("article", { name: /^Message 60: Scoped late author,/ }),
    ).toBeVisible();
    const typer = serverA.members.find((member) => member.user_id !== userId)!;
    const typing = page.getByRole("status", {
      name: "Typing activity",
      exact: true,
    });
    await expect(
      page.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
    serverA.publishTyping(typer.user_id);
    await expect(typing).toContainText(typer.display_name);
    await expect.poll(() => serverA.typingRequests).toEqual([orgA.org_id]);
    await page
      .getByRole("button", { name: "Organization: OpenSlate", exact: true })
      .click();
    await page.getByRole("menuitem", { name: /Second organization/ }).click();
    await verification.entered;
    try {
      await expect(
        page.getByRole("dialog", { name: "Session verification", exact: true }),
      ).toBeVisible();
      await expect(composer).toBeHidden();
      await expect(typing).toBeHidden();
      expect(
        await page.evaluate(
          (key) => sessionStorage.getItem(key),
          commsDraftTextKey(
            ownedCommsDraftTextId(userId, serverB.room, orgB.org_id),
          ),
        ),
      ).toBeNull();
    } finally {
      holdVerification = false;
      verification.release();
    }
    await expect(
      page.getByRole("button", {
        name: "Organization: Second organization",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("link", { name: "OpenComms", exact: true }).click();
    await expect(composer).toHaveValue("");
    await expect(
      page.getByRole("article", { name: /^Message 60: Unavailable person,/ }),
    ).toBeVisible();
    await expect(
      page.getByText("Scoped late author", { exact: true }),
    ).toHaveCount(0);
    expect(authorReads).toEqual([orgA.org_id, orgB.org_id]);
    await expect(typing).toBeEmpty();
    await page.getByRole("button", { name: "Members", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Away members", exact: true }),
    ).toContainText("HTTP fixture owner");
    await page
      .getByRole("button", { name: "Close members", exact: true })
      .click();
    await expect(
      page.getByText("Organization A message 59", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Organization B message 59", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        (key) => sessionStorage.getItem(key),
        commsDraftTextKey(
          ownedCommsDraftTextId(userId, serverA.room, orgA.org_id),
        ),
      ),
    ).toBeNull();
    await composer.fill("Organization B retained draft");
    await expect.poll(() => serverB.typingRequests).toEqual([orgB.org_id]);
    await page.reload();
    await expect(composer).toHaveValue("Organization B retained draft");
  } finally {
    serverA.close();
    serverB.close();
  }
});

test("Comms keeps separate conversation drafts and clears only a successfully sent message", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  await createWorkshop(page);
  await populateHistory(page);
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(message).toBeVisible();
  await message.fill("Operations unsent journey draft");
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await expect(message).toHaveValue("");
  await message.fill("Workshop retained journey draft");
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await expect(message).toHaveValue("Operations unsent journey draft");
  await page.getByLabel("Messages", { exact: true }).evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(message).toHaveValue("");
  await expect(
    page.getByText("Operations unsent journey draft", { exact: true }),
  ).toBeInViewport();
  expect(pageErrors).toEqual([]);
  const sentMessage = page
    .getByRole("article")
    .filter({ hasText: "Operations unsent journey draft" });
  await sentMessage.getByRole("button", { name: /^Message actions: / }).click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Edit message", exact: true })
    .fill("Edited operations journey message");
  await page.getByRole("button", { name: "Save message", exact: true }).click();
  await expect(
    page.getByText("Edited operations journey message", { exact: true }),
  ).toBeVisible();
  const edited = page
    .getByRole("article")
    .filter({ hasText: "Edited operations journey message" });
  await edited.getByRole("button", { name: /^Message actions:/ }).click();
  await page
    .getByRole("menuitem", { name: "Create thread", exact: true })
    .click();
  const thread = page.getByRole("region", {
    name: "Thread conversation",
    exact: true,
  });
  const reply = thread.getByRole("textbox", {
    name: "Thread reply",
    exact: true,
  });
  await reply.fill("Reply owned by the same conversation");
  await thread.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(reply).toHaveValue("");
  await expect(
    thread
      .getByRole("article")
      .filter({ hasText: "Reply owned by the same conversation" }),
  ).toHaveCount(1);
  await thread
    .getByRole("button", { name: "Back to messages", exact: true })
    .click();
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await expect(message).toHaveValue("Workshop retained journey draft");
  await page.reload();
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await expect(message).toHaveValue("Workshop retained journey draft");
});

test("Comms retains a rate-limited send draft and retries once after the real send window", async ({
  page,
}) => {
  const start = new Date("2026-10-19T12:00:00Z");
  // The server owns the 20-send/10-second limit; its clock moves only with the page's.
  const { clock } = await installCommsWorld(page, {
    userId: "00000000-0000-4000-8000-000000000101",
    displayName: "Journey owner",
    clock: { time: start, installPage: false },
  });
  await page.clock.setFixedTime(start);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/comms");
  const composer = page.getByRole("form", {
    name: "Message composer",
    exact: true,
  });
  const draft = composer.getByRole("textbox", { name: "Message", exact: true });
  const send = composer.getByRole("button", {
    name: "Send message",
    exact: true,
  });
  // The limit applies to administrators too.
  for (let index = 1; index <= 20; index++) {
    const body = `Send-window setup ${index}.`;
    await draft.fill(body);
    await send.click();
    await expect(draft).toHaveValue("");
    await expect(
      page.getByRole("article").filter({ hasText: body }),
    ).toHaveCount(1);
  }
  const retained = "Rate-limited draft must be accepted exactly once";
  const message = page.getByRole("article").filter({ hasText: retained });
  await draft.fill(retained);
  await send.click();
  await expect(composer.getByRole("alert")).toHaveText(
    "The message could not be sent. Your draft is still available.",
  );
  await expect(draft).toHaveValue(retained);
  await expect(message).toHaveCount(0);
  await expect(send).toBeEnabled();
  await expect(page.getByText("Not sent", { exact: true })).toBeVisible();

  // Fixed Date changes admission time, not browser timers. Do not edit the draft:
  // the real composer retains its fingerprint/client key across this retry.
  await page.clock.setFixedTime(new Date(start.getTime() + 11_000));
  clock!.set(start.getTime() + 11_000);
  await page
    .getByRole("button", { name: "Retry message", exact: true })
    .click();
  await expect(draft).toHaveValue("");
  await expect(composer.getByRole("alert")).toHaveCount(0);
  await expect(message).toHaveCount(1);
  await page.reload();
  await expect(draft).toHaveValue("");
  await expect(message).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test("Comms preferences keep an editing draft, discard cancelled changes, and persist accepted settings", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  const settings = page.getByRole("dialog", {
    name: "My preferences",
    exact: true,
  });
  const density = settings.getByRole("combobox", {
    name: "Message density",
    exact: true,
  });
  async function openPreferences() {
    await page
      .getByRole("button", { name: "OpenComms menu", exact: true })
      .first()
      .click();
    await page
      .getByRole("menuitem", { name: "My preferences", exact: true })
      .click();
    await settings
      .getByRole("tab", { name: "Appearance", exact: true })
      .click();
  }
  await openPreferences();
  await expect(density).toHaveValue("comfortable");
  await density.selectOption("compact");
  const membership = heldResponse();
  await page.route("**/api/auth/me", async (route) => {
    membership.enter();
    await membership.released;
    await route.fulfill({
      json: authMeBody({
        id: "00000000-0000-4000-8000-000000000101",
        role: "admin",
      }),
    });
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await membership.entered;
  } finally {
    membership.release();
  }
  await expect(density).toHaveValue("compact");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  const discard = page.getByRole("alertdialog", {
    name: "Discard changes?",
    exact: true,
  });
  await discard
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(density).toHaveValue("compact");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await discard
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(settings).toBeHidden();
  await openPreferences();
  await expect(density).toHaveValue("comfortable");
  await density.selectOption("compact");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(settings).toBeHidden();
  await openPreferences();
  await expect(density).toHaveValue("compact");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toBeHidden();
});

test("a partially saved new channel keeps unsaved settings and retries without creating another channel", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: "New channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create channel",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Channel name", exact: true })
    .fill("partial-save-room");
  await dialog
    .getByRole("tab", { name: "Files and records", exact: true })
    .click();
  const maximum = dialog.getByRole("spinbutton", {
    name: "Maximum file size (MB)",
    exact: true,
  });
  // Metadata is valid; the actual settings command refuses the platform's 10 MiB ceiling.
  await maximum.fill("11");
  await dialog
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(
    "Some changes were saved",
  );
  await expect(maximum).toHaveValue("11");
  await maximum.fill("10");
  await dialog
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole("button", { name: /^partial-save-room(,|$)/ });
  await expect(row).toHaveCount(1);
  await page.reload();
  await row.click();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const saved = page.getByRole("dialog", {
    name: "Channel settings",
    exact: true,
  });
  await saved
    .getByRole("tab", { name: "Files and records", exact: true })
    .click();
  await expect(
    saved.getByRole("spinbutton", {
      name: "Maximum file size (MB)",
      exact: true,
    }),
  ).toHaveValue("10");
});

test("a deleted message can be put back from the visible Undo notice", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  await createWorkshop(page);
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Undo journey message");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const sent = page
    .getByRole("article")
    .filter({ hasText: "Undo journey message" });
  await sent.getByRole("button", { name: /^Message actions: / }).click();
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .click();
  await expect(sent).toHaveCount(0);
  const notice = page.getByText("Message deleted.", { exact: true });
  await expect(notice).toBeVisible();
  // Undo still restores the message after the person moves on.
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await expect(sent).toHaveCount(1);
  // A used or dismissed notice clears, so the next delete reports again.
  for (const close of ["Undo", "Dismiss notification"]) {
    await sent.getByRole("button", { name: /^Message actions: / }).click();
    await page
      .getByRole("menuitem", { name: "Delete message", exact: true })
      .click();
    await expect(notice).toBeVisible();
    await page.getByRole("button", { name: close, exact: true }).click();
    await expect(notice).toBeHidden();
    if (close === "Undo") await expect(sent).toHaveCount(1);
  }
});

test("archiving a channel asks first and can be undone", async ({ page }) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  await createWorkshop(page);
  const row = page.getByRole("button", { name: /^workshop(,|$)/ });
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: "Archive #workshop?",
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  await row.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Archive channel", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  await confirm
    .getByRole("button", { name: "Archive channel", exact: true })
    .click();
  await expect(
    page.getByText("#workshop archived.", { exact: true }),
  ).toBeVisible();
  await row.click();
  await expect(
    page.getByText("This channel is archived. Restore it to post."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  // Undo reports what it did, not the archive again.
  await expect(
    page.getByText("#workshop restored.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toHaveCount(0);
});

test("blocking a person asks first; unblocking does not", async ({ page }) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Start direct message", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Start direct message", exact: true })
    .getByRole("combobox", { name: "Person", exact: true })
    .click();
  // The person picker is search-first.
  await page
    .getByRole("combobox", { name: "Search person", exact: true })
    .fill("Noah Tan");
  await page.getByRole("option", { name: "Noah Tan", exact: true }).click();
  await page
    .getByRole("button", { name: "Start conversation", exact: true })
    .click();
  await page.getByRole("button", { name: "Block user", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: /^Block / });
  await expect(confirm).toBeVisible();
  await confirm
    .getByRole("button", { name: "Block user", exact: true })
    .click();
  await expect(confirm).toBeHidden();
  await page.getByRole("button", { name: "Unblock user", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Block user", exact: true }),
  ).toBeVisible();
});

test("Reset to default asks first and says nothing is saved yet", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: "My preferences", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "My preferences" });
  await settings
    .getByRole("button", { name: "Reset to default", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: "Reset your preferences to default?",
  });
  await expect(confirm).toContainText("Nothing is saved until you select");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(settings).toBeVisible();
});

test("the OpenComms menu keeps everyday items up front and admin tools behind one entry", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  // The page heading is plain text, and the menu is a separate button.
  await expect(
    page.getByRole("heading", { name: "OpenComms", level: 1 }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  const menu = page.getByRole("menu", { name: "OpenComms menu" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "My preferences",
    "Browse threads",
    "Channel settings",
    "Category settings",
    "New channel",
    "New category",
    "Admin tools",
  ]);
  await menu.getByRole("menuitem", { name: "Admin tools" }).click();
  const tools = page.getByRole("menu", { name: "Admin tools" });
  await expect(tools.getByRole("menuitem")).toHaveText([
    "Moderation",
    "Scheduled messages",
    "Message retention",
    "Export messages",
    "Workspace settings",
    "Channel templates",
    "Join requests",
    "Settings history",
  ]);
  await tools.getByRole("menuitem", { name: "Moderation" }).click();
  await expect(page.getByRole("region", { name: "Moderation" })).toBeVisible();
});

test("settings history keeps workspace changes visible while a channel is selected", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  async function openTool(name: string) {
    await page
      .getByRole("button", { name: "OpenComms menu", exact: true })
      .first()
      .click();
    await page
      .getByRole("menuitem", { name: "Admin tools", exact: true })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  await openTool("Workspace settings");
  const settings = page.getByRole("dialog", {
    name: "Workspace settings",
    exact: true,
  });
  await settings.getByRole("tab", { name: "Messaging", exact: true }).click();
  await settings.getByRole("button", { name: /Advanced settings/ }).click();
  await settings
    .getByRole("spinbutton", { name: "Slow mode (seconds)", exact: true })
    .fill("1");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(settings).toBeHidden();
  await openTool("Settings history");
  const history = page.getByRole("region", {
    name: "Settings history",
    exact: true,
  });
  await expect(
    history
      .getByRole("article")
      .filter({ hasText: "Changed workspace settings" }),
  ).toHaveCount(1);
});

test("a channel has one settings dialog, reached the same way from its row and its header", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  await createWorkshop(page);
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: "New category", exact: true })
    .click();
  const category = page.getByRole("dialog", {
    name: "Create category",
    exact: true,
  });
  await category
    .getByRole("textbox", { name: "Category name", exact: true })
    .fill("Another category");
  await category
    .getByRole("button", { name: "Create category", exact: true })
    .click();
  await expect(category).toBeHidden();
  const row = page.getByRole("button", { name: /^workshop(,|$)/ });
  await row.click({ button: "right" });
  const rowMenu = page.getByRole("menu", { name: "Channel actions: workshop" });
  await expect(
    rowMenu.getByRole("menuitem", { name: "Channel settings" }),
  ).toHaveCount(1);
  await expect(
    rowMenu.getByRole("menuitem", { name: /^Move to (?!another)/ }),
  ).toHaveCount(0);
  await rowMenu
    .getByRole("menuitem", { name: "Move to another category…" })
    .click();
  const settings = page.getByRole("dialog", { name: "Channel settings" });
  await expect(settings.getByLabel("Category")).toBeVisible();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await row.click();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await expect(
    settings.getByLabel("Channel name", { exact: true }),
  ).toHaveValue("workshop");
});

test("two quick deletes each get their own Undo", async ({ page }) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  await createWorkshop(page);
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  for (const text of ["First quick delete", "Second quick delete"]) {
    await message.fill(text);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
  }
  const article = (text: string) =>
    page.getByRole("article").filter({ hasText: text });
  for (const text of ["First quick delete", "Second quick delete"]) {
    await article(text)
      .getByRole("button", { name: /^Message actions: / })
      .click();
    await page
      .getByRole("menuitem", { name: "Delete message", exact: true })
      .click();
    await expect(article(text)).toHaveCount(0);
  }
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toHaveCount(2);
  await undo.nth(0).click();
  // The used notice can linger while it closes; click the remaining Undo only.
  await expect(undo).toHaveCount(1);
  await undo.nth(0).click();
  await expect(article("First quick delete")).toHaveCount(1);
  await expect(article("Second quick delete")).toHaveCount(1);
});

test("categories carry department identity, and a channel says who can use it", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  await createWorkshop(page);
  await expect(
    page.getByRole("button", { name: /^Service delivery/ }),
  ).toContainText("Operations");
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await expect(
    page.getByRole("button", { name: /^Visible to Dispatch team \./ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await expect(
    page.getByRole("button", {
      name: /^Visible to everyone \./,
    }),
  ).toBeVisible();
});

test("a linked record opens beside the conversation and gives way to a thread", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  const followed = page.getByRole("list", { name: "Records you follow" });
  await followed
    .getByRole("button", { name: /Riverside service visit/ })
    .click();
  const panel = page.getByRole("complementary", { name: "Record" });
  await expect(
    panel.getByRole("heading", { name: "Riverside service visit" }),
  ).toBeVisible();
  await expect(panel).toContainText("Service requests");
  await expect(
    panel.getByRole("link", { name: "Open in OpenView" }),
  ).toHaveAttribute("href", /record=c0440000-0000-4000-8000-00000000000a/);
  await expect(panel.getByRole("list", { name: "Mentioned in" })).toContainText(
    "#operations",
  );
  // A thread takes the same place.
  await page.getByRole("button", { name: /^Thread: Morning handover/ }).click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Thread panel" }),
  ).toBeVisible();
  // The record card in the timeline opens the record again.
  await page
    .getByRole("button", { name: /^Open record: .*Riverside service visit/ })
    .first()
    .click();
  await expect(panel).toBeVisible();
});

test("group access in channel settings changes who the channel says it is for", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  await createWorkshop(page);
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await expect(
    page.getByRole("heading", { name: "workshop", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Channel settings" });
  const access = settings.getByRole("group", { name: "Who can use #workshop" });
  await settings.getByRole("tab", { name: "Access", exact: true }).click();
  await expect(access).toContainText(
    "Saved choices apply to this conversation.",
  );
  const commercial = access.getByRole("radiogroup", { name: "Dispatch team" });
  await commercial.getByText("Read", { exact: true }).click();
  await expect(
    commercial.getByRole("radio", { name: "Read", exact: true }),
  ).toBeChecked();
  await expect(access).toContainText("Guests can only read");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: /^Visible to Dispatch team \./,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await settings.getByRole("tab", { name: "Access", exact: true }).click();
  await settings
    .getByRole("button", { name: "Check one person", exact: true })
    .click();
  const inspector = page.getByRole("dialog", {
    name: "Effective access",
    exact: true,
  });
  await inspector
    .getByLabel("Check access for", { exact: true })
    .selectOption({ label: "Noah Tan" });
  await expect(inspector.getByRole("status")).toContainText(
    "Conversation access: read",
  );
});

test("lowering Everyone keeps what each group can already do", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  await createWorkshop(page);
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await expect(
    page.getByRole("heading", { name: "workshop", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const access = page
    .getByRole("dialog", { name: "Channel settings" })
    .getByRole("group", { name: "Who can use #workshop" });
  await page
    .getByRole("dialog", { name: "Channel settings" })
    .getByRole("tab", { name: "Access", exact: true })
    .click();
  const everyone = access.getByRole("radiogroup", { name: "Everyone" });
  await everyone.getByText("Read and post", { exact: true }).click();
  await everyone.getByText("Read", { exact: true }).click();
  await expect(
    access
      .getByRole("radiogroup", { name: "Dispatch team" })
      .getByRole("radio", { name: "Read and post" }),
  ).toBeChecked();
  await expect(
    everyone.getByRole("radio", { name: "Read", exact: true }),
  ).toBeChecked();
});

test("on a phone, a record's mention closes the record and shows the message", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/comms");
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await page
    .getByRole("button", { name: /^Open record: .*Riverside service visit/ })
    .first()
    .click();
  const record = page.getByRole("dialog", { name: "Record" });
  await expect(record).toBeVisible();
  await record
    .getByRole("list", { name: "Mentioned in" })
    .getByRole("button", { name: /#operations · Noah Tan/ })
    .click();
  await expect(record).toHaveCount(0);
  await expect(
    page.getByText(
      "Two vans are loaded. The spare tool kit is beside dispatch.",
      { exact: true },
    ),
  ).toBeInViewport();
});

test("OpenComms opens at the latest message, with few and meaningful unread marks", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Inspect unread state before opening the now automatically acknowledged feed.
  await page.goto("/comms?view=inbox");
  await expect(
    page
      .getByRole("complementary", { name: "Conversations", exact: true })
      .getByRole("button", { name: /^operations(,|$)/ })
      .getByLabel("2 unread", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("complementary", { name: "Conversations", exact: true })
    .getByRole("button", { name: /^operations(,|$)/ })
    .click();
  await populateHistory(page);
  await page.reload();
  const list = page.getByLabel("Messages", { exact: true });
  await expect
    .poll(() =>
      list.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(40);
  const conversations = page.getByRole("complementary", {
    name: "Conversations",
  });
  // S07 acknowledges only the focused, visible conversation.
  await expect
    .poll(() => conversations.getByLabel(/\d+ unread/, { exact: true }).count())
    .toBeLessThanOrEqual(8);
  await expect(
    page
      .getByRole("button", { name: /^operations(,|$)/ })
      .getByLabel(/\d+ unread/, { exact: true }),
  ).toHaveCount(0);
});

test("each message's actions are named for it and fit its author", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.goto("/comms");
  const buttons = page.getByRole("button", { name: /^Message actions: / });
  const names = await buttons.evaluateAll((items) =>
    items.slice(0, 3).map((item) => item.getAttribute("aria-label")),
  );
  expect(new Set(names).size).toBe(names.length);
  // Someone else's message can be reported, not scheduled.
  await page
    .getByRole("article")
    .filter({ hasText: "Two vans are loaded." })
    .getByRole("button", { name: /^Message actions: / })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Report message" }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Schedule/ })).toHaveCount(0);
});

test("Comms rechecks reaction capabilities when the admitted member becomes a guest", async ({
  page,
}) => {
  const world = await installCommsWorld(page, {
    userId: "00000000-0000-4000-8000-000000000101",
    displayName: "Journey owner",
    role: "member",
  });
  await page.goto("/comms");
  const root = page
    .getByRole("article")
    .filter({ hasText: "Two vans are loaded." });
  await root.getByRole("button", { name: /^Message actions:/ }).click();
  await expect(
    page.getByRole("menuitem", { name: "Add reaction", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  // The server admits the member again as a guest; the reload rereads it.
  await world.setRole("guest", { event: "none" });
  await page.reload();
  await expect(root).toBeVisible();
  await root.getByRole("button", { name: /^Message actions:/ }).click();
  await expect(
    page.getByRole("menuitem", { name: "Add reaction", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "Create thread", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "Report message", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeDisabled();
});

test("category defaults preserve existing members and the saved Permissions summary", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Channel members" }),
  ).toContainText("Members 4");
  // A category's group is chosen in its settings.
  await page
    .getByRole("button", { name: "Category actions: Service delivery" })
    .click();
  await page
    .getByRole("menuitem", { name: "Category settings", exact: true })
    .click();
  const category = page.getByRole("dialog", { name: "Category settings" });
  await category.getByRole("tab", { name: "Access", exact: true }).click();
  await category
    .getByRole("radiogroup", { name: "Everyone", exact: true })
    .getByText("Read and post", { exact: true })
    .click();
  await category
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Category actions: Service delivery" })
    .click();
  await page
    .getByRole("menuitem", { name: "Category settings", exact: true })
    .click();
  await category.getByRole("tab", { name: "Access", exact: true }).click();
  await expect(
    category
      .getByRole("radiogroup", { name: "Everyone", exact: true })
      .getByRole("radio", { name: "Read and post", exact: true }),
  ).toBeChecked();
  await category.getByRole("button", { name: "Cancel", exact: true }).click();
  // Permissions start from groups; exceptions are folded away.
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Channel settings" });
  await settings.getByRole("tab", { name: "Access" }).click();
  await expect(
    settings.getByRole("list", { name: "Access by group" }),
  ).toContainText("Everyone");
  await expect(
    settings.getByText("Capabilities for", { exact: true }),
  ).toBeHidden();
});

test("on a phone, opening a channel from the list shows no error", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/comms");
  await expect(
    page.getByText("Service delivery", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-type="error"]')).toHaveCount(0);
});

test("a channel row names its state, and leaving a channel marks it read", async ({
  page,
}) => {
  await installOwnedJourneyApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await createWorkshop(page);
  await page
    .getByRole("button", { name: /^workshop(,|$)/ })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Mark unread", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "workshop, marked unread", exact: true }),
  ).toBeVisible();
  // Switching right after load saves once, without a conflict.
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await expect(page.locator('[data-type="error"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "workshop", exact: true }),
  ).toBeVisible();
});
