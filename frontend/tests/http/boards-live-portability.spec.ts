import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installOpenViewEventSource } from "./helpers/openview-event-source";
import { isEventStream } from "./helpers/test";
import { pageOf } from "./helpers/openview-catalog";

const boardId = "00000000-0000-4000-8000-000000000001";
const newBoardId = "00000000-0000-4000-8000-000000000002";
const departmentId = "00000000-0000-4000-8000-000000000003";
const timestamp = "2026-09-23T00:00:00Z";

const s26NamedDefinition = {
  version: 1,
  logic: "and",
  deleted: "exclude",
  search: "00000000-0000-4000-8000-000000000101",
  columns: Array.from({ length: 100 }, (_, index) => ({
    name: `Label ${index}`,
    expected_type: "text",
  })),
  filters: Array.from({ length: 10 }, () => ({
    name: "Status",
    expected_type: "select",
    operator: "eq",
    value: "Open",
  })),
  sort: [
    { name: "Label 0", expected_type: "text", direction: "asc" },
    { name: "Label 1", expected_type: "text", direction: "desc" },
    { name: "Assignee", expected_type: "user", direction: "asc" },
  ],
  search_fields: [{ name: "Label 0", expected_type: "text" }],
};
const s26NamedBundle = {
  kind: "openslate-board",
  version: 3,
  configuration: {
    name: "Named query board",
    description: "Complete named definitions",
    widgets: [
      ...["count", "sum", "average", "min", "max", "distinct"].map(
        (aggregation, index) => ({
          name: `${aggregation} groups`,
          widget_type: "summary",
          source: { department_name: "Operations", module_name: "Requests" },
          config: {
            version: 1,
            size: ["S", "M", "L"][index % 3],
            pinned: index % 2 === 0,
            refresh: "manual",
            query: {
              mode: "groups",
              definition: s26NamedDefinition,
              aggregation,
              measure:
                aggregation === "count"
                  ? null
                  : { name: "Amount", expected_type: "decimal" },
              dimension: { name: "Status", expected_type: "select" },
              date_field: null,
              from_date: null,
              to_date: null,
            },
          },
        }),
      ),
      {
        name: "Yearly amount",
        widget_type: "chart",
        source: { department_name: "Operations", module_name: "Requests" },
        config: {
          version: 1,
          size: "L",
          pinned: false,
          refresh: "manual",
          chart_type: "line",
          query: {
            mode: "date_series",
            definition: s26NamedDefinition,
            aggregation: "sum",
            measure: { name: "Amount", expected_type: "decimal" },
            date_field: { name: "Opened", expected_type: "date" },
            from_date: "2020-01-01",
            to_date: "2022-12-31",
            bucket: "year",
          },
        },
      },
      {
        name: "Named records",
        widget_type: "records",
        source: { department_name: "Operations", module_name: "Requests" },
        config: {
          version: 1,
          size: "S",
          pinned: true,
          refresh: "manual",
          query: {
            definition: {
              ...s26NamedDefinition,
              columns: [{ name: "Assignee", expected_type: "user" }],
              filters: [
                {
                  name: "Assignee",
                  expected_type: "user",
                  operator: "not_empty",
                  value: null,
                },
              ],
            },
          },
        },
      },
    ],
  },
};

test("real configuration download and import preserve the complete named normalized v3 bundle", async ({
  page,
}) => {
  await installOpenViewEventSource(page);
  const actor = "00000000-0000-4000-8000-000000000671";
  const exact = JSON.stringify(s26NamedBundle, null, 2);
  const writes: Buffer[] = [];
  let imported = false;
  await page.route("**/api/**", (route) => {
    if (isEventStream(route)) return route.fallback();
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === "/api/auth/session")
      return json({
        authenticated: true,
        user_id: actor,
        setup_required: false,
      });
    if (path === "/api/auth/me")
      return json({ id: actor, role: "admin", access: [] });
    if (path === `/api/users/${actor}/preferences`)
      return json({
        user_id: actor,
        theme: "light",
        appearance: { motion: "reduce", keyboard_shortcuts: true },
      });
    if (path === "/api/workspace")
      return json({
        id: departmentId,
        display_name: "OpenSlate",
        legal_name: null,
        description: null,
        contact_email: null,
        contact_phone: null,
        postal_address: null,
        logo_file_id: null,
        locale: "en-US",
        timezone: "UTC",
        mark: "OS",
        currency: "USD",
        week_start: "monday",
        business_hours: "09:00–18:00",
        theme: "slate",
        revision: 1,
        today: "2026-10-07",
        purge_enabled: true,
      });
    if (path === "/api/boards/import") {
      expect(route.request().headers()["content-type"]).toBe(
        "application/octet-stream",
      );
      writes.push(route.request().postDataBuffer()!);
      imported = true;
      return route.fulfill({
        status: 201,
        headers: { Location: `/api/boards/${newBoardId}` },
        json: { ...boardResponse(newBoardId, 1), name: "Named query board" },
      });
    }
    if (path === `/api/boards/${boardId}/configuration`)
      return route.fulfill({
        contentType: "application/json",
        body: exact,
        headers: {
          "Content-Disposition":
            'attachment; filename="board-configuration.json"',
        },
      });
    if (path === "/api/boards")
      return json(
        pageOf(
          imported
            ? [
                boardResponse(boardId),
                { ...boardResponse(newBoardId, 1), name: "Named query board" },
              ]
            : [boardResponse(boardId)],
          { limit: 25 },
        ),
      );
    if (path === `/api/boards/${boardId}`) return json(boardResponse(boardId));
    if (path === `/api/boards/${newBoardId}`)
      return json({
        ...boardResponse(newBoardId, 1),
        name: "Named query board",
      });
    if (path.endsWith("/my-access"))
      return json({ level: "manage", read: true, write: true, manage: true });
    if (path.endsWith("/widgets"))
      return json({
        ...pageOf([], { limit: 12 }),
        board_revision: imported && path.includes(newBoardId) ? 1 : 4,
      });
    return route.fulfill({ status: 404, json: { detail: "No route fixture" } });
  });
  await page.goto(`/boards?board=${boardId}`);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Configurations", exact: true })
    .click();
  const panel = page.getByRole("dialog", {
    name: "Board configurations",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Export configuration", exact: true })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await panel
    .getByRole("link", { name: "Download configuration", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("board-configuration.json");
  const path = await download.path();
  if (!path) throw new Error("A real configuration download is required");
  const bytes = await readFile(path);
  expect(bytes.toString()).toBe(exact);
  expect(JSON.parse(bytes.toString())).toEqual(s26NamedBundle);
  await panel
    .getByLabel("Board configuration file", { exact: true })
    .setInputFiles({
      name: "named.json",
      mimeType: "application/json",
      buffer: bytes,
    });
  await panel
    .getByRole("button", { name: "Import configuration", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: "Import Board configuration?",
    exact: true,
  });
  await confirm
    .getByRole("button", { name: "Create project Board", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Named query board", exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.toString()).toBe(exact);
});

function boardResponse(id = boardId, revision = 4) {
  return {
    id,
    scope: id === boardId ? "department" : "project",
    department_id: id === boardId ? departmentId : null,
    name: "Dispatch",
    description: "Daily handoffs",
    status: "active",
    revision,
    level: "manage",
    created_at: timestamp,
    updated_at: timestamp,
  };
}
