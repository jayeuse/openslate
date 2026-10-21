import {
  expect,
  test,
  defaultSignedInIdentity,
  signedInAs,
  heldResponse,
  settleReact,
} from "./helpers/test";
import { installCommsLiveApi } from "./helpers/comms-live-api";
import type { Page, Request } from "@playwright/test";
import type { LiveMessage } from "../../src/components/systems/comms/contract/types";
import { pageOf } from "../helpers/pagination";

async function prepare(
  page: Page,
  role: "admin" | "member" = "admin",
  messageStore?: LiveMessage[],
) {
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    const shell =
      path === "/api/workspace/appearance" ||
      (!url.search &&
        ([
          "/api/auth/session",
          "/api/auth/me",
          "/api/workspace",
          "/api/notifications/unread-count",
        ].includes(path) ||
          /^\/api\/users\/[0-9a-f-]{36}\/preferences$/.test(path)));
    return route.request().method() === "GET" && shell
      ? route.fallback()
      : route.fulfill({
          status: 501,
          json: { detail: "Unconfigured owned HTTP fixture" },
        });
  });
  // signedInAs uses page routes, so install them after the fail-closed guard.
  await signedInAs(page, { id: defaultSignedInIdentity.id, role });
  const calls: {
    method: string;
    path: string;
    query: string;
    at: number;
    status?: number;
    completedAt?: number;
  }[] = [];
  const requests = new WeakMap<Request, (typeof calls)[number]>();
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("No queryFn"))
      warnings.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    const value = {
      method: request.method(),
      path: url.pathname,
      query: url.search,
      at: Date.now(),
    };
    calls.push(value);
    requests.set(request, value);
  });
  page.on("response", (response) => {
    const value = requests.get(response.request());
    if (value) {
      value.status = response.status();
      value.completedAt = Date.now();
    }
  });
  const server = await installCommsLiveApi(page, { role, messageStore });
  return { server, calls, warnings };
}

