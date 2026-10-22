import type { Page } from "@playwright/test";
import {
  expect,
  test,
  signedInAs,
  defaultOrganization,
  expectNoHorizontalScroll,
  heldResponse,
} from "./helpers/test";
import { createMemorySeed } from "../support/comms-memory/memory/seed";
import { validateMemoryState } from "../support/comms-memory/memory/snapshot";
import { createMemoryCommsRuntime } from "../support/comms-memory/memory-client";
import { installCommsLiveApi } from "./helpers/comms-live-api";
import {
  createCommsTestClock,
  type CommsTestClock,
} from "./helpers/comms-world";
import type { Settings } from "../../src/components/systems/comms/contract/types";
import { profilePreferences } from "./helpers/profile-api";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6+SYAAAAASUVORK5CYII=";
async function seedComposer(
  page: Page,
  settings: Partial<Settings> = {},
  role: "admin" | "member" = "admin",
  clock?: CommsTestClock,
  prepare?: (state: ReturnType<typeof createMemorySeed>) => void,
) {
  const owner = {
    user_id: "00000000-0000-4000-8000-000000000101",
    org_id: defaultOrganization.org_id,
  };
  await signedInAs(page, { id: owner.user_id, role });
  const state = createMemorySeed(owner, {
    role,
    display_name: "Composer owner",
  });
  const noah = Object.values(state.people).find(
    (person) => person.display_name === "Noah Tan",
  )!;
  const sofia = Object.values(state.people).find(
    (person) => person.display_name === "Sofia Garcia",
  )!;
  // Sofia holds no department role, so she cannot read the channel (D44).
  state.people[sofia.user_id].department_levels = {};
  state.configuration.workspace = {
    settings,
    capabilities: {
      scope: { kind: "workspace" },
      everyone: {},
      group_grants: [],
    },
  };
  prepare?.(state);
  validateMemoryState(state, owner.org_id);
  const runtime = createMemoryCommsRuntime(
    { owner, initial: state },
    clock ? { clock: clock.now } : {},
  );
  const server = await installCommsLiveApi(page, {
    userId: owner.user_id,
    organizationId: owner.org_id,
    runtime,
    clock: clock?.now,
  });
  return { runtime, server, noah: noah.user_id };
}

