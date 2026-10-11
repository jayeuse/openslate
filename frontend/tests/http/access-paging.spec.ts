import { expect, heldResponse, test } from "./helpers/test";
import {
  at,
  expectNoWrites,
  fixtureId,
  group,
  ids,
  mockAccessApi,
  person,
  type AccessEntry,
} from "./helpers/access-api";

test("Groups pages and server search preserve enriched reach without catalog crawling", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.groups.clear();
  for (let index = 0; index < 31; index++) {
    const access: AccessEntry[] =
      index === 30
        ? [
            {
              department_id: fixtureId(888),
              department_name: "Remote department",
              module_id: null,
              level: "read",
            },
          ]
        : [];
    api.groups.set(
      fixtureId(500 + index),
      group(
        fixtureId(500 + index),
        `Group ${String(index).padStart(2, "0")}`,
        [],
        access,
      ),
    );
  }
  const reads: URL[] = [];
  api.on("GET", "/api/access/groups", (route) => {
    reads.push(new URL(route.request().url()));
    return "next";
  });
  await page.goto("/access?view=groups");
  await expect(
    page.getByText("Showing 1–10 of 31", { exact: true }),
  ).toBeVisible();
  expect(reads.every((url) => url.searchParams.get("offset") === "0")).toBe(
    true,
  );
  await page
    .getByRole("navigation", { name: "Group pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(
    page.getByText("Showing 11–20 of 31", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: "Groups" })).toContainText(
    "Group 10",
  );
  await page
    .getByRole("searchbox", { name: "Search groups" })
    .fill("Remote department");
  await expect(page.getByRole("table", { name: "Groups" })).toContainText(
    "Remote department · Read",
  );
  await expect(
    page.getByText("Showing 1–1 of 1", { exact: true }),
  ).toBeVisible();
  expect(reads.at(-1)?.searchParams.get("search")).toBe("Remote department");
  expect(reads.at(-1)?.searchParams.get("offset")).toBe("0");
  expect(api.sent("GET", "/api/departments")).toHaveLength(0);
  expect(api.sent("GET", "/api/modules")).toHaveLength(0);
});

