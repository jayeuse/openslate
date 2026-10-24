import { readFile } from "node:fs/promises";

import {
  expect,
  expectNoHorizontalScroll,
  heldResponse,
  signedInAs,
  signedInSession,
  test,
  type Route,
  type Page,
} from "./helpers/test";
import { fixtureId } from "./helpers/access-api";
import { openFilters, enterDay } from "./helpers/filters";
import { mockMfa } from "./helpers/mfa";
import { profilePreferences, profileSelf } from "./helpers/profile-api";
import { pageOf } from "../helpers/pagination";

const ACTOR_ID = "00000000-0000-4000-8000-000000000201";
const NULL_LABEL_ACTOR_ID = "00000000-0000-4000-8000-000000000202";
const UNKNOWN_ACTOR_ID = "00000000-0000-4000-8000-000000000203";

type AuditLogFixture = {
  id: string;
  created_at: string;
  performed_by: string | null;
  action: "create" | "update" | "delete";
  entity_type: string;
  entity_id: string | null;
  department_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  request_id: string | null;
  request_method: string | null;
  request_path: string | null;
  actor_label: string | null;
  actor_name: string | null;
  note: string | null;
  target_label?: string;
};

const CSV_HEADER =
  '"Date","User","Entity","Action","Target","Before","After"\r\n';

function wireAuditLog(log: AuditLogFixture) {
  const snapshot = [
    log.after?.name,
    log.after?.title,
    log.before?.name,
    log.before?.title,
  ].find(
    (value): value is string =>
      typeof value === "string" && Boolean(value.trim()),
  );
  return {
    ...log,
    target_label:
      log.target_label ??
      snapshot ??
      `${humanize(log.entity_type)} · name unavailable`,
  };
}

function humanize(value: string): string {
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function fixtureCsv(logs: AuditLogFixture[]): string {
  function quote(value: string) {
    const neutral = /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${neutral.replaceAll('"', '""')}"`;
  }
  function values(
    value: Record<string, unknown> | null,
    empty: string,
  ): string {
    if (!value || !Object.keys(value).length) return empty;
    return Object.entries(value)
      .map(
        ([key, item]) =>
          `${humanize(key)}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`,
      )
      .join("\n");
  }
  const rows = logs.map((log) =>
    [
      log.created_at,
      log.actor_name?.trim() || "Unknown person",
      humanize(log.entity_type),
      humanize(log.action),
      wireAuditLog(log).target_label,
      values(log.before, "No previous values recorded."),
      values(log.after, "No updated values recorded."),
    ]
      .map(quote)
      .join(","),
  );
  return [CSV_HEADER.slice(0, -2), ...rows].join("\r\n");
}

function makeAuditLogs(count = 12): AuditLogFixture[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const performer = number % 2 === 0 ? NULL_LABEL_ACTOR_ID : ACTOR_ID;
    return {
      id: fixtureId(1000 + number),
      created_at: `2026-09-${String(12 - (index % 12)).padStart(2, "0")}T12:30:00Z`,
      performed_by: number % 7 === 0 ? null : performer,
      action: (["create", "update", "delete"] as const)[number % 3],
      entity_type: number % 2 === 0 ? "users" : "records",
      // Distinct leading digits: a target without a name reads as its kind
      // and the first 8 characters of its id.
      entity_id: `${String(2000 + number).padStart(8, "0")}-0000-4000-8000-000000000000`,
      department_id: null,
      before: number % 3 === 0 ? { status: "assigned" } : null,
      after: { status: number % 3 === 0 ? "in progress" : "active" },
      request_id: null,
      request_method: "PATCH",
      request_path: `/api/records/${fixtureId(2000 + number)}`,
      actor_label: null,
      actor_name:
        number % 7 === 0
          ? null
          : number % 2 === 0
            ? "Tara Reyes"
            : "Mara Santos",
      note: null,
    };
  });
}

function matchesDate(value: string, bound: string | null): boolean {
  return !bound || Date.parse(value) >= Date.parse(bound);
}

function createAuditRoute(logs: AuditLogFixture[]) {
  const requests: URL[] = [];
  const details: URL[] = [];
  const exports: URL[] = [];
  const exportBodies: string[] = [];
  let listDenied = false;
  let listUnavailable = false;
  let detailDenied = false;

  return {
    requests,
    details,
    exports,
    exportBodies,
    denyList() {
      listDenied = true;
    },
    allowList() {
      listDenied = false;
      listUnavailable = false;
    },
    failList() {
      listUnavailable = true;
    },
    denyDetails() {
      detailDenied = true;
    },
    allowDetails() {
      detailDenied = false;
    },
    async handle(route: Route) {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/audit-logs/options") {
        const latestEntityUse = new Map<string, string>();
        const latestActorUse = new Map<string, AuditLogFixture>();
        for (const log of logs) {
          const latestEntityDate = latestEntityUse.get(log.entity_type);
          if (!latestEntityDate || log.created_at > latestEntityDate)
            latestEntityUse.set(log.entity_type, log.created_at);
          if (!log.performed_by) continue;
          const latestActor = latestActorUse.get(log.performed_by);
          if (
            !latestActor ||
            log.created_at > latestActor.created_at ||
            (log.created_at === latestActor.created_at &&
              log.id > latestActor.id)
          )
            latestActorUse.set(log.performed_by, log);
        }
        const needle = (url.searchParams.get("search") ?? "").toLowerCase();
        const entityTypes = [...latestEntityUse.entries()]
          .filter(([type]) => !needle || type.toLowerCase().includes(needle))
          .sort(
            ([leftType, leftDate], [rightType, rightDate]) =>
              rightDate.localeCompare(leftDate) ||
              leftType.localeCompare(rightType),
          )
          .slice(0, 200)
          .map(([entityType]) => entityType);
        const actors = [...latestActorUse.entries()]
          .filter(
            ([, log]) =>
              !needle ||
              [log.actor_name ?? "", log.actor_label ?? ""].some((label) =>
                label.toLowerCase().includes(needle),
              ),
          )
          .sort(
            ([leftId, leftLog], [rightId, rightLog]) =>
              rightLog.created_at.localeCompare(leftLog.created_at) ||
              leftId.localeCompare(rightId),
          )
          .slice(0, 200)
          .map(([performed_by, log]) => ({
            performed_by,
            actor_label: log.actor_label,
            actor_name: log.actor_name,
          }));
        await route.fulfill({
          json: { entity_types: entityTypes, actors },
        });
        return;
      }
      if (
        url.pathname !== "/api/audit-logs" &&
        url.pathname !== "/api/audit-logs/export"
      ) {
        details.push(url);
        if (detailDenied) {
          await route.fulfill({
            status: 403,
            json: { detail: "Forbidden" },
          });
          return;
        }
        const selected = logs.find(
          (log) => log.id === url.pathname.split("/").pop(),
        );
        await route.fulfill({
          status: selected ? 200 : 404,
          json: selected
            ? wireAuditLog(selected)
            : { detail: "Audit log not found" },
        });
        return;
      }

      const exporting = url.pathname === "/api/audit-logs/export";
      (exporting ? exports : requests).push(url);
      if (listDenied || listUnavailable) {
        await route.fulfill({
          status: listDenied ? 403 : 503,
          json: { detail: listDenied ? "Forbidden" : "Unavailable" },
        });
        return;
      }

      const params = url.searchParams;
      const search = (params.get("search") ?? "").trim().toLocaleLowerCase();
      const filtered = logs
        .filter(
          (log) =>
            !params.get("performed_by") ||
            log.performed_by === params.get("performed_by"),
        )
        .filter(
          (log) =>
            !params.get("entity_type") ||
            log.entity_type === params.get("entity_type"),
        )
        .filter(
          (log) =>
            !params.get("department_id") ||
            log.department_id === params.get("department_id"),
        )
        .filter(
          (log) => !params.get("action") || log.action === params.get("action"),
        )
        .filter((log) =>
          matchesDate(log.created_at, params.get("created_after")),
        )
        .filter(
          (log) =>
            !params.get("created_before") ||
            Date.parse(log.created_at) <=
              Date.parse(params.get("created_before")!),
        )
        .filter(
          (log) =>
            !search ||
            [
              log.action,
              log.actor_label,
              log.entity_type,
              log.entity_id,
              JSON.stringify(log.before),
              JSON.stringify(log.after),
            ].some((value) => value?.toLocaleLowerCase().includes(search)),
        );
      const sortOrder = params.get("sort_order") === "asc" ? 1 : -1;
      filtered.sort(
        (left, right) =>
          sortOrder * left.created_at.localeCompare(right.created_at),
      );

      if (exporting) {
        if (filtered.length > 10_000) {
          await route.fulfill({
            status: 409,
            json: {
              detail: {
                code: "audit_export_limit",
                message:
                  "Audit exports support up to 10,000 entries. Narrow your filters and try again.",
              },
            },
          });
          return;
        }
        const csv = fixtureCsv(filtered);
        exportBodies.push(csv);
        await route.fulfill({
          body: csv,
          headers: {
            "Content-Type": "text/csv;charset=utf-8",
            "Content-Disposition": 'attachment; filename="openslate-audit.csv"',
            "Cache-Control": "no-store",
            "X-Audit-Export-Count": String(filtered.length),
          },
        });
        return;
      }

      const limit = Number(params.get("limit") ?? 20);
      const offset = Number(params.get("offset") ?? 0);
      const items = filtered.slice(offset, offset + limit);
      await route.fulfill({
        json: pageOf(items.map(wireAuditLog), {
          limit,
          offset,
          total: filtered.length,
        }),
      });
    },
  };
}

