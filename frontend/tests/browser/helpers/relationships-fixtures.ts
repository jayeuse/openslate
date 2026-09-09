import { type Page, type Request, type Route } from "@playwright/test";
import {
  TARGET_MODULE_ID,
  SOURCE_RECORD_ID,
  SECOND_TARGET_RECORD_ID,
  CONTACTS_FIELD_ID,
  type JsonObject,
  type FixtureState,
  type CapturedRequest,
  type PaginationOverrides,
  baseEntity,
  relationshipFixture,
} from "./relationships-data";

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requestBody(request: Request): JsonObject {
  const postData = request.postData();
  if (!postData) return {};
  const parsed: unknown = JSON.parse(postData);
  return isJsonObject(parsed) ? parsed : {};
}

export function pathFor(request: Request): string {
  return new URL(request.url()).pathname.replace(/^\/bff/, "") || "/";
}

export function listResponse<T>(
  items: T[],
  pagination: PaginationOverrides = {},
): JsonObject {
  const limit = pagination.limit ?? 100;
  const offset = pagination.offset ?? 0;
  const total = pagination.total ?? items.length;
  return {
    items,
    pagination: {
      limit,
      offset,
      count: items.length,
      total,
      has_more: pagination.has_more ?? offset + items.length < total,
    },
  };
}

