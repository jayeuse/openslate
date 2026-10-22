import {
  expect,
  test,
  defaultOrganization,
  defaultSignedInIdentity,
  expectNoHorizontalScroll,
  signedInAs,
} from "./helpers/test";
import { installCommsLiveApi } from "./helpers/comms-live-api";
import { createMemoryCommsRuntime } from "../support/comms-memory/memory-client";
import { createMemorySeed } from "../support/comms-memory/memory/seed";
import { profilePreferences } from "./helpers/profile-api";

test("an empty organization can open its first channel and category from workspace authority", async ({
  page,
}) => {
  const checks: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname ===
      "/api/comms/capabilities/channel-creation"
    )
      checks.push(request.headers()["x-org"]);
  });
  const server = await installCommsLiveApi(page, { empty: true });
  try {
    await page.goto("/comms");
    const list = page.getByRole("complementary", {
      name: "Conversations",
      exact: true,
    });
    // The empty list guides an admin to a labelled first channel action.
    const start = list.getByRole("region", {
      name: "No channels yet",
      exact: true,
    });
    await expect(
      start.getByText("Create the first channel for this organization.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      start.getByRole("button", { name: "Create channel", exact: true }),
    ).toHaveText("Create channel");
    await start
      .getByRole("button", { name: "Create channel", exact: true })
      .click();
    const channel = page.getByRole("dialog", {
      name: "Create channel",
      exact: true,
    });
    await expect(channel).toBeVisible();
    await expect(
      channel.getByRole("textbox", { name: "Channel name", exact: true }),
    ).toBeEnabled();
    await channel.getByRole("button", { name: "Cancel", exact: true }).click();
    // Create channel is the one list action while the list is empty; a
    // category stays reachable from the menu.
    await expect(
      list.getByRole("button", { name: "Create category", exact: true }),
    ).toHaveCount(0);
    await list
      .getByRole("button", { name: "OpenComms menu", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "New channel", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Admin tools", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New category", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("menuitem", { name: "New category", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Create category", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog", { name: "Create category", exact: true })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((org) => org === defaultOrganization.org_id)).toBe(
      true,
    );
  } finally {
    await page.close();
    server.close();
  }
});

for (const row of [
  {
    role: "member",
    title: "No channels yet",
    guidance: "Channels you can read appear here.",
    startsDirect: true,
  },
  // A guest cannot start a conversation (D3), so nothing points them there.
  {
    role: "guest",
    title: "No conversations yet",
    guidance: "Channels you can read appear here.",
    startsDirect: false,
  },
] as const)
  test(`an empty organization guides a ${row.role} who cannot create channels`, async ({
    page,
  }) => {
    await signedInAs(page, { id: defaultSignedInIdentity.id, role: row.role });
    const server = await installCommsLiveApi(page, {
      empty: true,
      role: row.role,
    });
    // A guest's role check that fails never falls back to member actions.
    if (!row.startsDirect)
      await page.route("**/api/comms/capabilities/channel-creation*", (route) =>
        route.fulfill({ status: 500, json: { detail: "unavailable" } }),
      );
    try {
      await page.goto("/comms");
      const list = page.getByRole("complementary", {
        name: "Conversations",
        exact: true,
      });
      const start = list.getByRole("region", {
        name: row.startsDirect
          ? row.title
          : /^No (channels|conversations) yet$/,
      });
      await expect(
        start.getByText(row.guidance, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Create channel", exact: true }),
      ).toHaveCount(0);
      const direct = list.getByRole("button", {
        name: "Start direct message",
        exact: true,
      });
      if (row.startsDirect) {
        // The empty state offers the one thing a member can start.
        await start
          .getByRole("button", { name: "Start direct message", exact: true })
          .click();
        await expect(
          page.getByRole("dialog", {
            name: "Start direct message",
            exact: true,
          }),
        ).toBeVisible();
      } else {
        await expect(direct).toHaveCount(0);
        await expect(
          page.getByText(/start a (direct |group )?(conversation|message)/i),
        ).toHaveCount(0);
      }
    } finally {
      await page.close();
      server.close();
    }
  });

test("channels that are all hidden point to Browse channels, with 44px list actions on a phone", async ({
  page,
}) => {
  const owner = {
    user_id: defaultSignedInIdentity.id,
    org_id: defaultOrganization.org_id,
  };
  const runtime = createMemoryCommsRuntime({
    owner,
    initial: createMemorySeed(owner, {
      role: "admin",
      display_name: "HTTP fixture owner",
    }),
  });
  const { conversations } = await runtime.client.bootstrap();
  for (const { conversation } of conversations)
    if (conversation.kind === "channel")
      await runtime.client.updateMemberPreferences(conversation.id, {
        hidden: true,
      });
  const server = await installCommsLiveApi(page, { runtime });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/comms");
    const list = page.getByRole("complementary", {
      name: "Conversations",
      exact: true,
    });
    await expect(
      list.getByText("Channels are hidden. Browse channels to show them.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      list.getByRole("region", { name: "No channels yet", exact: true }),
    ).toHaveCount(0);
    for (const name of ["Create channel", "Start direct message"]) {
      const box = await list
        .getByRole("button", { name, exact: true })
        .boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  } finally {
    await page.close();
    server.close();
  }
});

test("no selected conversation shows a plain chooser without errors actions or composer", async ({
  page,
}, testInfo) => {
  const server = await installCommsLiveApi(page, { empty: true });
  await page.route(
    `**/api/users/${defaultSignedInIdentity.id}/preferences`,
    (route) =>
      route.fulfill({
        json: {
          ...profilePreferences(defaultSignedInIdentity.id),
          theme: "system",
        },
      }),
  );
  try {
    await page.goto("/comms");
    await expect(
      page.getByRole("region", { name: "No channels yet", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry history", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Your role cannot post in this channel.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("This conversation is not available.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "No conversation open", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Members", exact: true }),
    ).toHaveCount(0);
    await page.goto("/comms?message=98000000-0000-4000-8000-000000000001");
    await expect(
      page.getByText("This conversation is not available.", { exact: true }),
    ).toBeVisible();
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        await page.emulateMedia({
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        await page.goto("/comms");
        const surface =
          width === 1440
            ? page.getByRole("region", {
                name: "No conversation open",
                exact: true,
              })
            : page.getByRole("complementary", {
                name: "Conversations",
                exact: true,
              });
        await expect(surface).toBeVisible();
        await expect(
          page.getByRole("textbox", { name: "Message", exact: true }),
        ).toHaveCount(0);
        if (theme === "dark")
          await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
        await expectNoHorizontalScroll(page);
        await surface.screenshot({
          path: testInfo.outputPath(`empty-${width}-${theme}.png`),
          animations: "disabled",
        });
      }
  } finally {
    await page.close();
    server.close();
  }
});

test("uncategorized channels have their own Channels section outside Starred", async ({
  page,
}, testInfo) => {
  const server = await installCommsLiveApi(page, { uncategorized: true });
  await page.route(
    `**/api/users/${defaultSignedInIdentity.id}/preferences`,
    (route) =>
      route.fulfill({
        json: {
          ...profilePreferences(defaultSignedInIdentity.id),
          theme: "system",
        },
      }),
  );
  try {
    await page.goto("/comms");
    const list = page.getByRole("complementary", {
      name: "Conversations",
      exact: true,
    });
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    const channels = list.getByRole("region", {
      name: "Channels",
      exact: true,
    });
    await expect(
      channels.getByRole("heading", { name: "Channels", exact: true }),
    ).toBeVisible();
    await expect(
      channels.getByRole("button", { name: /^live-operations(,|$)/ }),
    ).toBeVisible();
    await expect(
      list
        .getByRole("region", { name: "Starred", exact: true })
        .getByRole("button", { name: /^live-operations(,|$)/ }),
    ).toHaveCount(0);
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        await page.emulateMedia({
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        await page.goto("/comms");
        await expect(
          channels.getByRole("button", { name: /^live-operations(,|$)/ }),
        ).toBeVisible();
        if (theme === "dark")
          await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
        await expectNoHorizontalScroll(page);
        await list.screenshot({
          path: testInfo.outputPath(`channels-${width}-${theme}.png`),
          animations: "disabled",
        });
      }
  } finally {
    await page.close();
    server.close();
  }
});