const SALES_ID = "00000000-0000-4000-8000-0000000003a1";
const SERVICE_ID = "00000000-0000-4000-8000-0000000003a2";

function department(id: string, name: string) {
  return {
    id,
    department_name: name,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/departments?*", (route) =>
    route.fulfill({
      json: pageOf(
        [department(SALES_ID, "Sales"), department(SERVICE_ID, "Service")],
        { limit: 100, offset: 0, total: 2 },
      ),
    }),
  );
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        id: fixtureId(77),
        display_name: "Harbor workspace",
        legal_name: null,
        description: null,
        contact_email: null,
        contact_phone: null,
        postal_address: null,
        locale: "fr-FR",
        timezone: "Asia/Manila",
        logo_file_id: null,
        mark: "RS",
        currency: "PHP",
        week_start: "monday",
        business_hours: "09:00–18:00",
        theme: "slate",
        revision: 4,
      },
    }),
  );
});

test("Audit uses server filters, sort and page requests, with server-named actor options", async ({
  page,
}) => {
  const api = createAuditRoute(makeAuditLogs());
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");

  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(10);
  await expect(
    table.getByText("Mara Santos", { exact: true }).first(),
  ).toBeVisible();
  const filters = await openFilters(page);
  await filters.getByRole("combobox", { name: "Person", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Tara Reyes", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(filters).toBeHidden();
  await expect(
    table.getByText("Unknown person", { exact: true }).first(),
  ).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Source" })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("See who changed what, then inspect the details.", {
      exact: true,
    }),
  ).toBeVisible();

  expect(api.requests[0]?.searchParams.get("limit")).toBe("10");
  expect(api.requests[0]?.searchParams.get("offset")).toBe("0");
  expect(api.requests[0]?.searchParams.get("sort_by")).toBe("created_at");
  expect(api.requests[0]?.searchParams.get("sort_order")).toBe("desc");

  await page
    .getByRole("combobox", { name: "Sort activity" })
    .selectOption("oldest");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("sort_order"))
    .toBe("asc");

  // The kind quick filter is the action filter (MD6); it shows no counts.
  const kind = page.getByRole("group", { name: "Event type", exact: true });
  await expect(kind.getByRole("button")).toHaveText([
    "All",
    "Changes",
    "Created",
    "Deleted",
  ]);
  await kind.getByRole("button", { name: "Deleted", exact: true }).click();
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("action"))
    .toBe("delete");
  await expect(table.locator("tbody tr")).toHaveCount(4);

  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("active");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("search"))
    .toBe("active");
  await kind.getByRole("button", { name: "Changes", exact: true }).click();
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("action"))
    .toBe("update");

  await openFilters(page);
  await chooseAuditFilter(page, "Person", "Tara Reyes");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("performed_by"))
    .toBe(NULL_LABEL_ACTOR_ID);
  await chooseAuditFilter(page, "Area", "People · Access");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("entity_type"))
    .toBe("users");
  await enterDay(page, "From", "2026-09-04");
  await enterDay(page, "To", "2026-09-10");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_after"))
    .toBe("2026-09-03T16:00:00.000Z");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_before"))
    .toBe("2026-09-10T15:59:59.999Z");
  await page.keyboard.press("Escape");

  // Active filters show as removable chips (DESIGN.md, Filters).
  const chips = page.getByRole("group", { name: "Active filters" });
  await expect(chips).toContainText("Person: Tara Reyes");
  await expect(chips).toContainText("Area: People · Access");
  await expect(chips).toContainText("From: 4 sept. 2026");
  await expect(chips).toContainText("To: 10 sept. 2026");
  await expect(
    page.getByRole("button", { name: "Filters", exact: true }),
  ).toHaveAccessibleDescription("4 active filters");
  await chips
    .getByRole("button", { name: "Remove Area filter", exact: true })
    .click();
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.has("entity_type"))
    .toBe(false);
  await expect(chips).not.toContainText("Area:");

  await chips.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(chips).toBeHidden();
  // Clear all keeps the search and the kind.
  await expect(
    page.getByRole("searchbox", { name: "Search activity", exact: true }),
  ).toHaveValue("active");
  await expect(kind.getByRole("button", { pressed: true })).toHaveText(
    "Changes",
  );
  await openFilters(page);
  await expect(
    page.getByRole("combobox", { name: "Person", exact: true }),
  ).toHaveText("Anyone");
  await page.keyboard.press("Escape");

  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("no matching activity");
  await expect(
    page.getByText("No audit entries match these filters", { exact: true }),
  ).toBeVisible();
});

test("Audit rows are 40px sentences, each whole row opens its event, and paging is server-backed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const logs = makeAuditLogs();
  logs[0]!.before = { status: "assigned" };
  logs[0]!.after = { status: "in progress" };
  logs[5]!.after = { title: "Paged detail target", status: "in progress" };
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");

  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  const first = table.locator("tbody tr").first();
  await expect(first).toContainText("Changed Status · Record");
  expect((await first.boundingBox())?.height).toBe(40);
  // One open target per row, named by the sentence and made unique by the
  // person and time; no per-row "View details" button.
  await expect(table.getByRole("button", { name: "View details" })).toHaveCount(
    0,
  );
  const open = first.getByRole("button");
  await expect(open).toHaveCount(1);
  await expect(open).toHaveAccessibleName(
    // MD16: a period for the dot, and seconds keep names unique.
    /^Changed Status\. Record, Mara Santos, .+ \d{1,2}:\d{2}:\d{2}$/,
  );
  // The target covers the row: a click on the area cell opens the event.
  const area = first.getByRole("cell").last();
  const box = (await area.boundingBox())!;
  await page.mouse.click(box.x + 8, box.y + box.height / 2);
  const sheet = page.getByRole("dialog", {
    name: "Changed Record",
    exact: true,
  });
  await expect(sheet).toBeVisible();
  await sheet
    .getByRole("button", { name: "Close event details", exact: true })
    .click();
  await expect(sheet).toBeHidden();
  await expect(open).toBeFocused();

  await expect(
    page.getByText("Showing 1–10 of 12", { exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Rows per page" }).selectOption("5");
  await expect(
    page.getByText("Showing 1–5 of 12", { exact: true }),
  ).toBeVisible();
  expect(api.requests.at(-1)?.searchParams.get("limit")).toBe("5");

  const pages = page.getByRole("navigation", { name: "Activity pages" });
  await pages.getByRole("button", { name: "Go to next page" }).click();
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("offset"))
    .toBe("5");
  await expect(
    page.getByText("Showing 6–10 of 12", { exact: true }),
  ).toBeVisible();
  await table
    .getByRole("button", { name: /^Created\. Person Paged detail target, / })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Created Person Paged detail target" }),
  ).toBeVisible();
  // The sheet reads the list row; there is no detail request.
  expect(api.details).toHaveLength(0);
  await page.keyboard.press("Escape");
  await openFilters(page);
  await chooseAuditFilter(page, "Area", "Records · Sandbox");
  await expect
    .poll(() => ({
      entity: api.requests.at(-1)?.searchParams.get("entity_type"),
      offset: api.requests.at(-1)?.searchParams.get("offset"),
    }))
    .toEqual({ entity: "records", offset: "0" });
  await expect(
    page.getByText("Showing 1–5 of 6", { exact: true }),
  ).toBeVisible();
});