export async function fulfill(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export async function installMocks(
  page: Page,
  state: FixtureState,
): Promise<CapturedRequest[]> {
  const requests: CapturedRequest[] = [];

  await page.route("**/session/status", (route) =>
    fulfill(route, 200, { authenticated: true }),
  );
  await page.route("**/session/realtime-token", (route) =>
    fulfill(route, 401, { detail: "Authentication required" }),
  );
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = pathFor(request);
    const body = method === "GET" ? {} : requestBody(request);
    requests.push({ method, path, url: request.url(), body });

    if (method === "GET" && path === "/modules") {
      const departmentId = new URL(request.url()).searchParams.get(
        "department_id",
      );
      const modules = state.modules.filter(
        (module) => !departmentId || module.department_id === departmentId,
      );
      await fulfill(route, 200, listResponse(modules));
      return;
    }
    if (method === "GET" && /^\/departments\/[^/]+$/.test(path)) {
      const departmentId = path.split("/").pop();
      const department = state.modules.find(
        (item) => item.department_id === departmentId,
      );
      await fulfill(
        route,
        department ? 200 : 404,
        department
          ? {
              ...baseEntity(department.department_id),
              department_name: "Operations",
            }
          : { detail: "Not found" },
      );
      return;
    }
    if (method === "GET" && /^\/modules\/[^/]+$/.test(path)) {
      const moduleItem = state.modules.find((item) => path.endsWith(item.id));
      await fulfill(
        route,
        moduleItem ? 200 : 404,
        moduleItem ?? { detail: "Not found" },
      );
      return;
    }
    if (method === "POST" && /^\/modules\/[^/]+\/schema\/accept$/.test(path)) {
      const moduleItem = state.modules.find((item) =>
        path.includes(`/modules/${item.id}/`),
      );
      if (!moduleItem) {
        await fulfill(route, 404, { detail: "Not found" });
        return;
      }
      if (state.acceptanceError) {
        await fulfill(route, 409, { detail: state.acceptanceError });
        return;
      }
      moduleItem.is_schema_accepted = true;
      await fulfill(route, 200, moduleItem);
      return;
    }
    if (method === "GET" && path === "/fields") {
      const moduleId = new URL(request.url()).searchParams.get("module_id");
      const fields = state.fields.filter(
        (field) => !moduleId || field.module_id === moduleId,
      );
      await fulfill(route, 200, listResponse(fields));
      return;
    }
    if (method === "GET" && path === "/records") {
      const url = new URL(request.url());
      const moduleId = url.searchParams.get("module_id");
      const includeDeleted = url.searchParams.get("deleted") === "include";
      const records = state.records.filter(
        (record) =>
          (!moduleId || record.module_id === moduleId) &&
          (includeDeleted || !record.is_deleted),
      );
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      if (
        moduleId === TARGET_MODULE_ID &&
        state.targetRecordsFailures !== undefined &&
        state.targetRecordsFailures > 0
      ) {
        state.targetRecordsFailures -= 1;
        await fulfill(route, 503, { detail: "Target records unavailable" });
        return;
      }
      const page = records.slice(offset, offset + limit);
      await fulfill(
        route,
        200,
        listResponse(page, {
          limit,
          offset,
          total: records.length,
          has_more: offset + page.length < records.length,
        }),
      );
      return;
    }
    if (method === "GET" && /^\/records\/[^/]+$/.test(path)) {
      const record = state.records.find((item) => path.endsWith(item.id));
      await fulfill(
        route,
        record ? 200 : 404,
        record ?? { detail: "Not found" },
      );
      return;
    }
    if (method === "PATCH" && /^\/records\/[^/]+$/.test(path)) {
      const record = state.records.find((item) => path.endsWith(item.id));
      if (!record) {
        await fulfill(route, 404, { detail: "Not found" });
        return;
      }
      if (isJsonObject(body.data)) record.data = body.data;
      record.updated_at = "2026-01-03T00:00:00.000Z";
      await fulfill(route, 200, record);
      return;
    }
    if (method === "GET" && path === "/relationships") {
      const params = new URL(request.url()).searchParams;
      const includeDeleted = params.get("deleted") === "include";
      const relationships = state.relationships.filter((relationship) => {
        if (!includeDeleted && relationship.is_deleted) return false;
        return (
          (!params.get("field_id") ||
            relationship.field_id === params.get("field_id")) &&
          (!params.get("source_record_id") ||
            relationship.source_record_id === params.get("source_record_id")) &&
          (!params.get("target_record_id") ||
            relationship.target_record_id === params.get("target_record_id"))
        );
      });
      await fulfill(route, 200, listResponse(relationships));
      return;
    }
    if (method === "POST" && path === "/relationships") {
      const relationship = relationshipFixture(
        "18181818-1818-4181-8181-181818181818",
        typeof body.field_id === "string" ? body.field_id : CONTACTS_FIELD_ID,
        typeof body.source_record_id === "string"
          ? body.source_record_id
          : SOURCE_RECORD_ID,
        typeof body.target_record_id === "string"
          ? body.target_record_id
          : SECOND_TARGET_RECORD_ID,
      );
      state.relationships.push(relationship);
      await fulfill(route, 201, relationship);
      return;
    }
    if (
      method === "PUT" &&
      /^\/relationships\/fields\/[^/]+\/sources\/[^/]+$/.test(path)
    ) {
      const [, , , fieldId, , sourceRecordId] = path.split("/");
      const current = state.relationships.find(
        (relationship) =>
          relationship.field_id === fieldId &&
          relationship.source_record_id === sourceRecordId &&
          !relationship.is_deleted,
      );
      if (current) {
        current.is_deleted = true;
        current.deleted_at = "2026-01-03T00:00:00.000Z";
      }
      if (typeof body.target_record_id !== "string") {
        await fulfill(route, 200, null);
        return;
      }
      const replacement = relationshipFixture(
        "19191919-1919-4191-8191-191919191919",
        fieldId,
        sourceRecordId,
        body.target_record_id,
      );
      state.relationships.push(replacement);
      await fulfill(route, 200, replacement);
      return;
    }
    if (method === "DELETE" && /^\/relationships\/[^/]+$/.test(path)) {
      const relationship = state.relationships.find((item) =>
        path.endsWith(item.id),
      );
      if (!relationship) {
        await fulfill(route, 404, { detail: "Not found" });
        return;
      }
      relationship.is_deleted = true;
      relationship.deleted_at = "2026-01-03T00:00:00.000Z";
      await route.fulfill({ status: 204 });
      return;
    }

    await fulfill(route, 404, {
      detail: `Unhandled mock route: ${method} ${path}`,
    });
  });

  return requests;
}

export function requestMatching(
  requests: CapturedRequest[],
  method: string,
  path: string,
): CapturedRequest {
  const request = requests.find(
    (item) => item.method === method && item.path === path,
  );
  if (!request) throw new Error(`No ${method} request captured for ${path}`);
  return request;
}
