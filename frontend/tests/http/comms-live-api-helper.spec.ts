import { expect, test } from "./helpers/test";
import { installCommsWorld, swapCommsWorld } from "./helpers/comms-world";
import { fixtureId } from "./helpers/access-api";

// Each journey proves one capability of the live Comms fixture against the
// real app pages, reading the world back where the page changed it.

const composer = (page: import("@playwright/test").Page) =>
  page.getByRole("textbox", { name: "Message", exact: true });
const rootArticle = (page: import("@playwright/test").Page) =>
  page.getByRole("article").filter({ hasText: "Two vans are loaded." });

test("following a thread is stored by the world and survives a reload", async ({
  page,
}) => {
  const { ids, snapshot } = await installCommsWorld(page);
  await page.goto(`/comms?conversation=${ids.room}&thread=${ids.thread}`);
  const thread = page.getByRole("region", {
    name: "Thread conversation",
    exact: true,
  });
  await thread
    .getByRole("button", { name: "Follow thread", exact: true })
    .click();
  await expect(
    thread.getByRole("button", { name: "Unfollow thread", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => snapshot().users[ids.owner].followed_thread_ids)
    .toEqual([ids.thread]);
  await page.reload();
  await expect(
    thread.getByRole("button", { name: "Unfollow thread", exact: true }),
  ).toBeVisible();
});

test("a reaction and a pin reach the world through their own routes", async ({
  page,
}) => {
  const { ids, snapshot, server } = await installCommsWorld(page);
  await page.goto("/comms");
  // Pin first: a reopened menu under the pointer expands the reaction submenu.
  await rootArticle(page)
    .getByRole("button", { name: /^Message actions:/ })
    .click();
  await page
    .getByRole("menuitem", { name: "Pin message", exact: true })
    .click();
  await expect
    .poll(() => snapshot().messages[ids.root].pinned_by)
    .toBe(ids.owner);
  await rootArticle(page)
    .getByRole("button", { name: /^Message actions:/ })
    .click();
  await page
    .getByRole("menuitem", { name: "Add reaction", exact: true })
    .hover();
  await page
    .getByRole("menuitem", { name: "React with 👍", exact: true })
    .click();
  await expect
    .poll(() => snapshot().messages[ids.root].reactions)
    .toEqual([{ emoji: "👍", user_ids: [ids.owner] }]);
  await rootArticle(page)
    .getByRole("button", { name: /^👍 1:/ })
    .click();
  await expect.poll(() => snapshot().messages[ids.root].reactions).toEqual([]);
  expect(
    server.requests
      .filter(({ path }) => /\/(reactions|pin)$/.test(path))
      .map(({ method, path }) => `${method} ${path.split("/").at(-1)}`),
  ).toEqual(["PUT pin", "POST reactions", "DELETE reactions"]);
});

test("the record reference route answers the linked record and refuses an unknown one", async ({
  page,
}) => {
  const { ids } = await installCommsWorld(page);
  await page.goto("/comms");
  await expect(rootArticle(page)).toBeVisible();
  const read = (reference: string) =>
    page.evaluate(
      async ({ room, reference, org }) => {
        const response = await fetch(
          `/api/comms/conversations/${room}/record-references/${reference}`,
          { headers: { "X-Org": org } },
        );
        return { status: response.status, body: await response.json() };
      },
      { room: ids.room, reference, org: ids.org },
    );
  const found = await read(ids.recordReference);
  expect(found.status).toBe(200);
  expect(found.body).toMatchObject({
    id: ids.recordReference,
    state: "available",
    title: "Riverside service visit",
  });
  expect((await read(crypto.randomUUID())).status).toBe(404);
});

test("blocking and unblocking a direct partner changes the stored blocks", async ({
  page,
}) => {
  const { ids, runtime, snapshot } = await installCommsWorld(page);
  const direct = await runtime.client.findOrCreateDirect({
    recipient_id: ids.people.noah,
  });
  await page.goto(`/comms?conversation=${direct.data.id}`);
  await page.getByRole("button", { name: "Block user", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: /^Block / })
    .getByRole("button", { name: "Block user", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unblock user", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      (snapshot().blocks[ids.owner] ?? []).map((row) => row.blocked_user_id),
    )
    .toEqual([ids.people.noah]);
  await page.getByRole("button", { name: "Unblock user", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Block user", exact: true }),
  ).toBeVisible();
  await expect.poll(() => snapshot().blocks[ids.owner] ?? []).toEqual([]);
});

test("an uploaded attachment is stored ready and downloads with its name", async ({
  page,
}) => {
  const { snapshot } = await installCommsWorld(page);
  await page.goto("/comms");
  await composer(page).fill("Here is the route note");
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "route-note.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 owned synthetic route note"),
  });
  await expect
    .poll(() => Object.values(snapshot().files).map((file) => file.state))
    .toEqual(["ready"]);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const download = page.getByRole("button", {
    name: "Download route-note.pdf",
    exact: true,
  });
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    download.click(),
  ]);
  expect(file.suggestedFilename()).toBe("route-note.pdf");
});

