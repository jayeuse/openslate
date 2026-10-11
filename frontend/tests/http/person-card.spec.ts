import {
  expect,
  heldResponse,
  test,
  type Page,
  type Locator,
} from "./helpers/test";
import {
  cardTarget,
  cardViewer,
  secondViewer,
  cardEvent,
  cardRecord,
  installPersonCardApi,
  memberCard,
  publicCard,
  cardPage,
  type CardSurface,
} from "./helpers/person-card-api";
import { observeProfilePhotoRevocations } from "./helpers/profile-api";
import { boardId } from "./helpers/boards-api";

const card = (page: Page) =>
  page.getByRole("dialog", { name: "Person card", exact: true });
const trigger = (scope: Page | Locator, name = "Ana Santos") =>
  scope.getByRole("button", { name: `Person card: ${name}`, exact: true });
async function visit(
  page: Page,
  api: Awaited<ReturnType<typeof installPersonCardApi>>,
  surface: CardSurface = "platform",
) {
  await page.goto(api.href);
  if (surface === "platform")
    await page.getByRole("searchbox", { name: "Search workspace" }).fill("Ana");
  await expect(trigger(page).first()).toBeVisible();
}
async function expectMemberCard(page: Page) {
  await expect(card(page)).toBeVisible();
  await expect(
    card(page).getByText("Ana Santos", { exact: true }),
  ).toBeVisible();
  await expect(card(page)).toContainText("Equipment coordinator");
  await expect(card(page)).toContainText("ana@example.test");
  await expect(card(page)).toContainText("+1 555 0123");
  await expect(card(page)).toContainText(
    "Coordinates equipment and maintenance.",
  );
  await expect(card(page).getByText(/Department/)).toHaveCount(0);
}

test("Person card intent loads one target, keyboard opens and Escape restores focus without writes", async ({
  page,
}) => {
  const api = await installPersonCardApi(page);
  await visit(page, api);
  expect(api.reads).toHaveLength(0);
  const hold = heldResponse();
  api.hold = hold;
  try {
    await trigger(page).focus();
    await hold.entered;
    await page.keyboard.press("Enter");
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('[aria-busy="true"]')).toBeVisible();
    await expect(card(page).getByText("ana@example.test")).toHaveCount(0);
    hold.release();
    await expectMemberCard(page);
    expect(api.reads).toEqual([{ viewer: cardViewer, target: cardTarget }]);
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await page.keyboard.press("Space");
    await expectMemberCard(page);
    expect(api.reads).toHaveLength(1);
    expect(api.writes).toEqual([]);
  } finally {
    hold.release();
  }
});

test("Person card guest DTO omits private keys and nullable member values remain truthful", async ({
  page,
}) => {
  const api = await installPersonCardApi(page, "platform", "guest");
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, api);
  await trigger(page).click();
  await expect(card(page)).toContainText("Equipment coordinator");
  await expect(card(page).getByText(/Email|Phone|Short bio/)).toHaveCount(0);
  expect(Object.keys(api.cards.get(cardTarget) as object).sort()).toEqual([
    "avatar_url",
    "display_name",
    "job_title",
  ]);
  await page.keyboard.press("Escape");
  api.role = "member";
  api.viewer = secondViewer;
  api.cards.set(cardTarget, {
    ...memberCard,
    job_title: null,
    email: null,
    phone: null,
    bio: null,
  });
  await page.evaluate(() =>
    window.dispatchEvent(new Event("openslate:session-recheck")),
  );
  await expect(
    page.getByRole("searchbox", { name: "Search workspace" }),
  ).toHaveValue("");
  await page.getByRole("searchbox", { name: "Search workspace" }).fill("Ana");
  await expect(trigger(page)).toBeVisible();
  await trigger(page).click();
  await expect(
    card(page).getByText("Not provided", { exact: true }),
  ).toHaveCount(4);
  await expect(card(page).getByText("ana@example.test")).toHaveCount(0);
  const bounds = await card(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  expect(api.writes).toEqual([]);
});

