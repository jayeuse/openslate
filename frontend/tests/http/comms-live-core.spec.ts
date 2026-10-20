import {
  expect,
  test,
  defaultOrganization,
  defaultSignedInIdentity,
} from "./helpers/test";
import { installCommsLiveApi } from "./helpers/comms-live-api";
import {
  commsDraftTextKey,
  ownedCommsDraftTextId,
} from "../../src/components/systems/comms/state/draft-text";

test("Comms waits for the bound server bootstrap rather than opening an example conversation", async ({
  page,
}) => {
  let requested!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/comms/bootstrap", async (route) => {
    requested();
    await waiting;
    await route.fulfill({ status: 403, json: { detail: "Not allowed" } });
  });
  await page.route("**/api/realtime/token", (route) =>
    route.fulfill({ status: 403, json: { detail: "Not allowed" } }),
  );
  await page.goto("/comms");
  await expect(
    page.getByRole("button", {
      name: "Channel actions: operations",
      exact: true,
    }),
  ).toHaveCount(0);
  await Promise.race([entered, page.waitForRequest("**/api/comms/bootstrap")]);
  release();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /could not be loaded|not available|not allowed/i }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("openslate-organization")),
  ).toBe(defaultOrganization.org_id);
});

test("Comms repairs a live sequence gap and retries an unacknowledged send with its original key", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  try {
    await page.goto("/comms");
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    server.appendGap();
    await expect(
      page.getByText("Live message 61", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Live message 60", { exact: true }),
    ).toBeVisible();
    expect(
      server.histories.some(
        (url) => url.searchParams.get("after_seq") === "59",
      ),
    ).toBe(true);
    server.loseNextReceipt();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("One accepted message, even after retry");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.getByText("Not sent", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("One accepted message, even after retry");
    await page
      .getByRole("button", { name: "Retry message", exact: true })
      .click();
    await expect(input).toHaveValue("");
    expect(server.writes).toHaveLength(2);
    expect(server.writes[1]).toBe(server.writes[0]);
  } finally {
    server.close();
  }
});

test("Comms loads the Inbox without fetching unopened conversation histories", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  try {
    await page.goto("/comms?view=inbox");
    await expect(
      page.getByRole("heading", { name: "Inbox", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Channel actions: live-operations",
        exact: true,
      }),
    ).toBeVisible();
    expect(server.histories).toHaveLength(0);
  } finally {
    server.close();
  }
});

test("deferred templates stay in a labeled example workspace without adopting live channel content", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  try {
    await page.goto("/comms?tool=templates");
    const tools = page.getByRole("region", {
      name: "Channel templates",
      exact: true,
    });
    await expect(
      tools.getByText(
        "Example tools — simulated, not saved to your organization.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      tools.getByText("live-operations", { exact: true }),
    ).toHaveCount(0);
    await tools
      .getByRole("button", { name: "Advanced settings 0 changed", exact: true })
      .click();
    await tools
      .getByRole("textbox", { name: "Template name", exact: true })
      .fill("Example-only template");
    await tools
      .getByRole("button", { name: "Save template", exact: true })
      .click();
    await expect(
      tools.getByText("Template saved.", { exact: true }),
    ).toBeVisible();
  } finally {
    server.close();
  }
});

test("an unacknowledged composer keeps its client key across a page remount", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  try {
    await page.goto("/comms");
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    server.loseNextReceipt();
    await input.fill("Retry this exact draft after remount");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.getByText("Not sent", { exact: true })).toBeVisible();
    await page.reload();
    await expect(input).toHaveValue("Retry this exact draft after remount");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(input).toHaveValue("");
    expect(server.writes).toHaveLength(2);
    expect(server.writes[1]).toBe(server.writes[0]);
  } finally {
    server.close();
  }
});

test("a history refusal conceals copied conversation content until a fresh read admits it", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  try {
    await page.goto("/comms");
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    server.refuseHistory(true);
    server.appendGap();
    await expect(
      page.getByText("This conversation is not available", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "live-operations", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Channel actions: live-operations",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toHaveCount(0);
    server.refuseHistory(false);
    await page
      .getByRole("button", { name: "Retry history", exact: true })
      .click();
    await expect(
      page.getByText("Live message 61", { exact: true }),
    ).toBeVisible();
  } finally {
    server.close();
  }
});

test("live retention uses an ephemeral password proof instead of the example confirmation marker", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  try {
    await page.goto("/comms?tool=retention");
    const tools = page.getByRole("region", {
      name: "Message retention",
      exact: true,
    });
    const preview = tools.getByRole("button", {
      name: "Preview impact",
      exact: true,
    });
    await expect(preview).toBeDisabled();
    const password = tools.getByLabel("Current password", { exact: true });
    await password.fill("owned-synthetic-proof");
    await preview.click();
    await expect(tools.getByText(/1 messages and 0 files/)).toBeVisible();
    expect(server.retentionProofs).toEqual([true]);
    await expect(password).toHaveValue("");
  } finally {
    server.close();
  }
});

test("opening the administration menu shows the server's recoverable-message count", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page, { removedCount: 2 });
  try {
    await page.goto("/comms");
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "OpenComms menu", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("menuitem", {
        name: /Admin tools.*2 removed messages to review/,
      }),
    ).toBeVisible();
  } finally {
    server.close();
  }
});

test("a received edit updates a cached conversation while its history is not open", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  try {
    await page.goto("/comms");
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Inbox", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Inbox", exact: true }),
    ).toBeVisible();
    const handled = page.waitForResponse((response) =>
      /\/api\/comms\/(bootstrap|conversations\/[^/]+\/messages\/by-sequence\/59)$/.test(
        new URL(response.url()).pathname,
      ),
    );
    server.publishEdit(59, "Updated while Inbox was open");
    await handled;
    await page
      .getByRole("button", { name: "live-operations", exact: true })
      .click();
    await expect(
      page.getByText("Updated while Inbox was open", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toHaveCount(0);
  } finally {
    server.close();
  }
});

test("sign-out clears the owned Comms draft, visible content and connection", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  let signedOut = false;
  await page.route("**/api/auth/logout", (route) => {
    signedOut = true;
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: signedOut
        ? { authenticated: false }
        : {
            authenticated: true,
            user_id: defaultSignedInIdentity.id,
            organization_id: defaultOrganization.org_id,
            default_organization_blocked: null,
            setup_required: false,
          },
    }),
  );
  try {
    await page.goto("/comms");
    await expect(
      page.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Owned draft to clear on sign-out");
    const key = commsDraftTextKey(
      ownedCommsDraftTextId(
        defaultSignedInIdentity.id,
        server.room,
        defaultOrganization.org_id,
      ),
    );
    await expect
      .poll(() => page.evaluate((key) => sessionStorage.getItem(key), key))
      .toContain("Owned draft to clear on sign-out");
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(server.connections).toBe(0);
    expect(
      await page.evaluate(
        () => Reflect.get(window, "__openViewStreamState")().active,
      ),
    ).toBe(0);
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), key),
    ).toBeNull();
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toHaveCount(0);
  } finally {
    server.close();
  }
});
