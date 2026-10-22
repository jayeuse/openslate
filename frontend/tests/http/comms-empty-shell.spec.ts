import {
  expect,
  test,
  defaultOrganization,
  defaultSignedInIdentity,
  expectNoHorizontalScroll,
} from "./helpers/test";
import { installCommsLiveApi } from "./helpers/comms-live-api";
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
    await expect(
      list.getByText(
        "No conversations yet. Browse channels or start a conversation.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      list.getByRole("button", { name: "Create channel", exact: true }),
    ).toBeVisible();
    await list
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
    await list
      .getByRole("button", { name: "Create category", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Create category", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog", { name: "Create category", exact: true })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await list
      .getByRole("button", { name: "OpenComms menu", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "New channel", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New category", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Admin tools", exact: true }),
    ).toBeVisible();
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((org) => org === defaultOrganization.org_id)).toBe(
      true,
    );
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
      page.getByText(
        "No conversations yet. Browse channels or start a conversation.",
        { exact: true },
      ),
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
      page.getByRole("region", { name: "Choose a conversation", exact: true }),
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
                name: "Choose a conversation",
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
