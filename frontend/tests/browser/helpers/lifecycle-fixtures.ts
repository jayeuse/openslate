import { type Page, type Request, type Route } from "@playwright/test";

export const DEPARTMENT_ID = "11111111-1111-4111-8111-111111111111";

export const MODULE_ID = "22222222-2222-4222-8222-222222222222";

export const TARGET_MODULE_ID = "44444444-4444-4444-8444-444444444444";

export type JsonObject = Record<string, unknown>;

export function baseEntity(id: string, isDeleted = false): JsonObject {
  return {
    id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: isDeleted ? "2026-01-02T00:00:00.000Z" : null,
    is_deleted: isDeleted,
    performed_by: null,
  };
}

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

export function pathFor(route: Route) {
  return pathForRequest(route.request());
}

export function pathForRequest(request: Request) {
  return new URL(request.url()).pathname.replace(/^\/bff/, "");
}

export async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export async function installSessionMocks(page: Page) {
  await page.route("**/session/status", (route) =>
    json(route, 200, { authenticated: true }),
  );
  await page.route("**/session/realtime-token", (route) =>
    json(route, 401, { detail: "Authentication required" }),
  );
}

export function departmentFixture(isDeleted = false) {
  return {
    ...baseEntity(DEPARTMENT_ID, isDeleted),
    department_name: "Operations",
  };
}

export function moduleFixture(isDeleted = false) {
  return {
    ...baseEntity(MODULE_ID, isDeleted),
    department_id: DEPARTMENT_ID,
    module_name: "Assets",
    is_schema_accepted: true,
  };
}
