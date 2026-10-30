import {
  expect,
  test,
  defaultOrganization,
  defaultSignedInIdentity,
  authMeBody,
  heldResponse,
} from "./helpers/test";
import { installCommsLiveApi } from "./helpers/comms-live-api";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import type { Page } from "@playwright/test";
import type { LiveMessage } from "../../src/components/systems/comms/contract/types";
import { wireWorkspace } from "../helpers/wire";

async function streams(page: Page) {
  return page.evaluate(() => {
    const read = Reflect.get(window, "__openViewStreamState") as () => {
      active: number;
      constructed: number;
      closed: number;
    };
    return read();
  });
}
async function prepare(
  page: Page,
  options: {
    messageStore?: LiveMessage[];
    status?: number;
    retryAfter?: number;
    organizationId?: string;
    messagePrefix?: string;
  } = {},
) {
  await installOpenViewEventSource(page, {
    autoResync: true,
    status: options.status,
    retryAfter: options.retryAfter,
  });
  return installCommsLiveApi(page, {
    workspaceEvents: false,
    messageStore: options.messageStore,
    organizationId: options.organizationId,
    messagePrefix: options.messagePrefix,
  });
}

test("two admitted tabs share one connection set and the survivor takes ownership", async ({
  page,
  context,
}) => {
  const messages: LiveMessage[] = [];
  const first = await prepare(page, { messageStore: messages });
  const secondPage = await context.newPage();
  const second = await prepare(secondPage, { messageStore: messages });
  const unreadReads = new Map<Page, number>([
    [page, 0],
    [secondPage, 0],
  ]);
  for (const tab of [page, secondPage])
    tab.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/notifications/unread-count")
        unreadReads.set(tab, unreadReads.get(tab)! + 1);
    });
  try {
    await page.goto("/comms");
    await expect(
      page.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
    await secondPage.goto("/comms");
    await expect(
      secondPage.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
    await expect
      .poll(
        async () =>
          (await streams(page)).active + (await streams(secondPage)).active,
      )
      .toBe(1);
    expect(first.connections() + second.connections()).toBe(1);
    expect(first.heartbeats.length + second.heartbeats.length).toBeGreaterThan(
      0,
    );
    expect(
      first.heartbeats.length === 0 || second.heartbeats.length === 0,
    ).toBe(true);
    const leader = (await streams(page)).active ? page : secondPage;
    const follower = leader === page ? secondPage : page;
    const survivor = leader === page ? second : first;
    const publisher = leader === page ? first : second;
    publisher.appendGap();
    await expect(
      follower.getByText("Live message 61", { exact: true }),
    ).toBeVisible();
    const previousReads = unreadReads.get(follower)!;
    await sendOpenViewEvent(leader, "invalidate", {
      entity: "in_app_notifications",
    });
    await expect
      .poll(() => unreadReads.get(follower))
      .toBeGreaterThan(previousReads);
    await leader.close();
    await expect.poll(async () => (await streams(follower)).active).toBe(1);
    await expect.poll(survivor.connections).toBe(1);
    await expect.poll(() => survivor.heartbeats.length).toBeGreaterThan(0);
    await expect(
      follower.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
    expect(
      survivor.heartbeats.every(
        (request) => request.orgId === defaultOrganization.org_id,
      ),
    ).toBe(true);
  } finally {
    if (!page.isClosed()) await page.close();
    if (!secondPage.isClosed()) await secondPage.close();
    first.close();
    second.close();
  }
});

test("a follower that meets an already live new leader still refetches after the handoff", async ({
  page,
  context,
}) => {
  const messages: LiveMessage[] = [];
  const tabs = [page, await context.newPage(), await context.newPage()];
  const apis = [];
  for (const tab of tabs)
    apis.push(await prepare(tab, { messageStore: messages }));
  const unreadReads = new Map<Page, number>(tabs.map((tab) => [tab, 0]));
  for (const tab of tabs)
    tab.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/notifications/unread-count")
        unreadReads.set(tab, unreadReads.get(tab)! + 1);
    });
  try {
    for (const tab of tabs) {
      await tab.goto("/comms");
      await expect(
        tab.getByRole("status", {
          name: "Conversation connection",
          exact: true,
        }),
      ).toContainText("Live");
    }
    const active = async (tab: Page) => (await streams(tab)).active;
    const leader = (
      await Promise.all(tabs.map(async (tab) => [tab, await active(tab)]))
    ).find(([, count]) => count === 1)?.[0] as Page;
    const survivors = tabs.filter((tab) => tab !== leader);
    const before = new Map(
      survivors.map((tab) => [tab, unreadReads.get(tab)!]),
    );
    // Changes committed while no tab holds the stream reach no tab directly.
    await leader.close();
    await expect
      .poll(
        async () => (await active(survivors[0])) + (await active(survivors[1])),
      )
      .toBe(1);
    const follower = (await active(survivors[0])) ? survivors[1] : survivors[0];
    // The new stream's opening resync must reach the follower as a refetch.
    await expect
      .poll(() => unreadReads.get(follower))
      .toBeGreaterThan(before.get(follower)!);
  } finally {
    for (const tab of tabs) if (!tab.isClosed()) await tab.close();
    for (const api of apis) api.close();
  }
});

