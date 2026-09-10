import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fixture, signIn } from "./fixture";

const Entity = z.object({ id: z.uuid() });
const Profile = z.object({
  display_name: z.string(),
  revision: z.number(),
  logo_file_id: z.uuid().nullable(),
  timezone: z.string(),
  locale: z.string(),
});
const Definition = {
  version: 1,
  columns: [] as { field_id: string; expected_type: string }[],
  filters: [] as {
    field_id: string;
    expected_type: string;
    operator: string;
    value: string;
  }[],
  sort: [],
  deleted: "exclude",
  search: null,
};

function assertDisposableMutation() {
  if (
    process.env.E2E_ALLOW_MUTATIONS !== "true" ||
    fixture.baseURL !== "http://localhost:3008" ||
    fixture.authURL !== "http://127.0.0.1:55321" ||
    fixture.runId !== process.env.OPENSLATE_FULLSTACK_RUN_ID
  )
    throw new Error("Disposable mutation guard failed");
}

// A real decodable PNG, with zero trailing bytes to exercise the exact transfer
// ceiling. The current document validator preserves trailing image bytes.
function png() {
  function chunk(name: string, data: Buffer) {
    const payload = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 20, 40, 60]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function maximumPng() {
  const maximum = Buffer.alloc(25 * 1024 * 1024);
  png().copy(maximum);
  return maximum;
}

async function post(page: Page, path: string, data: unknown) {
  assertDisposableMutation();
  return page.request.post(`/bff${path}`, {
    headers: { Origin: fixture.baseURL },
    data,
  });
}

async function create(page: Page, path: string, data: unknown) {
  const response = await post(page, path, data);
  expect(response.ok()).toBe(true);
  return Entity.parse(await response.json());
}

test("workspace revisions, saved queries, CSV authority and automatic private scanning survive the real stack", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  await signIn(page, fixture.admin);
  const initialResponse = await page.request.get("/bff/workspace");
  expect(initialResponse.status()).toBe(200);
  const initial = Profile.parse(await initialResponse.json());
  const displayName = `Workspace ${fixture.runId}`;
  let profileChanged = false;
  try {
    await page.goto("/settings/workspace");
    await page.getByLabel("Display name", { exact: true }).fill(displayName);
    await page
      .getByLabel("Timezone (IANA)", { exact: true })
      .fill("Asia/Manila");
    await page.getByLabel("Locale", { exact: true }).fill("en-gb");
    const saved = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/bff/workspace" &&
        r.request().method() === "PATCH",
    );
    assertDisposableMutation();
    await page
      .getByRole("button", { name: "Save workspace", exact: true })
      .click();
    expect((await saved).status()).toBe(200);
    profileChanged = true;
    await page.reload();
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      displayName,
    );
    await expect(
      page.getByLabel("Timezone (IANA)", { exact: true }),
    ).toHaveValue("Asia/Manila");
    await expect(page.getByLabel("Locale", { exact: true })).toHaveValue(
      "en-GB",
    );
    assertDisposableMutation();
    const stale = await page.request.patch("/bff/workspace", {
      headers: { Origin: fixture.baseURL },
      data: { revision: initial.revision, display_name: "Stale overwrite" },
    });
    expect(stale.status()).toBe(409);
    const unchanged = await page.request.get("/bff/workspace");
    expect(Profile.parse(await unchanged.json()).display_name).toBe(
      displayName,
    );

    const department = await create(page, "/departments", {
      department_name: `Queries ${fixture.runId}`,
    });
    const recordModule = await create(page, "/modules", {
      department_id: department.id,
      module_name: "Documents",
    });
    const field = await create(page, "/fields", {
      module_id: recordModule.id,
      name: "Title",
      type: "text",
      position: 0,
    });
    const amount = await create(page, "/fields", {
      module_id: recordModule.id,
      name: "Amount",
      type: "number",
      position: 1,
    });
    const quantity = await create(page, "/fields", {
      module_id: recordModule.id,
      name: "Quantity",
      type: "int",
      position: 2,
    });
    expect(
      (await post(page, `/modules/${recordModule.id}/schema/accept`, {})).ok(),
    ).toBe(true);
    const matching = await create(page, "/records", {
      module_id: recordModule.id,
      data: { [field.id]: "Included", [amount.id]: 10.5, [quantity.id]: 7 },
    });
    await create(page, "/records", {
      module_id: recordModule.id,
      data: { [field.id]: "Excluded", [amount.id]: 100, [quantity.id]: 3 },
    });
    const definition = {
      ...Definition,
      columns: [{ field_id: field.id, expected_type: "text" }],
      filters: [
        {
          field_id: field.id,
          expected_type: "text",
          operator: "eq",
          value: "Included",
        },
      ],
    };
    const query = {
      module_id: recordModule.id,
      definition,
      limit: 25,
      offset: 0,
    };
    const queried = await post(page, "/records/query", query);
    expect(queried.status()).toBe(200);
    const rows = z
      .object({ items: z.array(Entity) })
      .parse(await queried.json());
    expect(rows.items.map((row) => row.id)).toEqual([matching.id]);
    const privateView = await create(page, "/views", {
      module_id: recordModule.id,
      name: `Personal ${fixture.runId}`,
      visibility: "private",
      definition,
    });
    const sharedView = await create(page, "/views", {
      module_id: recordModule.id,
      name: `Shared ${fixture.runId}`,
      visibility: "workspace",
      definition,
    });
    const published = await page.request.get(`/bff/views/${sharedView.id}`);
    expect(published.status()).toBe(200);
    expect(
      z
        .object({ visibility: z.literal("workspace") })
        .parse(await published.json()).visibility,
    ).toBe("workspace");
    await page.goto(`/modules/${recordModule.id}/records`);
    await page
      .getByLabel("Saved view", { exact: true })
      .selectOption(privateView.id);
    await expect(page.getByText("Included", { exact: true })).toBeVisible();
    await expect(page.getByText("Excluded", { exact: true })).toHaveCount(0);
    await page
      .getByText("Filters, sorting and columns", { exact: true })
      .click();
    for (const filter of [
      { id: amount.id, value: "10.5", expected: 10.5, count: 2 },
      { id: quantity.id, value: "7", expected: 7, count: 3 },
    ]) {
      await page
        .getByLabel("Filter field", { exact: true })
        .selectOption(filter.id);
      await page.getByLabel("Filter value", { exact: true }).fill(filter.value);
      const numericQuery = page.waitForResponse((response) => {
        if (
          new URL(response.url()).pathname !== "/bff/records/query" ||
          response.request().method() !== "POST"
        )
          return false;
        const body: unknown = response.request().postDataJSON();
        const parsed = z
          .object({ definition: z.object({ filters: z.array(z.unknown()) }) })
          .safeParse(body);
        return (
          parsed.success &&
          parsed.data.definition.filters.length === filter.count
        );
      });
      await page
        .getByRole("button", { name: "Add filter", exact: true })
        .click();
      const response = await numericQuery;
      expect(response.status()).toBe(200);
      const sent = z
        .object({
          definition: z.object({
            filters: z.array(
              z.object({ field_id: z.string(), value: z.unknown() }),
            ),
          }),
        })
        .parse(response.request().postDataJSON());
      expect(
        sent.definition.filters.find((item) => item.field_id === filter.id)
          ?.value,
      ).toBe(filter.expected);
      const filteredRows = z
        .object({ items: z.array(Entity) })
        .parse(await response.json());
      expect(filteredRows.items.map((row) => row.id)).toEqual([matching.id]);
    }
    const exported = await post(page, "/records/export", query);
    expect(exported.status()).toBe(200);
    expect(exported.headers()["content-type"]).toContain("text/csv");
    expect((await exported.text()).trim().split(/\r?\n/)).toEqual([
      "Record ID,Title",
      `${matching.id},Included`,
    ]);

    const memberContext = await browser.newContext({
      baseURL: fixture.baseURL,
    });
    try {
      const member = await memberContext.newPage();
      await signIn(member, fixture.member);
      expect((await post(member, "/records/export", query)).status()).toBe(403);
    } finally {
      await memberContext.close();
    }

    // The uploading browser is closed immediately after the API has committed
    // pending_scan. No manual scan request or browser polling starts the work.
    const bytes = maximumPng();
    const uploaderContext = await browser.newContext({
      baseURL: fixture.baseURL,
    });
    let fileId = "";
    try {
      const uploader = await uploaderContext.newPage();
      await signIn(uploader, fixture.admin);
      const reserved = await create(uploader, "/files", {
        purpose: "record_attachment",
        record_id: matching.id,
        filename: `transfer-${fixture.runId}.png`,
        expected_size: bytes.length,
      });
      fileId = reserved.id;
      assertDisposableMutation();
      const uploaded = await uploader.request.put(
        `/bff/files/${fileId}/content`,
        {
          headers: {
            Origin: fixture.baseURL,
            "Content-Type": "application/octet-stream",
          },
          data: bytes,
          timeout: 125_000,
        },
      );
      expect(uploaded.status()).toBe(200);
      expect(
        z
          .object({ state: z.literal("pending_scan"), actual_size: z.number() })
          .parse(await uploaded.json()).actual_size,
      ).toBe(25 * 1024 * 1024);
    } finally {
      await uploaderContext.close();
    }
    await expect
      .poll(
        async () => {
          const current = await page.request.get(`/bff/files/${fileId}`);
          expect(current.status()).toBe(200);
          return z.object({ state: z.string() }).parse(await current.json())
            .state;
        },
        { timeout: 90_000, intervals: [500, 1000, 2000] },
      )
      .toBe("ready");
    const downloaded = await page.request.get(`/bff/files/${fileId}/content`, {
      timeout: 125_000,
    });
    expect(downloaded.status()).toBe(200);
    expect(downloaded.headers()["cache-control"]).toBe("no-store");
    const received = await downloaded.body();
    expect(received.length).toBe(bytes.length);
    expect(createHash("sha256").update(received).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    await page.goto(`/modules/${recordModule.id}/records/${matching.id}/edit`);
    await expect(
      page.getByRole("button", {
        name: `Download transfer-${fixture.runId}.png`,
        exact: true,
      }),
    ).toBeVisible();

    // A clean logo becomes an explicit candidate; activation remains an
    // administrator decision and must follow the actual worker verdict.
    await page.goto("/settings/workspace");
    await page.getByLabel("Choose logo", { exact: true }).setInputFiles({
      name: `logo-${fixture.runId}.png`,
      mimeType: "image/png",
      buffer: png(),
    });
    const logoUpload = page.waitForResponse(
      (response) =>
        /\/bff\/files\/[^/]+\/content$/.test(
          new URL(response.url()).pathname,
        ) && response.request().method() === "PUT",
    );
    assertDisposableMutation();
    await page
      .getByRole("button", { name: "Upload and scan", exact: true })
      .click();
    expect((await logoUpload).status()).toBe(200);
    await expect(
      page.getByRole("button", { name: "Use this logo", exact: true }),
    ).toBeEnabled({ timeout: 90_000 });
    const activated = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/bff/workspace" &&
        response.request().method() === "PATCH",
    );
    assertDisposableMutation();
    await page
      .getByRole("button", { name: "Use this logo", exact: true })
      .click();
    expect((await activated).status()).toBe(200);
    const logoResponse = await page.request.get("/bff/workspace/logo");
    const diagnostic: Record<string, string | number> = {
      stage: "activated_logo_download",
      status: logoResponse.status(),
    };
    if (logoResponse.status() !== 200) {
      const payload: unknown = await logoResponse.json().catch(() => null);
      const parsed = z
        .object({ detail: z.object({ code: z.string() }) })
        .safeParse(payload);
      const code = parsed.success ? parsed.data.detail.code : null;
      diagnostic.code =
        code &&
        [
          "storage_unavailable",
          "workspace_unavailable",
          "logo_not_ready",
          "logo_not_found",
          "file_busy",
          "files_busy",
          "file_unavailable",
        ].includes(code)
          ? code
          : "unrecognized_or_absent";
      const detail = z.object({ detail: z.string() }).safeParse(payload);
      if (
        detail.success &&
        ["File capacity is busy", "Database unavailable"].includes(
          detail.data.detail,
        )
      )
        diagnostic.detail = detail.data.detail;
      for (const key of ["x-request-id", "retry-after"]) {
        const value = logoResponse.headers()[key];
        if (
          value &&
          (key === "retry-after" ? /^\d{1,6}$/ : /^[a-f0-9-]{16,64}$/i).test(
            value,
          )
        )
          diagnostic[key] = value;
      }
    }
    writeFileSync(
      test.info().outputPath("logo-download-diagnostic.json"),
      JSON.stringify(diagnostic),
    );
    expect(logoResponse.status(), JSON.stringify(diagnostic)).toBe(200);
    expect(logoResponse.headers()["content-type"]).toContain("image/png");
    expect((await logoResponse.body()).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  } finally {
    if (profileChanged) {
      const current = await page.request.get("/bff/workspace");
      expect(current.status()).toBe(200);
      const latest = Profile.parse(await current.json());
      assertDisposableMutation();
      const restored = await page.request.patch("/bff/workspace", {
        headers: { Origin: fixture.baseURL },
        data: {
          revision: latest.revision,
          display_name: initial.display_name,
          logo_file_id: initial.logo_file_id,
          timezone: initial.timezone,
          locale: initial.locale,
        },
      });
      expect(restored.status()).toBe(200);
    }
  }
});