test("the event sheet lists changed values only, as words, then the record and raw values", async ({
  page,
}) => {
  const logs = makeAuditLogs(1);
  logs[0]!.department_id = SALES_ID;
  logs[0]!.entity_type = "records";
  logs[0]!.target_label = "Q-1042";
  logs[0]!.before = {
    status: "draft",
    sent_at: null,
    is_pinned: false,
    owner: "[REDACTED]",
  };
  logs[0]!.after = {
    status: "sent",
    sent_at: "2026-09-12T12:30:00Z",
    is_pinned: true,
    owner: "[REDACTED]",
  };
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  const row = page
    .getByRole("table", { name: "Activity history table", exact: true })
    .getByRole("row")
    .filter({ hasText: "Q-1042" });
  await expect(row).toContainText("Changed Status, Sent at +2 · Q-1042");
  await expect(row.getByRole("cell").last()).toHaveText("Sales");
  await row.getByRole("button").click();

  const sheet = page.getByRole("dialog", { name: "Changed Q-1042" });
  const changed = sheet.getByRole("region", { name: "What changed" });
  // Old → new for each changed value: null reads "Not set", booleans read
  // as words, times use the organization format, and a redacted value is
  // "Hidden" on both sides.
  await expect(changed.getByRole("listitem")).toHaveText([
    "Status draft to sent",
    "Sent at Not set to 12 sept. 2026, 20:30",
    "Pinned No to Yes",
    "Owner Hidden to Hidden",
  ]);
  await expect(changed).not.toContainText("null");
  await expect(changed).not.toContainText("REDACTED");
  const record = sheet.getByRole("region", { name: "Record" });
  await expect(record).toContainText("Q-1042");
  await expect(record).toContainText("Records · Sales");
  await expect(record).toContainText(logs[0]!.id);
  await expect(
    record.getByRole("link", { name: "Open Q-1042", exact: true }),
  ).toHaveAttribute("href", `/openview?record=${logs[0]!.entity_id}`);
  // Advanced holds the raw values, closed by default.
  await expect(sheet.getByText('"sent_at": null')).toBeHidden();
  await sheet.getByRole("button", { name: /^Advanced/ }).click();
  await expect(sheet.getByText(/"sent_at": null/)).toBeVisible();
  // The record id is in Advanced, never in the row or the title.
  await expect(
    sheet.getByText(logs[0]!.entity_id!, { exact: true }),
  ).toBeVisible();
});

test("bookkeeping values stay in Advanced, and the organization reads as its name", async ({
  page,
}) => {
  const logs = makeAuditLogs(1);
  logs[0]!.entity_type = "organizations";
  logs[0]!.entity_id = fixtureId(77);
  logs[0]!.target_label = "Organizations · name unavailable";
  logs[0]!.before = { revision: 8, updated_at: "2026-09-12T12:00:00Z" };
  logs[0]!.after = { revision: 9, updated_at: "2026-09-12T12:30:00Z" };
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  const row = page
    .getByRole("table", { name: "Activity history table", exact: true })
    .getByRole("row")
    .filter({ hasText: "Organization" });
  await expect(row).toContainText(
    "Changed settings · Organization Harbor workspace",
  );
  await row.getByRole("button").click();
  const sheet = page.getByRole("dialog", {
    name: "Changed Organization Harbor workspace",
  });
  const changed = sheet.getByRole("region", { name: "What changed" });
  await expect(changed).toHaveText(
    "What changedOnly system values changed. Advanced shows them.",
  );
  await expect(changed).not.toContainText("Revision");
  await sheet.getByRole("button", { name: /^Advanced/ }).click();
  await expect(sheet.getByText(/"revision": 9/)).toBeVisible();
});

test("record values read by field name, a deleted field keeps its name, and an unreadable field keeps its short id", async ({
  page,
}) => {
  const quantity = "9e8d7c01-0000-4000-8000-000000000001";
  const oldNotes = "9e8d7c02-0000-4000-8000-000000000002";
  const hidden = "9e8d7c03-0000-4000-8000-000000000003";
  const logs = makeAuditLogs(2);
  for (const log of logs) {
    log.entity_type = "records";
    log.action = "update";
  }
  logs[0]!.target_label = "SC-118";
  logs[0]!.before = {
    data: { [quantity]: 40, [oldNotes]: "Count", [hidden]: 1 },
  };
  logs[0]!.after = { data: { [quantity]: 36, [oldNotes]: null, [hidden]: 2 } };
  logs[1]!.target_label = "SC-119";
  logs[1]!.before = { data: { [quantity]: 5 } };
  logs[1]!.after = { data: { [quantity]: 6 } };
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  const fieldReads: string[] = [];
  await page.route("**/api/fields/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    fieldReads.push(id);
    if (id === hidden)
      return route.fulfill({ status: 403, json: { detail: "Forbidden" } });
    const deleted = id === oldNotes;
    await route.fulfill({
      json: {
        id,
        module_id: "00000000-0000-4000-8000-000000000301",
        name: deleted ? "Old notes" : "Quantity",
        type: "text",
        required: false,
        position: 0,
        audit_redacted: false,
        config: {},
        relationship_target_module_id: null,
        relationship_multiple_targets: null,
        relationship_multiple_sources: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: deleted ? "2026-10-01T00:00:00Z" : null,
        is_deleted: deleted,
        performed_by: null,
      },
    });
  });
  await page.goto("/manage?view=audit");
  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  await expect(
    table.getByRole("row").filter({ hasText: "SC-118" }),
  ).toContainText("Changed Quantity, Old notes +1 · SC-118");
  await expect(
    table.getByRole("row").filter({ hasText: "SC-119" }),
  ).toContainText("Changed Quantity · SC-119");
  // One read per distinct field on the page; the refusal touches nothing else.
  expect([...fieldReads].sort()).toEqual([quantity, oldNotes, hidden].sort());
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await table
    .getByRole("row")
    .filter({ hasText: "SC-118" })
    .getByRole("button")
    .click();
  const sheet = page.getByRole("dialog", { name: "Changed SC-118" });
  await expect(
    sheet.getByRole("region", { name: "What changed" }).getByRole("listitem"),
  ).toHaveText([
    "Quantity 40 to 36",
    "Old notes Count to Not set",
    "Field 9e8d7c03 1 to 2",
  ]);
});

