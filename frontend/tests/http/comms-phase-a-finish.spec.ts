import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TestInfo } from "@playwright/test";
import {
  authMeBody,
  defaultOrganization,
  expect,
  expectNoHorizontalScroll,
  signedInAs,
  test,
  type Page,
} from "./helpers/test";
import { profilePreferences } from "./helpers/profile-api";
import { createMemoryCommsRuntime } from "../../src/components/systems/comms/adapters/memory-client";
import { createMemorySeed } from "../../src/components/systems/comms/memory/seed";
import { validateMemoryState } from "../../src/components/systems/comms/memory/snapshot";
import { serializeSampleSessionSnapshot } from "../../src/components/systems/shared/runtime/sample-state";
import { workspaceSessionSnapshotStorageKey } from "../../src/components/systems/shared/runtime/workspace-identity";

// The rectangle regression below runs normally. Visual capture tasks alone are
// opt-in and refuse existing directories so they cannot overwrite reviewed images.
const widths = process.env.OPENCOMMS_FINISH_CAPTURE === "1" ? [1440, 390] : [];
const round = process.env.OPENCOMMS_FINISH_ROUND ?? "1";
const tools = [
  ["moderation", "Moderation"],
  ["outbox", "Scheduled messages"],
  ["retention", "Message retention"],
  ["export", "Export messages"],
  ["templates", "Channel templates"],
  ["management", "Join requests"],
  ["history", "Settings history"],
] as const;