test("different organizations hold separate connection sets without cross-scope events", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  const orgA = { ...defaultOrganization, role: "admin" as const };
  const orgB = {
    org_id: "97000000-0000-4000-8000-000000000002",
    name: "Second organization",
    slug: "second",
    role: "admin" as const,
  };
  for (const [tab, org] of [
    [page, orgA],
    [other, orgB],
  ] as const) {
    await tab.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: {
          authenticated: true,
          user_id: defaultSignedInIdentity.id,
          organization_id: org.org_id,
          setup_required: false,
          default_organization_blocked: null,
        },
      }),
    );
    await tab.route("**/api/auth/me", (route) =>
      route.fulfill({
        json: authMeBody({
          id: defaultSignedInIdentity.id,
          role: "admin",
          memberships: [orgA, orgB],
          current_organization: { ...org, access: [] },
        }),
      }),
    );
    await tab.route("**/api/workspace", (route) =>
      route.fulfill({
        json: wireWorkspace({
          id: org.org_id,
          display_name: org.name,
          locale: "en-US",
          timezone: "UTC",
          currency: "USD",
          today: "2026-10-21",
          purge_enabled: true,
        }),
      }),
    );
  }
  const first = await prepare(page, {
    organizationId: orgA.org_id,
    messagePrefix: "First organization",
  });
  const second = await prepare(other, {
    organizationId: orgB.org_id,
    messagePrefix: "Second organization",
  });
  try {
    await page.goto("/comms");
    await other.goto("/comms");
    await expect(
      page.getByText("First organization 59", { exact: true }),
    ).toBeVisible();
    await expect(
      other.getByText("Second organization 59", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await streams(page)).active + (await streams(other)).active,
      )
      .toBe(2);
    await expect.poll(() => first.connections() + second.connections()).toBe(2);
    first.publishEdit(59, "Only the first organization changed");
    await expect(
      page.getByText("Only the first organization changed", { exact: true }),
    ).toBeVisible();
    await expect(
      other.getByText("Only the first organization changed", { exact: true }),
    ).toHaveCount(0);
    await expect(
      other.getByText("Second organization 59", { exact: true }),
    ).toBeVisible();
  } finally {
    await page.close();
    await other.close();
    first.close();
    second.close();
  }
});

test("a follower displays the leader's paused state without attempting its own reconnect", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  const first = await prepare(page),
    second = await prepare(other);
  first.setTokenStatus(429, 3);
  try {
    await page.clock.install();
    await other.clock.install();
    await page.goto("/comms");
    await expect(
      page.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live updates paused in this tab");
    await other.goto("/comms");
    const status = other.getByRole("status", {
      name: "Conversation connection",
      exact: true,
    });
    await expect(status).toContainText("Live updates paused in this tab");
    await other.clock.runFor(60_000);
    expect(second.tokenRequests()).toBe(0);
    expect(second.heartbeats).toHaveLength(0);
    expect((await streams(other)).constructed).toBe(0);
    first.setTokenStatus(200);
    await page.clock.runFor(3_000);
    await expect(status.getByText("Live", { exact: true })).toBeVisible();
    expect(first.connections() + second.connections()).toBe(1);
  } finally {
    await page.close();
    await other.close();
    first.close();
    second.close();
  }
});

test("without Web Locks each tab owns one explicitly local connection set", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  for (const tab of [page, other])
    await tab.addInitScript(() => {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: undefined,
      });
    });
  const first = await prepare(page),
    second = await prepare(other);
  try {
    await page.goto("/comms");
    await other.goto("/comms");
    await expect(
      page.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
    await expect(
      other.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
    expect((await streams(page)).active).toBe(1);
    expect((await streams(other)).active).toBe(1);
    expect(first.connections()).toBe(1);
    expect(second.connections()).toBe(1);
  } finally {
    await page.close();
    await other.close();
    first.close();
    second.close();
  }
});

