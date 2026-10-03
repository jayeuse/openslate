import { expect, test } from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { captureOpenViewReview } from "./helpers/openview-review-capture";

const moduleId = "00000000-0000-4000-8000-000000000110";
const departmentId = "00000000-0000-4000-8000-000000000111";
const selectFieldId = "00000000-0000-4000-8000-000000000112";
const userFieldId = "00000000-0000-4000-8000-000000000113";
const choiceId = "00000000-0000-4000-8000-000000000114";
const eligibleUserId = "00000000-0000-4000-8000-000000000115";
const userId = "00000000-0000-4000-8000-000000000101";

function pageResponse(items: unknown[]) {
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

test("Charts filter on stable choice and eligible person IDs", async ({
  page,
}) => {
  const requestPaths: Array<{ path: string; method: string }> = [];
  let assignableUserRequests = 0;
  let aggregateBody: Record<string, unknown> | null = null;
  let aggregateRequests = 0;
  let groupLabel = "Alex Reader";
  page.on("request", (request) => {
    const url = new URL(request.url());
    requestPaths.push({ path: url.pathname, method: request.method() });
    if (
      url.pathname === `/api/modules/${moduleId}/assignable-users` &&
      request.method() === "GET"
    )
      assignableUserRequests += 1;
  });
  await installOpenViewEventSource(page);
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/views/data-sources**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/views/data-sources") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageResponse([
            {
              id: moduleId,
              name: "Service requests",
              department_id: departmentId,
              title_field_id: null,
            },
          ]),
        ),
      });
    }
    if (pathname === `/api/views/data-sources/${moduleId}/fields`) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageResponse([
            {
              id: selectFieldId,
              module_id: moduleId,
              name: "Status",
              type: "select",
              required: false,
              position: 0,
              config: {
                options: [{ id: choiceId, label: "Awaiting review" }],
              },
            },
            {
              id: userFieldId,
              module_id: moduleId,
              name: "Assignee",
              type: "user",
              required: false,
              position: 1,
              config: { kind: "user" },
            },
          ]),
        ),
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.route(`**/api/modules/${moduleId}/assignable-users**`, (route) =>
    route.fulfill({
      headers: { "cache-control": "private, no-store" },
      contentType: "application/json",
      body: JSON.stringify(
        pageResponse([
          {
            id: eligibleUserId,
            display_name: "Alex Reader",
            username: "alex.reader",
          },
        ]),
      ),
    }),
  );
  await page.route("**/api/records/aggregate-snapshot", async (route) => {
    aggregateRequests += 1;
    aggregateBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            key: eligibleUserId,
            label: groupLabel,
            value: 1,
            record_count: 1,
          },
        ],
        pagination: {
          limit: 1,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      }),
    });
  });

  await page.goto("/openview?section=charts&module=" + moduleId);
  await page.getByRole("button", { name: "Filters (0)" }).click();
  await page.getByLabel("Group by").selectOption(userFieldId);
  await page.getByRole("button", { name: "Add filter" }).click();
  await page
    .getByLabel("Filter 1 field", { exact: true })
    .selectOption(selectFieldId);
  const selectValue = page.getByLabel("Filter 1 value", { exact: true });
  await expect(
    selectValue.getByRole("option", { name: "Awaiting review" }),
  ).toBeAttached();
  await selectValue.selectOption(choiceId);

  await page.getByRole("button", { name: "Add filter" }).click();
  await page
    .getByLabel("Filter 2 field", { exact: true })
    .selectOption(userFieldId);
  await expect(
    page
      .getByLabel("Filter 2 operator", { exact: true })
      .getByRole("option", { name: "Is one of", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => assignableUserRequests).toBeGreaterThan(0);
  const personValue = page.getByLabel("Filter 2 value", { exact: true });
  await expect(
    personValue.getByRole("option", { name: "Alex Reader" }),
  ).toBeAttached();
  await expect(page.getByText(eligibleUserId, { exact: true })).toHaveCount(0);
  await personValue.selectOption(eligibleUserId);

  const aggregateRequest = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/records/aggregate-snapshot" &&
      request.method() === "POST",
  );
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await aggregateRequest;
  const capturedAggregateBody = (): Record<string, unknown> | null =>
    aggregateBody;
  await expect.poll(capturedAggregateBody).not.toBeNull();
  const submittedBody = capturedAggregateBody();
  if (!submittedBody) throw new Error("The chart query was not captured");
  const filters = (
    submittedBody.definition as {
      filters: Array<Record<string, unknown>>;
    }
  ).filters;
  expect(filters).toContainEqual({
    field_id: selectFieldId,
    expected_type: "select",
    operator: "eq",
    value: choiceId,
  });
  expect(filters).toContainEqual({
    field_id: userFieldId,
    expected_type: "user",
    operator: "eq",
    value: eligibleUserId,
  });
  expect(
    requestPaths.filter(
      ({ path, method }) =>
        /^\/api\/users(?:\/|$)/.test(path) &&
        !(path === `/api/users/${userId}/preferences` && method === "GET"),
    ),
  ).toEqual([]);
  const resultTable = page.getByRole("table", {
    name: "Complete aggregate data",
  });
  await expect(
    resultTable.getByRole("row").filter({ hasText: "Alex Reader" }),
  ).toBeVisible();

  const requestsBeforeRename = aggregateRequests;
  groupLabel = "Alex Reader updated";
  await sendOpenViewEvent(page, "invalidate", {
    entity: "users",
    module_id: moduleId,
  });
  await expect
    .poll(() => aggregateRequests)
    .toBeGreaterThan(requestsBeforeRename);
  await expect(
    resultTable.getByRole("row").filter({ hasText: "Alex Reader updated" }),
  ).toBeVisible();
  await expect(
    resultTable.getByRole("cell", { name: "Alex Reader", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Filters (2)" }).click();
  await captureOpenViewReview(page, "charts-select-person-labels");
});
