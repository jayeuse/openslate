import { installAttentionApi } from "./helpers/comms-attention";
import { smallTargets } from "./helpers/layout";
import { installOpenViewEventSource } from "./helpers/openview-event-source";
import {
  installProfileApi,
  profileSelf,
  profileUserA,
  profileUserB,
} from "./helpers/profile-api";
import { defaultOrganization, expect, test, type Page } from "./helpers/test";

// The read-only Profile view (docs/specs/profile-sidebar-relayout.md,
// PD16–PD20). Which rows show is owned by isolated/shell/profile-api.spec.ts;
// the server rule (who sees which fields) by the backend profile tests.

test.use({ trace: "off", screenshot: "off", video: "off" });

const groups = [
  { id: "00000000-0000-4000-8000-000000000a01", name: "Field Ops" },
  { id: "00000000-0000-4000-8000-000000000a02", name: "Quality Review" },
];
const rosa = {
  display_name: "Rosa Reyes",
  job_title: "Dispatch coordinator",
  avatar_url: null,
};

/** Serve one person's profile read; other people fall through to the shared mock. */
async function serveProfile(
  page: Page,
  personId: string,
  ...responses: { status?: number; json: unknown }[]
) {
  const reads: string[] = [];
  await page.route(/\/api\/users\/[^/]+\/profile$/, (route) => {
    const target = new URL(route.request().url()).pathname.split("/")[3]!;
    if (target !== personId) return route.fallback();
    reads.push(target);
    const response = responses[Math.min(reads.length, responses.length) - 1]!;
    return route.fulfill({
      status: response.status ?? 200,
      headers: { "Cache-Control": "private, no-store" },
      json: response.json,
    });
  });
  return reads;
}

const main = (page: Page) => page.locator("#main-content");
const breadcrumb = (page: Page) =>
  page.getByRole("navigation", { name: "Breadcrumb", exact: true });
const accountRow = (page: Page) =>
  page
    .getByRole("complementary", { name: "Primary sidebar", exact: true })
    .getByRole("link", { name: "Your profile, Maya Chen", exact: true });

test("your own profile shows your facts and Account settings, and the account row is current", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installProfileApi(page);
  await serveProfile(page, profileUserA, {
    json: {
      display_name: "Maya Chen",
      job_title: "Equipment coordinator",
      avatar_url: null,
      phone: "+1 555 0101",
      bio: "Coordinates shared equipment.",
      role: "member",
      groups,
    },
  });
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { level: 1, name: "Maya Chen", exact: true }),
  ).toBeVisible();
  await expect(main(page)).toContainText("Equipment coordinator");
  const about = page.getByRole("region", { name: "About", exact: true });
  await expect(about.getByRole("term")).toHaveText(["Phone", "Role", "Groups"]);
  await expect(about.getByRole("definition").nth(0)).toHaveText("+1 555 0101");
  await expect(about.getByRole("definition").nth(1)).toHaveText("Member");
  await expect(about.getByRole("listitem")).toHaveText([
    "Field Ops",
    "Quality Review",
  ]);
  await expect(
    page.getByRole("region", { name: "Bio", exact: true }),
  ).toHaveText(/Coordinates shared equipment\./);
  await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText(
    "Your profile",
  );
  await expect(accountRow(page)).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Your profile",
    "Account settings",
    "Sign out",
  ]);
  await page.keyboard.press("Escape");

  await main(page)
    .getByRole("link", { name: "Account settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("heading", { name: "Account settings", exact: true }),
  ).toBeVisible();
  await expect(accountRow(page)).not.toHaveAttribute("aria-current", "page");
});

test("another member's profile names them in the breadcrumb, hides empty fields, and has no settings button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installProfileApi(page);
  await serveProfile(page, profileUserB, {
    json: { ...rosa, phone: null, bio: "  ", role: "admin", groups: [] },
  });
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Rosa Reyes", exact: true }),
  ).toBeVisible();
  const about = page.getByRole("region", { name: "About", exact: true });
  await expect(about.getByRole("term")).toHaveText(["Role"]);
  await expect(about.getByRole("definition")).toHaveText(["Administrator"]);
  await expect(page.getByRole("region", { name: "Bio" })).toHaveCount(0);
  await expect(
    main(page).getByRole("link", { name: "Account settings" }),
  ).toHaveCount(0);
  const crumb = breadcrumb(page).locator('[aria-current="page"]');
  await expect(crumb).toHaveText("Rosa Reyes");
  await expect(breadcrumb(page).getByRole("link")).toHaveText(["Workspace"]);
  await expect(accountRow(page)).not.toHaveAttribute("aria-current", "page");
});