test("composer mentions only current members and keeps the draft above the mention limit", async ({
  page,
}) => {
  const fixture = await seedComposer(page, { mention_limit: 1 });
  await page.goto("/comms");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("@");
  await expect(
    page.getByRole("option", { name: "channel", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "here", exact: true }),
  ).toBeVisible();
  await input.fill("Hello @Sofia");
  await expect(
    page.getByRole("listbox", { name: "Mention members", exact: true }),
  ).toBeHidden();
  await input.fill("Hello @Noah");
  await page.getByRole("option", { name: "Noah Tan", exact: true }).click();
  await input.fill("Hello @Noah Tan @Mara");
  await page.getByRole("option", { name: "Mara Santos", exact: true }).click();
  await expect(
    page.getByText("This conversation allows 1 mention per message.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await input.fill("Hello @Noah Tan");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(input).toHaveValue("");
  const mentionsFor = (body: string) =>
    Object.values(fixture.runtime.exportSnapshot().state.messages).find(
      (message) => message.body === body,
    )?.mention_user_ids;
  await expect
    .poll(() => mentionsFor("Hello @Noah Tan"))
    .toEqual([fixture.noah]);
  await input.fill("@Noah");
  await page.getByRole("option", { name: "Noah Tan", exact: true }).click();
  await input.fill("@Noah Tancredi");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect.poll(() => mentionsFor("@Noah Tancredi")).toEqual([]);
});

test("a mention query keeps its list open across a space while a name matches, and closes on Escape or no match", async ({
  page,
}) => {
  await seedComposer(page, {}, "admin", undefined, (state) => {
    const rename = (from: string, to: string) => {
      Object.values(state.people).find(
        (person) => person.display_name === from,
      )!.display_name = to;
    };
    rename("Noah Tan", "HO Manager");
    rename("Mara Santos", "HO Manager Lead");
  });
  await page.goto("/comms");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const list = page.getByRole("listbox", {
    name: "Mention members",
    exact: true,
  });
  await input.fill("Ready @HO M");
  await expect(list.getByRole("option")).toHaveText([
    "HO Manager",
    "HO Manager Lead",
  ]);
  await input.press("Escape");
  await expect(list).toBeHidden();
  await input.fill("Ready @HO Mx");
  await expect(list).toBeHidden();
  await input.fill("Ready @HO Ma");
  await list.getByRole("option", { name: "HO Manager", exact: true }).click();
  await expect(input).toHaveValue("Ready @HO Manager ");
  await expect(list).toBeHidden();
  // Text after a chosen mention never reopens it, even when it would match a
  // longer name; Enter sends.
  await input.press("End");
  await input.pressSequentially("Lead");
  await expect(input).toHaveValue("Ready @HO Manager Lead");
  await expect(list).toBeHidden();
  await input.press("Enter");
  await expect(input).toHaveValue("");
});

test("composer inserts emoji at the caret, edits its last message and cancels a quote without losing text", async ({
  page,
}) => {
  await seedComposer(page);
  await page.goto("/comms");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toHaveAttribute("dir", "auto");
  await input.fill("Hello world");
  await input.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(5, 5),
  );
  await page.getByRole("button", { name: "Use emotes", exact: true }).click();
  await page.getByRole("button", { name: "Insert 👍", exact: true }).click();
  await expect(input).toHaveValue("Hello👍 world");
  await input.fill("**Ready** `code` https://example.com <img src=x>");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  const message = page.getByRole("article").filter({ hasText: "<img src=x>" });
  await expect(
    message.locator("strong").filter({ hasText: "Ready" }),
  ).toBeVisible();
  await expect(message.locator("code")).toHaveText("code");
  await expect(
    message.getByRole("link", { name: "https://example.com", exact: true }),
  ).toHaveAttribute("href", "https://example.com");
  await expect(message.locator("img")).toHaveCount(0);
  await input.press("ArrowUp");
  await page
    .getByRole("textbox", { name: "Edit message", exact: true })
    .fill("Changed owned message");
  await page.getByRole("button", { name: "Save message", exact: true }).click();
  await page
    .getByRole("article")
    .filter({ hasText: "Changed owned message" })
    .getByRole("button", { name: /^Message actions:/ })
    .click();
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await input.fill("Keep escape draft");
  await input.press("Escape");
  await expect(
    page.getByRole("button", { name: "Cancel reply", exact: true }),
  ).toHaveCount(0);
  await expect(input).toHaveValue("Keep escape draft");
  await expect(input).toBeFocused();
});

test("composer hides channel and here mentions without the conversation capability", async ({
  page,
}) => {
  await seedComposer(page, {}, "member");
  await page.goto("/comms");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("@");
  await expect(
    page.getByRole("option", { name: "Noah Tan", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "channel", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "here", exact: true }),
  ).toHaveCount(0);
});

test("composer grows within the conversation and keeps touch controls usable in both themes", async ({
  page,
}, testInfo) => {
  await seedComposer(page);
  const user = "00000000-0000-4000-8000-000000000101";
  await page.route(`**/api/users/${user}/preferences`, (route) =>
    route.fulfill({ json: { ...profilePreferences(user), theme: "system" } }),
  );
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/comms");
      if (width === 390)
        await page.getByRole("button", { name: /^operations(,|$)/ }).click();
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      await input.fill("");
      await input.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const initial = (await input.boundingBox())!.height;
      await input.fill(
        "First line\nSecond line\nThird line\nFourth line\n@Noah",
      );
      await expect
        .poll(async () => (await input.boundingBox())!.height)
        .toBeGreaterThan(initial);
      await expect(
        page.getByRole("option", { name: "Noah Tan", exact: true }),
      ).toBeVisible();
      if (theme === "dark")
        await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
      await expectNoHorizontalScroll(page);
      if (width === 390) {
        const sizes = await page
          .getByRole("form", { name: "Message composer", exact: true })
          .locator("button")
          .evaluateAll((buttons) =>
            buttons.map((button) => ({
              width: button.getBoundingClientRect().width,
              height: button.getBoundingClientRect().height,
            })),
          );
        for (const size of sizes) {
          expect(size.width).toBeGreaterThanOrEqual(44);
          expect(size.height).toBeGreaterThanOrEqual(44);
        }
      }
      await page.screenshot({
        path: testInfo.outputPath(`composer-${width}-${theme}.png`),
        animations: "disabled",
      });
    }
});