async function seedFinish(page: Page) {
  const owner = {
    user_id: "00000000-0000-4000-8000-000000000101",
    org_id: defaultOrganization.org_id,
  };
  await signedInAs(page, { id: owner.user_id, role: "admin" });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: owner.user_id,
        role: "admin",
        display_name: "Sam Patel",
        memberships: [
          { ...defaultOrganization, role: "admin" },
          {
            org_id: "79000000-0000-4000-8000-000000000099",
            name: "West operations",
            slug: "west-operations",
            role: "member",
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/users/${owner.user_id}/preferences`, (route) =>
    route.fulfill({
      json: { ...profilePreferences(owner.user_id), theme: "system" },
    }),
  );
  const initial = createMemorySeed(owner, {
    role: "admin",
    display_name: "Sam Patel",
  });
  const conversation = Object.values(initial.conversations)[0].id;
  const root = Object.values(initial.messages).find(
    (message) => message.parent_id === null,
  )!;
  const thread = Object.values(initial.threads)[0].id;
  const record = Object.values(initial.records)[0].id;
  const removed = "79000000-0000-4000-8000-000000000098";
  initial.messages[removed] = {
    ...root,
    id: removed,
    client_key: removed,
    seq: 3,
    body: "Earlier dispatch note",
    record_links: [],
  };
  initial.high_water_seq[conversation] = 3;
  let tick = 0;
  const runtime = createMemoryCommsRuntime(
    { owner, initial },
    { clock: () => Date.parse("2026-10-20T00:00:00Z") + tick++ },
  );
  let snapshot;
  try {
    const client = runtime.client;
    await client.reportMessage(conversation, root.id, {
      reason: "Review dispatch wording",
    });
    await client.removeMessage(conversation, removed, {
      if_match: (await client.getMessage(conversation, removed)).etag,
    });
    await client.createTemplate({
      name: "Dispatch defaults",
      description: "Local example",
      settings: { mention_limit: 4 },
    });
    const workspace = { kind: "workspace" } as const;
    await client.updateSettings(
      workspace,
      { formatting: false },
      { if_match: (await client.getSettings(workspace)).etag },
    );
    await client.createSchedule({
      conversation_id: conversation,
      client_key: "79000000-0000-4000-8000-000000000097",
      body: "Scheduled dispatch update",
      attachment_ids: [],
      record_ids: [],
      mention_user_ids: [],
      mentions_channel: false,
      mentions_here: false,
      reply_to_id: null,
      parent_id: null,
      also_send_to_channel: false,
      send_at: "2099-12-01T12:00:00Z",
    });
    const privateRoom = (
      await client.createChannel({
        name: "private-dispatch",
        topic: "Dispatch coordination",
        category_id: null,
        position: 1,
        scope: "members",
        member_ids: [owner.user_id],
      })
    ).data;
    const scope = { kind: "channel", id: privateRoom.id } as const;
    await client.updateSettings(
      scope,
      { join_rule: "request" },
      { if_match: (await client.getSettings(scope)).etag },
    );
    snapshot = runtime.exportSnapshot();
    const id = "79000000-0000-4000-8000-000000000096";
    snapshot.state.admissions[id] = {
      id,
      org_id: owner.org_id,
      created_at: "2026-10-19T01:00:00Z",
      updated_at: "2026-10-19T01:00:00Z",
      conversation_id: privateRoom.id,
      user_id: root.author_id,
      kind: "request",
      status: "pending",
      resolved_at: null,
    };
  } finally {
    runtime.dispose();
  }
  validateMemoryState(snapshot.state, owner.org_id);
  const key = workspaceSessionSnapshotStorageKey(owner.user_id, owner.org_id);
  const value = serializeSampleSessionSnapshot(
    owner.user_id,
    { "comms-memory-v1": snapshot },
    owner.org_id,
  );
  await page.addInitScript(
    ({ key, value }) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
    },
    { key, value },
  );
  return { conversation, thread, record, root: root.id, removed };
}

async function observeMeasuredRows(page: Page) {
  await page.addInitScript(() => {
    const observed = new WeakSet<Element>();
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      observe(target: Element, options?: ResizeObserverOptions) {
        observed.add(target);
        super.observe(target, options);
      }
      unobserve(target: Element) {
        observed.delete(target);
        super.unobserve(target);
      }
    };
    Reflect.set(window, "commsRowObserved", (node: Element) =>
      observed.has(node),
    );
  });
}

async function checkRows(
  page: Page,
  data: { root: string; removed: string },
  state: string,
  testInfo: TestInfo,
) {
  // The phone Thread dialog marks this background feed aria-hidden, but its
  // actual mounted geometry remains the same overlap oracle.
  const viewport = page.locator('[role="region"][aria-label="Messages"]');
  // Let the pane's layout and ResizeObserver delivery commit, not a timed sleep.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const measurement = await viewport.evaluate((node) => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        height: box.height,
        width: box.width,
      };
    };
    const feed = node.querySelector('[role="feed"]')!;
    const rows = [...feed.children]
      .filter((element) => element.hasAttribute("data-index"))
      .map((wrapper) => {
        const article = wrapper.querySelector("article")!;
        return {
          index: Number(wrapper.getAttribute("data-index")),
          id: article.id,
          observerRegistered: Boolean(
            Reflect.get(window, "commsRowObserved")(wrapper),
          ),
          transform: getComputedStyle(wrapper).transform,
          wrapper: rect(wrapper),
          article: rect(article),
        };
      });
    return {
      scrollTop: node.scrollTop,
      viewport: rect(node),
      feed: rect(feed),
      renderedIndices: rows.map((row) => row.index),
      observedIndices: rows
        .filter((row) => row.observerRegistered)
        .map((row) => row.index),
      rows,
    };
  });
  await testInfo.attach(`row-rectangles-${state}`, {
    body: JSON.stringify(measurement, null, 2),
    contentType: "application/json",
  });
  console.info(`COMMS_ROW_GEOMETRY ${state} ${JSON.stringify(measurement)}`);
  expect
    .soft(
      measurement.rows.map((row) => row.id),
      state,
    )
    .toEqual([data.root, data.removed]);
  for (const row of measurement.rows) {
    expect
      .soft(row.article.height, `${state}: article ${row.id}`)
      .toBeGreaterThan(0);
    expect
      .soft(row.wrapper.height, `${state}: wrapper ${row.id}`)
      .toBeGreaterThan(0);
  }
  for (let index = 1; index < measurement.rows.length; index++) {
    const previous = measurement.rows[index - 1],
      next = measurement.rows[index];
    expect
      .soft(next.wrapper.top, `${state}: adjacent wrappers do not intersect`)
      .toBeGreaterThanOrEqual(previous.wrapper.bottom);
    expect
      .soft(next.article.top, `${state}: adjacent articles do not intersect`)
      .toBeGreaterThanOrEqual(previous.article.bottom);
  }
  return measurement;
}

test("short finish history keeps adjacent rows ordered through Members and Thread transitions", async ({
  page,
}, testInfo) => {
  const data = await seedFinish(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await observeMeasuredRows(page);
  await page.goto(`/comms?conversation=${data.conversation}`);
  await expect(
    page
      .getByRole("region", { name: "Conversation", exact: true })
      .getByRole("button", { name: /Open record:.*Riverside service visit/ }),
  ).toBeVisible();
  const check = (state: string) => checkRows(page, data, state, testInfo);
  await check("conversation");
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Members with access", exact: true }),
  ).toBeVisible();
  await check("members");
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Members with access", exact: true }),
  ).toHaveCount(0);
  await check("members-closed");
  await page
    .getByRole("button", { name: "Thread: Morning handover", exact: true })
    .click();
  const thread = page.getByRole("region", {
    name: "Thread conversation",
    exact: true,
  });
  await expect(thread).toBeVisible();
  await check("thread");
  await thread
    .getByRole("button", { name: "Back to messages", exact: true })
    .click();
  await expect(thread).toHaveCount(0);
  await check("thread-closed");
});

// Explicit owner exception: exactly four post-adjudication confirmations, not
// another finish sweep. Normal runs and the full round procedure do not opt in.
const confirmationCases = [
  { name: "1440-light-members", width: 1440, theme: "light", pane: "members" },
  { name: "1440-dark-members", width: 1440, theme: "dark", pane: "members" },
  { name: "1440-light-thread", width: 1440, theme: "light", pane: "thread" },
  { name: "390-light-thread", width: 390, theme: "light", pane: "thread" },
] as const;
for (const entry of process.env.OPENCOMMS_ADJUDICATED_CONFIRM === "1"
  ? confirmationCases
  : []) {
  test(`adjudicated overlap confirmation ${entry.name}`, async ({
    page,
  }, testInfo) => {
    expect(process.env.OPENCOMMS_FINISH_SOURCE_ID).toMatch(/^[0-9a-f]{64}$/);
    expect(process.env.OPENCOMMS_CONFIRM_BUILD_ID).toMatch(/^\S+$/);
    const data = await seedFinish(page);
    await observeMeasuredRows(page);
    await page.setViewportSize({
      width: entry.width,
      height: entry.width === 390 ? 844 : 900,
    });
    await page.emulateMedia({ colorScheme: entry.theme });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/comms?conversation=${data.conversation}`);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    if (entry.theme === "dark")
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    if (entry.pane === "members") {
      await page.getByRole("button", { name: "Members", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "Members with access", exact: true }),
      ).toBeVisible();
    } else {
      await page
        .getByRole("button", {
          name: entry.width === 390 ? "1 replies" : "Thread: Morning handover",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("region", { name: "Thread conversation", exact: true }),
      ).toBeVisible();
    }
    const rectangles = await checkRows(page, data, entry.name, testInfo);
    // A soft regression failure must stop this case before any screenshot.
    expect(testInfo.errors).toEqual([]);
    expect(errors).toEqual([]);
    const directory = resolve(
      process.cwd(),
      "../.impeccable/review/opencomms-a/adjudicated-confirmation",
    );
    await mkdir(directory, { recursive: true });
    expect(await readdir(directory)).not.toContain(`${entry.name}.png`);
    const evidence = {
      ...entry,
      sourceIdentity: process.env.OPENCOMMS_FINISH_SOURCE_ID,
      build: process.env.OPENCOMMS_CONFIRM_BUILD_ID,
      rectangles,
      pageErrors: errors,
    };
    await writeFile(
      resolve(directory, `${entry.name}.json`),
      JSON.stringify(evidence, null, 2),
      { flag: "wx" },
    );
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: resolve(directory, `${entry.name}.png`),
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  });
}

