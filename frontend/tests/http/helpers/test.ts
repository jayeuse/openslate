import {
  expect as baseExpect,
  test as base,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";

// The shared `test` for HTTP specs. The auth gate reads `/api/auth/session`
// and the app navigation reads `/api/auth/me` on every signed-in page, and the
// synthetic dev server has no backend, so each browser context answers both
// with a signed-in administrator by default. A spec overrides them with
// `signedInAs(...)`, `signedInSession(...)`, or its own `page.route(...)` /
// `context.route(...)`: page routes win over context routes, and a later
// context route wins over this one. Contexts a spec opens itself with
// `browser.newContext()` get no default.

export const defaultSignedInIdentity = {
  id: "00000000-0000-4000-8000-000000000001",
  role: "admin",
  access: [],
} as const;

type AccessLevel = "read" | "write" | "manage";

/** The `/api/auth/me` body: one account and its group access rows. */
export type SignedInIdentity = {
  id: string;
  role: "admin" | "member" | "guest";
  access?: readonly {
    department_id: string;
    module_id: string | null;
    level: AccessLevel;
  }[];
};

/**
 * Answers the session read as signed out, for pages a signed-out person uses
 * (sign in, invitation setup, recovery). The base fixture's default is signed
 * in. A browser without session cookies has its refresh rejected, so the
 * refresh answers 401 as well.
 */
export async function signedOut(target: Page | BrowserContext): Promise<void> {
  await target.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await target.route("**/api/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unauthenticated" } }),
  );
}

/**
 * Answers `/api/auth/session` with a signed-in session for `userId`. Use it
 * alone when the spec owns `/api/auth/me` separately or keeps the default
 * identity; otherwise use `signedInAs`. Stateful, held, counted, or failing
 * session reads stay inline in the spec.
 */
export async function signedInSession(
  target: Page | BrowserContext,
  userId: string,
  options: { setupRequired?: boolean } = {},
): Promise<void> {
  await target.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: userId,
        setup_required: options.setupRequired ?? false,
      },
    }),
  );
}

/** Signs `identity` in: its session and its `/api/auth/me` identity. */
export async function signedInAs(
  target: Page | BrowserContext,
  identity: SignedInIdentity,
  options: { setupRequired?: boolean } = {},
): Promise<void> {
  await signedInSession(target, identity.id, options);
  await target.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: identity.id,
        role: identity.role,
        access: identity.access ?? [],
      },
    }),
  );
}

