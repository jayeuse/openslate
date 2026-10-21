import type { Page } from "@playwright/test";
import {
  expect,
  test,
  signedInAs,
  defaultOrganization,
  expectNoHorizontalScroll,
} from "./helpers/test";
import { createMemorySeed } from "../support/comms-memory/memory/seed";
import { validateMemoryState } from "../support/comms-memory/memory/snapshot";
import { serializeSampleSessionSnapshot } from "../../src/components/systems/shared/runtime/sample-state";
import { workspaceSessionSnapshotStorageKey } from "../../src/components/systems/shared/runtime/workspace-identity";
import type { Settings } from "../../src/components/systems/comms/contract/types";
import { profilePreferences } from "./helpers/profile-api";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6+SYAAAAASUVORK5CYII=";
async function seedComposer(
  page: Page,
  settings: Partial<Settings> = {},
  role: "admin" | "member" = "admin",
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
  const room = Object.values(state.conversations)[0];
  const noah = Object.values(state.people).find(
    (person) => person.display_name === "Noah Tan",
  )!;
  const sofia = Object.values(state.people).find(
    (person) => person.display_name === "Sofia Garcia",
  )!;
  delete state.members[room.id][sofia.user_id];
  state.configuration.workspace = {
    settings,
    capabilities: {
      scope: { kind: "workspace" },
      everyone: {},
      group_grants: [],
    },
  };
  validateMemoryState(state, owner.org_id);
  const key = workspaceSessionSnapshotStorageKey(owner.user_id, owner.org_id);
  const value = serializeSampleSessionSnapshot(
    owner.user_id,
    { "comms-memory-v1": { format: 1, owner, state } },
    owner.org_id,
  );
  await page.addInitScript(
    ({ key, value }) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
    },
    { key, value },
  );
  return { key, noah: noah.user_id };
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
    page.getByText("No matching members.", { exact: true }),
  ).toBeVisible();
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
    page.evaluate(
      ({ key, body }) => {
        const messages: { body: string; mention_user_ids: string[] }[] =
          Object.values(
            JSON.parse(sessionStorage.getItem(key)!).values["comms-memory-v1"]
              .state.messages,
          );
        return messages.find((message) => message.body === body)
          ?.mention_user_ids;
      },
      { key: fixture.key, body },
    );
  expect(await mentionsFor("Hello @Noah Tan")).toEqual([fixture.noah]);
  await input.fill("@Noah");
  await page.getByRole("option", { name: "Noah Tan", exact: true }).click();
  await input.fill("@Noah Tancredi");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(input).toHaveValue("");
  expect(await mentionsFor("@Noah Tancredi")).toEqual([]);
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
  await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function (this: Blob) {
      if (this instanceof File && this.name === "clipboard.png")
        return new Promise<ArrayBuffer>((resolve, reject) =>
          window.addEventListener(
            "release-upload",
            () => {
              void read.call(this).then(resolve, reject);
            },
            { once: true },
          ),
        );
      return read.call(this);
    };
  });
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
  await page.evaluate(() => window.dispatchEvent(new Event("release-upload")));
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
    await seedComposer(page);
    await page.addInitScript(
      ({ status, code }) => {
        const race = Promise.race.bind(Promise);
        let refused = false;
        Promise.race = <T>(values: Iterable<T | PromiseLike<T>>) =>
          race<T>(values).then((result) => {
            const value =
              result && typeof result === "object" && "value" in result
                ? result.value
                : null;
            if (
              !refused &&
              value &&
              typeof value === "object" &&
              "filename" in value &&
              value.filename === "blocked.png"
            ) {
              refused = true;
              throw Object.assign(new Error("Owned upload refusal"), {
                kind: "http",
                failure: {
                  status,
                  body: { detail: { code, message: "Owned upload refusal" } },
                },
              });
            }
            return result;
          });
      },
      { status, code },
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
  await seedComposer(page, { slow_mode_seconds: 6 });
  await page.goto("/comms");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  await input.fill("First accepted message");
  await send.click();
  await expect(input).toHaveValue("");
  await input.fill("Waiting draft");
  await expect(
    page.getByText("Send available in 6s", { exact: true }),
  ).toBeVisible();
  await expect(send).toBeDisabled();
  await page.clock.runFor(3000);
  await expect(
    page.getByText("Send available in 3s", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("Waiting draft");
  await page.clock.runFor(4000);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(input).toHaveValue("");
});

test("composer schedules a record-linked draft through the existing client", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-20T12:00:00Z"));
  const fixture = await seedComposer(page);
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
  const scheduled = await page.evaluate(({ key }) => {
    const rows: {
      status: string;
      request: { body: string; record_ids: string[]; send_at: string };
    }[] = Object.values(
      JSON.parse(sessionStorage.getItem(key)!).values["comms-memory-v1"].state
        .schedules,
    );
    return rows.map(({ status, request }) => ({
      status,
      body: request.body,
      records: request.record_ids.length,
      send_at: request.send_at,
    }));
  }, fixture);
  expect(scheduled).toEqual([
    {
      status: "pending",
      body: "Scheduled from the composer",
      records: 1,
      send_at: "2026-10-20T13:00:00.000Z",
    },
  ]);
});