for (const width of widths)
  for (const theme of ["light", "dark"] as const)
    for (const section of ["core", ...tools.map(([id]) => id)]) {
      test(`Phase A finish capture ${width} ${theme} ${section}`, async ({
        page,
      }, testInfo) => {
        expect(["1", "2"]).toContain(round);
        const root = resolve(
          process.cwd(),
          "../.impeccable/review/opencomms-a",
          `round-${round}`,
        );
        await mkdir(resolve(root, `${width}-${theme}`), { recursive: true });
        const directory = resolve(root, `${width}-${theme}`, section);
        await mkdir(directory);
        const captures: { file: string; url: string; action: string }[] = [];
        const consoleMessages: { type: string; text: string }[] = [];
        const pageErrors: string[] = [];
        let completed = false;
        page.on("console", (message) => {
          if (["warning", "error"].includes(message.type()))
            consoleMessages.push({
              type: message.type(),
              text: message.text(),
            });
        });
        page.on("pageerror", (error) => pageErrors.push(error.message));
        async function capture(name: string, action: string) {
          await expectNoHorizontalScroll(page);
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.mouse.move(0, 0);
          const file = `${name}.png`;
          await page.screenshot({
            path: resolve(directory, file),
            animations: "disabled",
          });
          captures.push({ file, url: page.url(), action });
        }
        try {
          const data = await seedFinish(page);
          await page.setViewportSize({
            width,
            height: width === 390 ? 844 : 900,
          });
          await page.emulateMedia({ colorScheme: theme });
          const conversationUrl = `/comms?conversation=${data.conversation}`;
          await page.goto(conversationUrl);
          await expect(
            page.getByRole("textbox", { name: "Message", exact: true }),
          ).toBeEnabled();
          if (theme === "dark")
            await expect(page.locator("html")).toHaveClass(/\bdark\b/);
          else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
          await expect(
            page.getByRole("status", {
              name: "Conversation connection",
              exact: true,
            }),
          ).toContainText("Local example connection");
          await expect(
            page.getByLabel("Current organization", { exact: true }),
          ).toHaveText("OpenSlate");
          if (section === "core") {
            await expect(
              page.getByRole("region", {
                name: "Members with access",
                exact: true,
              }),
            ).toHaveCount(0);
            await expect(
              page.getByRole("heading", { name: /^Welcome to/ }),
            ).toHaveCount(0);
            await capture(
              "main",
              "Open the owned conversation; real local memory client, not a live transport",
            );

            if (width === 390)
              await page
                .getByRole("button", { name: "Open navigation", exact: true })
                .click();
            const organization = page.getByRole("button", {
              name: "Organization: OpenSlate",
              exact: true,
            });
            await expect(organization).toBeInViewport();
            await organization.click();
            await expect(
              page.getByRole("menu", { name: "Organizations", exact: true }),
            ).toContainText("West operations");
            await capture(
              "organization-switcher",
              "Open shell organization menu; current organization and second synthetic membership visible; do not switch",
            );
            await page.keyboard.press("Escape");
            if (width === 390)
              await page
                .getByRole("button", { name: "Close navigation", exact: true })
                .click();

            for (const panel of ["thread", "members", "record"] as const) {
              await page.goto(
                `${conversationUrl}&${panel === "thread" ? `thread=${data.thread}` : `panel=${panel === "record" ? `record:${data.record}` : "members"}`}`,
              );
              const region =
                panel === "thread"
                  ? page.getByRole("region", {
                      name: "Thread conversation",
                      exact: true,
                    })
                  : panel === "members"
                    ? page.getByRole("region", {
                        name: "Members with access",
                        exact: true,
                      })
                    : page.getByRole(
                        width === 390 ? "dialog" : "complementary",
                        {
                          name: "Record",
                          exact: true,
                        },
                      );
              await expect(region).toBeVisible();
              if (panel === "thread")
                await expect(
                  region.getByRole("textbox", {
                    name: "Thread reply",
                    exact: true,
                  }),
                ).toBeEnabled();
              await capture(
                `pane-${panel}`,
                `Open ${panel} via its retained deep-link contract`,
              );
            }

            await page.goto(conversationUrl);
            if (width === 390)
              await page
                .getByRole("button", { name: "Details", exact: true })
                .click();
            await page
              .getByRole("button", { name: "Channel settings", exact: true })
              .click();
            const settings = page.getByRole("dialog", {
              name: "Channel settings",
              exact: true,
            });
            if (width === 390)
              await settings
                .getByLabel("Settings section", { exact: true })
                .selectOption("messaging");
            else
              await settings
                .getByRole("tab", { name: "Messaging", exact: true })
                .click();
            const advanced = settings.getByRole("button", {
              name: /Advanced settings/,
            });
            await expect(advanced).toHaveAttribute("aria-expanded", "false");
            await expect(
              settings.getByLabel("Channel mode", { exact: true }),
            ).toBeVisible();
            await capture(
              "settings-advanced-closed",
              "Open channel Messaging; common controls and collapsed Advanced",
            );
            await advanced.click();
            await expect(
              settings.getByLabel("Slow mode (seconds)", { exact: true }),
            ).toBeVisible();
            await advanced.evaluate((node) =>
              node.scrollIntoView({ block: "start" }),
            );
            await capture(
              "settings-advanced-open",
              "Expand Advanced and scroll its heading into view; no settings mutation",
            );
          }

          for (const [id, title] of tools.filter(([id]) => id === section)) {
            await page.goto("/comms");
            await page
              .getByRole("button", { name: "OpenComms menu", exact: true })
              .first()
              .click();
            await page.getByRole("menuitem", { name: /^Admin tools/ }).click();
            await page
              .getByRole("menuitem", { name: new RegExp(`^${title}(?: |$)`) })
              .click();
            const tool = page.getByRole("region", { name: title, exact: true });
            await expect(tool).toBeVisible();
            await expect(
              tool.getByRole("button", {
                name: "Back to conversation",
                exact: true,
              }),
            ).toBeVisible();
            const toggle = tool.getByRole("button", {
              name: /Advanced settings/,
            });
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
            if (id === "moderation")
              await expect(
                tool.getByText("Review dispatch wording", { exact: true }),
              ).toBeVisible();
            if (id === "outbox")
              await expect(
                tool.getByRole("button", { name: /Scheduled dispatch update/ }),
              ).toBeVisible();
            if (id === "retention")
              await expect(
                tool.getByLabel("Retention days (0 keeps everything)", {
                  exact: true,
                }),
              ).toBeVisible();
            if (id === "export")
              await expect(tool.getByText(/fixed sample CSV/)).toBeVisible();
            if (id === "templates")
              await tool
                .getByLabel("Template", { exact: true })
                .selectOption({ label: "Dispatch defaults" });
            if (id === "management")
              await expect(
                tool.getByRole("button", { name: "Approve", exact: true }),
              ).toBeVisible();
            if (id === "history")
              await tool
                .getByRole("button", { name: "Before and after", exact: true })
                .first()
                .click();
            await capture(
              `tool-${id}-closed`,
              `Open ${title} through OpenComms > Admin tools; common task ready`,
            );
            await toggle.click();
            await expect(toggle).toHaveAttribute("aria-expanded", "true");
            await toggle.evaluate((node) =>
              node.scrollIntoView({ block: "start" }),
            );
            await capture(
              `tool-${id}-open`,
              `Expand ${title} Advanced; no destructive or server-side action`,
            );
          }
          expect(captures).toHaveLength(section === "core" ? 7 : 2);
          expect(pageErrors).toEqual([]);
          expect(
            consoleMessages.filter((message) => message.type === "error"),
          ).toEqual([]);
          completed = true;
        } finally {
          const report = {
            round,
            section,
            viewport: { width, height: width === 390 ? 844 : 900 },
            theme,
            sourceIdentity:
              process.env.OPENCOMMS_FINISH_SOURCE_ID ?? "not supplied",
            captures,
            consoleMessages,
            pageErrors,
            status: completed ? "completed" : "incomplete",
            boundary:
              "Owned synthetic memory state and mocked HTTP identity/profile; no live backend or Realtime acceptance",
          };
          await writeFile(
            resolve(directory, "index.json"),
            JSON.stringify(report, null, 2),
          );
          await testInfo.attach("Phase A capture index", {
            body: JSON.stringify(report, null, 2),
            contentType: "application/json",
          });
        }
      });
    }