test("composer pastes a file with real per-file progress and rejects an unsupported drop", async ({
  page,
}) => {
  await seedComposer(page);
  // Hold the file bytes upload so its in-flight progress is observable.
  const upload = heldResponse();
  await page.route(
    "**/api/comms/conversations/*/files/*/content",
    async (route) => {
      if (route.request().method() === "PUT") {
        upload.enter();
        await upload.released;
      }
      await route.fallback();
    },
  );
  await page.goto("/comms");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Keep upload draft");
  await input.evaluate((node, png) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        [Uint8Array.from(atob(png), (char) => char.charCodeAt(0))],
        "clipboard.png",
        { type: "image/png" },
      ),
    );
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  }, png);
  await expect(
    page.getByRole("progressbar", {
      name: "Upload clipboard.png",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  upload.release();
  await expect(
    page.getByRole("button", { name: "Remove clipboard.png", exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("Keep upload draft");
  await input.evaluate((node) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["x"], "unsafe.exe"));
    node.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect(
    page.getByText("This file type is not allowed.", { exact: true }),
  ).toBeVisible();
});

for (const [status, code, copy] of [
  [503, "file_quota_busy", "Try again"],
  [409, "file_uploads_full", "Too many files are waiting; try again shortly"],
] as const) {
  test(`composer preserves its draft after upload ${code}`, async ({
    page,
  }) => {
    const { server } = await seedComposer(page);
    // The server refuses the first file reservation; the retry reserves again.
    server.failNext(
      /^\/conversations\/[^/]+\/files$/,
      status,
      { detail: { code, message: "Owned upload refusal" } },
      "POST",
    );
    await page.goto("/comms");
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Retained after upload refusal");
    await page.getByLabel("Upload files", { exact: true }).setInputFiles({
      name: "blocked.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await expect(page.getByText(copy, { exact: true })).toBeVisible();
    await expect(input).toHaveValue("Retained after upload refusal");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Remove blocked.png", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
  });
}

test("composer counts down slow mode without discarding the waiting draft", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-20T12:00:00Z") });
  // The fake server stamps and checks slow mode on this clock, not Node's.
  const clock = createCommsTestClock(page, "2026-10-20T12:00:00Z");
  await seedComposer(page, { slow_mode_seconds: 6 }, "admin", clock);
  await page.goto("/comms");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  await input.fill("First accepted message");
  // Page time flows after install; the server clock moves only when told.
  clock.set(await page.evaluate(() => Date.now()));
  await send.click();
  await expect(input).toHaveValue("");
  await input.fill("Waiting draft");
  await expect(
    page.getByText("Send available in 6s", { exact: true }),
  ).toBeVisible();
  await expect(send).toBeDisabled();
  await clock.runFor(3000);
  await expect(
    page.getByText("Send available in 3s", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("Waiting draft");
  // A reload forgets the local countdown; the server's slow-mode refusal
  // restores it from Retry-After and is not a failed send.
  await page.reload();
  await expect(input).toHaveValue("Waiting draft");
  await expect(send).toBeEnabled();
  await input.press("Enter");
  await expect(
    page.getByText("Send available in 3s", { exact: true }),
  ).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(input).toHaveValue("Waiting draft");
  // The refused send has settled before its absent failure surfaces are read.
  await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Not sent", { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("form", { name: "Message composer", exact: true })
      .getByRole("alert"),
  ).toHaveCount(0);
  // Neither the composer nor a status toast reports a failed send.
  await expect(page.getByText("could not be sent")).toHaveCount(0);
  await clock.runFor(4000);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(input).toHaveValue("");
  await expect(
    page.getByRole("article").filter({ hasText: "Waiting draft" }),
  ).toHaveCount(1);
});

test("composer schedules a record-linked draft through the existing client", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-20T12:00:00Z"));
  const fixture = await seedComposer(
    page,
    {},
    "admin",
    createCommsTestClock(page, "2026-10-20T12:00:00Z"),
  );
  await page.goto("/comms");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Scheduled from the composer");
  await page
    .getByRole("button", { name: "Attach record", exact: true })
    .click();
  await page
    .getByLabel("Attach record link", { exact: true })
    .selectOption({ label: "Riverside service visit" });
  await page
    .getByRole("button", { name: "Schedule send", exact: true })
    .click();
  await page
    .getByLabel("Send at (local time)", { exact: true })
    .fill("2026-10-20T13:00");
  await page.reload();
  await expect(
    page.getByLabel("Send at (local time)", { exact: true }),
  ).toHaveValue("2026-10-20T13:00");
  await page
    .getByRole("button", { name: "Schedule message", exact: true })
    .click();
  await expect(input).toHaveValue("");
  // The input clears only after the server accepted and stored the schedule.
  const scheduled = Object.values(fixture.server.snapshot().schedules).map(
    ({ status, request }) => ({
      status,
      body: request.body,
      records: request.record_ids.length,
      send_at: request.send_at,
    }),
  );
  expect(scheduled).toEqual([
    {
      status: "pending",
      body: "Scheduled from the composer",
      records: 1,
      send_at: "2026-10-20T13:00:00.000Z",
    },
  ]);
});