test("a select value reads its option label, and a person without a loaded name reads Set, never an id", async ({
  page,
}) => {
  const status = "9e8d7c01-0000-4000-8000-00000000000a";
  const owner = "9e8d7c01-0000-4000-8000-00000000000b";
  const open = "0b0b0b0b-0000-4000-8000-000000000001";
  const logs = makeAuditLogs(1);
  logs[0]!.entity_type = "records";
  logs[0]!.action = "create";
  logs[0]!.target_label = "SC-120";
  logs[0]!.before = null;
  logs[0]!.after = {
    data: { [status]: open, [owner]: "01a15e0a-0444-7650-bab2-d6f9d32fa48a" },
  };
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.route("**/api/fields/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const select = id === status;
    await route.fulfill({
      json: {
        id,
        module_id: "00000000-0000-4000-8000-000000000301",
        name: select ? "Status" : "Assigned to",
        type: select ? "select" : "user",
        required: false,
        position: 0,
        audit_redacted: false,
        config: select ? { options: [{ id: open, label: "Open" }] } : {},
        relationship_target_module_id: null,
        relationship_multiple_targets: null,
        relationship_multiple_sources: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
    });
  });
  await page.goto("/manage?view=audit");
  await page
    .getByRole("table", { name: "Activity history table", exact: true })
    .getByRole("row")
    .filter({ hasText: "SC-120" })
    .getByRole("button")
    .click();
  const changed = page
    .getByRole("dialog", { name: "Created SC-120" })
    .getByRole("region", { name: "What changed" });
  await expect(changed.getByRole("listitem")).toHaveText([
    "Status Not set to Open",
    "Assigned to Set",
  ]);
  await expect(changed).not.toContainText("01a15e0a");
  await expect(changed).not.toContainText(open);
});

test("a system kind chosen as the Area lists its events instead of one fold row", async ({
  page,
}) => {
  const logs = makeAuditLogs(5);
  for (const log of logs.slice(0, 4)) {
    log.entity_type = "in_app_notifications";
    log.action = "update";
    log.before = { read_at: null };
    log.after = { read_at: "2026-09-12T12:30:00Z" };
    log.target_label = "In App Notifications · name unavailable";
  }
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  const fold = table.getByRole("row").filter({ hasText: "system events" });
  await expect(fold).toContainText("4 system events hidden on this page");
  await openFilters(page);
  await chooseAuditFilter(page, "Area", "Notifications");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("entity_type"))
    .toBe("in_app_notifications");
  await expect(fold).toHaveCount(0);
  await expect(
    table.getByRole("button", { name: /^Changed Read at\. Notification, / }),
  ).toHaveCount(4);
});

