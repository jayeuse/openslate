import {
  expect,
  signedInAs,
  test,
  type Locator,
  type Page,
  type Route,
} from "./helpers/test";
const MODULE = "10000000-0000-4000-8000-000000000001";
const TITLE = "20000000-0000-4000-8000-000000000001";
const QUANTITY = "20000000-0000-4000-8000-000000000002";
const ENABLED = "20000000-0000-4000-8000-000000000003";
const VIEW = "30000000-0000-4000-8000-000000000001";
const BOARD = "40000000-0000-4000-8000-000000000001";
const DIGEST = "a".repeat(64);
const uuid = (n: number) =>
  `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function list<T>(items: T[], total = items.length, offset = 0, limit = 100) {
  return {
    items,
    pagination: {
      limit,
      offset,
      count: items.length,
      total,
      has_more: offset + items.length < total,
    },
  };
}
const definition = {
  version: 1,
  logic: "and",
  columns: [{ field_id: TITLE, expected_type: "text" }],
  filters: [
    {
      field_id: ENABLED,
      expected_type: "boolean",
      operator: "eq",
      value: true,
    },
  ],
  sort: [],
  search: null,
  search_fields: [],
  deleted: "exclude",
};
async function catalog(page: Page) {
  await page.route("**/api/views/data-sources?*", (r) =>
    r.fulfill({
      json: list([
        {
          id: MODULE,
          name: "Maintenance",
          department_id: BOARD,
          title_field_id: TITLE,
        },
      ]),
    }),
  );
  await page.route(`**/api/views/data-sources/${MODULE}/fields?*`, (r) =>
    r.fulfill({
      json: list(
        [
          { id: TITLE, name: "Title", type: "text", required: true },
          { id: QUANTITY, name: "Quantity", type: "int", required: false },
          { id: ENABLED, name: "Enabled", type: "boolean", required: false },
        ].map((f, position) => ({
          ...f,
          module_id: MODULE,
          position,
          config: {},
        })),
      ),
    }),
  );
  await page.route("**/api/views?*", (r) =>
    r.fulfill({
      json: list([
        {
          id: VIEW,
          module_id: MODULE,
          name: "Enabled jobs",
          is_default: false,
          definition,
          presentation: {
            version: 1,
            layout: "table",
            column_field_ids: [TITLE],
            pinned_field_ids: [],
            density: "comfortable",
            wrap: false,
            card_size: "comfortable",
            primary_field_id: null,
            secondary_field_id: null,
            date_field_id: null,
            group_by_field_id: null,
            date_range: "month",
            scale: null,
          },
          revision: 1,
          is_deleted: false,
          can_edit: true,
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-01T00:00:00Z",
        },
      ]),
    }),
  );
}
type ImportRequest = {
  mode: "preview" | "import";
  module_id: string;
  headers: string[];
  mapping: { column_index: number; field_id: string }[];
  rows: { row_number: number; cells: string[] }[];
  defaults: Record<string, unknown>;
  schema_digest: string | null;
};
function importResult(body: ImportRequest) {
  const rows = body.rows.map((row) => {
    const invalid = row.cells[1] === "bad";
    return {
      row_number: row.row_number,
      status: invalid
        ? "invalid"
        : body.mode === "preview"
          ? "valid"
          : "created",
      record_id:
        !invalid && body.mode === "import" ? uuid(row.row_number) : null,
      data: invalid
        ? {}
        : {
            [TITLE]: row.cells[0],
            ...(body.mapping.some((item) => item.field_id === QUANTITY)
              ? { [QUANTITY]: Number(row.cells[1]) }
              : {}),
            ...body.defaults,
          },
      errors: invalid
        ? [
            {
              code: "invalid_field_value",
              message: "Integer must be a whole base-10 number",
              field_id: QUANTITY,
              column_index: 1,
            },
          ]
        : [],
    };
  });
  const invalid = rows.filter((r) => r.status === "invalid").length;
  return {
    mode: body.mode,
    schema_digest: DIGEST,
    rows,
    valid_count: rows.length - invalid,
    invalid_count: invalid,
    created_count: body.mode === "import" ? rows.length - invalid : 0,
  };
}
async function upload(page: Page, csv: string) {
  await page.goto("/platform?section=import-export");
  await selectCsv(page, csv);
}

async function selectCsv(page: Page, csv: string) {
  await page.getByLabel("Import module", { exact: true }).selectOption(MODULE);
  await page.getByLabel("CSV file", { exact: true }).setInputFiles({
    name: "maintenance.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page
    .getByLabel("Map column 1 · Title", { exact: true })
    .selectOption(TITLE);
  await page
    .getByLabel("Map column 2 · Quantity", { exact: true })
    .selectOption(QUANTITY);
}
test("Search queries four kinds, pages within cards and uses typed destinations", async ({
  page,
}) => {
  await signedInAs(page, {
    id: "00000000-0000-4000-8000-000000000001",
    role: "member",
    access: [{ department_id: BOARD, module_id: MODULE, level: "read" }],
  });
  const requests: URLSearchParams[] = [];
  await page.route("**/api/search?*", (r) => {
    const p = new URL(r.request().url()).searchParams;
    requests.push(p);
    const kind = p.get("kind");
    const offset = Number(p.get("offset"));
    const items = Array.from(
      { length: kind === "record" && offset === 0 ? 10 : 1 },
      (_, i) => ({
        kind,
        id: uuid(offset + i + 1),
        title: `${kind} match ${offset + i + 1}`,
        context_label: kind === "person" ? "reader" : "Maintenance",
        module_id: kind === "record" ? MODULE : null,
        board_id: kind === "post" || kind === "event" ? BOARD : null,
        can_open: kind !== "person",
      }),
    );
    return r.fulfill({
      json: list(items, kind === "record" ? 11 : 1, offset, 10),
    });
  });
  await page.goto("/platform?section=search");
  await page.getByRole("searchbox", { name: "Search workspace" }).fill("pump");
  await expect(
    page.getByRole("link", { name: "record match 1 Maintenance", exact: true }),
  ).toHaveAttribute(
    "href",
    `/openview?section=views&module=${MODULE}&record=${uuid(1)}`,
  );
  await expect(
    page.getByRole("link", { name: /post match 1/ }),
  ).toHaveAttribute(
    "href",
    `/boards?board=${BOARD}&section=posts&post=${uuid(1)}`,
  );
  await expect(
    page.getByRole("link", { name: /event match 1/ }),
  ).toHaveAttribute(
    "href",
    `/boards?board=${BOARD}&section=calendar&event=${uuid(1)}`,
  );
  await expect(page.getByText("person match 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /person match/ })).toHaveCount(0);
  for (const kind of ["record", "person", "post", "event"])
    expect(
      requests.some(
        (p) =>
          p.get("kind") === kind &&
          p.get("search") === "pump" &&
          p.get("limit") === "10",
      ),
    ).toBe(true);
  const records = page.getByRole("region", { name: "Records search results" });
  await records.getByRole("button", { name: "Go to next page" }).click();
  await expect(
    records.getByRole("link", { name: /record match 11/ }),
  ).toBeVisible();
  for (const name of ["Conversations", "Files"])
    await expect(
      page.getByRole("region", { name: `${name} search results` }),
    ).toHaveCount(0);
});
test("CSV preview and import use sequential complete batches, typed defaults and row errors", async ({
  page,
}) => {
  await catalog(page);
  const requests: ImportRequest[] = [];
  const committed = new Set<string>();
  await page.route("**/api/records/import", async (r) => {
    const body = r.request().postDataJSON() as ImportRequest;
    requests.push(body);
    expect(body.rows.length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(r.request().postData() ?? "")).toBeLessThanOrEqual(
      900 * 1024,
    );
    const result = importResult(body);
    for (const row of result.rows)
      if (row.record_id) {
        expect(committed.has(row.record_id)).toBe(false);
        committed.add(row.record_id);
      }
    await r.fulfill({
      json: result,
      headers: { "Cache-Control": "private, no-store" },
    });
  });
  await upload(
    page,
    `Title,Quantity\r\n${Array.from({ length: 205 }, (_, i) => (i === 0 ? '"Pump, north\nline",1' : `Job ${i + 1},${i === 102 ? "bad" : 2}`)).join("\r\n")}\r\n`,
  );
  await page
    .getByRole("checkbox", { name: "Use default for Enabled", exact: true })
    .check();
  await page.getByRole("checkbox", { name: "Enabled", exact: true }).check();
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(
    page.getByText("204 valid rows · 1 invalid row", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Row 104: Integer must be a whole base-10 number", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Validated import rows" }),
  ).toContainText("Pump, north");
  expect(committed.size).toBe(0);
  expect(
    requests.filter((r) => r.mode === "preview").map((r) => r.rows.length),
  ).toEqual([100, 100, 5]);
  expect(requests[0].rows[0]).toEqual({
    row_number: 2,
    cells: ["Pump, north\nline", "1"],
  });
  expect(requests[0].defaults).toEqual({ [ENABLED]: true });
  await page
    .getByRole("button", { name: "Import 204 valid rows", exact: true })
    .click();
  await expect(
    page.getByText("204 records imported.", { exact: true }),
  ).toBeVisible();
  expect(committed.size).toBe(204);
  const imports = requests.filter((r) => r.mode === "import");
  expect(imports.map((r) => r.rows.length)).toEqual([100, 100, 4]);
  expect(imports.every((r) => r.schema_digest === DIGEST)).toBe(true);
  expect(imports.flatMap((r) => r.rows).some((r) => r.row_number === 104)).toBe(
    false,
  );
  await expect(
    page.getByRole("button", { name: /^Import \d+ valid rows$/ }),
  ).toBeDisabled();
});
test("Cancel stops future import batches while awaiting the committed current batch", async ({
  page,
}) => {
  await catalog(page);
  let held: Route | undefined;
  let submitted: ImportRequest | undefined;
  let imports = 0;
  await page.route("**/api/records/import", (r) => {
    const body = r.request().postDataJSON() as ImportRequest;
    if (body.mode === "preview") return r.fulfill({ json: importResult(body) });
    imports++;
    held = r;
    submitted = body;
  });
  await upload(
    page,
    `Title,Quantity\n${Array.from({ length: 101 }, (_, i) => `Job ${i},1`).join("\n")}`,
  );
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import 101 valid rows", exact: true })
    .click();
  await expect.poll(() => imports).toBe(1);
  await page
    .getByRole("button", { name: "Cancel import", exact: true })
    .click();
  await expect(
    page.getByText("Stopping after the current batch…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview import", exact: true }),
  ).toBeDisabled();
  await held?.fulfill({ json: importResult(submitted!) });
  await expect(
    page.getByText(
      "100 records imported. Import stopped; confirmed records remain.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(imports).toBe(1);
  await page
    .getByRole("button", { name: "Import 1 valid rows", exact: true })
    .click();
  await expect.poll(() => imports).toBe(2);
  expect(submitted?.rows.map((r) => r.row_number)).toEqual([102]);
  await held?.fulfill({ json: importResult(submitted!) });
  await expect(
    page.getByText("101 records imported.", { exact: true }),
  ).toBeVisible();
});
test("Unconfirmed import outcomes stop without retry or duplicate submission", async ({
  page,
}) => {
  await catalog(page);
  let imports = 0;
  await page.route("**/api/records/import", (r) => {
    const body = r.request().postDataJSON() as ImportRequest;
    if (body.mode === "preview") return r.fulfill({ json: importResult(body) });
    imports++;
    return r.fulfill({ json: { ...importResult(body), created_count: 0 } });
  });
  await upload(page, "Title,Quantity\nPump,1");
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import 1 valid rows", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "unconfirmed",
  );
  await expect(
    page.getByRole("button", { name: /^Import \d+ valid rows$/ }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Preview import", exact: true }),
  ).toBeDisabled();
  expect(imports).toBe(1);
});
test("Schema drift and oversized UTF-8 rows retain the draft without writes", async ({
  page,
}) => {
  await catalog(page);
  let previews = 0;
  let imports = 0;
  await page.route("**/api/records/import", (r) => {
    const body = r.request().postDataJSON() as ImportRequest;
    if (body.mode === "preview") {
      previews++;
      return r.fulfill({ json: importResult(body) });
    }
    imports++;
    return r.fulfill({
      status: 409,
      json: {
        detail: {
          code: "schema_changed",
          message: "Module schema changed; preview again",
        },
      },
    });
  });
  await upload(page, "Title,Quantity\nPump,1");
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import 1 valid rows", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "preview again",
  );
  await expect(
    page.getByLabel("Map column 1 · Title", { exact: true }),
  ).toHaveValue(TITLE);
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect.poll(() => previews).toBe(2);
  expect(imports).toBe(1);
  await page.getByLabel("CSV file", { exact: true }).setInputFiles({
    name: "large.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`Title,Quantity\n${"é".repeat(470000)},1`),
  });
  await page
    .getByLabel("Map column 1 · Title", { exact: true })
    .selectOption(TITLE);
  await page
    .getByLabel("Map column 2 · Quantity", { exact: true })
    .selectOption(QUANTITY);
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "900 KiB",
  );
  expect(previews).toBe(2);
});
test("Export sends the saved-view query and downloads the complete server CSV", async ({
  page,
}) => {
  await catalog(page);
  const requests: unknown[] = [];
  const csv =
    "Record ID,Title\r\n" +
    Array.from(
      { length: 13 },
      (_, i) => `${uuid(i + 1)},${i === 0 ? "' =SUM(A1:A2)" : `Job ${i}`}\r\n`,
    ).join("");
  await page.route("**/api/records/export", (r) => {
    const body = r.request().postDataJSON();
    requests.push(body);
    return r.fulfill({
      // The accepted server contract omits Record ID unless explicitly requested.
      body: body.include_record_id === true ? csv : "Title\r\nJob 1\r\n",
      contentType: "text/csv; charset=utf-8",
      headers: {
        "Content-Disposition": 'attachment; filename="records.csv"',
        "Cache-Control": "no-store",
      },
    });
  });
  await page.goto("/platform?section=import-export");
  await page.getByLabel("Export module", { exact: true }).selectOption(MODULE);
  await page.getByLabel("Saved view", { exact: true }).selectOption(VIEW);
  await page
    .getByRole("button", { name: "Preview export", exact: true })
    .click();
  await expect(
    page.getByText("13 records ready · showing the first 10.", { exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([
    { module_id: MODULE, definition, include_record_id: true },
  ]);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("records.csv");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString("utf8")).toBe(csv);
  expect(requests).toHaveLength(1);
});
test("CSV input rejects invalid UTF-8, row limits and widths while accepting one-column CSV", async ({
  page,
}) => {
  await catalog(page);
  let requests = 0;
  await page.route("**/api/records/import", (route) => {
    requests++;
    return route.fulfill({
      json: importResult(route.request().postDataJSON() as ImportRequest),
    });
  });
  await page.goto("/platform?section=import-export");
  await page.getByLabel("Import module", { exact: true }).selectOption(MODULE);
  const file = page.getByLabel("CSV file", { exact: true });
  for (const [buffer, message] of [
    [Buffer.from([84, 105, 116, 108, 101, 10, 255]), "UTF-8"],
    [Buffer.from(`Title,Quantity\n${"Pump,1\n".repeat(10001)}`), "10,000"],
    [Buffer.from("Title,Quantity\nPump,1,extra"), "Row 2 must have 2 cells"],
    [Buffer.alloc(8 * 1024 * 1024 + 1, 65), "8 MB"],
  ] as const) {
    await file.setInputFiles({
      name: "invalid.csv",
      mimeType: "text/csv",
      buffer,
    });
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      message,
    );
    await expect(
      page.getByRole("button", { name: "Preview import", exact: true }),
    ).toBeDisabled();
  }
  expect(requests).toBe(0);
  await file.setInputFiles({
    name: "one-column.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Title\r\nPump\r\n"),
  });
  await expect(
    page.getByLabel("Map column 1 · Title", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Map column 1 · Title", { exact: true })
    .selectOption(TITLE);
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(
    page.getByText("1 valid rows · 0 invalid rows", { exact: true }),
  ).toBeVisible();
  expect(requests).toBe(1);
  await page.getByLabel("Import module", { exact: true }).selectOption("");
  await expect(page.getByLabel("CSV file", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("table", { name: "Validated import rows" }),
  ).toHaveCount(0);
});

test("UTF-8 JSON byte budget splits batches even with fewer than 100 rows", async ({
  page,
}) => {
  await catalog(page);
  const requests: ImportRequest[] = [];
  await page.route("**/api/records/import", (route) => {
    const body = route.request().postDataJSON() as ImportRequest;
    requests.push(body);
    expect(
      Buffer.byteLength(route.request().postData() ?? ""),
    ).toBeLessThanOrEqual(900 * 1024);
    return route.fulfill({ json: importResult(body) });
  });
  await upload(
    page,
    `Title,Quantity\n${"é".repeat(250000)},1\n${"é".repeat(250000)},2`,
  );
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(
    page.getByText("2 valid rows · 0 invalid rows", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Import 2 valid rows", exact: true })
    .click();
  await expect(
    page.getByText("2 records imported.", { exact: true }),
  ).toBeVisible();
  expect(
    requests.map((body) => [body.mode, body.rows.map((row) => row.row_number)]),
  ).toEqual([
    ["preview", [2]],
    ["preview", [3]],
    ["import", [2]],
    ["import", [3]],
  ]);
});

test("Leaving waits for the current import receipt and never starts a later batch", async ({
  page,
}) => {
  await catalog(page);
  let held: Route | undefined;
  let submitted: ImportRequest | undefined;
  let writes = 0;
  await page.route("**/api/records/import", (route) => {
    const body = route.request().postDataJSON() as ImportRequest;
    if (body.mode === "preview")
      return route.fulfill({ json: importResult(body) });
    writes++;
    held = route;
    submitted = body;
  });
  await upload(page, `Title,Quantity\n${"Pump,1\n".repeat(101)}`);
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import 101 valid rows", exact: true })
    .click();
  await expect.poll(() => writes).toBe(1);
  await page.getByRole("link", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Stop import and leave?" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Stop and leave", exact: true })
    .click();
  await expect(page).toHaveURL(/section=import-export/);
  await held?.fulfill({ json: importResult(submitted!) });
  await expect(page).toHaveURL(/section=search/);
  expect(writes).toBe(1);
});

for (const failure of ["lost response", "unconfirmed 503"] as const) {
  test(`Import ${failure} stops without retry`, async ({ page }) => {
    await catalog(page);
    let writes = 0;
    await page.route("**/api/records/import", (route) => {
      const body = route.request().postDataJSON() as ImportRequest;
      if (body.mode === "preview")
        return route.fulfill({ json: importResult(body) });
      writes++;
      return failure === "lost response"
        ? route.abort("connectionreset")
        : route.fulfill({
            status: 503,
            json: {
              detail: {
                code: "record_import_unconfirmed",
                message: "Import outcome could not be confirmed",
              },
            },
          });
    });
    await upload(page, "Title,Quantity\nPump,1");
    await page
      .getByRole("button", { name: "Preview import", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Import 1 valid rows", exact: true })
      .click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "unconfirmed",
    );
    await expect(
      page.getByRole("button", { name: "Preview import", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: /^Import \d+ valid rows$/ }),
    ).toBeDisabled();
    expect(writes).toBe(1);
  });
}

test("Search ignores old replies, hides denial and recovers with explicit retry", async ({
  page,
}) => {
  const releaseOld: (() => void)[] = [];
  let denied = true;
  await page.route("**/api/search?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("search") === "old")
      await new Promise<void>((resolve) => {
        releaseOld.push(resolve);
      });
    if (params.get("kind") !== "record")
      return route.fulfill({ json: list([], 0, 0, 10) });
    if (params.get("search") === "fresh" && denied)
      return route.fulfill({
        status: 403,
        json: { detail: "Permission denied" },
      });
    return route.fulfill({
      json: list(
        [
          {
            kind: "record",
            id: uuid(1),
            title: `${params.get("search")} result`,
            context_label: "Maintenance",
            module_id: MODULE,
            board_id: null,
            can_open: true,
          },
        ],
        1,
        0,
        10,
      ),
    });
  });
  await page.goto("/platform?section=search");
  const input = page.getByRole("searchbox", { name: "Search workspace" });
  await input.fill("old");
  await expect.poll(() => releaseOld.length).toBeGreaterThan(0);
  await input.fill("fresh");
  const records = page.getByRole("region", { name: "Records search results" });
  await expect(records.getByRole("alert")).toBeVisible();
  releaseOld.forEach((release) => release());
  await expect(page.getByText("old result", { exact: true })).toHaveCount(0);
  denied = false;
  await records.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    records.getByRole("link", { name: /fresh result/ }),
  ).toBeVisible();
});

test("Export failures and cancelled late replies never produce a download", async ({
  page,
}) => {
  await catalog(page);
  let request = 0;
  let held: Route | undefined;
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.route("**/api/records/export", (route) => {
    request++;
    if (request === 1)
      return route.fulfill({
        status: 422,
        json: {
          detail: {
            code: "export_limit_exceeded",
            message: "Export exceeds 10,000 rows or 8 MiB; narrow the filters",
          },
        },
      });
    held = route;
  });
  await page.goto("/platform?section=import-export");
  await page.getByLabel("Export module", { exact: true }).selectOption(MODULE);
  await page
    .getByRole("button", { name: "Preview export", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "choose a narrower saved view",
  );
  await page
    .getByRole("button", { name: "Preview export", exact: true })
    .click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page
    .getByRole("button", { name: "Cancel export", exact: true })
    .click();
  await held?.fulfill({
    contentType: "text/csv",
    body: `Record ID,Title,Quantity,Enabled\r\n${uuid(1)},Pump,1,true\r\n`,
  });
  await expect(
    page.getByRole("button", { name: "Download CSV", exact: true }),
  ).toHaveCount(0);
  expect(downloads).toBe(0);
});

test("Import and export role refusals retain drafts and never report creation or download", async ({
  page,
}) => {
  await catalog(page);
  let imports = 0;
  let previews = 0;
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.route("**/api/records/import", (route) => {
    const body = route.request().postDataJSON() as ImportRequest;
    if (body.mode === "preview") {
      previews++;
      return route.fulfill({ json: importResult(body) });
    }
    imports++;
    return route.fulfill({
      status: 403,
      json: { detail: "Administrator permission required" },
    });
  });
  await page.route("**/api/records/export", (route) =>
    route.fulfill({
      status: 403,
      json: { detail: "Administrator permission required" },
    }),
  );
  await upload(page, "Title,Quantity\nPump,1");
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import 1 valid rows", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Administrator permission is required to import",
  );
  await expect(
    page.getByLabel("Map column 1 · Title", { exact: true }),
  ).toHaveValue(TITLE);
  await expect(
    page.getByText("1 records imported.", { exact: true }),
  ).toHaveCount(0);
  expect(imports).toBe(1);
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(
    page.getByRole("table", { name: "Validated import rows" }),
  ).toBeVisible();
  expect(previews).toBe(2);
  expect(imports).toBe(1);
  await page.getByLabel("Export module", { exact: true }).selectOption(MODULE);
  await page
    .getByRole("button", { name: "Preview export", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Administrator permission is required to export",
  );
  await expect(
    page.getByRole("button", { name: "Download CSV", exact: true }),
  ).toHaveCount(0);
  expect(downloads).toBe(0);
});

test("Administrator people results open the existing People destination and empty groups stay truthful", async ({
  page,
}) => {
  await page.route("**/api/search?*", (route) => {
    const kind = new URL(route.request().url()).searchParams.get("kind");
    return route.fulfill({
      json: list(
        kind === "person"
          ? [
              {
                kind: "person",
                id: uuid(1),
                title: "Pump operator",
                context_label: "operator",
                module_id: null,
                board_id: null,
                can_open: true,
              },
            ]
          : [],
        kind === "person" ? 1 : 0,
        0,
        10,
      ),
    });
  });
  await page.goto("/platform?section=search");
  await page
    .getByRole("searchbox", { name: "Search workspace" })
    .fill("operator");
  await expect(
    page.getByRole("link", { name: "Open Pump operator", exact: true }),
  ).toHaveAttribute("href", `/access?view=people&user=${uuid(1)}`);
  await expect(
    page.getByRole("region", { name: "Records search results" }),
  ).toContainText("No matching records.");
});

async function queueLeaveDuringSecondBatch(page: Page) {
  await catalog(page);
  // Visit the queued destination in this document first, so the negative
  // assertions cannot race an uncached Next route fetch.
  await page.goto("/platform?section=search");
  await page
    .getByRole("link", { name: "Import & export", exact: true })
    .click();
  const pending = {
    writes: 0,
    held: null as Route | null,
    submitted: null as ImportRequest | null,
  };
  await page.route("**/api/records/import", (route) => {
    const body = route.request().postDataJSON() as ImportRequest;
    if (body.mode === "preview")
      return route.fulfill({ json: importResult(body) });
    pending.writes++;
    if (pending.writes === 1)
      return route.fulfill({ json: importResult(body) });
    pending.held = route;
    pending.submitted = body;
  });
  await selectCsv(page, `Title,Quantity\n${"Pump,1\n".repeat(301)}`);
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import 301 valid rows", exact: true })
    .click();
  await expect.poll(() => pending.writes).toBe(2);
  await expect(
    page.getByText("Confirmed record IDs (100)", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Stop import and leave?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Stop and leave", exact: true })
    .click();
  await expect(
    page.getByText("Stopping after the current batch…", { exact: true }),
  ).toBeVisible();
  return pending;
}

for (const outcome of [
  "unconfirmed 503",
  "malformed receipt",
  "lost response",
] as const) {
  test(`Queued leave with ${outcome} keeps warning and confirmed receipts visible`, async ({
    page,
  }) => {
    const pending = await queueLeaveDuringSecondBatch(page);
    if (outcome === "lost response")
      await pending.held!.abort("connectionreset");
    else if (outcome === "malformed receipt")
      await pending.held!.fulfill({
        json: { ...importResult(pending.submitted!), created_count: 0 },
      });
    else
      await pending.held!.fulfill({
        status: 503,
        json: {
          detail: {
            code: "record_import_unconfirmed",
            message: "Import outcome could not be confirmed",
          },
        },
      });
    const warning = page.getByRole("main").getByRole("alert");
    await expect(warning).toContainText("unconfirmed");
    await expect(warning).toContainText("100 records are confirmed");
    await expect(
      page.getByText("Stopping after the current batch…", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Confirmed record IDs (100)", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/section=import-export/);
    await expect(
      page.getByRole("button", { name: "Preview import", exact: true }),
    ).toBeDisabled();
    expect(pending.writes).toBe(2);
    await page.getByRole("link", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/section=search/);
    expect(pending.writes).toBe(2);
  });
}

for (const dismissal of ["Stay", "Escape", "outside"] as const) {
  test(`Queued leave dismissed by ${dismissal} still stops future batches and stays after receipt`, async ({
    page,
  }) => {
    const pending = await queueLeaveDuringSecondBatch(page);
    const dialog = page.getByRole("dialog", {
      name: "Stop import and leave?",
      exact: true,
    });
    if (dismissal === "Stay") {
      const stay = dialog.getByRole("button", { name: "Stay", exact: true });
      await expect(stay).toBeEnabled();
      await stay.click();
    } else if (dismissal === "Escape") await page.keyboard.press("Escape");
    else
      await page
        .getByTestId("dialog-backdrop")
        .click({ position: { x: 2, y: 2 } });
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/section=import-export/);
    await pending.held!.fulfill({ json: importResult(pending.submitted!) });
    await expect(
      page.getByText(
        "200 records imported. Import stopped; confirmed records remain.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Stopping after the current batch…", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Confirmed record IDs (200)", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/section=import-export/);
    expect(pending.writes).toBe(2);
  });
}

test("Queued leave positive control resumes after the same held second receipt", async ({
  page,
}) => {
  const pending = await queueLeaveDuringSecondBatch(page);
  await pending.held!.fulfill({ json: importResult(pending.submitted!) });
  await expect(page).toHaveURL(/section=search/);
  expect(pending.writes).toBe(2);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`Import and export previews remain contained at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await catalog(page);
    let writes = 0;
    await page.route("**/api/records/import", (route) => {
      const body = route.request().postDataJSON() as ImportRequest;
      if (body.mode === "import") writes++;
      return route.fulfill({ json: importResult(body) });
    });
    const title =
      "PreventiveMaintenanceInspectionForPrimaryCirculationAssembly";
    await page.route("**/api/records/export", (route) =>
      route.fulfill({
        body: `Record ID,Title\r\n${uuid(1)},${title}\r\n${uuid(2)},Reserve pump\r\n`,
        contentType: "text/csv; charset=utf-8",
        headers: {
          "Content-Disposition": 'attachment; filename="records.csv"',
          "Cache-Control": "no-store",
        },
      }),
    );

    async function containedPage(stage: string) {
      const geometry = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        windowX: window.scrollX,
      }));
      console.log(`${stage} ${viewport.width}x${viewport.height}`, geometry);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
      expect(geometry.windowX).toBe(0);
    }
    async function reachable(control: Locator) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
      await containedPage("Reachable action");
    }
    async function localTableScroll(table: Locator) {
      await table.scrollIntoViewIfNeeded();
      const geometry = await table.evaluate((element) => {
        let scroller = element.parentElement;
        while (scroller) {
          const overflow = getComputedStyle(scroller).overflowX;
          if (
            ["auto", "scroll"].includes(overflow) &&
            scroller.scrollWidth > scroller.clientWidth + 1
          )
            break;
          scroller = scroller.parentElement;
        }
        if (!scroller) return null;
        const bounds = scroller.getBoundingClientRect();
        scroller.scrollLeft = 0;
        scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
        return {
          left: bounds.left,
          right: bounds.right,
          client: scroller.clientWidth,
          scroll: scroller.scrollWidth,
          scrollLeft: scroller.scrollLeft,
          windowX: window.scrollX,
        };
      });
      console.log(
        `Local preview scroll ${viewport.width}x${viewport.height}`,
        geometry,
      );
      expect(geometry).not.toBeNull();
      expect(geometry!.scroll).toBeGreaterThan(geometry!.client);
      expect(geometry!.scrollLeft).toBeGreaterThan(0);
      expect(geometry!.left).toBeGreaterThanOrEqual(0);
      expect(geometry!.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(geometry!.windowX).toBe(0);
      await containedPage("Scrolled preview");
    }

    await upload(page, `Title,Quantity\n${title},12\nReserve pump,2`);
    await containedPage("Column mapping");
    await reachable(page.getByLabel("Map column 1 · Title", { exact: true }));
    const importHeading = await page
      .getByRole("heading", { name: "Import records", exact: true })
      .boundingBox();
    const exportHeading = await page
      .getByRole("heading", { name: "Export records", exact: true })
      .boundingBox();
    expect(importHeading).not.toBeNull();
    expect(exportHeading).not.toBeNull();
    if (viewport.width === 1440) {
      expect(Math.abs(importHeading!.y - exportHeading!.y)).toBeLessThanOrEqual(
        1,
      );
      expect(exportHeading!.x).toBeGreaterThan(
        importHeading!.x + importHeading!.width,
      );
    } else
      expect(exportHeading!.y).toBeGreaterThan(
        importHeading!.y + importHeading!.height,
      );

    const previewImport = page.getByRole("button", {
      name: "Preview import",
      exact: true,
    });
    await reachable(previewImport);
    await previewImport.click();
    const importTable = page.getByRole("table", {
      name: "Validated import rows",
    });
    await expect(importTable).toContainText(title);
    await containedPage("Import preview");
    await localTableScroll(importTable);
    await reachable(
      page.getByRole("button", { name: "Import 2 valid rows", exact: true }),
    );

    await page
      .getByLabel("Export module", { exact: true })
      .selectOption(MODULE);
    await page.getByLabel("Saved view", { exact: true }).selectOption(VIEW);
    const previewExport = page.getByRole("button", {
      name: "Preview export",
      exact: true,
    });
    await reachable(previewExport);
    await previewExport.click();
    await expect(
      page.getByText("2 records ready · showing the first 2.", { exact: true }),
    ).toBeVisible();
    const exportTable = page
      .getByRole("main")
      .getByRole("table")
      .filter({
        has: page.getByRole("columnheader", { name: "Record ID", exact: true }),
      });
    await containedPage("Export preview");
    await localTableScroll(exportTable);
    const download = page.getByRole("button", {
      name: "Download CSV",
      exact: true,
    });
    await reachable(download);
    const downloading = page.waitForEvent("download");
    await download.click();
    expect((await downloading).suggestedFilename()).toBe("records.csv");
    const cancelExport = page.getByRole("button", {
      name: "Cancel export",
      exact: true,
    });
    await reachable(cancelExport);
    await cancelExport.click();
    await expect(exportTable).toHaveCount(0);
    const cancelImport = page.getByRole("button", {
      name: "Cancel import",
      exact: true,
    });
    await reachable(cancelImport);
    await cancelImport.click();
    await expect(importTable).toHaveCount(0);
    expect(writes).toBe(0);
    if (viewport.width === 390) {
      const navigation = page.getByRole("button", {
        name: "Open navigation",
        exact: true,
      });
      await reachable(navigation);
      await navigation.click();
    }
    await page.getByRole("link", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/section=search/);
    await containedPage("After leaving");
  });
}
