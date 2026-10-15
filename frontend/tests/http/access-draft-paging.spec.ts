import { expect, test } from "./helpers/test";
import {
  fixtureId,
  group,
  ids,
  mockAccessApi,
  person,
} from "./helpers/access-api";

test("an uncertain replacement resolves all current and draft member labels in bounded ID batches", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const before: string[] = [];
  const after: string[] = [];
  for (let index = 0; index < 100; index++) {
    before.push(fixtureId(5000 + index));
    after.push(fixtureId(6000 + index));
    api.users.set(
      before[index]!,
      person({
        id: before[index]!,
        username: `before${index}`,
        display_name: `Before member ${index}`,
      }),
    );
    api.users.set(
      after[index]!,
      person({
        id: after[index]!,
        username: `after${index}`,
        display_name: `After member ${index}`,
      }),
    );
  }
  const added = fixtureId(7000);
  api.users.set(
    added,
    person({
      id: added,
      username: "replacement_candidate",
      display_name: "Replacement candidate",
    }),
  );
  api.groups.set(
    ids.readers,
    group(ids.readers, "Finance readers", before, [
      { department_id: ids.finance, module_id: null, level: "read" },
    ]),
  );
  api.on("PUT", `/api/access/groups/${ids.readers}/members`, (route) => {
    // A concurrent full replacement is visible on read-back; this request's
    // outcome is unknown, so the saved draft must stay available for review.
    api.groups.set(ids.readers, {
      ...group(ids.readers, "Finance readers", after, [
        { department_id: ids.finance, module_id: null, level: "read" },
      ]),
      revision: 2,
    });
    // The submitted members were eligible at the write boundary. This
    // historical draft person is deleted afterward, while the outcome is
    // still unknown; the administrator may resolve its authorized label.
    const historical = api.users.get(before[99]!);
    if (historical)
      api.users.set(historical.id, {
        ...historical,
        is_deleted: true,
        status: "disabled",
        deleted_at: "2026-10-08T00:00:00Z",
      });
    return route.abort();
  });
  await page.goto(`/access?view=groups&group=${ids.readers}&tab=members`);
  const sheet = page.getByRole("dialog", {
    name: "Finance readers",
    exact: true,
  });
  await sheet
    .getByRole("button", { name: "Remove Before member 0", exact: true })
    .click();
  await sheet
    .getByRole("searchbox", { name: "Search people to add", exact: true })
    .fill("replacement_candidate");
  await sheet
    .getByRole("button", { name: "Add Replacement candidate", exact: true })
    .click();
  await sheet
    .getByRole("button", { name: "Save members", exact: true })
    .click();
  await expect(sheet.getByRole("alert")).toContainText("may have completed");
  await page.reload();
  await expect(
    sheet.getByRole("region", { name: "Saved group draft", exact: true }),
  ).toContainText("Before member 99");
  await expect(
    sheet.getByRole("region", { name: "Saved group draft", exact: true }),
  ).toContainText("Replacement candidate");
  await expect(
    sheet.getByRole("region", { name: "Current Access group", exact: true }),
  ).toContainText("After member 99");
  const lookups = api.listReads.filter(
    (query) => query.getAll("ids").length > 0,
  );
  expect(lookups.every((query) => query.getAll("ids").length <= 100)).toBe(
    true,
  );
  expect(
    api.sent("PUT", `/api/access/groups/${ids.readers}/members`),
  ).toHaveLength(1);
  let denied = true;
  api.on("GET", "/api/users", (route) =>
    denied &&
    new URL(route.request().url()).searchParams
      .getAll("ids")
      .includes(after[99]!)
      ? route.fulfill({ status: 403, json: { detail: "Forbidden" } })
      : "next",
  );
  await page.reload();
  await expect(
    sheet.getByRole("region", { name: "Saved group draft", exact: true }),
  ).not.toContainText("Before member 99");
  await expect(
    sheet.getByRole("button", { name: "Retry member names", exact: true }),
  ).toBeVisible();
  denied = false;
  await sheet
    .getByRole("button", { name: "Retry member names", exact: true })
    .click();
  await expect(
    sheet.getByRole("region", { name: "Saved group draft", exact: true }),
  ).toContainText("Before member 99");
  await expect(
    sheet.getByRole("region", { name: "Current Access group", exact: true }),
  ).toContainText("After member 99");
  expect(
    api.sent("PUT", `/api/access/groups/${ids.readers}/members`),
  ).toHaveLength(1);
  await sheet
    .getByRole("button", { name: "Discard after review", exact: true })
    .click();
  const searched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/users" &&
      new URL(response.url()).searchParams.get("search") === "before99",
  );
  await sheet
    .getByRole("searchbox", { name: "Search people to add", exact: true })
    .fill("before99");
  await searched;
  await expect(
    sheet.getByText("Loading people…", { exact: true }),
  ).toBeHidden();
  await expect(
    sheet.getByRole("button", { name: "Add Before member 99", exact: true }),
  ).toHaveCount(0);
  expect(
    api.sent("PUT", `/api/access/groups/${ids.readers}/members`),
  ).toHaveLength(1);
});