test("system events fold into one row with Show, the choice is remembered, and a search lists every match", async ({
  page,
}) => {
  const logs = makeAuditLogs(6);
  for (const index of [1, 2, 4]) {
    logs[index]!.entity_type = "in_app_notifications";
    logs[index]!.action = "update";
    logs[index]!.before = { read_at: null };
    logs[index]!.after = { read_at: "2026-09-12T12:30:00Z" };
    logs[index]!.target_label = "In App Notifications · name unavailable";
  }
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  const fold = table.getByRole("row").filter({ hasText: "system events" });
  await expect(fold).toHaveText(
    "3 system events hidden on this page, such as read receipts.Show system events",
  );
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(table).not.toContainText("Notification");

  await fold.getByRole("button", { name: "Show system events" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(7);
  await expect(
    table.getByRole("button", { name: /^Changed Read at\. Notification, / }),
  ).toHaveCount(3);
  await expect(table).not.toContainText("name unavailable");

  // The viewer's choice survives a reload.
  await page.reload();
  await expect(table.locator("tbody tr")).toHaveCount(7);
  await fold.getByRole("button", { name: "Hide system events" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(4);

  // A search always lists its matches, fold or not.
  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("read_at");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("search"))
    .toBe("read_at");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(fold).toHaveCount(0);
});

test("a department manager reads Audit for the departments they manage, with no Security events, no Export and no refused request", async ({
  page,
}) => {
  const managerId = "00000000-0000-4000-8000-000000000301";
  await signedInAs(page, {
    id: managerId,
    role: "member",
    // Service comes first here; the picker sorts by name (MD16).
    access: [
      { department_id: SERVICE_ID, module_id: null, level: "manage" },
      { department_id: SALES_ID, module_id: null, level: "manage" },
    ],
  });
  const logs = makeAuditLogs(6).map((log, index) => ({
    ...log,
    department_id: index < 4 ? SALES_ID : SERVICE_ID,
  }));
  const api = createAuditRoute(logs);
  const refused: string[] = [];
  let revoked = false;
  // The department names arrive late; the default waits for them.
  const names = heldResponse();
  await page.route("**/api/departments?*", async (route) => {
    names.enter();
    await names.released;
    await route.fallback();
  });
  // The server rule (audit/router.py): a member reads only with the
  // department_id of a department they manage; everything else is refused.
  await page.route("**/api/audit-logs**", async (route) => {
    const url = new URL(route.request().url());
    const scoped =
      !revoked &&
      (url.pathname === "/api/audit-logs" ||
        url.pathname === "/api/audit-logs/options") &&
      [SALES_ID, SERVICE_ID].includes(
        url.searchParams.get("department_id") ?? "",
      );
    if (!scoped) {
      refused.push(url.pathname + url.search);
      await route.fulfill({ status: 403, json: { detail: "Forbidden" } });
      return;
    }
    await api.handle(route);
  });
  await page.route("**/api/security-events**", async (route) => {
    refused.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 403, json: { detail: "Forbidden" } });
  });
  await page.goto("/manage?view=organization");
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(page).toHaveURL(/view=audit/);
  await names.entered;
  expect(api.requests).toEqual([]);
  names.release();

  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(table.getByRole("cell", { name: "Sales" })).toHaveCount(4);
  expect(api.requests.at(-1)?.searchParams.get("department_id")).toBe(SALES_ID);
  await expect(page.getByRole("tab", { name: "Security events" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Export audit preview" }),
  ).toHaveCount(0);

  // Two managed departments: a Department picker sorted by name, the
  // first by name by default.
  const picker = page.getByRole("combobox", { name: "Department" });
  await expect(picker.locator("option")).toHaveText(["Sales", "Service"]);
  await expect(picker).toHaveValue(SALES_ID);
  expect(
    api.requests.every(
      (url) => url.searchParams.get("department_id") === SALES_ID,
    ),
  ).toBe(true);
  await picker.selectOption({ label: "Service" });
  await expect(table.locator("tbody tr")).toHaveCount(2);
  expect(api.requests.at(-1)?.searchParams.get("department_id")).toBe(
    SERVICE_ID,
  );
  // The sheet reads the row, since the single-event read is admin-only.
  await table.locator("tbody tr").first().getByRole("button").click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "What changed" }),
  ).toBeVisible();
  expect(api.details).toHaveLength(0);
  expect(refused).toEqual([]);

  // A manager who loses the department is told so, not "Only administrators".
  await page.keyboard.press("Escape");
  revoked = true;
  // A new page size is a fresh read, which the server now refuses.
  await page.getByRole("combobox", { name: "Rows per page" }).selectOption("5");
  await expect(
    page.getByRole("alert").filter({
      hasText: "You no longer have access to this audit history.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Only administrators can view audit history."),
  ).toHaveCount(0);
});

test("a manager of one department sees which department Audit reads", async ({
  page,
}) => {
  await signedInAs(page, {
    id: "00000000-0000-4000-8000-000000000301",
    role: "member",
    access: [{ department_id: SALES_ID, module_id: null, level: "manage" }],
  });
  const logs = makeAuditLogs(2).map((log) => ({
    ...log,
    department_id: SALES_ID,
  }));
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  await expect(
    page
      .getByRole("table", { name: "Activity history table", exact: true })
      .locator("tbody tr"),
  ).toHaveCount(2);
  await expect(
    page.getByRole("main").getByText("Department: Sales", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Department" })).toHaveCount(
    0,
  );
});

test("on a phone Activity is a list of two-line rows, and a row opens its event as a full sheet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const logs = makeAuditLogs(3);
  logs[0]!.department_id = SALES_ID;
  logs[0]!.before = { status: "assigned" };
  logs[0]!.after = { status: "in progress" };
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  const list = page.getByRole("list", { name: "Activity history" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  const first = list.getByRole("listitem").first();
  await expect(first).toContainText("Changed Status · Record");
  await expect(first).toContainText("Mara Santos · Sales");
  expect((await first.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await first.getByRole("button").click();
  const sheet = page.getByRole("dialog", {
    name: "Changed Record",
    exact: true,
  });
  await expect(sheet).toBeVisible();
  expect((await sheet.boundingBox())!.width).toBeCloseTo(390, 0);
  await expect(sheet.getByRole("listitem")).toHaveText([
    "Status assigned to in progress",
  ]);
  await expectNoHorizontalScroll(page);
});

test("Audit export downloads server CSV beyond one page and blocks a failed stale preview until Retry succeeds", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-01T09:00:00Z") });
  const logs = makeAuditLogs(123);
  logs[0]!.target_label = "  =SUM(1,2)";
  logs[0]!.actor_name = 'Export person, "quoted"';
  const api = createAuditRoute(logs);
  let retryResponseGate = Promise.resolve();
  await page.route("**/api/audit-logs**", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.pathname === "/api/audit-logs" &&
      url.searchParams.has("created_before")
    )
      await retryResponseGate;
    await api.handle(route);
  });
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await page.goto("/manage?view=audit");
  await expect(
    page.getByText("Showing 1–10 of 123", { exact: true }),
  ).toBeVisible();

  await openFilters(page);
  await enterDay(page, "From", "2026-09-01");
  await enterDay(page, "To", "2026-09-12");
  await page.keyboard.press("Escape");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_after"))
    .toBe("2026-08-31T16:00:00.000Z");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_before"))
    .toBe("2026-09-12T15:59:59.999Z");

  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(preview).toContainText("123 filtered entries");
  await expect(preview.getByLabel("CSV preview")).toContainText("Mara Santos");
  await expect(preview.getByLabel("CSV preview")).not.toContainText("Source");
  await expect(preview).toContainText("Showing the first 10 of 123 entries");
  // The description already says the download holds every entry.
  await expect(preview).not.toContainText("The CSV download includes");
  await expect(preview.getByLabel("CSV preview")).not.toContainText(
    logs[122]!.entity_id!,
  );
  expect(
    api.requests.every((url) => Number(url.searchParams.get("limit")) <= 10),
  ).toBe(true);
  expect(api.exports).toHaveLength(0);

  const downloadStarted = page.waitForEvent("download");
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe("openslate-audit.csv");
  const csvPath = testInfo.outputPath("audit-filtered.csv");
  await download.saveAs(csvPath);
  const csv = await readFile(csvPath, "utf8");
  expect(csv.trimEnd().split(/\r?\n/)).toHaveLength(124);
  expect(csv).toBe(api.exportBodies[0]);
  expect(csv).toContain('"Export person, ""quoted"""');
  expect(csv).toContain('"\'  =SUM(1,2)"');
  expect(api.exports).toHaveLength(1);
  const exported = api.exports[0]!.searchParams;
  expect(exported.get("created_after")).toBe("2026-08-31T16:00:00.000Z");
  expect(exported.get("created_before")).toBe("2026-09-12T15:59:59.999Z");
  expect(exported.get("sort_order")).toBe("desc");
  expect(exported.has("limit")).toBe(false);
  expect(exported.has("offset")).toBe(false);

  await expect(preview).toBeHidden();
  api.failList();
  // Reopening the same export after its cache goes stale refetches while
  // retaining the successful preparation; no query internals are injected.
  await page.clock.setSystemTime(new Date("2026-10-01T09:01:00Z"));
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preparationError = preview.getByRole("alert");
  await expect(preparationError).toContainText(
    "Audit export preview could not be loaded. Try again.",
  );
  const downloadCsv = preview.getByRole("button", {
    name: "Download CSV",
    exact: true,
  });
  await expect(downloadCsv).toBeDisabled();
  expect(downloads).toBe(1);

  api.allowList();
  logs[0]!.after = { status: "retry succeeded" };
  const retryHold = heldResponse();
  retryResponseGate = retryHold.released;
  try {
    const retryStarted = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === "/api/audit-logs" &&
        url.searchParams.get("limit") === "10" &&
        url.searchParams.get("offset") === "0"
      );
    });
    await preparationError.getByRole("button", { name: "Retry" }).click();
    await retryStarted;
    await expect(downloadCsv).toBeDisabled();
    expect(downloads).toBe(1);
    retryHold.release();
    await expect(preparationError).toBeHidden();
    await expect(preview.getByLabel("CSV preview")).toContainText(
      "retry succeeded",
    );
    await expect(downloadCsv).toBeEnabled();

    const recoveredDownloadStarted = page.waitForEvent("download");
    await downloadCsv.click();
    const recoveredDownload = await recoveredDownloadStarted;
    const recoveredCsvPath = testInfo.outputPath("audit-recovered.csv");
    await recoveredDownload.saveAs(recoveredCsvPath);
    const recoveredCsv = await readFile(recoveredCsvPath, "utf8");
    expect(recoveredCsv.trimEnd().split(/\r?\n/)).toHaveLength(124);
    expect(recoveredCsv).toContain("retry succeeded");
    expect(recoveredCsv).toBe(api.exportBodies[1]);
    expect(downloads).toBe(2);
  } finally {
    retryHold.release();
  }
});

test("Audit unscoped reads and export hide cached data on refusal until explicit fresh Retry", async ({
  page,
}) => {
  const logs = makeAuditLogs();
  const api = createAuditRoute(logs);
  api.denyList();
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");

  const listDenied = page.getByRole("alert").filter({
    hasText: "Only administrators can view audit history.",
  });
  await expect(listDenied).toBeVisible();
  api.allowList();
  await listDenied.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("table", { name: "Activity history table", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeEnabled();
  api.denyList();
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  await expect(listDenied).toBeVisible();
  await expect(preview).toBeHidden();
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).toBeHidden();
  await page
    .getByRole("combobox", { name: "Sort activity" })
    .selectOption("oldest");
  await expect(listDenied).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).toBeHidden();
  expect(downloads).toBe(0);
  api.allowList();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(page).toHaveURL(/view=organization/);
  await expect(
    page.getByRole("heading", { name: "Organization", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(page).toHaveURL(/view=audit/);
  await expect(listDenied).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).toBeHidden();
  await page
    .getByRole("combobox", { name: "Sort activity" })
    .selectOption("oldest");
  await listDenied.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).toBeVisible();
  expect(api.requests.at(-1)?.searchParams.get("sort_order")).toBe("asc");
});

for (const code of ["mfa_required", "ip_not_allowed"] as const) {
  test(`Audit coded export refusal ${code} delegates to the existing session gate and resumes without an admin latch`, async ({
    page,
  }) => {
    const state = await mockMfa(page, { verified: true, aal2: true });
    const api = createAuditRoute(makeAuditLogs());
    let blocked = true;
    await page.route("**/api/audit-logs**", async (route) => {
      if (
        new URL(route.request().url()).pathname === "/api/audit-logs/export" &&
        blocked
      ) {
        await route.fulfill({
          status: 403,
          json: {
            detail: {
              code,
              message:
                code === "mfa_required"
                  ? "Complete multi-factor authentication to continue"
                  : "Access from this address is not allowed",
            },
          },
        });
        return;
      }
      await api.handle(route);
    });
    await page.goto("/manage?view=audit");
    const table = page.getByRole("table", { name: "Activity history table" });
    await expect(table).toBeVisible();
    await page.getByRole("button", { name: "Export audit preview" }).click();
    const preview = page.getByRole("dialog", {
      name: "Audit export preview",
      exact: true,
    });
    await expect(
      preview.getByRole("button", { name: "Download CSV", exact: true }),
    ).toBeEnabled();
    if (code === "mfa_required")
      state.actors.get(state.userId)!.assurance = "aal1";
    else state.networkDenied = true;
    const sessionCheck = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/auth/session",
    );
    await preview
      .getByRole("button", { name: "Download CSV", exact: true })
      .click();
    const curtain = page.getByRole("dialog", {
      name: "Session verification",
      exact: true,
    });
    await expect(curtain).toBeVisible();
    if (code === "mfa_required")
      await expect(
        curtain.getByRole("heading", {
          name: "Complete two-step verification",
          exact: true,
        }),
      ).toBeVisible();
    else
      await expect(
        curtain
          .getByRole("alert")
          .filter({ hasText: "address is not allowed" }),
      ).toBeVisible();
    await expect(table).toBeHidden();
    await expect(preview).toBeHidden();
    await sessionCheck;
    blocked = false;
    state.actors.get(state.userId)!.assurance = "aal2";
    state.networkDenied = false;
    await curtain
      .getByRole("button", {
        name: code === "mfa_required" ? "Check again" : "Retry",
        exact: true,
      })
      .click();
    await expect(curtain).toBeHidden();
    await expect(table).toBeVisible();
    await expect(
      page.getByText("Only administrators can view audit history.", {
        exact: true,
      }),
    ).toBeHidden();
    expect(state.calls.filter((call) => call.method === "POST")).toHaveLength(
      0,
    );
    await page.getByRole("button", { name: "Export audit preview" }).click();
    await expect(
      preview.getByRole("button", { name: "Download CSV", exact: true }),
    ).toBeEnabled();
    const downloaded = page.waitForEvent("download");
    await preview
      .getByRole("button", { name: "Download CSV", exact: true })
      .click();
    expect((await downloaded).suggestedFilename()).toBe("openslate-audit.csv");
  });
}

