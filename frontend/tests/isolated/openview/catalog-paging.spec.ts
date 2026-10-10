import { expect, test } from "@playwright/test";
import {
  boundedCatalogOptions,
  moduleWorkspaceOptions,
  departmentsOptions,
} from "../../../src/components/systems/openview/adapters/openview-queries";
import { QueryClient } from "@tanstack/react-query";

const moduleId = "00000000-0000-4000-8000-000000000015";
const departmentId = "00000000-0000-4000-8000-000000000016";
const timestamp = "2026-10-01T00:00:00Z";

test("OpenView catalog and department reads leave later pages for explicit loading", async () => {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    requests.push(url.pathname + url.search);
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const item = url.pathname.endsWith("/departments")
      ? {
          id: departmentId,
          department_name: "Dispatch",
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
        }
      : {
          id: moduleId,
          name: "Visits",
          department_id: departmentId,
          title_field_id: null,
        };
    return Promise.resolve(
      Response.json({
        items: offset === 0 ? [item] : [],
        pagination: {
          limit: 100,
          offset,
          count: offset === 0 ? 1 : 0,
          total: 101,
          has_more: offset === 0,
        },
      }),
    );
  }) as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    const catalog = await client.fetchQuery(boundedCatalogOptions());
    expect(catalog.hasMore).toBe(true);
    expect(catalog.items).toHaveLength(1);
    const departments = await client.fetchQuery(departmentsOptions());
    expect(departments.pagination.hasMore).toBe(true);
    expect(departments.items).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests.every((path) => path.includes("offset=0"))).toBe(true);
  } finally {
    client.clear();
    globalThis.fetch = originalFetch;
  }
});

test("module workspace leaves field and saved-view continuations for the load-more action", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    requests.push(url.pathname + url.search);
    return Promise.resolve(
      Response.json({
        items: [],
        pagination: {
          limit: 100,
          offset: Number(url.searchParams.get("offset") ?? 0),
          count: 0,
          total: 101,
          has_more: true,
        },
      }),
    );
  }) as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    const workspace = await client.fetchQuery(moduleWorkspaceOptions(moduleId));
    expect(workspace.fieldsHasMore).toBe(true);
    expect(workspace.viewsHasMore).toBe(true);
    expect(requests).toHaveLength(2);
  } finally {
    client.clear();
    globalThis.fetch = originalFetch;
  }
});
