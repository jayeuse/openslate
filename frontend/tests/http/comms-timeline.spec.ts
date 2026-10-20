import { expect, test } from "./helpers/test";
import { profilePreferences } from "./helpers/profile-api";
import { seedTimeline, timelineId } from "./helpers/comms-timeline-fixture";

test("Comms shows Sending until its real send receipt is released", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const race = Promise.race.bind(Promise);
    Promise.race = <T>(values: Iterable<T | PromiseLike<T>>) =>
      race<T>(values).then((result) => {
        const receipt =
          result && typeof result === "object" && "value" in result
            ? result.value
            : result;
        if (
          receipt &&
          typeof receipt === "object" &&
          "message" in receipt &&
          receipt.message &&
          typeof receipt.message === "object" &&
          "body" in receipt.message &&
          receipt.message.body === "Held send receipt"
        )
          return new Promise<Awaited<T>>((resolve) =>
            window.addEventListener(
              "release-comms-receipt",
              () => resolve(result),
              { once: true },
            ),
          );
        return result;
      });
  });
  await page.goto("/comms");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Held send receipt");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Sending…", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("Held send receipt");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("release-comms-receipt")),
  );
  await expect(input).toHaveValue("");
  await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0);
});

test("Comms Mark unread on fully read history survives refresh until new engagement", async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await seedTimeline(page, 80);
  await page.goto("/comms");
  await expect(page.locator(`[id="${timelineId(80)}"]`)).toBeInViewport();
  await page
    .getByRole("button", { name: "Channel actions: operations", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Mark unread", exact: true })
    .click();
  await page.clock.runFor(500);
  const reminder = () =>
    page.evaluate(
      ({ storageKey, owner, conversationId }) =>
        JSON.parse(sessionStorage.getItem(storageKey)!).values[
          "comms-memory-v1"
        ].state.users[owner.user_id].conversations[conversationId]
          .manual_unread,
      fixture,
    );
  expect(await reminder()).toBe(true);
  await page.getByLabel("Messages", { exact: true }).press("PageUp");
  await page.clock.runFor(32);
  await expect.poll(reminder).toBe(false);
});

test("Comms sparse history puts the unread divider at the actual first unread sequence", async ({
  page,
}) => {
  await seedTimeline(page, 180, 30, false, false, true);
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Jump to first unread", exact: true })
    .click();
  await expect(page.locator(`[id="${timelineId(131)}"]`)).toBeInViewport();
  await expect(
    page.getByRole("separator", { name: "New messages", exact: true }),
  ).toBeInViewport();
});

test("Comms edit Save and Cancel restore focus to the message action", async ({
  page,
}) => {
  await page.goto("/comms");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("An owned message for editing");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const message = page
    .getByRole("article")
    .filter({ hasText: "An owned message for editing" });
  const action = message.getByRole("button", { name: /^Message actions:/ });
  for (const submit of ["Save message", "Cancel edit"]) {
    await action.click();
    await page
      .getByRole("menuitem", { name: "Edit message", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Edit message", exact: true })
      .fill("An owned message for editing, changed");
    await page.getByRole("button", { name: submit, exact: true }).click();
    await expect(action).toBeFocused();
  }
});

test("Comms retains the entry unread divider after read acknowledgement and jumps to unread or latest", async ({
  page,
}) => {
  const fixture = await seedTimeline(page, 80, 30);
  await page.goto("/comms");
  await expect
    .poll(() =>
      page.evaluate(
        ({ storageKey, owner, conversationId }) =>
          JSON.parse(sessionStorage.getItem(storageKey)!).values[
            "comms-memory-v1"
          ].state.users[owner.user_id].last_read_seq[conversationId],
        fixture,
      ),
    )
    .toBe(80);
  await page
    .getByRole("button", { name: "Jump to first unread", exact: true })
    .click();
  await expect(
    page.getByText("New messages", { exact: true }),
  ).toBeInViewport();
  await expect(page.locator(`[id="${timelineId(31)}"]`)).toBeInViewport();
  await expect(page.getByText("New messages", { exact: true })).toHaveCount(1);
  await page
    .getByRole("button", { name: "Jump to latest", exact: true })
    .click();
  await expect(page.locator(`[id="${timelineId(80)}"]`)).toBeInViewport();
});

test("Comms day boundaries and message times use the confirmed display region", async ({
  page,
}) => {
  const fixture = await seedTimeline(page, 12);
  const preferences = profilePreferences(fixture.owner.user_id);
  await page.route(
    `**/api/users/${fixture.owner.user_id}/preferences`,
    (route) =>
      route.fulfill({
        json: {
          ...preferences,
          appearance: {
            ...preferences.appearance,
            timezone: "America/New_York",
            time_format: "24h",
          },
        },
      }),
  );
  await page.goto("/comms");
  const feed = page.getByLabel("Messages", { exact: true });
  await expect(
    page.locator(`[id="${timelineId(10)}"]`).getByRole("button", {
      name: "Message actions: Noah Tan, 19:10",
      exact: true,
    }),
  ).toBeAttached();
  await feed.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(feed.getByText("December 31", { exact: true })).toBeVisible();
});

test("Comms bounded older and newer history retains the visible message anchor", async ({
  page,
}) => {
  await seedTimeline(page, 180);
  await page.goto("/comms");
  const feed = page.getByLabel("Messages", { exact: true });
  await expect(feed.getByRole("article").last()).toHaveAttribute(
    "aria-setsize",
    "50",
  );
  await feed.hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => feed.evaluate((node) => node.scrollTop)).toBe(0);
  const anchor = page.locator(`[id="${timelineId(131)}"]`);
  const scrollFreely = async (
    item: typeof anchor,
    gesture: () => Promise<void>,
    minimum = 20,
  ) => {
    await item.focus();
    const start = await feed.evaluate((node) => node.scrollTop);
    await gesture();
    await expect
      .poll(() => feed.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(start + minimum);
    await expect(item).toBeFocused();
  };
  const top = (await anchor.boundingBox())!.y;
  await page
    .getByRole("button", { name: "Load older messages", exact: true })
    .click();
  await expect(feed).toHaveAttribute("aria-busy", "false");
  await expect(anchor).toHaveAttribute("aria-setsize", "100");
  await expect
    .poll(async () => Math.abs((await anchor.boundingBox())!.y - top))
    .toBeLessThan(2);
  await scrollFreely(
    anchor,
    async () => {
      for (let step = 0; step < 10; step++)
        await page.keyboard.press("ArrowDown");
    },
    160,
  );
  await feed.hover();
  await page.mouse.wheel(0, -100000);
  await page
    .getByRole("button", { name: "Load older messages", exact: true })
    .click();
  await expect(page.locator(`[id="${timelineId(81)}"]`)).toHaveAttribute(
    "aria-posinset",
    "51",
  );
  await feed.hover();
  await page.mouse.wheel(0, 100000);
  const newerAnchor = page.locator(`[id="${timelineId(130)}"]`);
  await expect(newerAnchor).toBeInViewport();
  const newerTop = (await newerAnchor.boundingBox())!.y;
  await page
    .getByRole("button", { name: "Load newer messages", exact: true })
    .click();
  await expect(newerAnchor).toHaveAttribute("aria-posinset", "50");
  await expect
    .poll(async () => Math.abs((await newerAnchor.boundingBox())!.y - newerTop))
    .toBeLessThan(2);
  await feed.hover();
  await scrollFreely(newerAnchor, () => page.mouse.wheel(0, 120));
  await page
    .getByRole("button", { name: "Jump to latest", exact: true })
    .click();
  await expect(page.locator(`[id="${timelineId(180)}"]`)).toBeInViewport();
});

test("Comms only acknowledges visible focused history, never the Inbox or a hidden tab", async ({
  page,
}) => {
  const fixture = await seedTimeline(page, 80, 0);
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => false,
    });
  });
  const read = () =>
    page.evaluate(
      ({ storageKey, owner, conversationId }) =>
        JSON.parse(sessionStorage.getItem(storageKey)!).values[
          "comms-memory-v1"
        ].state.users[owner.user_id].last_read_seq[conversationId],
      fixture,
    );
  await page.goto("/comms?view=inbox");
  await expect(
    page.getByRole("region", { name: "Inbox", exact: true }),
  ).toBeVisible();
  expect(await read()).toBe(0);
  await page.goto(`/comms?conversation=${fixture.conversationId}`);
  await expect(page.locator(`[id="${timelineId(80)}"]`)).toBeInViewport();
  expect(await read()).toBe(0);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    Reflect.deleteProperty(document, "hasFocus");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new FocusEvent("focus"));
  });
  await expect.poll(read).toBe(80);
});

