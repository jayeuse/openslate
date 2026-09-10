import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import { expect, test } from "@playwright/test";
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
