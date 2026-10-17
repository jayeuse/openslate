import { expect, test, type Page } from "./helpers/test";
import {
  avatarFileId,
  avatarPng,
  installProfileApi,
  profileSelf,
  profileUserA,
} from "./helpers/profile-api";
import { ids, mockAccessApi } from "./helpers/access-api";
import { mockMfa } from "./helpers/mfa";

test.use({ trace: "on", screenshot: "on", video: "off" });

for (const [width, theme] of [
  [1440, "light"],
  [390, "dark"],
] as const) {
  test(`Account-only Profile and photo remain reachable without organization resources at ${width}`, async ({
    page,
  }, testInfo) => {
    const api = await installProfileApi(page, { role: null });
    api.theme = theme;
    const organizationReads: string[] = [];
    await page.route(
      /\/api\/(?:workspace$|notifications|events|boards|departments)/,
      (route) => {
        organizationReads.push(new URL(route.request().url()).pathname);
        return route.fulfill({
          status: 403,
          json: {
            detail: {
              code: "organization_required",
              message: "An active organization membership is required",
            },
          },
        });
      },
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/boards");
    await expect(
      page.getByRole("heading", { name: "No organization yet" }),
    ).toBeVisible();
    const profile = page.getByRole("link", {
      name: "Your profile",
      exact: true,
    });
    await profile.focus();
    await expect(profile).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath("account-gate.png"),
      fullPage: true,
    });
    await profile.press("Enter");
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Maya Chen",
    );
    await expect(
      page.getByRole("navigation", { name: "Main navigation" }),
    ).toHaveCount(0);
    await page.getByLabel("Phone", { exact: true }).fill("+1 555 0199");
    await page
      .getByRole("button", { name: "Save identity", exact: true })
      .click();
    await expect(
      page.getByText("Profile saved.", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Upload photo", { exact: true }).setInputFiles({
      name: "portrait.png",
      mimeType: "image/png",
      buffer: avatarPng,
    });
    await expect(
      page.getByRole("img", { name: "Your profile photo", exact: true }),
    ).toBeVisible();
    expect(api.people.get(profileUserA)?.avatar_file_id).toBe(avatarFileId);
    await page.reload();
    await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
      "+1 555 0199",
    );
    await expect(
      page.getByRole("img", { name: "Your profile photo", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Firefox on Android", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/Loading organization date settings/),
    ).toHaveCount(0);
    await expect(page.locator("html")).toHaveClass(
      theme === "dark" ? /dark/ : /^(?!.*\bdark\b).*$/,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("account-profile.png"),
      fullPage: true,
    });
    expect(organizationReads).toEqual([]);
    await page.goto("/boards");
    await expect(
      page.getByRole("heading", { name: "No organization yet" }),
    ).toBeVisible();
    expect(organizationReads).toEqual([]);
  });
}

for (const blocked of ["ip_not_allowed", "mfa_required"] as const) {
  test(`Profile can leave a pinned organization refused by ${blocked}`, async ({
    page,
  }, testInfo) => {
    await installProfileApi(page, { role: null });
    const organizationReads: string[] = [];
    await page.route(
      /\/api\/(?:workspace$|notifications|events|boards|departments)/,
      (route) => {
        organizationReads.push(new URL(route.request().url()).pathname);
        return route.fulfill({ status: 403 });
      },
    );
    await page.setViewportSize({
      width: blocked === "mfa_required" ? 390 : 1440,
      height: 900,
    });
    await page.addInitScript(() =>
      sessionStorage.setItem(
        "openslate-organization",
        "00000000-0000-4000-8000-000000000901",
      ),
    );
    await page.route("**/api/auth/session", (route) =>
      route.request().headers()["x-org"]
        ? route.fulfill({
            status: 403,
            json: {
              detail: { code: blocked, message: "Organization entry refused" },
            },
          })
        : route.fulfill({
            json: {
              authenticated: true,
              user_id: profileUserA,
              setup_required: false,
              organization_id: null,
              default_organization_blocked: blocked,
            },
          }),
    );
    await page.goto("/boards");
    if (blocked === "mfa_required")
      await expect(
        page.getByRole("heading", { name: "Complete two-step verification" }),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("alert").filter({ hasText: "address is not allowed" }),
      ).toBeVisible();
    await expect(page.getByLabel("Display name", { exact: true })).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("openslate-organization"),
      ),
    ).toBe("00000000-0000-4000-8000-000000000901");
    const profile = page.getByRole("link", {
      name: "Your profile",
      exact: true,
    });
    await expect(profile).toBeVisible();
    await profile.focus();
    await expect(profile).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath("policy-gate.png"),
      fullPage: true,
    });
    await profile.press("Enter");
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Maya Chen",
    );
    await expect(
      page.getByRole("navigation", { name: "Main navigation" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("openslate-organization"),
      ),
    ).toBeNull();
    await page.screenshot({
      path: testInfo.outputPath("policy-profile.png"),
      fullPage: true,
    });
    expect(organizationReads).toEqual([]);
  });
}

