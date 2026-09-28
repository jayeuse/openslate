import { test as base } from "@playwright/test";

// The shared `test` for HTTP specs. The app navigation reads `/api/auth/me`
// on every signed-in page, and the synthetic dev server has no backend, so
// each browser context answers it with a signed-in administrator by default.
// A spec overrides it with its own `page.route("**/api/auth/me", ...)` or
// `context.route(...)`: page routes win over context routes, and a later
// context route wins over this one. Contexts a spec opens itself with
// `browser.newContext()` get no default.

export const defaultSignedInIdentity = {
  id: "00000000-0000-4000-8000-000000000001",
  role: "admin",
  access: [],
} as const;

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route("**/api/auth/me", (route) =>
      route.fulfill({ json: defaultSignedInIdentity }),
    );
    await use(context);
  },
});

export { expect } from "@playwright/test";
export type { BrowserContext, Locator, Page, Route } from "@playwright/test";