export const test = base.extend({
  context: async ({ context }, provide) => {
    await context.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: {
          authenticated: true,
          user_id: defaultSignedInIdentity.id,
          setup_required: false,
        },
      }),
    );
    await context.route("**/api/auth/me", (route) =>
      route.fulfill({ json: defaultSignedInIdentity }),
    );
    await context.route("**/api/workspace/appearance", (route) =>
      route.fulfill({
        headers: { "Cache-Control": "no-store" },
        json: { theme: "slate" },
      }),
    );
    // Saved navigation branding uses the existing workspace read. Page-specific
    // routes still own their role-filtered profile and all workspace writes.
    await context.route("**/api/workspace", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: {
              id: "00000000-0000-4000-8000-000000000102",
              display_name: "OpenSlate",
              legal_name: null,
              description: null,
              contact_email: null,
              contact_phone: null,
              postal_address: null,
              logo_file_id: null,
              locale: "en-PH",
              timezone: "Asia/Manila",
              mark: "OS",
              currency: "PHP",
              week_start: "monday",
              business_hours: "09:00–18:00",
              theme: "slate",
              revision: 1,
              today: "2026-10-06",
              purge_enabled: false,
            },
          })
        : route.fallback(),
    );
    await context.route("**/api/notifications/unread-count", (route) =>
      route.fulfill({ json: { unread_count: 0 } }),
    );
    // The synthetic server has no event stream: proxied, it fails at a random
    // moment and the resync reloads whatever the journey is doing. Holding the
    // request keeps it connecting; specs that drive the stream override it.
    await context.route("**/api/events", () => undefined);
    // Preferences are read under the verified session ID, which individual
    // journeys may override independently of this default navigation identity.
    // Full preferences mirror the separate strict9a DTO; each context owns its state.
    type Preference = {
      theme: "light" | "dark" | "system";
      appearance: { motion: "system" | "reduce"; keyboard_shortcuts: boolean };
    };
    const preferences = new Map<string, Preference>();
    await context.route(
      /\/api\/users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/preferences$/,
      async (route) => {
        const userId = new URL(route.request().url()).pathname.split("/")[3];
        let current: Preference = preferences.get(userId) ?? {
          theme: "light",
          appearance: { motion: "system", keyboard_shortcuts: true },
        };
        if (route.request().method() === "PATCH") {
          const body: unknown = route.request().postDataJSON();
          const object = (value: unknown): value is Record<string, unknown> =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value);
          if (
            !object(body) ||
            Object.keys(body).some(
              (key) => !["theme", "appearance"].includes(key),
            ) ||
            ("theme" in body &&
              !["light", "dark", "system"].includes(String(body.theme))) ||
            ("appearance" in body &&
              (!object(body.appearance) ||
                Object.keys(body.appearance).some(
                  (key) => !["motion", "keyboard_shortcuts"].includes(key),
                ) ||
                ("motion" in body.appearance &&
                  !["system", "reduce"].includes(
                    String(body.appearance.motion),
                  )) ||
                ("keyboard_shortcuts" in body.appearance &&
                  typeof body.appearance.keyboard_shortcuts !== "boolean")))
          ) {
            await route.fulfill({
              status: 422,
              json: { detail: "Invalid preference" },
            });
            return;
          }
          const appearance = object(body.appearance) ? body.appearance : {};
          current = {
            theme: (body.theme ?? current.theme) as Preference["theme"],
            appearance: {
              motion: (appearance.motion ??
                current.appearance
                  .motion) as Preference["appearance"]["motion"],
              keyboard_shortcuts: (appearance.keyboard_shortcuts ??
                current.appearance.keyboard_shortcuts) as boolean,
            },
          };
          preferences.set(userId, current);
        } else if (route.request().method() !== "GET") {
          await route.fulfill({
            status: 405,
            json: { detail: "Method not allowed" },
          });
          return;
        }
        await route.fulfill({
          headers: { "Cache-Control": "no-store" },
          json: { user_id: userId, ...current },
        });
      },
    );
    await provide(context);
  },
});

export { expect } from "@playwright/test";
export type { BrowserContext, Locator, Page, Route } from "@playwright/test";

/**
 * The event stream stays held by the context route above. A spec's catch-all
 * `/api/**` page route takes precedence over it, so it hands the stream back
 * with `route.fallback()`; answering it instead makes the stream fail at a
 * random moment, and its resync reloads whatever the journey is doing.
 */
export function isEventStream(route: Route): boolean {
  return new URL(route.request().url()).pathname === "/api/events";
}

/**
 * Whether the page blocks a browser exit now: dispatches a cancelable
 * `beforeunload` and reports whether a listener prevented it.
 */
export function exitGuarded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

/**
 * Waits `frames` animation frames, so React commits the updates and effect
 * cleanups that already-settled promise handlers scheduled. Use it before a
 * check that must not run ahead of those commits; it waits for no event.
 */
export async function settleReact(page: Page, frames = 2): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const step = (left: number): void => {
          if (left === 0) resolve();
          else requestAnimationFrame(() => step(left - 1));
        };
        step(count);
      }),
    frames,
  );
}

/**
 * A held mock response. The route handler calls `enter()` and awaits
 * `released`; the test awaits `entered`, acts, then calls `release()`.
 */
export function heldResponse() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    released,
    enter: () => enter(),
    release: () => release(),
  };
}

/** The page does not scroll sideways at the current viewport. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  baseExpect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

/**
 * Replaces the browser `EventSource` with one that never connects or emits,
 * for journeys that drive the session gate and must not see a stream resync.
 */
export async function quietEventSource(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class QuietEventSource extends EventTarget {
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: QuietEventSource });
  });
}

/** Asks the auth gate to verify the current session again, as a focus or retry does. */
export async function recheckSession(page: Page): Promise<void> {
  await page.evaluate(() =>
    window.dispatchEvent(new Event("openslate:session-recheck")),
  );
}