test("your own id in the person query is still your own profile", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.goto(`/profile?person=${profileUserA}`);
  await expect(
    main(page).getByRole("link", { name: "Account settings", exact: true }),
  ).toBeVisible();
  await expect(accountRow(page)).toHaveAttribute("aria-current", "page");
});

test("a guest sees only the photo, name and job title", async ({ page }) => {
  await installProfileApi(page, { role: "guest" });
  await serveProfile(page, profileUserB, { json: rosa });
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Rosa Reyes", exact: true }),
  ).toBeVisible();
  await expect(main(page)).toContainText("Dispatch coordinator");
  for (const panel of ["About", "Bio"])
    await expect(page.getByRole("region", { name: panel })).toHaveCount(0);
  await expect(main(page).getByRole("term")).toHaveCount(0);
});

test("a profile that is not available says so once, names no one and offers your own", async ({
  page,
}) => {
  await installProfileApi(page);
  const reads = await serveProfile(page, profileUserB, {
    status: 404,
    json: { detail: { code: "person_not_found", message: "Person not found" } },
  });
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(main(page)).toContainText("This profile is not available.");
  await expect(main(page).getByRole("button", { name: "Retry" })).toHaveCount(
    0,
  );
  await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText(
    "Profile",
  );
  await expect(breadcrumb(page)).not.toContainText(profileUserB);
  expect(reads).toEqual([profileUserB]);
  await main(page)
    .getByRole("link", { name: "Go to your profile", exact: true })
    .click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Maya Chen", exact: true }),
  ).toBeVisible();
});

test("a failed profile read keeps Retry, which loads the profile", async ({
  page,
}) => {
  await installProfileApi(page);
  const reads = await serveProfile(
    page,
    profileUserB,
    { status: 500, json: { detail: "Private server detail" } },
    { json: { ...rosa, phone: null, bio: null, role: "member", groups } },
  );
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(main(page)).toContainText("This profile could not load.");
  await expect(main(page)).not.toContainText("Private server detail");
  await main(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Rosa Reyes", exact: true }),
  ).toBeVisible();
  expect(reads).toEqual([profileUserB, profileUserB]);
});

test("from 1280px the profile is a still page; only the facts column scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installProfileApi(page);
  await serveProfile(page, profileUserB, {
    json: {
      ...rosa,
      phone: "+63 917 555 0118",
      bio: Array.from(
        { length: 30 },
        (_, line) => `Line ${line + 1} of a long bio.`,
      ).join("\n"),
      role: "member",
      groups,
    },
  });
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(
    page.getByRole("region", { name: "Bio", exact: true }),
  ).toContainText("Line 30 of a long bio.");
  expect(
    await page.evaluate(() => [
      document.documentElement.scrollHeight,
      document.documentElement.scrollWidth,
    ]),
  ).toEqual([720, 1280]);
  // The identity column and the facts column sit side by side.
  const name = await page
    .getByRole("heading", { level: 1, name: "Rosa Reyes" })
    .boundingBox();
  const about = await page
    .getByRole("region", { name: "About", exact: true })
    .boundingBox();
  expect(about!.x).toBeGreaterThan(name!.x + name!.width);
});