// The other malformed cards are rows of isolated/shell/profile-api.spec.ts.
test("Person card rejects guest-private-key without leaking response metadata or fetching unsafe photos", async ({
  page,
}) => {
  const api = await installPersonCardApi(page, "platform", "guest");
  api.cards.set(cardTarget, {
    ...publicCard,
    display_name: "Private leaked name",
    email: "private@example.test",
  });
  await visit(page, api);
  await trigger(page).click();
  await expect(card(page).getByRole("alert")).toContainText(
    "Person unavailable",
  );
  await expect(
    card(page).getByText(
      /Private leaked name|private@example.test|ana@example.test/,
    ),
  ).toHaveCount(0);
  expect(api.avatarReads).toEqual([]);
  expect(api.writes).toEqual([]);
});

for (const status of [401, 403, 500]) {
  test(`Person card ${status} shows safe unavailability and retries only on request`, async ({
    page,
  }) => {
    const api = await installPersonCardApi(page);
    api.status = status;
    await visit(page, api);
    await trigger(page).click();
    await expect(card(page).getByRole("alert")).toContainText(
      "Person unavailable",
    );
    await expect(card(page)).not.toContainText("Private source exception");
    expect(api.reads).toHaveLength(1);
    api.status = 200;
    await card(page)
      .getByRole("button", { name: "Retry person card", exact: true })
      .click();
    await expectMemberCard(page);
    expect(api.writes).toEqual([]);
  });
}