test("Profile entry from a pinned-organization gate cannot bypass account-wide MFA", async ({
  page,
}) => {
  await mockMfa(page, { verified: true });
  const api = await installProfileApi(page, {
    role: null,
    session: false,
    mfa: false,
  });
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "openslate-organization",
      "00000000-0000-4000-8000-000000000901",
    ),
  );
  await page.goto("/boards");
  await expect(
    page.getByLabel("Verification code", { exact: true }),
  ).toBeVisible();
  const profile = page.getByRole("link", {
    name: "Your profile",
    exact: true,
  });
  await expect(profile).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/session" &&
        !response.request().headers()["x-org"] &&
        response.status() === 403,
    ),
    profile.click(),
  ]);
  await expect(page).toHaveURL(/\/profile$/);
  await expect(profile).toHaveCount(0);
  await expect(
    page.getByLabel("Verification code", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toHaveCount(0);
  expect(api.selfReads).toEqual([]);
});

test("Inline avatar stays in tab A after tab B changes the session default", async ({
  page,
  context,
}, testInfo) => {
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
  const imageRequests: string[] = [];
  const tabB = await context.newPage();
  async function installTab(tab: Page) {
    await installProfileApi(tab, { role: "admin", session: false });
    const access = await mockAccessApi(tab, {
      identity: { id: profileUserA, role: "admin", access: [] },
    });
    Object.assign(access.users.get(ids.ana)!, {
      avatar_url: `/api/users/${ids.ana}/avatar`,
    });
    const body = (orgId: string) => ({
      ...profileSelf(profileUserA, "admin"),
      memberships: [first, second],
      current_organization: {
        ...(orgId === first.org_id ? first : second),
        owner: true,
        access: [],
      },
    });
    await tab.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: {
          authenticated: true,
          user_id: profileUserA,
          setup_required: false,
          default_organization_blocked: null,
          organization_id: route.request().headers()["x-org"] ?? sessionDefault,
        },
      }),
    );
    await tab.route("**/api/auth/me", (route) =>
      route.fulfill({
        json: body(route.request().headers()["x-org"] ?? sessionDefault),
      }),
    );
    await tab.route("**/api/auth/session/organization", (route) => {
      sessionDefault = (route.request().postDataJSON() as { org_id: string })
        .org_id;
      return route.fulfill({ json: body(sessionDefault) });
    });
    await tab.route(/\/api\/users\/[^/]+\/avatar\?/, (route) => {
      const url = new URL(route.request().url());
      imageRequests.push(url.search);
      const orgId =
        route.request().headers()["x-org"] ??
        url.searchParams.get("org") ??
        sessionDefault;
      return orgId === first.org_id
        ? route.fulfill({
            contentType: "image/png",
            headers: {
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
            body: avatarPng,
          })
        : route.fulfill({ status: 404, json: { detail: "Person not found" } });
    });
  }
  try {
    await installTab(page);
    await installTab(tabB);
    await page.goto("/access?view=people");
    await expect(
      page.getByText("Ana Santos", { exact: true }).first(),
    ).toBeVisible();
    await tabB.goto("/profile");
    await tabB
      .getByRole("button", { name: /^Organization:/ })
      .first()
      .click();
    await tabB.getByRole("menuitem", { name: /Example B/ }).click();
    await expect.poll(() => sessionDefault).toBe(second.org_id);
    await page.bringToFront();
    await page.reload();
    const row = page.getByRole("row").filter({ hasText: "Ana Santos" });
    const thumbnail = row.locator("img");
    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toHaveAttribute(
      "src",
      `/api/users/${ids.ana}/avatar?size=64&org=${first.org_id}`,
    );
    expect(
      await thumbnail.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("tab-a-avatar.png"),
      fullPage: true,
    });
    expect(imageRequests).toContain(`?size=64&org=${first.org_id}`);
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("openslate-organization"),
      ),
    ).toBe(first.org_id);
    expect(
      await tabB.evaluate(() =>
        sessionStorage.getItem("openslate-organization"),
      ),
    ).toBe(second.org_id);
  } finally {
    await tabB.close();
  }
});
