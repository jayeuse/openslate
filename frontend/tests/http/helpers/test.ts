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
  context: async ({ context }, provide) => {
    await context.route("**/api/auth/me", (route) =>
      route.fulfill({ json: defaultSignedInIdentity }),
    );
    await context.route("**/api/notifications/unread-count", (route) =>
      route.fulfill({ json: { unread_count: 0 } }),
    );
    // Preferences are read under the verified session ID, which individual
    // journeys may override independently of this default navigation identity.
    // Only UUID paths and the approved light/dark command are supported.
    const themes = new Map<string, "light" | "dark">();
    await context.route(
      /\/api\/users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/preferences$/,
      async (route) => {
        const userId = new URL(route.request().url()).pathname.split("/")[3];
        if (route.request().method() === "PATCH") {
          const body: unknown = route.request().postDataJSON();
          if (
            typeof body !== "object" ||
            body === null ||
            !("theme" in body) ||
            Object.keys(body).length !== 1 ||
            (body.theme !== "light" && body.theme !== "dark")
          ) {
            await route.fulfill({
              status: 422,
              json: { detail: "Invalid preference" },
            });
            return;
          }
          themes.set(userId, body.theme === "dark" ? "dark" : "light");
        } else if (route.request().method() !== "GET") {
          await route.fulfill({
            status: 405,
            json: { detail: "Method not allowed" },
          });
          return;
        }
        await route.fulfill({
          headers: { "Cache-Control": "no-store" },
          json: { user_id: userId, theme: themes.get(userId) ?? "light" },
        });
      },
    );
    await provide(context);
  },
});

export { expect } from "@playwright/test";
export type { BrowserContext, Locator, Page, Route } from "@playwright/test";
