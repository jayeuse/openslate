import {
  authMeBody,
  defaultOrganization,
  expect,
  signedInAs,
  test,
} from "./helpers/test";
import type { Page } from "@playwright/test";
import { wireWorkspace } from "../helpers/wire";
import { createMemorySeed } from "../support/comms-memory/memory/seed";
import { createMemoryCommsRuntime } from "../support/comms-memory/memory-client";
import { installCommsLiveApi } from "./helpers/comms-live-api";

const userId = "00000000-0000-4000-8000-000000000101";
test.beforeEach(async ({ page }) => {
  await signedInAs(page, { id: userId, role: "admin" });
  const owner = { user_id: userId, org_id: defaultOrganization.org_id };
  await installCommsLiveApi(page, {
    userId,
    organizationId: owner.org_id,
    runtime: createMemoryCommsRuntime({
      owner,
      initial: createMemorySeed(owner, {
        role: "admin",
        display_name: "URL owner",
      }),
    }),
  });
});

async function createChannel(page: Page) {
  await page
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Create channel",
    exact: true,
  });
  await editor
    .getByRole("textbox", { name: "Channel name", exact: true })
    .fill("url-workshop");
  await editor
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(editor).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "url-workshop", exact: true }),
  ).toBeVisible();
}

test("Comms message deep links survive Back and Forward without pinning later conversation selection", async ({
  page,
}) => {
  await page.goto("/comms");
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("A message reached by a shareable link");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const target = page
    .getByRole("article")
    .filter({ hasText: "A message reached by a shareable link" });
  await expect(target).toHaveCount(1);
  const id = await target.getAttribute("id");
  expect(id).not.toBeNull();
  await createChannel(page);
  await page.goto(`/comms?message=${encodeURIComponent(id!)}`);
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
  await expect(
    page.getByRole("heading", { name: "operations", exact: true }),
  ).toBeVisible();
  await draft.fill("Keep the source conversation draft");
  await page.getByRole("button", { name: /^url-workshop(,|$)/ }).click();
  await expect(page).toHaveURL(/\/comms\?conversation=[^&]+$/);
  await expect(draft).toHaveValue("");
  await expect(target).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`message=${id}`));
  await expect(target).toBeFocused();
  await expect(draft).toHaveValue("Keep the source conversation draft");
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "url-workshop", exact: true }),
  ).toBeVisible();
  await expect(target).toHaveCount(0);
});

test("Comms replaces panel toggles and restores thread and tool destinations from the URL", async ({
  page,
}) => {
  await page.goto("/comms");
  await createChannel(page);
  const conversationUrl = page.url();
  await expect(page).toHaveURL(/conversation=/);
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(page).toHaveURL(/panel=members/);
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(page).toHaveURL(/panel=none/);
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(page).toHaveURL(/panel=members/);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "operations", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("complementary", { name: "Channel members", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "url-workshop", exact: true }),
  ).toBeVisible();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Thread route root");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const root = page
    .getByRole("article")
    .filter({ hasText: "Thread route root" });
  await root.getByRole("button", { name: /^Message actions:/ }).click();
  await page
    .getByRole("menuitem", { name: "Create thread", exact: true })
    .click();
  await expect(page).toHaveURL(/thread=/);
  await page.reload();
  const thread = page.getByRole("region", {
    name: "Thread conversation",
    exact: true,
  });
  await expect(thread).toBeVisible();
  await expect(
    thread.getByText("Thread route root", { exact: true }),
  ).toBeVisible();
  await thread
    .getByRole("button", { name: "Back to messages", exact: true })
    .click();
  await expect(page).not.toHaveURL(/thread=/);
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: "Admin tools", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Moderation", exact: true }).click();
  await expect(page).toHaveURL(/tool=moderation/);
  await page.reload();
  const tool = page.getByRole("region", { name: "Moderation", exact: true });
  await expect(tool).toBeVisible();
  await tool
    .getByRole("button", { name: "Back to conversation", exact: true })
    .click();
  await expect(page).not.toHaveURL(/tool=/);
  expect(new URL(page.url()).searchParams.get("conversation")).toBe(
    new URL(conversationUrl).searchParams.get("conversation"),
  );
});

test("Comms mobile Escape dismisses a reply-only deep link without reopening it on reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/comms");
  await createChannel(page);
  const conversationId = new URL(page.url()).searchParams.get("conversation");
  expect(conversationId).not.toBeNull();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Root for the mobile reply link");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const root = page
    .getByRole("article")
    .filter({ hasText: "Root for the mobile reply link" });
  const rootId = await root.getAttribute("id");
  await root.getByRole("button", { name: /^Message actions:/ }).click();
  await page
    .getByRole("menuitem", { name: "Create thread", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Thread", exact: true });
  await dialog
    .getByRole("textbox", { name: "Thread reply", exact: true })
    .fill("Reply reached without an explicit conversation or thread");
  await dialog.getByRole("button", { name: "Send reply", exact: true }).click();
  const reply = dialog.getByRole("article").filter({
    hasText: "Reply reached without an explicit conversation or thread",
  });
  await expect(reply).toHaveCount(1);
  const replyId = await reply.getAttribute("id");
  expect(replyId).not.toBeNull();

  await page.goto(`/comms?message=${encodeURIComponent(replyId!)}`);
  await expect(dialog).toBeVisible();
  await expect(reply).toBeInViewport();
  // Escape invokes the generic Dialog onOpenChange, not Back to messages.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("conversation") === conversationId &&
      url.searchParams.get("panel") === "none" &&
      url.searchParams.get("message") === rootId &&
      !url.searchParams.has("thread"),
  );
  await expect(root).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "url-workshop", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "url-workshop", exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
});

test("Comms does not substitute content for unknown or another organization's conversation link", async ({
  page,
}) => {
  const orgA = { ...defaultOrganization, role: "admin" as const };
  const orgB = {
    org_id: "00000000-0000-4000-8000-000000000202",
    name: "Other organization",
    slug: "other",
    role: "admin" as const,
  };
  let current: typeof orgA | typeof orgB = orgA;
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
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: userId,
        organization_id: current.org_id,
        default_organization_blocked: null,
        setup_required: false,
      },
    }),
  );
  await page.route("**/api/auth/session/organization", (route) => {
    current = orgB;
    return route.fulfill({ json: identity() });
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
  const otherOwner = { user_id: userId, org_id: orgB.org_id };
  await installCommsLiveApi(page, {
    userId,
    organizationId: otherOwner.org_id,
    runtime: createMemoryCommsRuntime({
      owner: otherOwner,
      initial: createMemorySeed(otherOwner, {
        role: "admin",
        display_name: "Other organization owner",
      }),
    }),
  });
  await page.goto("/comms?conversation=unknown-conversation");
  await expect(
    page.getByText("This conversation is not available.", { exact: true }),
  ).toBeVisible();
  // The header stays neutral too: no hint that a private conversation exists.
  await expect(
    page.getByRole("heading", {
      name: "Conversation not available",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Private conversation", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveCount(0);
  await page.goto("/comms");
  await createChannel(page);
  const foreignLink = page.url();
  await page
    .getByRole("button", { name: "Organization: OpenSlate", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /Other organization/ }).click();
  await expect(
    page.getByRole("button", {
      name: "Organization: Other organization",
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(foreignLink);
  await expect(
    page.getByText("This conversation is not available.", { exact: true }),
  ).toBeVisible();
  // The same state for any unavailable id, with no way to ask for access (D44).
  await expect(
    page.getByText("It may have been removed, or you may not have access.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Request to join", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "url-workshop", exact: true }),
  ).toHaveCount(0);
});
