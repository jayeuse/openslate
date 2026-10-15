import { expect, signedInSession, test, type Page } from "./helpers/test";
import { profileSelf, regionalDefaults } from "./helpers/profile-api";

const userId = "00000000-0000-4000-8000-000000000101";

async function signIn(page: Page) {
  await signedInSession(page, userId);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: profileSelf(userId) }),
  );
}

// The sidebar's width change is one of the glides that reduce motion stops.
const sidebarGlide = (page: Page) =>
  page.evaluate(
    () =>
      getComputedStyle(
        document.querySelector('[data-slot="sidebar-gap"]') as Element,
      ).transitionProperty,
  );

test("reduce motion in Appearance stops the sidebar glide and turning it off restores it", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/appearance");
  const toggle = page.getByRole("switch", { name: "Reduce motion" });
  await expect(toggle).not.toBeChecked();
  expect(await sidebarGlide(page)).toBe("width");

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  expect(await sidebarGlide(page)).toBe("none");

  await toggle.click();
  await expect(page.locator("html")).not.toHaveAttribute("data-motion");
  expect(await sidebarGlide(page)).toBe("width");
});

test("System motion follows OS changes without preference writes", async ({
  page,
}) => {
  await signIn(page);
  let writes = 0;
  await page.route("**/api/users/*/preferences", (route) => {
    if (route.request().method() === "PATCH") writes++;
    return route.fulfill({
      json: {
        user_id: userId,
        theme: "light",
        appearance: {
          motion: "system",
          keyboard_shortcuts: true,
          ...regionalDefaults,
        },
      },
    });
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/settings/appearance");
  await expect(
    page.getByRole("switch", { name: "Reduce motion" }),
  ).toBeEnabled();
  expect(await sidebarGlide(page)).toBe("width");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => sidebarGlide(page)).toBe("none");
  await expect(
    page.getByRole("switch", { name: "Reduce motion" }),
  ).not.toBeChecked();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => sidebarGlide(page)).toBe("width");
  expect(writes).toBe(0);
});