test("Comms renders edits tombstones and reaction people while preserving old quotes and record actions", async ({
  page,
}) => {
  await seedTimeline(page, 80, 80, true);
  await page.goto("/comms");
  const latest = page.locator(`[id="${timelineId(80)}"]`);
  await expect(latest.getByText("edited", { exact: true })).toBeVisible();
  await expect(
    latest.getByRole("button", {
      name: "👍 2: Noah Tan, Sofia Garcia",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Message removed", { exact: true }),
  ).toBeVisible();
  await latest.getByRole("button", { name: /Open record:/ }).click();
  await expect(
    page.getByRole("complementary", { name: "Record", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close record", exact: true }).click();
  await latest.getByRole("button", { name: /Timeline message 1\./ }).click();
  await expect(page.locator(`[id="${timelineId(1)}"]`)).toBeFocused();
  await page
    .locator(`[id="${timelineId(2)}"]`)
    .getByRole("button", { name: /Message actions:/ })
    .click();
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Cancel reply", exact: true }),
  ).toBeVisible();
});

test("Comms keeps an older-reading anchor when the existing client delivers another message", async ({
  page,
}) => {
  await seedTimeline(page, 180, 180, false, true);
  await page.goto("/comms");
  const feed = page.getByLabel("Messages", { exact: true });
  await feed.hover();
  await page.mouse.wheel(0, -100000);
  await page
    .getByRole("button", { name: "Load older messages", exact: true })
    .click();
  await expect(feed.getByRole("article").first()).toHaveAttribute(
    "aria-setsize",
    "100",
  );
  await feed.hover();
  const beforeScroll = await feed.evaluate((node) => node.scrollTop);
  await page.mouse.wheel(0, -800);
  // wheel() queues input; sample the anchor only after that scroll has committed.
  await expect
    .poll(() => feed.evaluate((node) => node.scrollTop))
    .toBeLessThan(beforeScroll);
  const anchor = await feed.evaluate((node) => {
    const frame = node.getBoundingClientRect();
    const wrapper = [
      ...node.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > frame.top && rect.top < frame.bottom;
    })!;
    const article = wrapper.querySelector("article")!;
    return { id: article.id, top: article.getBoundingClientRect().top };
  });
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: "Admin tools", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Scheduled messages", exact: true })
    .click();
  const outbox = page.getByRole("region", {
    name: "Scheduled messages",
    exact: true,
  });
  await outbox
    .getByRole("button", {
      name: /^Edit scheduled message: A newly delivered scheduled message/,
    })
    .click();
  await outbox
    .getByRole("button", { name: "Preview scheduled message", exact: true })
    .click();
  await outbox
    .getByRole("button", { name: "Confirm Send Now", exact: true })
    .click();
  await expect(
    outbox.getByText("Scheduled message sent.", { exact: true }),
  ).toBeVisible();
  await outbox
    .getByRole("button", { name: "Back to conversation", exact: true })
    .click();
  await expect(page.locator(`[id="${anchor.id}"]`)).toBeVisible();
  await expect
    .poll(async () =>
      Math.abs(
        (await page.locator(`[id="${anchor.id}"]`).boundingBox())!.y -
          anchor.top,
      ),
    )
    .toBeLessThan(2);
  await page
    .getByRole("button", { name: "Jump to latest", exact: true })
    .click();
  await expect(
    page.getByText("A newly delivered scheduled message", { exact: true }),
  ).toBeInViewport();
});
