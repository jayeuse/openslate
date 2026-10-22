import { expect, test, heldResponse, settleReact } from "./helpers/test";
import { installCommsLiveApi } from "./helpers/comms-live-api";
import type { Page } from "@playwright/test";

async function delayedStartup(page: Page) {
  // Only verified base-fixture GETs may fall through. Even when the asset server
  // is the owned dev origin, an unexpected API call must never reach its backend.
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    const shellRead =
      path === "/api/workspace/appearance" ||
      (!url.search &&
        ([
          "/api/auth/session",
          "/api/auth/me",
          "/api/workspace",
          "/api/notifications/unread-count",
        ].includes(path) ||
          /^\/api\/users\/[0-9a-f-]{36}\/preferences$/.test(path)));
    return route.request().method() === "GET" && shellRead
      ? route.fallback()
      : route.fulfill({
          status: 501,
          json: { detail: "Unconfigured owned HTTP fixture" },
        });
  });
  const server = await installCommsLiveApi(page);
  const catalog = heldResponse(),
    refresh = heldResponse();
  let bootstrapReads = 0;
  server.pauseJoins(true);
  await page.route("**/api/access/groups?**", async (route) => {
    catalog.enter();
    await catalog.released;
    return route.fallback();
  });
  await page.route("**/api/comms/bootstrap", async (route) => {
    if (++bootstrapReads > 1) {
      refresh.enter();
      await refresh.released;
    }
    return route.fallback();
  });
  return {
    server,
    catalog,
    refresh,
    release() {
      catalog.release();
      refresh.release();
      server.pauseJoins(false);
    },
  };
}

test("the first Create channel click after reload survives a held lazy editor load", async ({
  page,
}) => {
  const startup = await delayedStartup(page);
  const chunk = heldResponse();
  try {
    await page.goto(`/comms?conversation=${startup.server.room}`);
    const create = page.getByRole("button", {
      name: "Create channel",
      exact: true,
    });
    await expect(create).toBeVisible();
    // The access catalog is an on-demand read now, so cold load never asks for it.
    startup.release();
    await page.reload();
    await expect(create).toBeVisible();
    // Select the actual lazy editor response, not a build-specific chunk hash.
    await page.route("**/_next/static/**/*.js", async (route) => {
      const response = await route.fetch();
      const body = await response.body();
      if (body.toString().includes("No editor changes prepared")) {
        chunk.enter();
        await chunk.released;
      }
      await route.fulfill({ response, body });
    });
    await create.click();
    await chunk.entered;
    startup.release();
    const editor = page.getByRole("dialog", {
      name: "Create channel",
      exact: true,
    });
    // While the editor code is still held, the first click already shows its
    // dialog, and the workspace stays mounted instead of becoming a skeleton.
    await expect(editor.getByRole("status")).toHaveText("Loading editor…");
    await expect(
      page.getByRole("complementary", {
        name: "Conversations",
        exact: true,
        includeHidden: true,
      }),
    ).toBeVisible();
    chunk.release();
    await expect(editor).toBeVisible();
    await expect(
      editor.getByRole("textbox", { name: "Channel name", exact: true }),
    ).toBeEnabled();
  } finally {
    startup.release();
    chunk.release();
    await page.close();
    startup.server.close();
  }
});

test("the first Enter after reload retains its exact draft until one real message POST is acknowledged", async ({
  page,
}, testInfo) => {
  const startup = await delayedStartup(page);
  // First inspect the owner's ordinary cold-load sequence; the previous held
  // startup experiment dispatched once and retained its draft without a receipt.
  startup.release();
  const receipt = heldResponse();
  const posts: Record<string, unknown>[] = [];
  const body = "First cold draft text";
  try {
    await page.clock.install();
    await page.route(
      `**/api/comms/conversations/${startup.server.room}/messages`,
      async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        posts.push(route.request().postDataJSON());
        receipt.enter();
        await receipt.released;
        return route.fallback();
      },
    );
    await page.goto(`/comms?conversation=${startup.server.room}`);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toBeEnabled();
    await page.reload();
    await expect(input).toBeEnabled();
    await page.clock.runFor(3_000);
    await input.fill(body);
    await expect(input).toHaveValue(body);
    await input.press("Enter");
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({
      body,
      reply_to_id: null,
      attachment_ids: [],
      record_ids: [],
    });
    expect(posts[0].client_key).toMatch(/^[0-9a-f-]{36}$/);
    await expect(input).toHaveValue(body);
    startup.release();
    await settleReact(page);
    await expect(input).toHaveValue(body);
    expect(posts).toHaveLength(1);
    receipt.release();
    await expect(page.getByText(body, { exact: true })).toBeVisible();
    expect([body, ""]).toContain(await input.inputValue());
    expect(posts).toHaveLength(1);
  } finally {
    await testInfo.attach("first-submit ownership", {
      body: JSON.stringify({
        posts,
        draft: await page
          .getByRole("textbox", { name: "Message", exact: true })
          .inputValue()
          .catch(() => null),
      }),
      contentType: "application/json",
    });
    startup.release();
    receipt.release();
    await page.close();
    startup.server.close();
  }
});