async function ready(page: Page) {
  await expect(
    page.getByText("Live message 59", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("status", { name: "Conversation connection", exact: true })
      .getByText("Live", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Refreshing conversations…", { exact: true }),
  ).toBeHidden();
  await settleReact(page);
}

test("a cold bootstrap observer always has a query function without console errors", async ({
  page,
}, testInfo) => {
  const api = await prepare(page);
  try {
    await page.goto("/comms");
    await ready(page);
    expect(api.warnings).toEqual([]);
  } finally {
    await testInfo.attach("cold query evidence", {
      body: JSON.stringify({ calls: api.calls, warnings: api.warnings }),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("cold Comms reads are deduplicated and configuration catalogs wait for intent", async ({
  page,
}, testInfo) => {
  const messages: LiveMessage[] = [];
  const api = await prepare(page, "admin", messages);
  const locks = heldResponse();
  const linked = messages.at(-1)!;
  linked.record_references = [
    {
      id: "98000000-0000-4000-8000-000000000041",
      state: "available",
      record_id: "98000000-0000-4000-8000-000000000042",
      module_id: "98000000-0000-4000-8000-000000000043",
      module_name: "Maintenance",
      title: "Owned maintenance record",
      fields: [
        {
          field_id: "98000000-0000-4000-8000-000000000044",
          label: "Priority",
          display_value: "High",
        },
      ],
    },
  ];
  await page.route("**/api/comms/search?**", (route) =>
    route.fulfill({
      json: pageOf(
        [
          {
            message_id: linked.id,
            conversation_id: api.server.room,
            conversation_name: "live-operations",
            seq: linked.seq,
            author_id: defaultSignedInIdentity.id,
            author_name: "HTTP fixture owner",
            created_at: linked.created_at,
            excerpt: "Live message 59",
            matches: [],
            parent_id: null,
          },
        ],
        { limit: 100 },
      ),
    }),
  );
  await page.route(
    "**/api/comms/settings/workspace/capability-locks",
    async (route) => {
      locks.enter();
      await locks.released;
      return route.fallback();
    },
  );
  try {
    await page.goto("/comms");
    await ready(page);
    const gets = api.calls.filter((call) => call.method === "GET");
    const count = (path: string) =>
      gets.filter((call) => call.path === path).length;
    expect(count("/api/comms/bootstrap")).toBe(1);
    expect(count("/api/comms/preferences")).toBe(1);
    expect(count("/api/comms/settings/workspace")).toBe(1);
    expect(count(`/api/comms/settings/channel/${api.server.room}`)).toBe(1);
    expect(
      count(`/api/comms/conversations/${api.server.room}/capabilities`),
    ).toBe(1);
    const threads = gets.filter((call) => call.path === "/api/comms/threads");
    expect(threads).toHaveLength(2);
    expect(new Set(threads.map((call) => call.query)).size).toBe(2);
    const commsGets = gets
      .filter((call) => call.path.startsWith("/api/comms/"))
      .map((call) => call.path + call.query);
    expect(new Set(commsGets).size).toBe(commsGets.length);
    expect(
      gets.filter(
        (call) =>
          [
            "/api/access/groups",
            "/api/departments",
            "/api/modules",
            "/api/comms/settings/workspace/capability-locks",
            "/api/comms/direct-blocks",
          ].includes(call.path) ||
          (call.path === "/api/comms/search" &&
            new URLSearchParams(call.query).get("has") === "record"),
      ),
    ).toEqual([]);
    await page
      .getByRole("button", { name: "Create channel", exact: true })
      .click();
    await locks.entered;
    await expect(
      page
        .getByRole("dialog", { name: "Create channel", exact: true })
        .getByText("Loading settings data…", { exact: true }),
    ).toBeVisible();
    locks.release();
    await expect(
      page
        .getByRole("dialog", { name: "Create channel", exact: true })
        .getByRole("textbox", { name: "Channel name", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() => api.calls.some((call) => call.path === "/api/access/groups"))
      .toBe(true);
    await expect
      .poll(() =>
        api.calls.some(
          (call) =>
            call.path === "/api/comms/settings/workspace/capability-locks",
        ),
      )
      .toBe(true);
    await page
      .getByRole("dialog", { name: "Create channel", exact: true })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page
      .getByRole("button", { name: /Open record:.*Owned maintenance record/ })
      .click();
    const record = page.getByRole("complementary", {
      name: "Record",
      exact: true,
    });
    await expect(
      record.getByRole("heading", {
        name: "Owned maintenance record",
        exact: true,
      }),
    ).toBeVisible();
    await expect(record.getByText("High", { exact: true })).toBeVisible();
    expect(api.calls.some((call) => call.path === "/api/comms/search")).toBe(
      true,
    );
  } finally {
    locks.release();
    await testInfo.attach("cold query evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("an ordinary member cold load makes no forbidden administrative reads and can send", async ({
  page,
}, testInfo) => {
  const api = await prepare(page, "member");
  const receipt = heldResponse();
  const posts: unknown[] = [];
  await page.route("**/api/access/groups?**", (route) =>
    route.fulfill({ status: 403, json: { detail: "Unavailable" } }),
  );
  await page.route(
    `**/api/comms/conversations/${api.server.room}/messages`,
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts.push(route.request().postDataJSON());
      receipt.enter();
      await receipt.released;
      return route.fallback();
    },
  );
  try {
    await page.goto("/comms");
    await ready(page);
    expect(
      api.calls.filter((call) => call.path === "/api/access/groups"),
    ).toEqual([]);
    expect(
      api.calls.filter((call) => call.status === 401 || call.status === 403),
    ).toEqual([]);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Member cold query run");
    await input.press("Enter");
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({
      body: "Member cold query run",
      reply_to_id: null,
    });
    await expect(input).toHaveValue("Member cold query run");
    receipt.release();
    await expect(
      page.getByText("Member cold query run", { exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue("");
  } finally {
    receipt.release();
    await testInfo.attach("member cold query evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});