test("on a phone the profile is one column that scrolls, with 44px targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installProfileApi(page);
  await serveProfile(page, profileUserA, {
    json: {
      display_name: "Maya Chen",
      job_title: "Equipment coordinator",
      avatar_url: null,
      phone: "+1 555 0101",
      bio: "Coordinates shared equipment.",
      role: "member",
      groups,
    },
  });
  await page.goto("/profile");
  const settings = main(page).getByRole("link", {
    name: "Account settings",
    exact: true,
  });
  await expect(settings).toBeVisible();
  expect((await settings.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const button = await settings.boundingBox();
  const about = await page
    .getByRole("region", { name: "About", exact: true })
    .boundingBox();
  expect(about!.y).toBeGreaterThan(button!.y + button!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});

test("without an organization your own profile comes from the account, with no role or groups", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installProfileApi(page, { role: null });
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { level: 1, name: "Maya Chen", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toHaveCount(0);
  const about = page.getByRole("region", { name: "About", exact: true });
  await expect(about.getByRole("term")).toHaveText(["Phone"]);
  await expect(
    page.getByRole("link", { name: "Account settings", exact: true }),
  ).toHaveAttribute("href", "/settings");
  expect(
    await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.scrollHeight,
    ]),
  ).toEqual([1440, 900]);
  // Without an organization there are no other members to show.
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(page.locator("main")).toContainText(
    "This profile is not available.",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
  expect(api.forbiddenReads).toEqual([]);
});

test("a name saved in Account settings shows on your profile at once", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { level: 1, name: "Maya Chen", exact: true }),
  ).toBeVisible();
  await main(page)
    .getByRole("link", { name: "Account settings", exact: true })
    .click();
  await page.getByLabel("Display name", { exact: true }).fill("Maya Reyes");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /profile saved/i }),
  ).toBeVisible();
  // A client-side return keeps the account's cache, inside its 30 s freshness.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Your profile", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Maya Reyes", exact: true }),
  ).toBeVisible();
});

test("the account row and header show a name saved in Account settings without a reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installProfileApi(page);
  await page.goto("/settings");
  await expect(accountRow(page)).toBeVisible();
  const header = page.getByRole("button", { name: "Account", exact: true });
  await expect(header).toContainText("MC");
  await page.getByLabel("Display name", { exact: true }).fill("Maya Reyes");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /profile saved/i }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "Primary sidebar", exact: true })
      .getByRole("link", { name: "Your profile, Maya Reyes", exact: true }),
  ).toBeVisible();
  await expect(header).toContainText("MR");
});

test("the tab names your profile, the person shown, or Profile", async ({
  page,
}) => {
  await installProfileApi(page);
  await serveProfile(page, profileUserB, {
    json: { ...rosa, phone: null, bio: null, role: "member", groups: [] },
  });
  await page.goto("/profile");
  await expect(page).toHaveTitle("Your profile | OpenSlate");
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(page).toHaveTitle("Rosa Reyes | OpenSlate");
  await page.goto("/profile?person=not-a-person");
  await expect(page).toHaveTitle("Profile | OpenSlate");
});

test("the tab keeps the OpenComms unread count before the person's name", async ({
  page,
}) => {
  await installOpenViewEventSource(page, { autoResync: true });
  await installAttentionApi(page, {
    orgId: defaultOrganization.org_id,
    unread: 3,
  });
  await serveProfile(page, profileUserB, { json: rosa });
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Rosa Reyes", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("(3) Rosa Reyes | OpenSlate");
});

test("an organization switch shows no profile from the previous organization", async ({
  page,
}) => {
  const first = {
    org_id: "00000000-0000-4000-8000-000000000901",
    name: "Example A",
    slug: "example-a",
    role: "admin" as const,
  };
  const second = {
    ...first,
    org_id: "00000000-0000-4000-8000-000000000902",
    name: "Example B",
    slug: "example-b",
  };
  let sessionDefault = first.org_id;
  await installProfileApi(page, { role: "admin", session: false });
  const body = (orgId: string) => ({
    ...profileSelf(profileUserA, "admin"),
    memberships: [first, second],
    current_organization: {
      ...(orgId === first.org_id ? first : second),
      owner: true,
      access: [],
    },
  });
  const orgOf = (headers: Record<string, string>) =>
    headers["x-org"] ?? sessionDefault;
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: profileUserA,
        setup_required: false,
        default_organization_blocked: null,
        organization_id: orgOf(route.request().headers()),
      },
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: body(orgOf(route.request().headers())) }),
  );
  await page.route("**/api/auth/session/organization", (route) => {
    sessionDefault = (route.request().postDataJSON() as { org_id: string })
      .org_id;
    return route.fulfill({ json: body(sessionDefault) });
  });
  const reads: string[] = [];
  await page.route(/\/api\/users\/[^/]+\/profile$/, (route) => {
    const orgId = orgOf(route.request().headers());
    reads.push(orgId);
    return orgId === first.org_id
      ? route.fulfill({
          json: { ...rosa, phone: null, bio: null, role: "member", groups },
        })
      : route.fulfill({
          status: 404,
          json: {
            detail: { code: "person_not_found", message: "Person not found" },
          },
        });
  });
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Rosa Reyes", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Organization:/ })
    .first()
    .click();
  await page.getByRole("menuitem", { name: /Example B/ }).click();
  await expect.poll(() => sessionDefault).toBe(second.org_id);
  await expect(page).toHaveURL(/\/openview/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`person=${profileUserB}$`));
  await expect(main(page)).toContainText("This profile is not available.");
  await expect(main(page)).not.toContainText("Rosa Reyes");
  expect(reads).toEqual([first.org_id, second.org_id]);
});