test("Audit CSV failure retains its pinned preview and Retry refuses malformed or oversized responses", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-01T09:00:00Z") });
  const api = createAuditRoute(makeAuditLogs(12));
  let failure: "unavailable" | "media" | "cap" | null = "unavailable";
  const downloads: string[] = [];
  const requests: URL[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  await page.route("**/api/audit-logs**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/audit-logs/export") {
      requests.push(url);
      if (failure === "unavailable")
        return route.fulfill({
          status: 503,
          json: { detail: "Private upstream diagnostic" },
        });
      if (failure === "cap")
        return route.fulfill({
          status: 409,
          json: {
            detail: {
              code: "audit_export_limit",
              message:
                "Audit exports support up to 10,000 entries. Narrow your filters and try again.",
            },
          },
        });
      if (failure)
        return route.fulfill({
          body: CSV_HEADER,
          headers: {
            "Content-Type":
              failure === "media" ? "text/html" : "text/csv;charset=utf-8",
            "Content-Disposition": 'attachment; filename="openslate-audit.csv"',
            "Cache-Control": "no-store",
            "X-Audit-Export-Count": "10001",
          },
        });
    }
    await api.handle(route);
  });
  await page.goto("/manage?view=audit");
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeEnabled();
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  const alert = preview.getByRole("alert");
  await expect(alert).toContainText(
    "Audit CSV could not be downloaded. Try again.",
  );
  await expect(preview.getByLabel("CSV preview")).toContainText("Mara Santos");
  await expect(preview).not.toContainText("Private upstream diagnostic");
  const cutoff = requests[0]!.searchParams.get("created_before");
  await page.clock.setSystemTime(new Date("2026-10-01T09:05:00Z"));
  for (const next of ["media", "cap"] as const) {
    failure = next;
    await alert.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(alert).toContainText(
      next === "cap"
        ? "Audit exports support up to 10,000 entries. Narrow your filters and try again."
        : "Audit CSV could not be downloaded. Try again.",
    );
    expect(downloads).toHaveLength(0);
  }
  failure = null;
  const downloaded = page.waitForEvent("download");
  await alert.getByRole("button", { name: "Retry", exact: true }).click();
  const download = await downloaded;
  const path = testInfo.outputPath("audit-retried.csv");
  await download.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(api.exportBodies[0]);
  expect(downloads).toEqual(["openslate-audit.csv"]);
  expect(requests).toHaveLength(4);
  expect(
    requests.every((url) => url.searchParams.get("created_before") === cutoff),
  ).toBe(true);
  await expect(preview).toBeHidden();
});