test("selected sponsor reload and username server search keep labels and write no changes", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const remote = fixtureId(999);
  api.users.set(
    remote,
    person({
      id: remote,
      username: "remote_login",
      display_name: "Remote display",
    }),
  );
  const ana = api.users.get(ids.ana)!;
  api.users.set(ids.ana, { ...ana, sponsor_user_id: remote });
  await page.goto(`/access?view=people&user=${ids.ana}`);
  const sheet = page.getByRole("dialog", { name: "Ana Santos", exact: true });
  const sponsor = sheet.getByRole("combobox", { name: "Sponsor", exact: true });
  await expect(sponsor).toContainText("Remote display");
  await sponsor.click();
  await page
    .getByRole("combobox", { name: "Sponsor", exact: true })
    .and(page.getByPlaceholder("Search…", { exact: true }))
    .fill("remote_login");
  await expect
    .poll(() =>
      api.listReads.some((query) => query.get("search") === "remote_login"),
    )
    .toBe(true);
  await expect(
    page.getByRole("option", { name: "Remote display", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sponsor).toContainText("Remote display");
  expect(
    api.listReads.some((query) => query.getAll("ids").includes(remote)),
  ).toBe(true);
  expect(
    api.listReads.some((query) => query.get("search") === "remote_login"),
  ).toBe(true);
  expectNoWrites(api);
});

test("session pages expose later devices and retain global revocation", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  for (let index = 0; index < 11; index++)
    api.sessions.push({
      id: fixtureId(3000 + index),
      created_at: at(-1000),
      refreshed_at: at(-1000),
      expires_at: at(100000),
      current: false,
      ip_address: null,
      user_agent: `Later device ${index}`,
    });
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
  await sheet.getByRole("tab", { name: "Sessions", exact: true }).click();
  await expect(
    sheet.getByText("13 active sessions", { exact: true }),
  ).toBeVisible();
  await expect(
    sheet
      .getByRole("list", { name: "Sessions", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(10);
  await sheet
    .getByRole("navigation", { name: "Session pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(
    sheet.getByRole("list", { name: "Sessions", exact: true }),
  ).toContainText("Later device 10");
  await sheet
    .getByRole("button", { name: "Sign out everywhere", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(
    sheet.getByText("No active sessions.", { exact: true }),
  ).toBeVisible();
  expect(api.sent("DELETE", `/api/users/${ids.ben}/sessions`)).toHaveLength(1);
});

test("member search preserves off-page members and marks ended manager candidates", async ({
  page,
}) => {
  const api = await mockAccessApi(page, {
    identity: {
      id: ids.ben,
      role: "member",
      access: [
        { department_id: ids.inventory, module_id: null, level: "manage" },
      ],
    },
  });
  const current = fixtureId(999);
  const expired = fixtureId(998);
  api.users.set(
    current,
    person({
      id: current,
      username: "zzz_current",
      display_name: "Selected member",
    }),
  );
  api.users.set(
    expired,
    person({
      id: expired,
      username: "expired_login",
      display_name: "Ended guest",
      role: "guest",
      expires_at: at(-1000),
    }),
  );
  api.groups.set(
    ids.clerks,
    group(
      ids.clerks,
      "Inventory clerks",
      [current],
      [{ department_id: ids.inventory, module_id: null, level: "write" }],
    ),
  );
  const reads: URL[] = [];
  api.on("GET", "/api/access/member-candidates", (route) => {
    reads.push(new URL(route.request().url()));
    return "next";
  });
  await page.goto(`/access?view=groups&group=${ids.clerks}`);
  const sheet = page.getByRole("dialog", {
    name: "Inventory clerks",
    exact: true,
  });
  await expect(
    sheet.getByRole("list", { name: "Members", exact: true }),
  ).toContainText("Selected member");
  await sheet
    .getByRole("searchbox", { name: "Search people to add", exact: true })
    .fill("expired_login");
  await expect(
    sheet.getByRole("button", { name: "Add Ended guest", exact: true }),
  ).toBeDisabled();
  await expect(
    sheet.getByRole("list", { name: "People to add", exact: true }),
  ).toContainText("Access ended");
  expect(
    reads.some((url) => url.searchParams.getAll("ids").includes(current)),
  ).toBe(true);
  expect(
    reads.some((url) => url.searchParams.get("search") === "expired_login"),
  ).toBe(true);
  expect(api.sent("GET", "/api/users")).toHaveLength(0);
  expectNoWrites(api);
});

test("a refused people continuation conceals selected names until an explicit fresh retry", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  for (let index = 0; index < 30; index++)
    api.users.set(
      fixtureId(4000 + index),
      person({
        id: fixtureId(4000 + index),
        username: `additional${index}`,
        display_name: `Additional ${index}`,
      }),
    );
  api.on("GET", "/api/users", (route) =>
    new URL(route.request().url()).searchParams.get("offset") === "25"
      ? route.fulfill({ status: 403, json: { detail: "Forbidden" } })
      : "next",
  );
  await page.goto(`/access?view=groups&group=${ids.clerks}&tab=members`);
  const sheet = page.getByRole("dialog", {
    name: "Inventory clerks",
    exact: true,
  });
  const members = sheet.getByRole("list", { name: "Members", exact: true });
  await expect(members).toContainText("Ana Santos");
  await sheet
    .getByRole("button", { name: "Load more people", exact: true })
    .click();
  await expect(sheet.getByRole("alert")).toBeVisible();
  await expect(members).not.toContainText("Ana Santos");
  await expect(
    sheet.getByRole("button", { name: "Remove Unavailable person" }).first(),
  ).toBeDisabled();
  await sheet
    .getByRole("button", { name: "Retry people", exact: true })
    .click();
  await expect(members).toContainText("Ana Santos");
  expectNoWrites(api);
});

test("a people search refusal survives cached search and an older Retry", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  let denied = true;
  const hold = heldResponse();
  api.on("GET", "/api/users", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("search") !== "blocked") return "next";
    if (denied)
      return route.fulfill({ status: 403, json: { detail: "Forbidden" } });
    hold.enter();
    await hold.released;
    return "next";
  });
  await page.goto(`/access?view=groups&group=${ids.clerks}&tab=members`);
  const sheet = page.getByRole("dialog", {
    name: "Inventory clerks",
    exact: true,
  });
  const members = sheet.getByRole("list", { name: "Members", exact: true });
  const search = sheet.getByRole("searchbox", {
    name: "Search people to add",
    exact: true,
  });
  await expect(members).toContainText("Ana Santos");
  await search.fill("blocked");
  await expect(sheet.getByRole("alert")).toContainText(
    "People are unavailable",
  );
  await expect(members).not.toContainText("Ana Santos");
  denied = false;
  try {
    await sheet
      .getByRole("button", { name: "Retry people", exact: true })
      .click();
    await hold.entered;
    await search.fill("");
    await expect(
      sheet.getByText("Loading people…", { exact: true }),
    ).toBeHidden();
    await expect(members).not.toContainText("Ana Santos");
    hold.release();
    await expect(sheet.getByRole("alert")).toContainText(
      "People are unavailable",
    );
    await expect(members).not.toContainText("Ana Santos");
    await sheet
      .getByRole("button", { name: "Retry people", exact: true })
      .click();
    await expect(members).toContainText("Ana Santos");
    expectNoWrites(api);
  } finally {
    hold.release();
  }
});

test("a selected-person refusal survives reopening a cached group", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.goto(`/access?view=groups&group=${ids.clerks}&tab=members`);
  let sheet = page.getByRole("dialog", {
    name: "Inventory clerks",
    exact: true,
  });
  await expect(
    sheet.getByRole("list", { name: "Members", exact: true }),
  ).toContainText("Ana Santos");
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  let denied = true;
  api.on("GET", "/api/users", (route) => {
    const selected = new URL(route.request().url()).searchParams.getAll("ids");
    return denied && selected.length === 1 && selected[0] === ids.ben
      ? route.fulfill({ status: 403, json: { detail: "Forbidden" } })
      : "next";
  });
  await page
    .getByRole("table", { name: "Groups", exact: true })
    .getByRole("button", { name: "Finance readers", exact: true })
    .click();
  sheet = page.getByRole("dialog", { name: "Finance readers", exact: true });
  await sheet.getByRole("tab", { name: "Members", exact: true }).click();
  await expect(sheet.getByRole("alert")).toContainText(
    "People are unavailable",
  );
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("table", { name: "Groups", exact: true })
    .getByRole("button", { name: "Inventory clerks", exact: true })
    .click();
  sheet = page.getByRole("dialog", { name: "Inventory clerks", exact: true });
  await sheet.getByRole("tab", { name: "Members", exact: true }).click();
  await expect(sheet.getByRole("alert")).toContainText(
    "People are unavailable",
  );
  await expect(
    sheet.getByRole("list", { name: "Members", exact: true }),
  ).not.toContainText("Ana Santos");
  denied = false;
  await sheet
    .getByRole("button", { name: "Retry people", exact: true })
    .click();
  await expect(
    sheet.getByRole("list", { name: "Members", exact: true }),
  ).toContainText("Ana Santos");
  expectNoWrites(api);
});
