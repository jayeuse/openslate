import { expect, test, type Page } from "./helpers/test";

const userId = "00000000-0000-4000-8000-000000000101";
const departmentId = "00000000-0000-4000-8000-0000000000d1";

type Identity = {
  role: "admin" | "member" | "guest";
  access: { department_id: string; module_id: null; level: string }[];
};

async function signIn(page: Page, identity: Identity) {
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/auth/session")
      return route.fulfill({
        json: { authenticated: true, user_id: userId, setup_required: false },
      });
    if (pathname === "/api/auth/me")
      return route.fulfill({ json: { id: userId, ...identity } });
    return route.fulfill({ status: 404, json: {} });
  });
}

function accessLinks(page: Page) {
  return page
    .getByRole("navigation", { name: "Main navigation" })
    .locator('a[href^="/access"]');
}

test("an administrator sees Overview, People, Groups and Security", async ({
  page,
}) => {
  await signIn(page, { role: "admin", access: [] });
  await page.goto("/access?view=people");

  await expect(
    page.getByRole("heading", { level: 1, name: "People" }),
  ).toBeVisible();
  await expect(accessLinks(page)).toHaveText([
    "Overview",
    "People",
    "Groups",
    "Security",
  ]);
});

test("a department manager sees and opens only Groups", async ({ page }) => {
  await signIn(page, {
    role: "member",
    access: [{ department_id: departmentId, module_id: null, level: "manage" }],
  });
  await page.goto("/access?view=overview");

  await expect(page).toHaveURL(/\/access\?view=groups$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Groups" }),
  ).toBeVisible();
  await expect(accessLinks(page)).toHaveText(["Groups"]);
  await expect(
    page.getByRole("link", { name: "Sign-in & security" }),
  ).toHaveCount(0);
});

test("a member without manage access has no Access entry or screen", async ({
  page,
}) => {
  await signIn(page, {
    role: "member",
    access: [{ department_id: departmentId, module_id: null, level: "write" }],
  });
  await page.goto("/access");

  await expect(
    page.getByText("Access is managed by administrators"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Breadcrumb" })
      .locator('[aria-current="page"]'),
  ).toHaveText("Access");
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Access" }),
  ).toHaveCount(0);
});

for (const role of ["member", "guest"] as const) {
  test(`${role} cannot admit privileged reads from a direct Security URL`, async ({
    page,
  }) => {
    await signIn(page, {
      role,
      access:
        role === "member"
          ? [{ department_id: departmentId, module_id: null, level: "manage" }]
          : [],
    });
    const privileged: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path === "/api/workspace/security" ||
        path === "/api/auth/admin-sessions"
      )
        privileged.push(path);
    });
    await page.goto("/access?view=security");
    if (role === "member") await expect(page).toHaveURL(/view=groups$/);
    else
      await expect(
        page.getByText("Access is managed by administrators"),
      ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit policy", exact: true }),
    ).toHaveCount(0);
    expect(privileged).toEqual([]);
  });
}

test("a different identity response cannot admit Security and offers a fresh Retry", async ({
  page,
}) => {
  await signIn(page, { role: "admin", access: [] });
  let matching = false;
  const privileged: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      path === "/api/workspace/security" ||
      path === "/api/auth/admin-sessions"
    )
      privileged.push(path);
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: matching ? userId : "00000000-0000-4000-8000-000000000999",
        role: "admin",
        access: [],
      },
    }),
  );
  await page.goto("/access?view=security");
  await expect(
    page.getByRole("heading", {
      name: "Access data is unavailable",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit policy", exact: true }),
  ).toHaveCount(0);
  expect(privileged).toEqual([]);
  matching = true;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Security", exact: true }),
  ).toBeVisible();
});