test("Audit Close, Escape, route leave and session concealment suppress pending CSV downloads", async ({
  page,
  context,
}) => {
  const api = createAuditRoute(makeAuditLogs());
  // Another tab's sign-in conceals the workspace until the session is checked.
  let sessionHold: ReturnType<typeof heldResponse> | null = null;
  await page.route("**/api/auth/session", async (route) => {
    const held = sessionHold;
    if (held) {
      sessionHold = null;
      held.enter();
      await held.released;
    }
    await route.fallback();
  });
  const otherTab = await context.newPage();
  await otherTab.goto("/openview-print.css");
  // `response` holds the export answer; `handled` is entered once it is sent.
  let hold: {
    response: ReturnType<typeof heldResponse>;
    handled: ReturnType<typeof heldResponse>;
  } | null = null;
  let started = 0;
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await page.route("**/api/audit-logs**", async (route) => {
    if (
      new URL(route.request().url()).pathname === "/api/audit-logs/export" &&
      hold
    ) {
      const captured = hold;
      started += 1;
      captured.response.enter();
      await captured.response.released;
      try {
        await api.handle(route);
      } finally {
        captured.handled.enter();
      }
      return;
    }
    await api.handle(route);
  });
  for (const method of ["Close", "Escape", "leave", "concealment"] as const) {
    await page.goto("/manage?view=organization");
    await expect(
      page.getByRole("heading", { name: "Organization", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Audit", exact: true }).click();
    await expect(page).toHaveURL(/view=audit/);
    await expect(
      page.getByRole("table", { name: "Activity history table" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Export audit preview" }).click();
    const preview = page.getByRole("dialog", {
      name: "Audit export preview",
      exact: true,
    });
    await expect(
      preview.getByRole("button", { name: "Download CSV", exact: true }),
    ).toBeEnabled();
    hold = { response: heldResponse(), handled: heldResponse() };
    const barrier = hold;
    const session = heldResponse();
    const before = started;
    try {
      await preview
        .getByRole("button", { name: "Download CSV", exact: true })
        .click();
      await barrier.response.entered;
      expect(started).toBe(before + 1);
      await expect(
        preview.getByRole("button", { name: "Download CSV", exact: true }),
      ).toBeDisabled();
      if (method === "Close")
        await preview
          .getByRole("button", { name: "Close export", exact: true })
          .click();
      if (method === "Escape") await page.keyboard.press("Escape");
      if (method === "concealment") {
        sessionHold = session;
        await otherTab.evaluate(() =>
          new BroadcastChannel("openslate-session").postMessage({
            tabId: "another-tab",
          }),
        );
        await expect(
          page.getByRole("dialog", {
            name: "Session verification",
            exact: true,
          }),
        ).toBeVisible();
      }
      if (method === "leave") {
        await page.goBack();
        await expect(page).toHaveURL(/view=organization/);
        await expect(
          page.getByRole("heading", { name: "Organization", exact: true }),
        ).toBeVisible();
      }
      await expect(preview).toBeHidden();
      barrier.response.release();
      await barrier.handled.entered;
      if (method === "concealment") {
        await session.entered;
        session.release();
        await expect(
          page.getByRole("dialog", {
            name: "Session verification",
            exact: true,
          }),
        ).toBeHidden();
        await expect(preview).toBeVisible();
        await expect(
          preview.getByRole("button", { name: "Download CSV", exact: true }),
        ).toBeEnabled();
        await preview
          .getByRole("button", { name: "Close export", exact: true })
          .click();
      }
      expect(downloads).toBe(0);
      await expect(
        page.getByText(/Downloaded \d+ filtered audit/),
      ).toBeHidden();
    } finally {
      barrier.response.release();
      session.release();
      hold = null;
    }
  }
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(page).toHaveURL(/view=audit/);
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeEnabled();
  const downloaded = page.waitForEvent("download");
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  await downloaded;
  await expect(preview).toBeHidden();
  expect(downloads).toBe(1);
});

test("Audit shows server actor names, meaningful targets and workspace-local date and time", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-09-12T14:00:00Z"));
  let allowDateSettings = false;
  await page.route("**/api/workspace", (route) =>
    allowDateSettings
      ? route.fulfill({
          json: {
            id: fixtureId(77),
            display_name: "Harbor workspace",
            legal_name: null,
            description: null,
            contact_email: null,
            contact_phone: null,
            postal_address: null,
            locale: "fr-FR",
            timezone: "Asia/Manila",
            logo_file_id: null,
            mark: "RS",
            currency: "PHP",
            week_start: "monday",
            business_hours: "09:00–18:00",
            theme: "slate",
            revision: 4,
          },
        })
      : route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
  );
  const logs = makeAuditLogs(4);
  logs[1]!.actor_label = "Historical person label";
  logs[1]!.actor_name = null;
  logs[2]!.performed_by = UNKNOWN_ACTOR_ID;
  logs[2]!.actor_label = null;
  logs[2]!.actor_name = null;
  logs[0]!.actor_label = "historical import metadata";
  logs[0]!.actor_name = "Server display name";
  logs[0]!.before = { title: "Old record title" };
  logs[0]!.after = { title: "New record title" };
  logs[1]!.actor_label = "Historical person label";
  logs[1]!.before = { name: "Closed team" };
  logs[1]!.after = null;
  logs[1]!.entity_type = "groups";
  logs[2]!.after = { data: { title_field: "[REDACTED]" } };
  logs[2]!.target_label = "Records · name unavailable";
  logs[3]!.target_label = "Authorized current person";
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  const namedRow = table
    .getByRole("row")
    .filter({ hasText: "New record title" });
  await expect(namedRow).toContainText("Server display name");
  await expect(namedRow.getByRole("cell").first()).toHaveText(
    "Date format unavailable",
  );
  allowDateSettings = true;
  await page
    .getByRole("button", { name: "Retry date settings", exact: true })
    .click();
  // 12:30 UTC is 20:30 in Manila: today, in the organization's zone.
  await expect(namedRow.getByRole("cell").first()).toHaveText("Today 20:30");
  await expect(
    table.getByText("Unknown person", { exact: true }).first(),
  ).toBeVisible();
  // MD13: a name reads with its kind; without one, the kind and short id.
  await expect(
    table.getByRole("button", { name: /^Deleted\. Group Closed team, / }),
  ).toBeVisible();
  await expect(
    table.getByRole("button", {
      name: /^Created\. Record, Unknown person, /,
    }),
  ).toBeVisible();
  await expect(
    table.getByRole("button", {
      name: /^Changed Status\. Person Authorized current person, /,
    }),
  ).toBeVisible();
  await expect(table).not.toContainText("name unavailable");
  await expect(table).not.toContainText(logs[2]!.entity_id!);
  await openFilters(page);
  await page.getByRole("combobox", { name: "Person", exact: true }).click();
  for (const name of [
    "Server display name",
    "Historical person label",
    "Unknown person",
  ])
    await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await namedRow.getByRole("button").click();
  const detail = page.getByRole("dialog", {
    name: "Changed New record title",
    exact: true,
  });
  await expect(detail).toContainText("Server display name");
  await expect(detail).toContainText("12 sept. 2026, 20:30");
  await expect(detail).not.toContainText("2026-09-12T12:30:00Z");
  await detail
    .getByRole("button", { name: "Close event details", exact: true })
    .click();
});

test("Audit search waits for typing to settle before sending its server query", async ({
  page,
}) => {
  const api = createAuditRoute(makeAuditLogs());
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  await expect(
    page.getByRole("table", { name: "Activity history table", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .pressSequentially("delete", { delay: 20 });
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("search"))
    .toBe("delete");
  expect(
    api.requests.map((url) => url.searchParams.get("search")).filter(Boolean),
  ).toEqual(["delete"]);
});

for (const [personal, title] of [
  [
    false,
    "Audit date filters use workspace-local day bounds across a daylight-saving change",
  ],
  [
    true,
    "Audit personal display preserves workspace DST day bounds and server CSV",
  ],
] as const) {
  test(title, async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date("2026-03-10T12:00:00Z"));
    if (personal) {
      const userId = "00000000-0000-4000-8000-000000000101";
      await signedInSession(page, userId);
      await page.route("**/api/auth/me", (route) =>
        route.fulfill({ json: profileSelf(userId, "admin") }),
      );
      await page.route(`**/api/users/${userId}/preferences`, (route) =>
        route.fulfill({
          json: profilePreferences(userId, {
            timezone: "America/Los_Angeles",
            date_format: "ymd",
            time_format: "24h",
          }),
        }),
      );
    }
    await page.route("**/api/workspace", (route) =>
      route.fulfill({
        json: {
          id: fixtureId(77),
          display_name: "Harbor workspace",
          legal_name: null,
          description: null,
          contact_email: null,
          contact_phone: null,
          postal_address: null,
          locale: "en-US",
          timezone: "America/New_York",
          logo_file_id: null,
          mark: "RS",
          currency: "PHP",
          week_start: "monday",
          business_hours: "09:00–18:00",
          theme: "slate",
          revision: 4,
        },
      }),
    );
    const logs = makeAuditLogs(5);
    const localDayRows = [
      ["2026-03-08T04:59:59.999Z", "Before local day"],
      ["2026-03-08T05:00:00.000Z", "At local day start"],
      ["2026-03-08T07:00:00.000Z", "After clock change"],
      ["2026-03-09T03:59:59.999Z", "At local day end"],
      ["2026-03-09T04:00:00.000Z", "After local day"],
    ] as const;
    logs.forEach((log, index) => {
      log.created_at = localDayRows[index]![0];
      log.after = { name: localDayRows[index]![1] };
    });
    const api = createAuditRoute(logs);
    await page.route("**/api/audit-logs**", (route) => api.handle(route));
    await page.goto("/manage?view=audit");
    const table = page.getByRole("table", {
      name: "Activity history table",
      exact: true,
    });
    await expect(table).toBeVisible();
    await openFilters(page);
    await enterDay(page, "From", "2026-03-08");
    await enterDay(page, "To", "2026-03-08");
    await page.keyboard.press("Escape");

    await expect
      .poll(() => api.requests.at(-1)?.searchParams.get("created_after"))
      .toBe("2026-03-08T05:00:00.000Z");
    await expect
      .poll(() => api.requests.at(-1)?.searchParams.get("created_before"))
      .toBe("2026-03-09T03:59:59.999Z");
    await expect(
      page.getByText("Showing 1–3 of 3", { exact: true }),
    ).toBeVisible();
    await expect(table).toContainText("At local day start");
    await expect(table).toContainText("After clock change");
    await expect(table).toContainText("At local day end");
    await expect(table).not.toContainText("Before local day");
    await expect(table).not.toContainText("After local day");
    if (personal) {
      const row = table
        .getByRole("row")
        .filter({ hasText: "At local day start" });
      await expect(row).toContainText("2026-03-07");
      await expect(row).toContainText("21:00");
      await page
        .getByRole("button", { name: "Export audit preview", exact: true })
        .click();
      const preview = page.getByRole("dialog", {
        name: "Audit export preview",
        exact: true,
      });
      await expect(preview).toContainText("3 filtered entries");
      const downloaded = page.waitForEvent("download");
      await preview
        .getByRole("button", { name: "Download CSV", exact: true })
        .click();
      const download = await downloaded;
      const path = testInfo.outputPath("audit-workspace-day.csv");
      await download.saveAs(path);
      const csv = await readFile(path, "utf8");
      expect(csv).toContain('"2026-03-08T05:00:00.000Z"');
      expect(csv).toContain('"2026-03-09T03:59:59.999Z"');
      expect(csv).toBe(api.exportBodies[0]);
      expect(api.exports).toHaveLength(1);
      expect(api.exports[0]?.searchParams.get("created_after")).toBe(
        "2026-03-08T05:00:00.000Z",
      );
      expect(api.exports[0]?.searchParams.get("created_before")).toBe(
        "2026-03-09T03:59:59.999Z",
      );
    }
  });
}

test("Audit export uses the last settled search while a newer search is debouncing", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-01T09:00:00Z") });
  const api = createAuditRoute(makeAuditLogs());
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  await expect(table).toBeVisible();
  const search = page.getByRole("searchbox", {
    name: "Search activity",
    exact: true,
  });
  await search.fill("delete");
  await page.clock.runFor(300);
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("search"))
    .toBe("delete");
  // Hold time still: the newer search must stay inside its 300 ms debounce
  // until the export opens, however slowly the browser runs.
  await page.clock.pauseAt(new Date("2026-10-01T09:01:00Z"));
  await search.fill("assigned");
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      api.requests
        .find((url) => url.searchParams.get("created_before"))
        ?.searchParams.get("search"),
    )
    .toBe("delete");
});

test("Audit export pins the opening horizon through preview retry and server CSV download", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-01T09:00:00Z") });
  const logs = makeAuditLogs(102);
  logs[0]!.actor_label = "import metadata";
  logs[0]!.actor_name = "Export person";
  const api = createAuditRoute(logs);
  let failExport = true;
  let addedConcurrentEntry = false;
  const exportRequests: URL[] = [];
  await page.route("**/api/audit-logs**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("created_before") === "2026-10-01T09:00:00.000Z") {
      exportRequests.push(url);
      if (failExport) {
        await route.fulfill({ status: 503, json: { detail: "Unavailable" } });
        return;
      }
      if (url.pathname === "/api/audit-logs/export" && !addedConcurrentEntry) {
        addedConcurrentEntry = true;
        logs.push({
          ...logs[0]!,
          id: fixtureId(9999),
          created_at: "2026-10-01T09:00:01Z",
          after: { title: "Concurrent future entry" },
        });
      }
    }
    await api.handle(route);
  });
  await page.goto("/manage?view=audit");
  await expect(
    page.getByText("Showing 1–10 of 102", { exact: true }),
  ).toBeVisible();
  await openFilters(page);
  await enterDay(page, "To", "2026-10-02");
  await page.keyboard.press("Escape");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_before"))
    .toBe("2026-10-02T15:59:59.999Z");
  // Freeze the user's opening instant, independent of browser/test duration.
  await page.clock.setFixedTime(new Date("2026-10-01T09:00:00Z"));
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(preview.getByRole("alert")).toBeVisible();
  expect(exportRequests[0]?.searchParams.get("created_before")).toBe(
    "2026-10-01T09:00:00.000Z",
  );
  failExport = false;
  await page.clock.setFixedTime(new Date("2026-10-01T09:05:00Z"));
  await preview.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeEnabled();
  await expect(preview).toContainText("102 filtered entries");
  const downloaded = page.waitForEvent("download");
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  const download = await downloaded;
  const csvPath = testInfo.outputPath("audit-pinned.csv");
  await download.saveAs(csvPath);
  const csv = await readFile(csvPath, "utf8");
  expect(csv.trimEnd().split(/\r?\n/)).toHaveLength(103);
  expect(csv).toContain("Export person");
  expect(csv).toBe(api.exportBodies[0]);
  expect(
    exportRequests.filter((url) => url.pathname === "/api/audit-logs/export"),
  ).toHaveLength(1);
  expect(
    exportRequests.every(
      (url) =>
        url.searchParams.get("created_before") === "2026-10-01T09:00:00.000Z",
    ),
  ).toBe(true);
  expect(
    api.requests.every((url) => Number(url.searchParams.get("limit")) <= 10),
  ).toBe(true);
});