test("unauthorized streams wait for the shared refresh before opening again", async ({
  page,
}) => {
  let expired = false,
    refreshes = 0;
  const held = heldResponse();
  await page.exposeFunction("__onWorkspaceStreamRequest", () => {
    expired = true;
  });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: expired
        ? { authenticated: false }
        : {
            authenticated: true,
            user_id: defaultSignedInIdentity.id,
            organization_id: defaultOrganization.org_id,
            setup_required: false,
            default_organization_blocked: null,
          },
    }),
  );
  await page.route("**/api/auth/refresh", async (route) => {
    refreshes++;
    held.enter();
    await held.released;
    expired = false;
    await route.fulfill({ status: 204 });
  });
  const server = await prepare(page, { status: 401 });
  server.setTokenStatus(401);
  try {
    await page.clock.install();
    await page.goto("/comms");
    await held.entered;
    await page.clock.runFor(5000);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, "__openViewHttpRequests")(),
      ),
    ).toBe(1);
    expect(server.connections()).toBe(0);
    server.setTokenStatus(200);
    await page.evaluate(() => {
      Reflect.set(window, "__onWorkspaceStreamRequest", () => {});
      Reflect.get(window, "__setOpenViewHttpStatus")(200);
    });
    held.release();
    await expect(
      page.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
    expect(refreshes).toBe(1);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, "__openViewHttpRequests")(),
      ),
    ).toBe(2);
  } finally {
    held.release();
    await page.close();
    server.close();
  }
});

for (const transport of ["SSE", "Realtime token"] as const)
  test(`${transport} rate limits pause until Retry-After and then recover`, async ({
    page,
  }) => {
    const server = await prepare(
      page,
      transport === "SSE" ? { status: 429, retryAfter: 3 } : {},
    );
    if (transport === "Realtime token") server.setTokenStatus(429, 3);
    try {
      await page.clock.install();
      await page.goto("/comms");
      const status = page.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      });
      await expect(status).toContainText("Live updates paused in this tab");
      await page.clock.runFor(2000);
      if (transport === "SSE") {
        expect(
          await page.evaluate(() =>
            Reflect.get(window, "__openViewHttpRequests")(),
          ),
        ).toBe(1);
        await page.evaluate(() =>
          Reflect.get(window, "__setOpenViewHttpStatus")(200),
        );
      } else {
        expect(server.tokenRequests()).toBe(1);
        server.setTokenStatus(200);
      }
      await page.clock.runFor(1000);
      await expect(status.getByText("Live", { exact: true })).toBeVisible();
    } finally {
      await page.close();
      server.close();
    }
  });

test("observable Realtime limits pause while leader HTTP heartbeats still repair messages", async ({
  page,
}) => {
  const server = await prepare(page);
  server.setJoinLimit("ChannelRateLimitReached: Too many channels");
  try {
    await page.clock.install();
    await page.goto("/comms");
    const status = page.getByRole("status", {
      name: "Conversation connection",
      exact: true,
    });
    await expect(status).toContainText("Live updates paused in this tab");
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    server.appendQuietly();
    await page.clock.runFor(60_000);
    await expect(
      page.getByText("Live message 60", { exact: true }),
    ).toBeVisible();
    await expect(status).toContainText("Live updates paused in this tab");
    server.setJoinLimit(null);
    await page.clock.runFor(60_000);
    await expect(status.getByText("Live", { exact: true })).toBeVisible();
  } finally {
    await page.close();
    server.close();
  }
});

test("opaque disconnects back off and a stable minute resets retry delay", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Math.random = () => 0.5;
  });
  const server = await prepare(page);
  try {
    await page.clock.install();
    await page.goto("/comms");
    const status = page.getByRole("status", {
      name: "Conversation connection",
      exact: true,
    });
    await expect(status.getByText("Live", { exact: true })).toBeVisible();
    server.setTokenStatus(503);
    server.dropConnections();
    await expect(status).toHaveAttribute("aria-busy", "true");
    await page.clock.runFor(500);
    expect(server.tokenRequests()).toBe(1);
    await page.clock.runFor(60_000);
    await expect.poll(server.tokenRequests).toBeGreaterThan(1);
    expect(server.tokenRequests()).toBeLessThan(10);
    server.setTokenStatus(200);
    await page.clock.runFor(60_000);
    await expect(status.getByText("Live", { exact: true })).toBeVisible();
    await page.clock.fastForward(60_000);
    await expect(status.getByText("Live", { exact: true })).toBeVisible();
    const before = server.tokenRequests();
    server.setTokenStatus(503);
    server.dropConnections();
    await expect(status).toHaveAttribute("aria-busy", "true");
    await page.clock.runFor(1500);
    await expect.poll(server.tokenRequests).toBeGreaterThan(before);
  } finally {
    await page.close();
    server.close();
  }
});

test("leader presence waits ten hidden minutes and returns online after visible input", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
  });
  const server = await prepare(page);
  server.setJoinLimit("ChannelRateLimitReached: Too many channels");
  try {
    await page.clock.install();
    await page.goto("/comms");
    await expect.poll(() => server.heartbeats.at(-1)?.state).toBe("online");
    await page.clock.fastForward(600_000);
    await expect.poll(() => server.heartbeats.at(-1)?.state).toBe("away");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("A fresh local draft");
    await page.clock.fastForward(60_000);
    await expect.poll(() => server.heartbeats.at(-1)?.state).toBe("online");
  } finally {
    await page.close();
    server.close();
  }
});