test("a mid-test role change rechecks capabilities through the grants event", async ({
  page,
}) => {
  const world = await installCommsWorld(page, { role: "member" });
  await page.goto("/comms");
  await rootArticle(page)
    .getByRole("button", { name: /^Message actions:/ })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Add reaction", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  const before = world.server.requests.length;
  await world.setRole("guest");
  expect(world.snapshot().people[world.ids.owner].role).toBe("guest");
  // The page rereads its capabilities only because the event reached it.
  await expect
    .poll(() =>
      world.server.requests
        .slice(before)
        .some(({ path }) => path.endsWith("/capabilities")),
    )
    .toBe(true);
  await rootArticle(page)
    .getByRole("button", { name: /^Message actions:/ })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Add reaction", exact: true }),
  ).toBeDisabled();
});

test("failNext refuses one send and the next send is stored", async ({
  page,
}) => {
  const { server, snapshot, ids } = await installCommsWorld(page);
  server.failNext(
    /^\/conversations\/[^/]+\/messages$/,
    503,
    { detail: "Unavailable" },
    "POST",
  );
  await page.goto("/comms");
  await composer(page).fill("Refused once");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Not sent", { exact: true })).toBeVisible();
  const stored = () =>
    Object.values(snapshot().messages)
      .filter((row) => row.conversation_id === ids.room)
      .map((row) => row.body);
  expect(stored()).not.toContain("Refused once");
  await composer(page).fill("Accepted next");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(stored).toContain("Accepted next");
});

test("stored notices list in Activity and leave when their source is removed", async ({
  page,
}) => {
  const world = await installCommsWorld(page, {
    mutate(state, ids) {
      state.users[ids.owner].notifications.push({
        id: fixtureId(9501),
        org_id: ids.org,
        subject_type: "comms_message",
        subject_id: ids.root,
        kind: "comms-mention",
        conversation_id: ids.room,
        message_id: ids.root,
        status: "unread",
        scheduled_for: null,
        created_at: "2026-09-11T01:00:00.000Z",
        read_at: null,
      });
    },
  });
  await page.goto("/comms");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await expect(
    activity.getByRole("button", {
      name: "Mention in operations",
      exact: true,
    }),
  ).toBeVisible();
  const message = await world.runtime.client.getMessage(
    world.ids.room,
    world.ids.root,
  );
  await world.runtime.client.removeMessage(world.ids.room, world.ids.root, {
    if_match: message.etag,
  });
  await page.reload();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(
    activity.getByText("No activity yet.", { exact: true }),
  ).toBeVisible();
});

test("the server clock moves with the page clock", async ({ page }) => {
  const world = await installCommsWorld(page, {
    clock: "2026-10-21T08:00:00Z",
  });
  await page.goto("/comms");
  const sendAt = async (body: string, expected: string) => {
    await composer(page).fill(body);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(
        () =>
          Object.values(world.snapshot().messages).find(
            (row) => row.body === body,
          )?.created_at,
      )
      .toBe(expected);
  };
  await sendAt("At eight", "2026-10-21T08:00:00.000Z");
  await world.clock!.runFor(60_000);
  await sendAt("A minute later", "2026-10-21T08:01:00.000Z");
  const pageNow = await page.evaluate(() => Date.now());
  expect(Math.abs(pageNow - world.clock!.now())).toBeLessThan(10_000);
});

test("swapping worlds removes the first account's routes", async ({ page }) => {
  const first = await installCommsWorld(page);
  await page.goto("/comms");
  await composer(page).fill("Only in the first world");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("article").filter({ hasText: "Only in the first world" }),
  ).toHaveCount(1);
  const second = await swapCommsWorld(page, first, {
    userId: fixtureId(201),
    role: "member",
  });
  const firstRequests = first.server.requests.length;
  await page.reload();
  await expect(rootArticle(page)).toBeVisible();
  await expect(
    page.getByRole("article").filter({ hasText: "Only in the first world" }),
  ).toHaveCount(0);
  expect(first.server.requests.length).toBe(firstRequests);
  expect(
    Object.values(second.snapshot().messages).map((row) => row.body),
  ).not.toContain("Only in the first world");
});