test("Person card result with no Open destination is still read-only and cannot create an Access link", async ({
  page,
}) => {
  const api = await installPersonCardApi(page);
  await page.route("**/api/search?*", (route) =>
    route.fulfill({
      json: cardPage(
        new URL(route.request().url()).searchParams.get("kind") === "person"
          ? [
              {
                kind: "person",
                id: cardTarget,
                title: "Ana Santos",
                context_label: "Equipment team",
                module_id: null,
                board_id: null,
                can_open: false,
              },
            ]
          : [],
        10,
      ),
    }),
  );
  await visit(page, api);
  await trigger(page).click();
  await expectMemberCard(page);
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("region", { name: "People search results" })
      .getByRole("link"),
  ).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

test("Person card cached metadata disappears after current 404 and only explicit Retry restores it", async ({
  page,
}) => {
  const api = await installPersonCardApi(page);
  await visit(page, api);
  await trigger(page).click();
  await expectMemberCard(page);
  api.status = 404;
  await card(page)
    .getByRole("button", { name: "Reload person card", exact: true })
    .click();
  await expect(card(page).getByRole("alert")).toContainText(
    "Person unavailable",
  );
  await expect(
    card(page).getByText(/ana@example.test|Equipment coordinator/),
  ).toHaveCount(0);
  await expect(
    page.getByText("Private source exception must not be shown"),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await trigger(page).click();
  await expect(card(page).getByRole("alert")).toBeVisible();
  expect(api.reads).toHaveLength(2);
  api.status = 200;
  await card(page)
    .getByRole("button", { name: "Retry person card", exact: true })
    .click();
  await expectMemberCard(page);
  expect(api.reads).toHaveLength(3);
});

test("Person card ignores a late removed target and a late previous-account reply", async ({
  page,
}) => {
  const api = await installPersonCardApi(page);
  await visit(page, api);
  const hold = heldResponse();
  api.hold = hold;
  try {
    await trigger(page).click();
    await hold.entered;
    await page.keyboard.press("Escape");
    await page.getByRole("searchbox", { name: "Search workspace" }).fill("Ben");
    await expect(trigger(page, "Ben Cruz")).toBeVisible();
    hold.release();
    await trigger(page, "Ben Cruz").click();
    await expect(card(page)).toContainText("ben@example.test");
    await expect(card(page).getByText("ana@example.test")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("searchbox", { name: "Search workspace" }).fill("Ana");
    await expect(trigger(page)).toBeVisible();
    const accountHold = heldResponse();
    await trigger(page).click();
    await expectMemberCard(page);
    api.hold = accountHold;
    await card(page)
      .getByRole("button", { name: "Reload person card", exact: true })
      .click();
    await accountHold.entered;
    api.viewer = secondViewer;
    api.cards.set(cardTarget, {
      ...memberCard,
      email: "second-viewer@example.test",
    });
    await page.evaluate(() =>
      window.dispatchEvent(new Event("openslate:session-recheck")),
    );
    await expect(card(page)).toHaveCount(0);
    await expect(
      page.getByRole("searchbox", { name: "Search workspace" }),
    ).toHaveValue("");
    await page.getByRole("searchbox", { name: "Search workspace" }).fill("Ana");
    await expect(trigger(page)).toBeVisible();
    accountHold.release();
    await trigger(page).click();
    await expect(card(page)).toContainText("second-viewer@example.test");
    await expect(card(page).getByText("ana@example.test")).toHaveCount(0);
  } finally {
    hold.release();
    api.hold?.release();
  }
});

test("Person card private avatar is target-bound, revoked on close and unavailable after current-card refusal", async ({
  page,
}) => {
  const revoked = await observeProfilePhotoRevocations(page);
  const api = await installPersonCardApi(page);
  api.cards.set(cardTarget, {
    ...memberCard,
    avatar_url: `/api/users/${cardTarget}/avatar`,
  });
  await visit(page, api);
  await trigger(page).click();
  const photo = card(page).getByRole("img", {
    name: "Ana Santos photo",
    exact: true,
  });
  await expect(photo).toHaveAttribute("src", /^blob:/);
  const url = await photo.getAttribute("src");
  expect(api.avatarReads.length).toBeGreaterThan(0);
  expect(
    api.avatarReads.every((path) => path === `/api/users/${cardTarget}/avatar`),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(() => revoked.includes(url!)).toBe(true);
  const hold = heldResponse();
  api.holdAvatar = hold;
  try {
    await trigger(page).click();
    await hold.entered;
    api.status = 404;
    hold.release();
    await expect(card(page).getByRole("alert")).toContainText(
      "Person unavailable",
    );
    await expect(card(page).getByRole("img")).toHaveCount(0);
    await expect(card(page).getByText("ana@example.test")).toHaveCount(0);
  } finally {
    hold.release();
  }
});

test("Person card accepts current text and drops bytes when the avatar disappears during its read", async ({
  page,
}) => {
  const api = await installPersonCardApi(page);
  api.cards.set(cardTarget, {
    ...memberCard,
    avatar_url: `/api/users/${cardTarget}/avatar`,
  });
  const hold = heldResponse();
  api.holdAvatar = hold;
  try {
    await visit(page, api);
    await trigger(page).click();
    await hold.entered;
    api.cards.set(cardTarget, {
      ...memberCard,
      email: "current@example.test",
      avatar_url: null,
    });
    hold.release();
    await expect(card(page)).toContainText("current@example.test");
    await expect(card(page).getByRole("img")).toHaveCount(0);
    await expect(card(page).getByText("ana@example.test")).toHaveCount(0);
    await expect(card(page).getByRole("alert")).toHaveCount(0);
  } finally {
    hold.release();
  }
});

// The other byte faults are rows of isolated/shell/profile-api.spec.ts.
test("Person card rejects mime avatar bytes and keeps accepted text with explicit photo retry", async ({
  page,
}) => {
  const api = await installPersonCardApi(page);
  api.cards.set(cardTarget, {
    ...memberCard,
    avatar_url: `/api/users/${cardTarget}/avatar`,
  });
  api.avatarFault = "mime";
  await visit(page, api);
  await trigger(page).click();
  await expectMemberCard(page);
  await expect(card(page).getByRole("alert")).toContainText(
    "Photo unavailable",
  );
  await expect(card(page).getByRole("img")).toHaveCount(0);
  api.avatarFault = null;
  await card(page)
    .getByRole("button", { name: "Retry photo", exact: true })
    .click();
  await expect(card(page).getByRole("img")).toHaveAttribute("src", /^blob:/);
  expect(api.writes).toEqual([]);
});

test("Person card calendar resolves visible author ids once and never requests an administrator catalog", async ({
  page,
}) => {
  const api = await installPersonCardApi(page, "calendar", "member");
  const catalogs: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/users") catalogs.push(url.href);
  });
  const hold = heldResponse();
  api.hold = hold;
  try {
    await page.goto(api.href);
    await hold.entered;
    await expect(
      page.getByText("Loading person…", { exact: true }),
    ).toHaveCount(2);
    await expect(page.getByText(cardTarget, { exact: true })).toHaveCount(0);
    hold.release();
    await expect(trigger(page)).toHaveCount(2);
    expect(api.reads).toEqual([{ viewer: cardViewer, target: cardTarget }]);
    await trigger(page).first().click();
    await expectMemberCard(page);
    await page.keyboard.press("Escape");
    await trigger(page).last().click();
    await expectMemberCard(page);
    expect(api.reads).toHaveLength(1);
    expect(catalogs).toEqual([]);
    expect(api.writes).toEqual([]);
  } finally {
    hold.release();
  }
});

test("Person card selected assignee remains inspectable without changing the record form", async ({
  page,
}) => {
  const api = await installPersonCardApi(page, "openview", "admin");
  await visit(page, api, "openview");
  await page
    .getByRole("button", { name: "Pump inspection", exact: true })
    .click();
  const inspector = page.getByRole("region", {
    name: "Record details content",
  });
  await inspector
    .getByRole("button", { name: "Edit record", exact: true })
    .click();
  const assignee = inspector.getByRole("combobox", {
    name: "Assignee",
    exact: true,
  });
  await expect(assignee).toHaveValue(cardTarget);
  const form = inspector.locator("form");
  await trigger(form).click();
  await expectMemberCard(page);
  await page.keyboard.press("Escape");
  await expect(assignee).toHaveValue(cardTarget);
  expect(api.writes).toEqual([]);
});

for (const layout of ["Table", "Grid"] as const) {
  test(`Person card OpenView ${layout} USER title retains a separate record action`, async ({
    page,
  }) => {
    const api = await installPersonCardApi(page, "openview", "admin", true);
    await page.goto(api.href);
    await page.getByRole("tab", { name: layout, exact: true }).click();
    await expect(trigger(page).first()).toBeVisible();
    await trigger(page).first().click();
    await expectMemberCard(page);
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Open record: Ana Santos", exact: true })
      .click();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("record") === cardRecord,
    );
    expect(api.writes).toEqual([]);
  });
}

for (const surface of [
  "access",
  "posts",
  "openview",
  "calendar",
  "platform",
] as const) {
  test(`Person card ${surface} name opens the shared card and preserves its deliberate domain action`, async ({
    page,
  }) => {
    const api = await installPersonCardApi(page, surface, "admin");
    await visit(page, api, surface);
    await trigger(page).first().click();
    await expectMemberCard(page);
    expect(api.writes).toEqual([]);
    await page.keyboard.press("Escape");
    if (surface === "access") {
      const row = page.getByRole("row").filter({ hasText: "Ana Santos" });
      await row.getByRole("button", { name: /Manage Ana Santos/ }).click();
      await expect(
        page.getByRole("dialog", { name: "Ana Santos", exact: true }),
      ).toBeVisible();
    } else if (surface === "platform") {
      await expect(
        page.getByRole("link", { name: "Open Ana Santos", exact: true }),
      ).toHaveAttribute("href", `/access?view=people&user=${cardTarget}`);
    } else if (surface === "openview") {
      await page
        .getByRole("button", { name: "Pump inspection", exact: true })
        .click();
      await expect(page).toHaveURL(
        (url) => url.searchParams.get("record") === cardRecord,
      );
      await expect(
        page.getByRole("region", { name: "Record details content" }),
      ).toContainText("Pump inspection");
    } else if (surface === "posts") {
      await page
        .getByRole("button", {
          name: "Open post",
          exact: true,
        })
        .click();
      const reader = page.getByRole("dialog", {
        name: "Maintenance update",
        exact: true,
      });
      await trigger(reader).click();
      await expectMemberCard(page);
      await page.keyboard.press("Escape");
      await expect(reader).toBeVisible();
      await reader.getByRole("button", { name: "Edited", exact: true }).click();
      const history = page.getByRole("dialog", {
        name: "Edit history",
        exact: true,
      });
      await trigger(history).first().click();
      await expectMemberCard(page);
    } else {
      await page.goto(
        `/boards?board=${boardId}&section=calendar&event=${cardEvent}`,
      );
      const reader = page.getByRole("dialog", {
        name: "Equipment handover",
        exact: true,
      });
      await trigger(reader).click();
      await expectMemberCard(page);
    }
    expect(api.writes).toEqual([]);
  });
}
