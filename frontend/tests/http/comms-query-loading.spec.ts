import {
  expect,
  test,
  defaultOrganization,
  defaultSignedInIdentity,
  signedInAs,
  heldResponse,
  settleReact,
} from "./helpers/test";
import { installCommsLiveApi } from "./helpers/comms-live-api";
import type { Page, Request } from "@playwright/test";
import type { LiveMessage } from "../../src/components/systems/comms/contract/types";
import { pageOf } from "../helpers/pagination";
import {
  createMemorySeed,
  organizationChannel,
} from "../support/comms-memory/memory/seed";
import {
  createMemoryCommsRuntime,
  type MemoryCommsRuntime,
} from "../support/comms-memory/memory-client";

async function prepare(
  page: Page,
  role: "admin" | "member" = "admin",
  messageStore?: LiveMessage[],
  runtime?: MemoryCommsRuntime,
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
  const server = await installCommsLiveApi(page, {
    role,
    messageStore,
    runtime,
  });
  return { server, calls, warnings };
}

async function ready(page: Page, lastMessage = "Live message 59") {
  await expect(page.getByText(lastMessage, { exact: true })).toBeVisible();
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
  // The Realtime join is held until the cold reads finish: the cold ledger
  // is read first, then the join repair's. The presence heartbeat, whose
  // receipt also repairs history and the bootstrap, stays held throughout.
  const heartbeat = heldResponse();
  await page.route("**/api/comms/presence", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await heartbeat.released;
    return route.fallback();
  });
  const token = heldResponse();
  await page.route("**/api/realtime/token", async (route) => {
    token.enter();
    await token.released;
    return route.fallback();
  });
  try {
    await page.goto("/comms");
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    // A department category names its department on first paint.
    await expect(
      page.getByRole("button", { name: /^Service delivery.*Operations/ }),
    ).toBeVisible();
    // Records you follow need record links from thread replies on first paint.
    const recordSearches = () =>
      api.calls.filter(
        (call) =>
          call.path === "/api/comms/search" &&
          new URLSearchParams(call.query).get("has") === "record",
      );
    await expect.poll(() => recordSearches().length).toBe(1);
    await settleReact(page);
    const count = (path: string) =>
      api.calls.filter((call) => call.method === "GET" && call.path === path)
        .length;
    const gets = api.calls.filter((call) => call.method === "GET");
    expect(count("/api/departments")).toBe(1);
    // Comms reuses the shell's verified identity read.
    expect(count("/api/auth/me")).toBe(1);
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
      gets.filter((call) =>
        [
          "/api/access/groups",
          "/api/modules",
          "/api/comms/settings/workspace/capability-locks",
          "/api/comms/direct-blocks",
        ].includes(call.path),
      ),
    ).toEqual([]);
    expect(recordSearches()).toHaveLength(1);
    // The join, landing after the cold read, repairs every read once.
    token.release();
    await ready(page);
    for (const path of [
      "/api/comms/bootstrap",
      "/api/comms/preferences",
      `/api/comms/conversations/${api.server.room}/members`,
      `/api/comms/conversations/${api.server.room}/pins`,
      `/api/comms/conversations/${api.server.room}/capabilities`,
    ])
      await expect.poll(() => count(path)).toBe(2);
    await expect.poll(() => recordSearches().length).toBe(2);
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
    // Opening the dialog and the record panel reuses the repaired record read.
    expect(recordSearches()).toHaveLength(2);
    expect(
      api.calls.filter((call) => call.path === "/api/comms/search"),
    ).toHaveLength(2);
    expect(
      api.calls.filter((call) => call.path === "/api/departments"),
    ).toHaveLength(1);
  } finally {
    token.release();
    heartbeat.release();
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

test("an incoming message and a presence change reread no workspace metadata", async ({
  page,
}, testInfo) => {
  const api = await prepare(page);
  // Workspace and per-conversation metadata: none of it changes when a message
  // arrives or a person's presence changes.
  const metadata = (call: { method: string; path: string }) =>
    call.method === "GET" &&
    (call.path === "/api/comms/preferences" ||
      call.path === "/api/comms/threads" ||
      call.path === "/api/comms/search" ||
      call.path === "/api/comms/presence" ||
      call.path.startsWith("/api/comms/settings/") ||
      /^\/api\/comms\/conversations\/[^/]+\/(members|capabilities|pins)$/.test(
        call.path,
      ));
  try {
    await page.goto("/comms");
    await ready(page);
    const before = api.calls.length;
    api.server.appendGap();
    await expect(
      page.getByText("Live message 61", { exact: true }),
    ).toBeVisible();
    // The bootstrap refresh carries the new unread counts.
    await expect
      .poll(() =>
        api.calls
          .slice(before)
          .some((call) => call.path === "/api/comms/bootstrap"),
      )
      .toBe(true);
    const other = api.server.members.find(
      (member) => member.user_id !== defaultSignedInIdentity.id,
    )!;
    api.server.setPresence(other.user_id, "away");
    // A later message proves both events were handled before the ledger is read.
    api.server.appendGap();
    await expect(
      page.getByText("Live message 63", { exact: true }),
    ).toBeVisible();
    await settleReact(page);
    expect(api.calls.slice(before).filter(metadata)).toEqual([]);
  } finally {
    await testInfo.attach("incoming event evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

/** Three channels and a direct conversation, so unopened rooms are visible. */
function fourRoomWorld() {
  const owner = {
    user_id: defaultSignedInIdentity.id,
    org_id: defaultOrganization.org_id,
  };
  const initial = createMemorySeed(owner, {
    role: "admin",
    display_name: "HTTP fixture owner",
  });
  const channel = Object.values(initial.conversations)[0];
  if (channel.kind !== "channel") throw new Error("Expected the seed channel");
  const ids = {
    operations: channel.id,
    deliveries: "77000000-0000-4000-8000-000000000001",
    planning: "77000000-0000-4000-8000-000000000002",
    direct: "77000000-0000-4000-8000-000000000003",
  };
  for (const [position, name] of [
    [1, "deliveries"],
    [2, "planning"],
  ] as const) {
    const id = ids[name];
    initial.conversations[id] = { ...channel, id, name, position };
    initial.members[id] = structuredClone(initial.members[channel.id]);
    initial.high_water_seq[id] = 0;
  }
  const peer = Object.values(initial.people).find(
    (person) => person.display_name === "Noah Tan",
  )!;
  initial.conversations[ids.direct] = {
    id: ids.direct,
    org_id: owner.org_id,
    created_at: channel.created_at,
    updated_at: channel.updated_at,
    archived_at: null,
    creator_id: owner.user_id,
    kind: "direct",
  };
  initial.members[ids.direct] = Object.fromEntries(
    [owner.user_id, peer.user_id].map((user_id) => [
      user_id,
      { user_id, member_role: "member", joined_at: channel.created_at },
    ]),
  );
  initial.high_water_seq[ids.direct] = 0;
  const root = Object.values(initial.messages).find(
    (message) => !message.parent_id,
  )!;
  const sofia = Object.values(initial.people).find(
    (person) => person.display_name === "Sofia Garcia",
  )!;
  return {
    runtime: createMemoryCommsRuntime({ owner, initial }),
    ids,
    root,
    peer,
    sofia,
    initial,
  };
}

/** GET reads of one conversation's own members, check, settings and pins. */
function detailReads(
  calls: { method: string; path: string }[],
  id: string,
): string[] {
  return calls
    .filter((call) => call.method === "GET")
    .map((call) => call.path)
    .filter(
      (path) =>
        path === `/api/comms/conversations/${id}/members` ||
        path === `/api/comms/conversations/${id}/capabilities` ||
        path === `/api/comms/conversations/${id}/pins` ||
        path === `/api/comms/settings/channel/${id}` ||
        path === `/api/comms/settings/channel/${id}/capabilities`,
    )
    .sort();
}

test("a cold load reads conversation details only for the open conversation", async ({
  page,
}, testInfo) => {
  const world = fourRoomWorld();
  const api = await prepare(page, "admin", undefined, world.runtime);
  const { operations, deliveries, planning, direct } = world.ids;
  try {
    await page.goto("/comms");
    await ready(
      page,
      "Two vans are loaded. The spare tool kit is beside dispatch.",
    );
    // The direct row is named from the bootstrap, without reading its members.
    await expect(
      page.getByRole("button", { name: /^Noah Tan(,|$)/ }),
    ).toBeVisible();
    // The join repair may read the open conversation's detail once more.
    expect([...new Set(detailReads(api.calls, operations))]).toEqual([
      `/api/comms/conversations/${operations}/capabilities`,
      `/api/comms/conversations/${operations}/members`,
      `/api/comms/conversations/${operations}/pins`,
      `/api/comms/settings/channel/${operations}`,
      `/api/comms/settings/channel/${operations}/capabilities`,
    ]);
    for (const id of [deliveries, planning, direct])
      expect(detailReads(api.calls, id)).toEqual([]);
    await page.getByRole("button", { name: /^deliveries(,|$)/ }).click();
    await expect(
      page.getByRole("heading", { name: "deliveries", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    await settleReact(page);
    expect(detailReads(api.calls, deliveries)).toEqual([
      `/api/comms/conversations/${deliveries}/capabilities`,
      `/api/comms/conversations/${deliveries}/members`,
      `/api/comms/conversations/${deliveries}/pins`,
      `/api/comms/settings/channel/${deliveries}`,
      `/api/comms/settings/channel/${deliveries}/capabilities`,
    ]);
    for (const id of [planning, direct])
      expect(detailReads(api.calls, id)).toEqual([]);
  } finally {
    await testInfo.attach("open conversation detail evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("a created channel opens from the create response before the workspace is read again", async ({
  page,
}, testInfo) => {
  const world = fourRoomWorld();
  const api = await prepare(page, "admin", undefined, world.runtime);
  const reread = heldResponse();
  try {
    await page.goto("/comms");
    await ready(
      page,
      "Two vans are loaded. The spare tool kit is beside dispatch.",
    );
    await page
      .getByRole("button", { name: "Create channel", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Create channel",
      exact: true,
    });
    const name = editor.getByRole("textbox", {
      name: "Channel name",
      exact: true,
    });
    await expect(name).toBeEnabled();
    await name.fill("workshop");
    // Hold the workspace read that follows the create.
    await page.route("**/api/comms/threads?**", async (route) => {
      reread.enter();
      await reread.released;
      return route.fallback();
    });
    await editor
      .getByRole("button", { name: "Create channel", exact: true })
      .click();
    await expect(editor).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "workshop", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^workshop(,|$)/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    // The workspace read after the create is still held.
    await reread.entered;
    reread.release();
    await expect(
      page.getByText("Refreshing conversations…", { exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "workshop", exact: true }),
    ).toBeVisible();
  } finally {
    reread.release();
    await testInfo.attach("create to open evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("a held presence read does not delay the open conversation", async ({
  page,
}) => {
  const api = await prepare(page);
  const presence = heldResponse();
  await page.route("**/api/comms/presence?**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    presence.enter();
    await presence.released;
    return route.fallback();
  });
  const members = api.server.members.filter(
    (member) => member.user_id !== defaultSignedInIdentity.id,
  );
  api.server.setPresence(members[0].user_id, "online");
  try {
    await page.goto("/comms?panel=members");
    await presence.entered;
    // Messages, names and the composer do not wait for presence.
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    const panel = page.getByRole("region", {
      name: "Members with access",
      exact: true,
    });
    await expect(panel).toContainText(members[0].display_name);
    presence.release();
    // Presence fills in when it arrives.
    await expect(
      panel.getByRole("region", { name: "Online members", exact: true }),
    ).toContainText(members[0].display_name);
  } finally {
    presence.release();
    await page.close();
    api.server.close();
  }
});

test("held thread lists and record search do not delay the open conversation", async ({
  page,
}) => {
  const api = await prepare(page);
  const slow = heldResponse();
  // No join repair: the record read below is the cold one.
  const token = heldResponse();
  await page.route("**/api/realtime/token", async (route) => {
    await token.released;
    return route.fallback();
  });
  for (const pattern of ["**/api/comms/threads?**", "**/api/comms/search?**"])
    await page.route(pattern, async (route) => {
      slow.enter();
      await slow.released;
      return route.fallback();
    });
  try {
    await page.goto("/comms");
    await slow.entered;
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    slow.release();
    await settleReact(page);
    // The record read still runs once, after the conversation opened.
    expect(
      api.calls.filter(
        (call) =>
          call.path === "/api/comms/search" &&
          new URLSearchParams(call.query).get("has") === "record",
      ),
    ).toHaveLength(1);
  } finally {
    slow.release();
    token.release();
    await page.close();
    api.server.close();
  }
});

test("a thread reply reads the thread lists again and no other workspace data", async ({
  page,
}, testInfo) => {
  const world = fourRoomWorld();
  const api = await prepare(page, "admin", undefined, world.runtime);
  try {
    await page.goto("/comms");
    await ready(
      page,
      "Two vans are loaded. The spare tool kit is beside dispatch.",
    );
    const before = api.calls.length;
    await world.runtime.controls
      .clientFor(world.peer.user_id)
      .sendReply(world.ids.operations, world.root.id, {
        client_key: "77000000-0000-4000-8000-000000000020",
        body: "A reply from Noah",
      });
    // The thread event re-reads the two thread lists.
    await expect
      .poll(
        () =>
          api.calls
            .slice(before)
            .filter((call) => call.path === "/api/comms/threads").length,
      )
      .toBe(2);
    await settleReact(page);
    expect(
      api.calls
        .slice(before)
        .filter(
          (call) =>
            call.method === "GET" &&
            (call.path === "/api/comms/preferences" ||
              call.path === "/api/comms/search" ||
              call.path.startsWith("/api/comms/settings/") ||
              call.path ===
                `/api/comms/conversations/${world.ids.operations}/messages/${world.root.id}` ||
              /\/(members|capabilities|pins)$/.test(call.path)),
        )
        .map((call) => call.path),
    ).toEqual([]);
  } finally {
    await testInfo.attach("thread reply evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("the composer waits neutrally for the open conversation's access and retries a failed read", async ({
  page,
}) => {
  const api = await prepare(page);
  const check = heldResponse();
  // No join repair re-reads the failed detail behind the test's back.
  const token = heldResponse();
  await page.route("**/api/realtime/token", async (route) => {
    await token.released;
    return route.fallback();
  });
  let fail = true;
  await page.route(
    `**/api/comms/conversations/${api.server.room}/capabilities`,
    async (route) => {
      // Every access read fails until the person retries.
      if (fail)
        return route.fulfill({
          status: 500,
          json: { detail: "Unavailable" },
        });
      check.enter();
      await check.released;
      return route.fallback();
    },
  );
  const composer = page.getByRole("form", {
    name: "Message composer",
    exact: true,
  });
  try {
    await page.goto("/comms");
    await expect(
      composer.getByText("Your access could not be loaded.", { exact: true }),
    ).toBeVisible();
    await expect(
      composer.getByText("Your role cannot post in this channel.", {
        exact: true,
      }),
    ).toHaveCount(0);
    fail = false;
    await composer
      .getByRole("button", { name: "Try again", exact: true })
      .click();
    await check.entered;
    await expect(
      composer.getByText("Loading your access…", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      composer.getByText("Your role cannot post in this channel.", {
        exact: true,
      }),
    ).toHaveCount(0);
    check.release();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
  } finally {
    check.release();
    token.release();
    await page.close();
    api.server.close();
  }
});

test("a record link outside the open conversation names its author", async ({
  page,
}) => {
  const owner = {
    user_id: defaultSignedInIdentity.id,
    org_id: defaultOrganization.org_id,
  };
  const initial = createMemorySeed(owner, {
    role: "admin",
    display_name: "HTTP fixture owner",
  });
  const channel = Object.values(initial.conversations)[0];
  const root = Object.values(initial.messages).find(
    (message) => !message.parent_id,
  )!;
  const sofia = Object.values(initial.people).find(
    (person) => person.display_name === "Sofia Garcia",
  )!;
  root.author_id = sofia.user_id;
  for (const thread of Object.values(initial.threads))
    if (thread.root_message_id === root.id) thread.starter_id = sofia.user_id;
  // A direct conversation with the owner alone opens; Sofia is not in it.
  const noah = Object.values(initial.people).find(
    (person) => person.display_name === "Noah Tan",
  )!;
  const direct = "77000000-0000-4000-8000-000000000030";
  initial.conversations[direct] = {
    id: direct,
    org_id: owner.org_id,
    created_at: channel.created_at,
    updated_at: channel.updated_at,
    archived_at: null,
    creator_id: owner.user_id,
    kind: "direct",
  };
  initial.members[direct] = Object.fromEntries(
    [owner.user_id, noah.user_id].map((user_id) => [
      user_id,
      { user_id, member_role: "member", joined_at: channel.created_at },
    ]),
  );
  initial.high_water_seq[direct] = 0;
  const api = await prepare(
    page,
    "admin",
    undefined,
    createMemoryCommsRuntime({ owner, initial }),
  );
  await page.route(`**/api/users/${sofia.user_id}/card`, (route) =>
    route.fulfill({
      json: {
        display_name: "Sofia Garcia",
        job_title: null,
        avatar_url: null,
        email: null,
        phone: null,
        bio: null,
      },
    }),
  );
  const record = Object.values(initial.records)[0];
  try {
    await page.goto(`/comms?conversation=${direct}&panel=record:${record.id}`);
    await expect(
      page.getByRole("list", { name: "Mentioned in", exact: true }),
    ).toContainText("Sofia Garcia");
  } finally {
    await page.close();
    api.server.close();
  }
});

test("members keep their presence while the open conversation is read again", async ({
  page,
}) => {
  const api = await prepare(page);
  const person = api.server.members.find(
    (member) => member.user_id !== defaultSignedInIdentity.id,
  )!;
  api.server.setPresence(person.user_id, "online");
  try {
    await page.goto("/comms?panel=members");
    const panel = page.getByRole("region", {
      name: "Members with access",
      exact: true,
    });
    const online = panel.getByRole("region", {
      name: "Online members",
      exact: true,
    });
    await expect(online).toContainText(person.display_name);
    await ready(page);
    const presence = heldResponse();
    await page.route("**/api/comms/presence?**", async (route) => {
      presence.enter();
      await presence.released;
      return route.fallback();
    });
    // A repair reads the members again; their presence follows later.
    api.server.publishAuthorizationChange("grants");
    await presence.entered;
    await expect(online).toContainText(person.display_name);
    await expect(
      panel.getByRole("region", { name: "Offline members", exact: true }),
    ).not.toContainText(person.display_name);
    presence.release();
  } finally {
    await page.close();
    api.server.close();
  }
});

test("a thread event reads no quoted message again", async ({
  page,
}, testInfo) => {
  const world = fourRoomWorld();
  const reply = Object.values(world.initial.messages).find(
    (message) => message.parent_id === world.root.id,
  )!;
  // The thread root quotes its first reply; the workspace reads that quote.
  world.initial.messages[world.root.id].reply_to_id = reply.id;
  const api = await prepare(
    page,
    "admin",
    undefined,
    createMemoryCommsRuntime({
      owner: {
        user_id: defaultSignedInIdentity.id,
        org_id: defaultOrganization.org_id,
      },
      initial: world.initial,
    }),
  );
  const quote = `/api/comms/conversations/${world.ids.operations}/messages/${reply.id}`;
  try {
    await page.goto(`/comms?conversation=${world.ids.direct}`);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() => api.calls.filter((call) => call.path === quote).length)
      .toBeGreaterThan(0);
    // The join repair (full root and quote reads) finishes before the mark.
    await expect(
      page
        .getByRole("status", { name: "Conversation connection", exact: true })
        .getByText("Live", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Refreshing conversations…", { exact: true }),
    ).toBeHidden();
    await settleReact(page);
    const before = api.calls.length;
    await api.server.runtime.controls
      .clientFor(world.peer.user_id)
      .sendReply(world.ids.operations, world.root.id, {
        client_key: "77000000-0000-4000-8000-000000000021",
        body: "Another reply from Noah",
      });
    await expect
      .poll(
        () =>
          api.calls
            .slice(before)
            .filter((call) => call.path === "/api/comms/threads").length,
      )
      .toBe(2);
    await settleReact(page);
    expect(
      api.calls.slice(before).filter((call) => call.path === quote),
    ).toEqual([]);
  } finally {
    await testInfo.attach("thread quote evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("a cold load without department categories reads no department names", async ({
  page,
}, testInfo) => {
  const owner = {
    user_id: defaultSignedInIdentity.id,
    org_id: defaultOrganization.org_id,
  };
  const initial = createMemorySeed(owner, {
    role: "admin",
    display_name: "HTTP fixture owner",
  });
  for (const category of Object.values(initial.categories))
    category.department_id = null;
  // No department channel either, so nothing needs a department name.
  for (const room of Object.values(initial.conversations))
    if (room.kind === "channel")
      initial.conversations[room.id] = organizationChannel(room);
  const api = await prepare(
    page,
    "admin",
    undefined,
    createMemoryCommsRuntime({ owner, initial }),
  );
  try {
    await page.goto("/comms");
    await ready(
      page,
      "Two vans are loaded. The spare tool kit is beside dispatch.",
    );
    await expect(
      page.getByRole("button", { name: "Service delivery", exact: true }),
    ).toBeVisible();
    expect(
      api.calls.filter((call) => call.path === "/api/departments"),
    ).toEqual([]);
  } finally {
    await testInfo.attach("departmentless cold query evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("a cold load reads a thread root that also links a record once", async ({
  page,
}, testInfo) => {
  const world = fourRoomWorld();
  const api = await prepare(page, "admin", undefined, world.runtime);
  // No join repair: only the cold reads count.
  const token = heldResponse();
  await page.route("**/api/realtime/token", async (route) => {
    await token.released;
    return route.fallback();
  });
  const root = `/api/comms/conversations/${world.ids.operations}/messages/${world.root.id}`;
  try {
    await page.goto("/comms");
    await expect(
      page.getByRole("list", { name: "Records you follow", exact: true }),
    ).toContainText("Riverside service visit");
    await expect
      .poll(() =>
        api.calls.some(
          (call) => call.path === "/api/comms/search" && call.completedAt,
        ),
      )
      .toBe(true);
    await settleReact(page);
    expect(api.calls.filter((call) => call.path === root)).toHaveLength(1);
  } finally {
    token.release();
    await testInfo.attach("thread root record evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("two quick thread replies read no thread root again", async ({
  page,
}, testInfo) => {
  const world = fourRoomWorld();
  const api = await prepare(page, "admin", undefined, world.runtime);
  const root = `/api/comms/conversations/${world.ids.operations}/messages/${world.root.id}`;
  const lists = heldResponse();
  try {
    await page.goto("/comms");
    await ready(page, world.root.body);
    const before = api.calls.length;
    await page.route("**/api/comms/threads?**", async (route) => {
      lists.enter();
      await lists.released;
      return route.fallback().catch(() => {});
    });
    const noah = world.runtime.controls.clientFor(world.peer.user_id);
    await noah.sendReply(world.ids.operations, world.root.id, {
      client_key: "77000000-0000-4000-8000-000000000030",
      body: "First quick reply",
    });
    await lists.entered;
    await noah.sendReply(world.ids.operations, world.root.id, {
      client_key: "77000000-0000-4000-8000-000000000031",
      body: "Second quick reply",
    });
    // The second event restarts the held read of both lists.
    const listReads = () =>
      api.calls
        .slice(before)
        .filter((call) => call.path === "/api/comms/threads");
    await expect.poll(() => listReads().length).toBe(4);
    lists.release();
    await expect
      .poll(() => listReads().filter((call) => call.completedAt).length)
      .toBeGreaterThanOrEqual(2);
    await settleReact(page);
    expect(
      api.calls.slice(before).filter((call) => call.path === root),
    ).toEqual([]);
  } finally {
    lists.release();
    await testInfo.attach("thread burst evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("a change to a held message reads it once, and a purged one reloads every list that held it", async ({
  page,
}, testInfo) => {
  const world = fourRoomWorld();
  const { operations } = world.ids;
  // A second top-level message links the same record; it is not a thread.
  const linked = {
    ...world.root,
    id: "77000000-0000-4000-8000-000000000040",
    client_key: "77000000-0000-4000-8000-000000000041",
    seq: 3,
    body: "The Riverside visit needs a second van.",
    record_links: [
      {
        id: "77000000-0000-4000-8000-000000000042",
        record_id: world.root.record_links[0].record_id,
      },
    ],
  };
  world.initial.messages[linked.id] = linked;
  world.initial.high_water_seq[operations] = 3;
  const owner = {
    user_id: defaultSignedInIdentity.id,
    org_id: defaultOrganization.org_id,
  };
  const api = await prepare(
    page,
    "admin",
    undefined,
    createMemoryCommsRuntime({ owner, initial: world.initial }),
  );
  const author = api.server.runtime.controls.clientFor(world.root.author_id);
  const noah = api.server.runtime.controls.clientFor(world.peer.user_id);
  const edit = (id: string, body: string) =>
    author.editMessage(operations, id, {
      body,
      mention_user_ids: [],
      mentions_channel: false,
      mentions_here: false,
    });
  const bySequence = (seq: number) => (start: number) =>
    api.calls
      .slice(start)
      .filter(
        (call) =>
          call.path ===
          `/api/comms/conversations/${operations}/messages/by-sequence/${seq}`,
      );
  const listReads = (start: number) =>
    api.calls
      .slice(start)
      .filter(
        (call) =>
          call.path === "/api/comms/threads" ||
          call.path === "/api/comms/search",
      )
      .map((call) => call.path)
      .sort();
  async function change(
    action: () => Promise<unknown>,
    reads: (start: number) => typeof api.calls,
  ) {
    const start = api.calls.length;
    await action();
    await expect
      .poll(() => reads(start).filter((call) => call.completedAt).length)
      .toBeGreaterThan(0);
    await settleReact(page);
    return start;
  }
  const record = page.getByRole("complementary", {
    name: "Record",
    exact: true,
  });
  try {
    await page.goto("/comms");
    await ready(page, linked.body);
    await page
      .getByRole("list", { name: "Records you follow", exact: true })
      .getByRole("button", { name: /Riverside service visit/ })
      .click();
    await expect(
      record.getByRole("button", { name: /Two vans are loaded/ }),
    ).toBeVisible();
    // An edit and a reaction on the open conversation's thread root: its
    // history and the held thread list share one read of that message.
    let start = await change(
      () => edit(world.root.id, "Three vans are loaded."),
      bySequence(1),
    );
    await expect(
      record.getByRole("button", { name: /Three vans are loaded/ }),
    ).toBeVisible();
    expect(bySequence(1)(start)).toHaveLength(1);
    expect(listReads(start)).toEqual([]);
    start = await change(
      () => noah.addReaction(operations, world.root.id, { emoji: "\u{1F44D}" }),
      bySequence(1),
    );
    expect(bySequence(1)(start)).toHaveLength(1);
    expect(listReads(start)).toEqual([]);
    // An unavailable read is not a purge: no list is read again.
    api.server.failNext(/\/by-sequence\/1$/, 503);
    start = await change(
      () => edit(world.root.id, "Four vans are loaded."),
      bySequence(1),
    );
    expect(listReads(start)).toEqual([]);
    // The linked message becomes a thread root: both lists now hold it.
    start = await change(
      () => author.createThread(operations, linked.id),
      (from) =>
        api.calls
          .slice(from)
          .filter(
            (call) =>
              call.path ===
              `/api/comms/conversations/${operations}/messages/${linked.id}`,
          ),
    );
    // A purged message has no DTO: every list that held it is read again.
    api.server.failNext(/\/by-sequence\/3$/, 404);
    start = await change(
      () => edit(linked.id, "Purged before the read."),
      bySequence(3),
    );
    await expect
      .poll(() => listReads(start))
      .toEqual([
        "/api/comms/search",
        "/api/comms/threads",
        "/api/comms/threads",
      ]);
    // A deleted root leaves the record's linked messages.
    start = await change(
      () => author.deleteMessage(operations, world.root.id),
      bySequence(1),
    );
    await expect(
      record.getByRole("button", { name: /vans are loaded/ }),
    ).toHaveCount(0);
    expect(bySequence(1)(start)).toHaveLength(1);
  } finally {
    await testInfo.attach("held message evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("a later change to a held message never takes the read of an earlier one", async ({
  page,
}, testInfo) => {
  const world = fourRoomWorld();
  const api = await prepare(page, "admin", undefined, world.runtime);
  const { operations } = world.ids;
  const author = world.runtime.controls.clientFor(world.root.author_id);
  const edit = (body: string) =>
    author.editMessage(operations, world.root.id, {
      body,
      mention_user_ids: [],
      mentions_channel: false,
      mentions_here: false,
    });
  const record = page.getByRole("complementary", {
    name: "Record",
    exact: true,
  });
  // Each read answers with the message as it was when the read arrived.
  const held: (() => void)[] = [];
  let holding = true;
  await page.route(
    `**/api/comms/conversations/${operations}/messages/by-sequence/1`,
    async (route) => {
      const result = await world.runtime.client.getMessageBySequence(
        operations,
        1,
      );
      if (holding) await new Promise<void>((done) => held.push(done));
      await route.fulfill({
        json: result.data,
        headers: { ETag: result.etag, "Cache-Control": "private, no-store" },
      });
    },
  );
  const bySequence = () =>
    api.calls.filter((call) => call.path.endsWith("/by-sequence/1"));
  try {
    await page.goto("/comms");
    await ready(page, world.root.body);
    await page
      .getByRole("list", { name: "Records you follow", exact: true })
      .getByRole("button", { name: /Riverside service visit/ })
      .click();
    await expect(
      record.getByRole("button", { name: /Two vans are loaded/ }),
    ).toBeVisible();
    await edit("Three vans are loaded.");
    await expect.poll(() => held.length).toBe(1);
    // A second edit arrives while the first edit's read is still open.
    await edit("Four vans are loaded.");
    await settleReact(page);
    held.shift()!();
    await expect
      .poll(() => bySequence().filter((call) => call.completedAt).length)
      .toBeGreaterThan(0);
    holding = false;
    for (const release of held.splice(0)) release();
    await expect(
      page
        .getByLabel("Messages", { exact: true })
        .getByText("Four vans are loaded.", { exact: true }),
    ).toBeVisible();
    await expect(
      record.getByRole("button", { name: /Four vans are loaded/ }),
    ).toBeVisible();
  } finally {
    holding = false;
    for (const release of held.splice(0)) release();
    await testInfo.attach("held message order evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("after a session re-check Comms waits for a fresh identity read", async ({
  page,
}, testInfo) => {
  const api = await prepare(page);
  const identity = heldResponse();
  try {
    await page.goto("/comms");
    await ready(page);
    await page.route("**/api/auth/me", async (route) => {
      identity.enter();
      await identity.released;
      return route.fallback();
    });
    const before = api.calls.length;
    const since = (path: string) =>
      api.calls.slice(before).filter((call) => call.path === path);
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await identity.entered;
    await expect
      .poll(() => since("/api/auth/session").filter((call) => call.completedAt))
      .not.toEqual([]);
    await settleReact(page, 4);
    // The cached identity predates the re-check: Comms does not start on it.
    expect(since("/api/comms/bootstrap")).toEqual([]);
    identity.release();
    await expect.poll(() => since("/api/comms/bootstrap").length).toBe(1);
    await ready(page);
  } finally {
    identity.release();
    await testInfo.attach("re-check identity evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});

test("an older read of a held message that lands last does not replace a newer one", async ({
  page,
}, testInfo) => {
  const world = fourRoomWorld();
  const api = await prepare(page, "admin", undefined, world.runtime);
  const { operations } = world.ids;
  const author = world.runtime.controls.clientFor(world.root.author_id);
  const edit = (body: string) =>
    author.editMessage(operations, world.root.id, {
      body,
      mention_user_ids: [],
      mentions_channel: false,
      mentions_here: false,
    });
  const record = page.getByRole("complementary", {
    name: "Record",
    exact: true,
  });
  // Each read answers with the message as it was when the read arrived.
  const held: (() => void)[] = [];
  let holding = true;
  await page.route(
    `**/api/comms/conversations/${operations}/messages/by-sequence/1`,
    async (route) => {
      const result = await world.runtime.client.getMessageBySequence(
        operations,
        1,
      );
      if (holding) await new Promise<void>((done) => held.push(done));
      await route.fulfill({
        json: result.data,
        headers: { ETag: result.etag, "Cache-Control": "private, no-store" },
      });
    },
  );
  const completed = () =>
    api.calls.filter(
      (call) => call.path.endsWith("/by-sequence/1") && call.completedAt,
    ).length;
  try {
    await page.goto("/comms");
    await ready(page, world.root.body);
    await page
      .getByRole("list", { name: "Records you follow", exact: true })
      .getByRole("button", { name: /Riverside service visit/ })
      .click();
    await expect(
      record.getByRole("button", { name: /Two vans are loaded/ }),
    ).toBeVisible();
    await edit("Three vans are loaded.");
    await expect.poll(() => held.length).toBe(1);
    await edit("Four vans are loaded.");
    await expect.poll(() => held.length).toBe(2);
    // The newer read lands first; the older one lands after it.
    held.splice(1, 1)[0]();
    await expect(
      record.getByRole("button", { name: /Four vans are loaded/ }),
    ).toBeVisible();
    holding = false;
    for (const release of held.splice(0)) release();
    await expect.poll(completed).toBeGreaterThanOrEqual(2);
    await expect(
      page
        .getByLabel("Messages", { exact: true })
        .getByText("Four vans are loaded.", { exact: true }),
    ).toBeVisible();
    await settleReact(page);
    await expect(
      record.getByRole("button", { name: /Four vans are loaded/ }),
    ).toBeVisible();
  } finally {
    holding = false;
    for (const release of held.splice(0)) release();
    await testInfo.attach("out-of-order read evidence", {
      body: JSON.stringify(api.calls),
      contentType: "application/json",
    });
    await page.close();
    api.server.close();
  }
});