test("Audit Export is disabled with its reason above 10,000 events and exports the header after filters narrow to zero", async ({
  page,
}, testInfo) => {
  const api = createAuditRoute(makeAuditLogs(10001));
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  await expect(
    page.getByText("Showing 1–10 of 10001", { exact: true }),
  ).toBeVisible();
  // MD7: the list total says why before anything opens.
  const exportButton = page.getByRole("button", {
    name: "Export audit preview",
    exact: true,
  });
  await expect(exportButton).toHaveAttribute("aria-disabled", "true");
  await expect(exportButton).toHaveAccessibleDescription(
    "Narrow the filters to 10,000 events or fewer to export.",
  );
  await exportButton.focus();
  await page.keyboard.press("Enter");
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(preview).toBeHidden();
  expect(
    api.requests.every((url) => Number(url.searchParams.get("limit")) <= 10),
  ).toBe(true);
  expect(api.exports).toHaveLength(0);
  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("no matching activity");
  await expect(
    page.getByText("No audit entries match these filters", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Export audit preview" }).click();
  await expect(preview).toContainText("0 filtered entries");
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeEnabled();
  const downloaded = page.waitForEvent("download", { timeout: 5000 });
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  const download = await downloaded;
  const path = testInfo.outputPath("audit-empty.csv");
  await download.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(
    '"Date","User","Entity","Action","Target","Before","After"',
  );
  expect(api.exports).toHaveLength(1);
  expect(api.exports[0]!.searchParams.get("search")).toBe(
    "no matching activity",
  );
  await expect(preview).toBeHidden();
  await expect(
    page.getByText("Downloaded 0 filtered audit entries.", { exact: true }),
  ).toBeVisible();
});

test("Audit option search finds actors outside the capped first result and preserves selection", async ({
  page,
}) => {
  const api = createAuditRoute(makeAuditLogs());
  const reads: URL[] = [];
  await page.route("**/api/audit-logs**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/audit-logs/options") return api.handle(route);
    reads.push(url);
    await route.fulfill({
      json:
        url.searchParams.get("search") === "Remote actor"
          ? {
              actors: [
                {
                  performed_by: ACTOR_ID,
                  actor_name: "Remote actor",
                  actor_label: null,
                },
              ],
              entity_types: [],
            }
          : {
              actors: [
                {
                  performed_by: NULL_LABEL_ACTOR_ID,
                  actor_name: "Tara Reyes",
                  actor_label: null,
                },
              ],
              entity_types: ["record"],
            },
    });
  });
  await page.goto("/manage?view=audit");
  await expect(
    page.getByRole("table", { name: "Activity history table", exact: true }),
  ).toBeVisible();
  await openFilters(page);
  const person = page.getByRole("combobox", { name: "Person", exact: true });
  await person.click();
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Search person", exact: true })
    .fill("Remote actor");
  await page.getByRole("option", { name: "Remote actor", exact: true }).click();
  await expect(
    page.getByText("Person: Remote actor", { exact: true }),
  ).toBeVisible();
  await person.click();
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Search person", exact: true })
    .fill("Tara");
  await expect(
    page.getByRole("option", { name: "Tara Reyes", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(person).toContainText("Remote actor");
  expect(
    reads.some((url) => url.searchParams.get("search") === "Remote actor"),
  ).toBe(true);
  expect(api.requests.at(-1)?.searchParams.get("performed_by")).toBe(ACTOR_ID);
});

async function chooseAuditFilter(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
