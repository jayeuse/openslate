import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import { expect, test } from "../coverage";
import { testSecret } from "../../helpers/test-secret";
import {
  ACTIVE_ID,
  ADMIN_ID,
  installSessionMocks,
  json,
  listResponse,
  pathForRequest,
} from "../helpers/administration-fixtures";

const providerCanary = testSecret();

test("audit filters requests, reveals details, and switches views by keyboard", async ({
  page,
}) => {
  await installSessionMocks(page);
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const entry = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    created_at: "2026-02-01T10:00:00.000Z",
    performed_by: ADMIN_ID,
    action: "update",
    entity_type: "records",
    entity_id: ACTIVE_ID,
    before: { state: "before-value" },
    after: { state: "after-value" },
    request_id: operationId,
    request_method: "PATCH",
    request_path: "/records/66666666-6666-4666-8666-666666666666",
    actor_label: "Admin actor",
    note: null,
  };
  const requests: URL[] = [];
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    const url = new URL(route.request().url());
    requests.push(url);
    await json(
      route,
      200,
      listResponse(url.pathname.endsWith("/audit-logs") ? [entry] : []),
    );
  });
  await page.goto("/administration/audit");
  await expect(
    page.getByRole("heading", { name: "Audit logs", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Action").selectOption("update");
  await page.getByLabel("Entity type").fill("records");
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.pathname.endsWith("/audit-logs") &&
          url.searchParams.get("action") === "update" &&
          url.searchParams.get("entity_type") === "records",
      ),
    )
    .toBe(true);
  await page.getByText("View details", { exact: true }).first().click();
  await expect(page.getByText(/before-value/)).toBeVisible();
  await expect(page.getByText(/after-value/)).toBeVisible();
  const securityTab = page.getByRole("tab", { name: "Security events" });
  await securityTab.focus();
  await securityTab.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Security events" }),
  ).toBeVisible();
  await expect(
    page.getByText("No security events found for the current filters.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("audit governance gives safe authorization and failure retry guidance", async ({
  page,
}) => {
  await installSessionMocks(page);
  let allowAudit = false;
  let allowSecurity = false;
  const emptyAudit = listResponse([]);
  const emptySecurity = listResponse([]);
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    const request = route.request();
    const path = pathForRequest(request);
    if (request.method() === "GET" && path === "/audit-logs") {
      if (!allowAudit) {
        await json(route, 403, {
          detail: "internal permission explanation must not be shown",
        });
      } else {
        await json(route, 200, emptyAudit);
      }
    } else if (request.method() === "GET" && path === "/security-events") {
      if (!allowSecurity) {
        await json(route, 503, {
          detail: providerCanary,
        });
      } else {
        await json(route, 200, emptySecurity);
      }
    } else {
      await json(route, 404, { detail: "Unhandled mock route" });
    }
  });

  await page.goto("/administration/audit");
  await expect(
    page.getByText("Administrator access is required to load audit logs.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/internal permission explanation/)).toHaveCount(
    0,
  );
  allowAudit = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("No audit logs found for the current filters.", {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Security events" }).click();
  await expect(
    page.getByText("security events could not be loaded. Try again.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(providerCanary)).toHaveCount(0);
  allowSecurity = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("No security events found for the current filters.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("security events paginate, correlate operations, reveal details and export bounded JSON", async ({
  page,
}) => {
  await installSessionMocks(page);
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const event = {
    id: ACTIVE_ID,
    occurred_at: "2026-02-01T10:00:00.000Z",
    event_type: "session.denied",
    outcome: "denied",
    source: "auth",
    operation_id: operationId,
    actor_id: ADMIN_ID,
    subject_id: null,
    labels: { channel: "browser" },
    fingerprint: null,
    reason: "Session expired",
    request_id: null,
    request_method: "POST",
    request_path: "/session/refresh",
    metadata: {},
  };
  const requests: URL[] = [];
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.pathname.endsWith("/security-events/export"))
      return json(route, 200, [event]);
    if (url.pathname.endsWith("/security-events")) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json(route, 200, {
        items: [
          {
            ...event,
            event_type: offset ? "session.rejected" : event.event_type,
          },
        ],
        pagination: {
          offset,
          limit,
          count: 1,
          total: limit + 1,
          has_more: offset === 0,
        },
      });
    }
    await json(route, 200, listResponse([]));
  });
  await page.goto("/administration/audit");
  await page.getByRole("tab", { name: "Security events" }).click();
  await expect(
    page.getByRole("button", { name: "Previous security events page" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Next security events page" }).click();
  await expect(
    page.getByText("session.rejected", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next security events page" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Previous security events page" })
    .click();
  await page
    .getByLabel("Search security events", { exact: true })
    .fill("session");
  await page.getByLabel("Operation ID", { exact: true }).fill(operationId);
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.pathname.endsWith("/security-events") &&
          url.searchParams.get("search") === "session" &&
          url.searchParams.get("operation_id") === operationId &&
          url.searchParams.get("offset") === "0",
      ),
    )
    .toBe(true);
  await page
    .getByLabel("View details for session.denied", { exact: true })
    .first()
    .click();
  await expect(
    page.getByText("POST /session/refresh", { exact: true }).first(),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("security-events.json");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual([event]);
  expect(
    requests
      .find((url) => url.pathname.endsWith("/security-events/export"))
      ?.searchParams.get("operation_id"),
  ).toBe(operationId);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByLabel("Operation ID", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByLabel("Search security events", { exact: true }),
  ).toHaveValue("");
});

test("audit exports date filters and recovers safely from malformed export data", async ({
  page,
}) => {
  await installSessionMocks(page);
  let validExport = false;
  const exports: URL[] = [];
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/audit-logs/export")) {
      exports.push(url);
      return json(
        route,
        200,
        validExport ? [] : [{ private_context: "invalid export response" }],
      );
    }
    await json(route, 200, listResponse([]));
  });
  await page.goto("/administration/audit");
  await page.getByLabel("From date").fill("2026-02-01");
  await page.getByLabel("To date").fill("2026-02-02");
  await page.getByRole("button", { name: "Export JSON" }).click();
  await expect(
    page.getByText("audit logs could not be exported. Try again.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("invalid export response")).toHaveCount(0);
  expect(exports[0].searchParams.get("created_after")).toBe(
    "2026-02-01T00:00:00Z",
  );
  expect(exports[0].searchParams.get("created_before")).toBe(
    "2026-02-02T23:59:59.999Z",
  );
  validExport = true;
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("audit-logs.json");
  await expect(
    page.getByText("audit logs could not be exported. Try again.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByLabel("From date")).toHaveValue("");
  await expect(page.getByLabel("To date")).toHaveValue("");
});