test("your own bare profile says where to add a job title, phone and bio; another's never does", async ({
  page,
}) => {
  await installProfileApi(page);
  await serveProfile(page, profileUserA, {
    json: {
      display_name: "Maya Chen",
      job_title: null,
      avatar_url: null,
      phone: " ",
      bio: null,
      role: "admin",
      groups: [],
    },
  });
  await serveProfile(page, profileUserB, {
    json: {
      ...rosa,
      job_title: null,
      phone: null,
      bio: null,
      role: "member",
      groups: [],
    },
  });
  await page.goto("/profile");
  await expect(main(page)).toContainText(
    "Add your job title, phone, and bio in Account settings.",
  );
  const hint = main(page).getByRole("link", {
    name: "Account settings",
    exact: true,
  });
  await expect(hint.last()).toHaveAttribute("href", "/settings#identity");
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Rosa Reyes", exact: true }),
  ).toBeVisible();
  await expect(main(page)).not.toContainText("Add your job title");
});

test("the profile does not scroll the document at 1440×900 and 1920×1080 either", async ({
  page,
}) => {
  await installProfileApi(page);
  await serveProfile(page, profileUserB, {
    json: {
      ...rosa,
      phone: "+63 917 555 0118",
      bio: Array.from(
        { length: 40 },
        (_, line) => `Line ${line + 1} of a long bio.`,
      ).join("\n"),
      role: "member",
      groups,
    },
  });
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(`/profile?person=${profileUserB}`);
    await expect(
      page.getByRole("region", { name: "Bio", exact: true }),
    ).toContainText("Line 40 of a long bio.");
    expect(
      await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.scrollHeight,
      ]),
      `${width}×${height}`,
    ).toEqual([width, height]);
  }
});

test("on a phone every target on your own, another member's and a guest's view of a profile is at least 44px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installProfileApi(page);
  await serveProfile(page, profileUserB, {
    json: {
      ...rosa,
      phone: "+63 917 555 0118",
      bio: "Dispatch.",
      role: "member",
      groups,
    },
  });
  // Your own bare profile, so the fill hint and its link show too.
  await serveProfile(page, profileUserA, {
    json: {
      display_name: "Maya Chen",
      job_title: null,
      avatar_url: null,
      phone: null,
      bio: null,
      role: "member",
      groups: [],
    },
  });
  await page.goto("/profile");
  await expect(
    main(page).getByRole("link", { name: "Account settings" }),
  ).toHaveCount(2);
  expect(await smallTargets(main(page))).toEqual([]);
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(
    page.getByRole("region", { name: "About", exact: true }),
  ).toBeVisible();
  expect(await smallTargets(main(page))).toEqual([]);
});

test("a guest's phone view of a profile has no target under 44px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installProfileApi(page, { role: "guest" });
  await serveProfile(page, profileUserB, { json: rosa });
  await page.goto(`/profile?person=${profileUserB}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Rosa Reyes" }),
  ).toBeVisible();
  expect(await smallTargets(main(page))).toEqual([]);
});

test("without an organization your own profile is still at 1280×720 and one column at 390", async ({
  page,
}) => {
  await installProfileApi(page, { role: null });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/profile");
  const name = page.getByRole("heading", { level: 1, name: "Maya Chen" });
  await expect(name).toBeVisible();
  expect(
    await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.scrollHeight,
    ]),
  ).toEqual([1280, 720]);
  await page.setViewportSize({ width: 390, height: 844 });
  const about = page.getByRole("region", { name: "About", exact: true });
  await expect(about).toBeVisible();
  expect((await about.boundingBox())!.y).toBeGreaterThan(
    (await name.boundingBox())!.y,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  expect(await smallTargets(page.locator("main"))).toEqual([]);
});
