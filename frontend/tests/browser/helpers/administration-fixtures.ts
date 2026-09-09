import { type Page, type Request, type Route } from "@playwright/test";

export type JsonObject = Record<string, unknown>;

export const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

export const ACTIVE_ID = "66666666-6666-4666-8666-666666666666";

export function listResponse(items: unknown[]): JsonObject {
  return {
    items,
    pagination: {
      limit: 100,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}

export async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export function pathForRequest(request: Request) {
  return new URL(request.url()).pathname.replace(/^\/bff/, "");
}

export async function installSessionMocks(page: Page) {
  await page.route("**/session/status", (route) =>
    json(route, 200, { authenticated: true }),
  );
  await page.route("**/session/realtime-token", (route) =>
    json(route, 401, { detail: "Authentication required" }),
  );
}
