import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";

const LIBRARY_USER = "00000000-0000-4000-8000-000000000001";
const LIBRARY_OTHER_USER = "00000000-0000-4000-8000-000000000002";
const LIBRARY_DEPARTMENT = "61000000-0000-4000-8000-000000000001";
const LIBRARY_SECOND_DEPARTMENT = "61000000-0000-4000-8000-000000000002";
const LIBRARY_CLOSED_DEPARTMENT = "61000000-0000-4000-8000-000000000003";
const LIBRARY_MODULE_DEPARTMENT = "61000000-0000-4000-8000-000000000004";
const LIBRARY_MODULE = "62000000-0000-4000-8000-000000000001";
const libraryPdf = Buffer.from("%PDF-1.7\nLibrary guide\n");
const libraryUuid = (value: number) =>
  `63000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

type LibraryRole = "admin" | "member" | "guest";
type LibraryAccess = {
  department_id: string;
  module_id: string | null;
  level: "read" | "write" | "manage";
};
type LibraryFileWire = {
  id: string;
  purpose:
    | "library_document"
    | "record_attachment"
    | "board_attachment"
    | "workspace_logo";
  record_id: string | null;
  board_id: string | null;
  department_id: string | null;
  creator_id: string;
  filename: string;
  media_type: string | null;
  expected_size: number;
  actual_size: number | null;
  state:
    | "awaiting_upload"
    | "uploading"
    | "ready"
    | "rejected"
    | "deleting"
    | "purged";
  failure_code: string | null;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
};

function libraryDepartment(id: string, name: string, closed = false) {
  return {
    id,
    department_name: name,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    deleted_at: closed ? "2026-10-03T00:00:00Z" : null,
    is_deleted: closed,
    performed_by: LIBRARY_USER,
  };
}

function libraryFile(
  overrides: Partial<LibraryFileWire> = {},
): LibraryFileWire {
  return {
    id: libraryUuid(1),
    purpose: "library_document",
    record_id: null,
    board_id: null,
    department_id: LIBRARY_DEPARTMENT,
    creator_id: LIBRARY_USER,
    filename: "Safety guide.pdf",
    media_type: "application/pdf",
    expected_size: libraryPdf.length,
    actual_size: libraryPdf.length,
    state: "ready",
    failure_code: null,
    is_deleted: false,
    created_at: "2026-10-04T18:30:00Z",
    updated_at: "2026-10-04T18:30:00Z",
    ...overrides,
  };
}

function libraryPage<Item>(
  items: Item[],
  limit = 100,
  offset = 0,
  total = items.length,
) {
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

function libraryGate() {
  let release!: () => void;
  let started!: () => void;
  let finished!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  const entered = new Promise<void>((resolve) => (started = resolve));
  const completed = new Promise<void>((resolve) => (finished = resolve));
  return { wait, entered, completed, release, started, finished };
}
type LibraryGate = ReturnType<typeof libraryGate>;

async function installLibrary(
  page: Page,
  options: { role?: LibraryRole; access?: LibraryAccess[] } = {},
) {
  await installOpenViewEventSource(page);
  const state = {
    userId: LIBRARY_USER,
    role: options.role ?? "admin",
    access: options.access ?? [],
    theme: "light" as "light" | "dark",
    departments: [
      libraryDepartment(LIBRARY_DEPARTMENT, "Maintenance"),
      libraryDepartment(LIBRARY_SECOND_DEPARTMENT, "Operations"),
      libraryDepartment(LIBRARY_CLOSED_DEPARTMENT, "Records", true),
      libraryDepartment(LIBRARY_MODULE_DEPARTMENT, "Module only"),
    ],
    files: [
      libraryFile(),
      libraryFile({
        id: libraryUuid(2),
        creator_id: LIBRARY_OTHER_USER,
        created_at: "2026-10-02T08:00:00Z",
      }),
      libraryFile({
        id: libraryUuid(3),
        filename: "Archived handbook.pdf",
        is_deleted: true,
      }),
      libraryFile({
        id: libraryUuid(4),
        filename: "Operations guide.pdf",
        department_id: LIBRARY_SECOND_DEPARTMENT,
      }),
      libraryFile({
        id: libraryUuid(5),
        filename: "Closed department guide.pdf",
        department_id: LIBRARY_CLOSED_DEPARTMENT,
      }),
      libraryFile({
        id: libraryUuid(6),
        filename: "Closed archived guide.pdf",
        department_id: LIBRARY_CLOSED_DEPARTMENT,
        is_deleted: true,
      }),
    ],
    labels: { [LIBRARY_USER]: "Mara Santos" } as Record<string, string>,
    identityStatus: 200,
    departmentStatus: 200,
    listStatus: 200,
    readbackStatus: 200,
    readbackBroken: false,
    workspaceStatus: 200,
    archiveStatus: 200,
    reopenStatus: 200,
    downloadStatus: 200,
    downloadBroken: false,
    reserveBroken: false,
    listBroken: null as
      | "department"
      | "purpose"
      | "creator"
      | "pagination"
      | "continuation"
      | "duplicate"
      | null,
    uploadMode: "ready" as
      | "ready"
      | "ready-error"
      | "awaiting"
      | "uploading"
      | "rejected"
      | "purged"
      | "deleting"
      | "archived",
    uploadHold: null as LibraryGate | null,
    archiveHold: null as LibraryGate | null,
    downloadHold: null as LibraryGate | null,
    listHold: new Map<string, LibraryGate>(),
    detailHold: null as LibraryGate | null,
    calls: [] as { method: string; path: string; body: unknown }[],
    listReads: [] as {
      department: string | null;
      account: string;
      parameters: URLSearchParams;
    }[],
    catalogReads: [] as URLSearchParams[],
    directoryReads: [] as string[],
  };
  const failure = (route: Route, status: number) =>
    route.fulfill({
      status,
      json: { detail: "Private database detail must never be displayed" },
    });
  const level = (departmentId: string | null) => {
    if (state.role === "admin") return "manage";
    const entry = state.access.find(
      (access) =>
        access.department_id === departmentId && access.module_id === null,
    );
    return entry ? (state.role === "guest" ? "read" : entry.level) : null;
  };
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: state.userId,
        setup_required: false,
      },
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    state.identityStatus === 200
      ? route.fulfill({
          json: { id: state.userId, role: state.role, access: state.access },
        })
      : failure(route, state.identityStatus),
  );
  await page.route("**/api/auth/refresh", (route) => failure(route, 401));
  await page.route("**/api/workspace", (route) =>
    state.workspaceStatus === 200
      ? route.fulfill({
          json: {
            id: libraryUuid(900),
            display_name: "Library test workspace",
            legal_name: null,
            description: null,
            ...(state.role === "guest"
              ? {}
              : {
                  contact_email: null,
                  contact_phone: null,
                  postal_address: null,
                }),
            locale: "en-GB",
            timezone: "Asia/Manila",
            logo_file_id: null,
            mark: "RS",
            currency: "PHP",
            week_start: "monday",
            business_hours: "09:00–18:00",
            theme: "slate",
            revision: 1,
          },
        })
      : failure(route, state.workspaceStatus),
  );
  await page.route("**/api/users**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/preferences"))
      return route.fulfill({
        json: {
          user_id: path.split("/")[3],
          theme: state.theme,
          appearance: { motion: "system", keyboard_shortcuts: true },
        },
      });
    state.directoryReads.push(path);
    return failure(route, 403);
  });
  await page.route("**/api/departments?*", (route) => {
    const parameters = new URL(route.request().url()).searchParams;
    state.catalogReads.push(parameters);
    if (state.departmentStatus !== 200)
      return failure(route, state.departmentStatus);
    const limit = Number(parameters.get("limit"));
    const offset = Number(parameters.get("offset"));
    const visible = state.departments
      .filter(
        (department) =>
          (state.role === "admin" ||
            state.access.some(
              (access) => access.department_id === department.id,
            )) &&
          (parameters.get("deleted") === "include" || !department.is_deleted),
      )
      .sort((a, b) => a.department_name.localeCompare(b.department_name));
    return route.fulfill({
      json: libraryPage(
        visible.slice(offset, offset + limit),
        limit,
        offset,
        visible.length,
      ),
    });
  });
  await page.route("**/api/files**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const actor = state.userId;
    state.calls.push({
      method,
      path: url.pathname,
      body:
        method === "PUT"
          ? request.postDataBuffer()?.toString()
          : request.postData()
            ? request.postDataJSON()
            : null,
    });
    if (url.pathname === "/api/files" && method === "GET") {
      const departmentId = url.searchParams.get("department_id");
      state.listReads.push({
        department: departmentId,
        account: state.userId,
        parameters: url.searchParams,
      });
      if (!level(departmentId)) return failure(route, 404);
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const deleted = url.searchParams.get("deleted");
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const available = state.files
        .filter(
          (file) =>
            file.department_id === departmentId &&
            (deleted === "include" ||
              file.is_deleted === (deleted === "only")) &&
            file.filename.toLowerCase().includes(search),
        )
        .sort((a, b) => {
          const by = url.searchParams.get("sort_by");
          const compared =
            by === "size"
              ? (a.actual_size ?? a.expected_size) -
                (b.actual_size ?? b.expected_size)
              : by === "name"
                ? a.filename.localeCompare(b.filename)
                : a.created_at.localeCompare(b.created_at);
          const direction =
            url.searchParams.get("sort_order") === "desc" ? -1 : 1;
          return direction * compared || a.id.localeCompare(b.id);
        });
      const items = available
        .slice(offset, offset + limit)
        .map((file) => ({ ...file }));
      const response = {
        ...libraryPage(items, limit, offset, available.length),
        creator_labels: Object.fromEntries(
          [...new Set(items.map((file) => file.creator_id))]
            .filter((id) => id in state.labels)
            .map((id) => [id, state.labels[id]]),
        ),
        storage_used_bytes: state.files
          .filter(
            (file) =>
              file.department_id === departmentId && file.state === "ready",
          )
          .reduce((sum, file) => sum + (file.actual_size ?? 0), 0),
      };
      if (state.listBroken === "creator")
        response.creator_labels[libraryUuid(999)] = "Private unrelated person";
      else if (state.listBroken === "pagination")
        response.pagination.count += 1;
      else if (state.listBroken === "continuation")
        response.pagination.has_more = !response.pagination.has_more;
      else if (state.listBroken === "duplicate" && items.length)
        response.items = [items[0], items[0]];
      else if (state.listBroken && items.length)
        response.items = [
          {
            ...items[0],
            filename: "Foreign private file.pdf",
            ...(state.listBroken === "purpose"
              ? {
                  purpose: "record_attachment" as const,
                  record_id: LIBRARY_MODULE,
                }
              : { department_id: LIBRARY_SECOND_DEPARTMENT }),
          },
        ];
      const hold = state.listHold.get(departmentId ?? "");
      hold?.started();
      await hold?.wait;
      return state.listStatus === 200
        ? route.fulfill({ json: response })
        : failure(route, state.listStatus);
    }
    if (url.pathname === "/api/files" && method === "POST") {
      const body = request.postDataJSON() as {
        purpose: string;
        department_id: string;
        filename: string;
        expected_size: number;
      };
      const granted = level(body.department_id);
      if (!granted) return failure(route, 404);
      if (granted === "read") return failure(route, 403);
      if (
        state.departments.find(
          (department) => department.id === body.department_id,
        )?.is_deleted
      )
        return failure(route, 409);
      const file = libraryFile({
        id: libraryUuid(
          1000 +
            state.calls.filter(
              (call) => call.method === "POST" && call.path === "/api/files",
            ).length,
        ),
        department_id: body.department_id,
        creator_id: state.userId,
        filename: body.filename,
        expected_size: body.expected_size,
        actual_size: null,
        media_type: null,
        state: "awaiting_upload",
      });
      state.files.push(file);
      return route.fulfill({
        status: 201,
        json: state.reserveBroken
          ? { ...file, department_id: LIBRARY_SECOND_DEPARTMENT }
          : file,
      });
    }
    const fileId = url.pathname.split("/")[3];
    const file = state.files.find((item) => item.id === fileId);
    if (!file || !level(file.department_id)) return failure(route, 404);
    if (method === "GET" && url.pathname.endsWith("/content")) {
      const hold = state.downloadHold;
      hold?.started();
      await hold?.wait;
      if (state.downloadStatus !== 200)
        return failure(route, state.downloadStatus);
      if (file.state !== "ready") return failure(route, 409);
      return route
        .fulfill({
          body: libraryPdf,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": state.downloadBroken
              ? "inline"
              : "attachment; filename*=UTF-8''" +
                encodeURIComponent(file.filename),
            "X-Content-Type-Options": "nosniff",
          },
        })
        .finally(() => hold?.finished());
    }
    if (method === "GET") {
      state.detailHold?.started();
      await state.detailHold?.wait;
      return state.readbackStatus === 200
        ? route.fulfill({
            json: state.readbackBroken
              ? { ...file, id: libraryUuid(888) }
              : file,
          })
        : failure(route, state.readbackStatus);
    }
    if (method === "PUT") {
      const hold = state.uploadHold;
      hold?.started();
      await hold?.wait;
      if (
        actor === state.userId &&
        (!level(file.department_id) || level(file.department_id) === "read")
      )
        return failure(route, 403).finally(() => hold?.finished());
      const mode = state.uploadMode;
      if (mode === "ready" || mode === "ready-error") {
        file.state = "ready";
        file.actual_size = file.expected_size;
        file.media_type = "application/pdf";
      } else if (mode !== "awaiting") {
        file.state = mode === "archived" ? "awaiting_upload" : mode;
        file.is_deleted = mode === "archived";
      }
      const response =
        mode === "ready"
          ? route.fulfill({ json: file })
          : route.fulfill({
              status: 200,
              contentType: "application/json",
              body: "unreadable",
            });
      return response.finally(() => hold?.finished());
    }
    const reopen = url.pathname.endsWith("/reopen");
    if (level(file.department_id) !== "manage") return failure(route, 403);
    if (
      reopen &&
      state.departments.find(
        (department) => department.id === file.department_id,
      )?.is_deleted
    )
      return failure(route, 409);
    state.archiveHold?.started();
    await state.archiveHold?.wait;
    const status = reopen ? state.reopenStatus : state.archiveStatus;
    if (status !== 200) return failure(route, status);
    file.is_deleted = !reopen;
    return route.fulfill({ json: file });
  });
  return state;
}

async function openLibrary(page: Page, department = LIBRARY_DEPARTMENT) {
  await page.goto(
    `/platform?section=files&department=${encodeURIComponent(department)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Department file library" }),
  ).toBeVisible();
}

async function chooseLibraryFile(
  page: Page,
  name = "Upload guide.pdf",
  buffer = libraryPdf,
) {
  const input = page.getByLabel("Upload file", { exact: true });
  await expect(input).toBeEnabled();
  await input.setInputFiles({ name, mimeType: "application/pdf", buffer });
}

test("Library files: direct department picker excludes module-only grants and preserves URL choice", async ({
  page,
}) => {
  const fixture = await installLibrary(page, {
    role: "member",
    access: [
      { department_id: LIBRARY_DEPARTMENT, module_id: null, level: "read" },
      {
        department_id: LIBRARY_SECOND_DEPARTMENT,
        module_id: null,
        level: "read",
      },
      {
        department_id: LIBRARY_MODULE_DEPARTMENT,
        module_id: LIBRARY_MODULE,
        level: "manage",
      },
    ],
  });
  await openLibrary(page);
  const picker = page.getByRole("combobox", {
    name: "Department",
    exact: true,
  });
  await expect(picker).toHaveValue(LIBRARY_DEPARTMENT);
  await expect(
    picker.getByRole("option", { name: "Module only", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toBeVisible();
  await picker.selectOption(LIBRARY_SECOND_DEPARTMENT);
  await expect(page).toHaveURL(
    new RegExp(`department=${LIBRARY_SECOND_DEPARTMENT}`),
  );
  await expect(
    page.getByRole("button", {
      name: "Download Operations guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search workspace" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await expect(picker).toHaveValue(LIBRARY_SECOND_DEPARTMENT);
  await expect(
    page.getByRole("button", {
      name: "Download Operations guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(picker).toHaveValue(LIBRARY_SECOND_DEPARTMENT);
  expect(
    fixture.listReads.every(
      (read) => read.department !== LIBRARY_MODULE_DEPARTMENT,
    ),
  ).toBe(true);
  expect(
    fixture.catalogReads.every(
      (parameters) => parameters.get("deleted") === "include",
    ),
  ).toBe(true);
});

for (const role of ["member", "guest"] as const)
  test(`Library files: ${role} readers see Added metadata and download without mutation controls`, async ({
    page,
  }) => {
    const fixture = await installLibrary(page, {
      role,
      access: [
        {
          department_id: LIBRARY_DEPARTMENT,
          module_id: null,
          level: role === "guest" ? "manage" : "read",
        },
      ],
    });
    await openLibrary(page);
    const files = page.getByRole("list", {
      name: "Library files",
      exact: true,
    });
    await expect(files.getByRole("listitem")).toHaveCount(2);
    await expect(
      files.getByText("Added by Mara Santos", { exact: true }),
    ).toBeVisible();
    await expect(
      files.getByText("Added by Unavailable user", { exact: true }),
    ).toBeVisible();
    await expect(files.getByText(/Added.*5 Oct 2026/)).toBeVisible();
    await expect(page.getByText(/Storage used.*69 bytes/)).toBeVisible();
    await expect(page.getByLabel("Upload file", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: /^Archive/ })).toHaveCount(0);
    const downloaded = page.waitForEvent("download");
    await files
      .getByRole("button", { name: "Download Safety guide.pdf", exact: true })
      .first()
      .click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toBe("Safety guide.pdf");
    expect(await readFile((await file.path())!)).toEqual(libraryPdf);
    expect(fixture.directoryReads).toEqual([]);
    expect(fixture.calls.some((call) => call.method !== "GET")).toBe(false);
  });

test("Library files: writer uploads once and manage-only lifecycle actions use confirmed responses", async ({
  page,
}) => {
  const fixture = await installLibrary(page, {
    role: "member",
    access: [
      { department_id: LIBRARY_DEPARTMENT, module_id: null, level: "write" },
    ],
  });
  await openLibrary(page);
  fixture.uploadHold = libraryGate();
  await chooseLibraryFile(page);
  await fixture.uploadHold.entered;
  await expect(page.getByLabel("Upload file", { exact: true })).toBeDisabled();
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(
    1,
  );
  expect(fixture.calls.find((call) => call.method === "POST")?.body).toEqual({
    purpose: "library_document",
    department_id: LIBRARY_DEPARTMENT,
    filename: "Upload guide.pdf",
    expected_size: libraryPdf.length,
  });
  expect(fixture.calls.find((call) => call.method === "PUT")?.body).toBe(
    libraryPdf.toString(),
  );
  fixture.uploadHold.release();
  await expect(
    page.getByRole("button", {
      name: "Download Upload guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Archive/ })).toHaveCount(0);
  fixture.access[0].level = "manage";
  await sendOpenViewEvent(page, "invalidate", { entity: "group_access" });
  const archive = page.getByRole("button", {
    name: "Archive Upload guide.pdf",
    exact: true,
  });
  await expect(archive).toBeEnabled();
  fixture.archiveStatus = 503;
  await archive.click();
  await expect(
    page.getByRole("heading", { name: /Could not archive the file/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Download Upload guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  fixture.archiveStatus = 200;
  fixture.archiveHold = libraryGate();
  await archive.click();
  await fixture.archiveHold.entered;
  await expect(archive).toBeDisabled();
  fixture.archiveHold.release();
  await expect(
    page.getByRole("button", {
      name: "Download Upload guide.pdf",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "File status", exact: true })
    .selectOption({ label: "Archived" });
  const reopen = page.getByRole("button", {
    name: "Reopen Upload guide.pdf",
    exact: true,
  });
  await expect(reopen).toBeEnabled();
  fixture.reopenStatus = 503;
  fixture.archiveHold = null;
  await reopen.click();
  await expect(
    page.getByRole("heading", { name: /Could not reopen the file/ }),
  ).toBeVisible();
  await expect(reopen).toBeVisible();
  fixture.reopenStatus = 200;
  await reopen.click();
  await expect(reopen).toHaveCount(0);
  expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

test("Library files: uncertain committed upload reads the exact reservation without resending", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.uploadMode = "ready-error";
  await openLibrary(page);
  await chooseLibraryFile(page);
  await expect(
    page.getByRole("button", {
      name: "Download Upload guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check status", exact: true }),
  ).toHaveCount(0);
  const reserved = fixture.files.find(
    (file) => file.filename === "Upload guide.pdf",
  )!;
  expect(
    fixture.calls.filter(
      (call) => call.path === "/api/files" && call.method === "POST",
    ),
  ).toHaveLength(1);
  expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(
    fixture.calls.some(
      (call) =>
        call.path === `/api/files/${reserved.id}` && call.method === "GET",
    ),
  ).toBe(true);
});

test("Library files: unknown reservation outcome survives department and section changes with matching explicit retry", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.uploadMode = "awaiting";
  fixture.readbackStatus = 503;
  await openLibrary(page);
  await chooseLibraryFile(page);
  const check = page.getByRole("button", { name: "Check status", exact: true });
  await expect(check).toBeEnabled();
  await expect(page.getByLabel("Upload file", { exact: true })).toBeDisabled();
  const picker = page.getByRole("combobox", {
    name: "Department",
    exact: true,
  });
  await picker.selectOption(LIBRARY_SECOND_DEPARTMENT);
  await expect(
    page.getByRole("button", {
      name: "Download Operations guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  await expect(check).toHaveCount(0);
  fixture.readbackStatus = 200;
  await picker.selectOption(LIBRARY_DEPARTMENT);
  await expect(page.getByLabel("Upload file", { exact: true })).toBeEnabled();
  await expect(
    page.getByText("Choose the same file to retry this upload.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search workspace" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await expect(page.getByLabel("Upload file", { exact: true })).toBeEnabled();
  await chooseLibraryFile(page, "Different guide.pdf");
  await expect(
    page.getByRole("alert").filter({ hasText: "same file name and size" }),
  ).toBeVisible();
  expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  fixture.uploadMode = "ready";
  await chooseLibraryFile(page);
  await expect(
    page.getByRole("button", {
      name: "Download Upload guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    fixture.calls.filter(
      (call) => call.path === "/api/files" && call.method === "POST",
    ),
  ).toHaveLength(1);
  expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
});

test("Library files: closed departments remain readable and archivable but cannot upload or reopen", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  await openLibrary(page, LIBRARY_CLOSED_DEPARTMENT);
  const picker = page.getByRole("combobox", {
    name: "Department",
    exact: true,
  });
  await expect(picker).toHaveValue(LIBRARY_CLOSED_DEPARTMENT);
  await expect(
    picker.getByRole("option", { name: "Records (Closed)", exact: true }),
  ).toHaveCount(1);
  await expect(page.getByLabel("Upload file", { exact: true })).toHaveCount(0);
  const archive = page.getByRole("button", {
    name: "Archive Closed department guide.pdf",
    exact: true,
  });
  await expect(archive).toBeEnabled();
  await archive.click();
  await expect(archive).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "File status", exact: true })
    .selectOption({ label: "Archived" });
  const download = page.getByRole("button", {
    name: "Download Closed archived guide.pdf",
    exact: true,
  });
  await expect(download).toBeEnabled();
  await expect(page.getByRole("button", { name: /^Reopen/ })).toHaveCount(0);
  const completed = page.waitForEvent("download");
  await download.click();
  expect(await readFile((await (await completed).path())!)).toEqual(libraryPdf);
  expect(
    fixture.calls.some(
      (call) => call.method === "PUT" || call.path.endsWith("/reopen"),
    ),
  ).toBe(false);
});

test("Library files: invalid and module-only department links never fall back to another library", async ({
  page,
}) => {
  const fixture = await installLibrary(page, {
    role: "member",
    access: [
      { department_id: LIBRARY_DEPARTMENT, module_id: null, level: "manage" },
      {
        department_id: LIBRARY_MODULE_DEPARTMENT,
        module_id: LIBRARY_MODULE,
        level: "manage",
      },
    ],
  });
  for (const department of [
    LIBRARY_MODULE_DEPARTMENT,
    libraryUuid(777),
    "invalid-department",
  ]) {
    await openLibrary(page, department);
    await expect(
      page.getByRole("alert").filter({
        hasText: /department.*unavailable|department.*not available/i,
      }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`department=${department}`));
    await expect(page.getByLabel("Upload file", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("list", { name: "Library files", exact: true }),
    ).toHaveCount(0);
  }
  expect(fixture.listReads).toEqual([]);
  await page
    .getByRole("combobox", { name: "Department", exact: true })
    .selectOption(LIBRARY_DEPARTMENT);
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toBeVisible();
});

test("Library files: default department selection waits for a complete catalog beyond the first page", async ({
  page,
}) => {
  const sourceDepartments = Array.from({ length: 100 }, (_, index) =>
    libraryDepartment(libraryUuid(2000 + index), `A source ${index}`),
  );
  const fixture = await installLibrary(page, {
    role: "member",
    access: [
      ...sourceDepartments.map((department) => ({
        department_id: department.id,
        module_id: LIBRARY_MODULE,
        level: "read" as const,
      })),
      { department_id: LIBRARY_DEPARTMENT, module_id: null, level: "read" },
    ],
  });
  fixture.departments = [
    ...sourceDepartments,
    libraryDepartment(LIBRARY_DEPARTMENT, "Z maintenance"),
  ];
  await page.goto("/platform?section=files");
  await expect(
    page.getByRole("combobox", { name: "Department", exact: true }),
  ).toHaveValue(LIBRARY_DEPARTMENT);
  await expect(page).toHaveURL(new RegExp(`department=${LIBRARY_DEPARTMENT}`));
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toBeVisible();
  expect(
    fixture.catalogReads.map((parameters) => parameters.get("offset")),
  ).toContain("100");
  await expect(page.getByRole("option", { name: /^A source/ })).toHaveCount(0);
});

test("Library files: bounded department overflow fails visibly and never exposes a partial picker", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.departments = Array.from({ length: 2001 }, (_, index) =>
    libraryDepartment(
      libraryUuid(3000 + index),
      `Department ${String(index).padStart(4, "0")}`,
    ),
  );
  await openLibrary(page);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /departments.*could not|could not.*departments/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Department", exact: true }),
  ).toBeDisabled();
  expect(fixture.catalogReads).toHaveLength(20);
  expect(fixture.listReads).toEqual([]);
  fixture.departments = [libraryDepartment(LIBRARY_DEPARTMENT, "Maintenance")];
  await page
    .getByRole("button", { name: "Retry departments", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toBeVisible();
});

test("Library files: unavailable identity and department catalogs make no library request and recover", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.identityStatus = 403;
  await openLibrary(page);
  await expect(
    page.getByRole("button", { name: "Retry access", exact: true }),
  ).toBeVisible();
  expect(fixture.listReads).toEqual([]);
  fixture.identityStatus = 200;
  fixture.departmentStatus = 503;
  await page.getByRole("button", { name: "Retry access", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry departments", exact: true }),
  ).toBeVisible();
  expect(fixture.listReads).toEqual([]);
  fixture.departmentStatus = 200;
  await page
    .getByRole("button", { name: "Retry departments", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Private database detail must never be displayed", {
      exact: true,
    }),
  ).toHaveCount(0);
});

test("Library files: slow and failed reads expose loading, safe retry and a true empty library", async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await installLibrary(page);
  const held = libraryGate();
  fixture.listHold.set(LIBRARY_DEPARTMENT, held);
  fixture.listStatus = 503;
  await openLibrary(page);
  await held.entered;
  await page.clock.runFor(301);
  await expect(
    page.getByRole("status").filter({ hasText: "Loading files" }),
  ).toBeVisible();
  const response = page.waitForResponse(
    (result) => new URL(result.url()).pathname === "/api/files",
  );
  held.release();
  await response;
  await page.clock.runFor(301);
  await expect(
    page.getByRole("button", { name: "Retry files", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Private database detail must never be displayed", {
      exact: true,
    }),
  ).toHaveCount(0);
  fixture.listStatus = 200;
  fixture.listHold.delete(LIBRARY_DEPARTMENT);
  fixture.files = [];
  await page.getByRole("button", { name: "Retry files", exact: true }).click();
  await expect
    .poll(async () => {
      await page.clock.runFor(1);
      return page
        .getByText("No files in this department.", { exact: true })
        .count();
    })
    .toBe(1);
  await expect(page.getByText(/Storage used.*0 bytes/)).toBeVisible();
});

test("Library files: date-setting failure keeps file controls usable and offers a separate recovery", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.workspaceStatus = 503;
  await openLibrary(page);
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Upload file", { exact: true })).toBeEnabled();
  await expect(
    page
      .getByRole("button", { name: "Download Safety guide.pdf", exact: true })
      .first(),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: /Retry date/ })).toBeVisible();
  fixture.workspaceStatus = 200;
  await page.getByRole("button", { name: /Retry date/ }).click();
  await expect(page.getByText(/Added.*5 Oct 2026/)).toBeVisible();
});

for (const broken of [
  "department",
  "purpose",
  "creator",
  "pagination",
  "continuation",
  "duplicate",
] as const)
  test(`Library files: ${broken} list contract violations reveal no foreign data and retry safely`, async ({
    page,
  }) => {
    const fixture = await installLibrary(page);
    fixture.listBroken = broken;
    await openLibrary(page);
    await expect(
      page.getByRole("alert").filter({ hasText: /invalid.*response/i }),
    ).toBeVisible();
    await expect(
      page.getByText("Foreign private file.pdf", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Private unrelated person", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "Library files", exact: true }),
    ).toHaveCount(0);
    fixture.listBroken = null;
    await page
      .getByRole("button", { name: "Retry files", exact: true })
      .click();
    await expect(
      page
        .getByRole("list", { name: "Library files", exact: true })
        .getByRole("listitem"),
    ).toHaveCount(2);
  });

test("Library files: server search and name-size sorting page before rendering and keep the full storage total", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.files = Array.from({ length: 35 }, (_, index) =>
    libraryFile({
      id: libraryUuid(100 + index),
      filename: `Guide ${String(index + 1).padStart(2, "0")}.pdf`,
      creator_id: index === 34 ? LIBRARY_OTHER_USER : LIBRARY_USER,
    }),
  );
  fixture.labels[LIBRARY_OTHER_USER] = "Eli Rivera";
  await openLibrary(page);
  const list = page.getByRole("list", { name: "Library files", exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(25);
  await page
    .getByRole("button", { name: "Load more files", exact: true })
    .click();
  await expect(list.getByRole("listitem")).toHaveCount(35);
  await expect(
    list.getByText("Added by Eli Rivera", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load more files", exact: true }),
  ).toHaveCount(0);
  expect(
    fixture.listReads.some((read) => read.parameters.get("offset") === "25"),
  ).toBe(true);
  await page
    .getByRole("searchbox", { name: "Search files by name" })
    .fill("guide 3");
  await expect(list.getByRole("listitem")).toHaveCount(6);
  await expect(page.getByText(/Storage used.*805 bytes/)).toBeVisible();
  expect(
    fixture.listReads.some(
      (read) =>
        read.parameters.get("search") === "guide 3" &&
        read.parameters.get("offset") === "0",
    ),
  ).toBe(true);
  await page
    .getByRole("combobox", { name: "Sort files", exact: true })
    .selectOption({ label: "Name (Z–A)" });
  await expect(list.getByRole("listitem").first()).toContainText(
    "Guide 35.pdf",
  );
  expect(
    fixture.listReads.some(
      (read) =>
        read.parameters.get("sort_by") === "name" &&
        read.parameters.get("sort_order") === "desc",
    ),
  ).toBe(true);
  fixture.files = [
    libraryFile({
      id: libraryUuid(700),
      filename: "Alpha.pdf",
      expected_size: 100,
      actual_size: 100,
    }),
    libraryFile({
      id: libraryUuid(701),
      filename: "Zulu.pdf",
      expected_size: 200,
      actual_size: 200,
    }),
  ];
  await page.getByRole("searchbox", { name: "Search files by name" }).fill("");
  await page
    .getByRole("combobox", { name: "Sort files", exact: true })
    .selectOption({ label: "Size (largest first)" });
  await expect(list.getByRole("listitem").first()).toContainText("Zulu.pdf");
  expect(
    fixture.listReads.some(
      (read) =>
        read.parameters.get("sort_by") === "size" &&
        read.parameters.get("sort_order") === "desc",
    ),
  ).toBe(true);
});

test("Library files: a stale later page cannot follow search or department changes", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.files = [
    ...Array.from({ length: 30 }, (_, index) =>
      libraryFile({
        id: libraryUuid(100 + index),
        filename: `Guide ${String(index + 1).padStart(2, "0")}.pdf`,
      }),
    ),
    libraryFile({
      id: libraryUuid(900),
      department_id: LIBRARY_SECOND_DEPARTMENT,
      filename: "Operations guide.pdf",
    }),
  ];
  await openLibrary(page);
  await expect(
    page
      .getByRole("list", { name: "Library files", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(25);
  const held = libraryGate();
  fixture.listHold.set(LIBRARY_DEPARTMENT, held);
  await page
    .getByRole("button", { name: "Load more files", exact: true })
    .click();
  await held.entered;
  fixture.listHold.delete(LIBRARY_DEPARTMENT);
  await page
    .getByRole("searchbox", { name: "Search files by name" })
    .fill("Guide 01");
  await expect(
    page
      .getByRole("list", { name: "Library files", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(1);
  held.release();
  await expect(page.getByText("Guide 26.pdf", { exact: true })).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Department", exact: true })
    .selectOption(LIBRARY_SECOND_DEPARTMENT);
  await expect(
    page.getByRole("button", {
      name: "Download Operations guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Guide 01.pdf", { exact: true })).toHaveCount(0);
});

test("Library files: an empty terminal page after concurrent removal is valid", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.files = Array.from({ length: 30 }, (_, index) =>
    libraryFile({
      id: libraryUuid(100 + index),
      filename: `Guide ${index + 1}.pdf`,
    }),
  );
  await openLibrary(page);
  await expect(
    page
      .getByRole("list", { name: "Library files", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(25);
  fixture.files = fixture.files.slice(0, 3);
  await page
    .getByRole("button", { name: "Load more files", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Load more files", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: /invalid.*response|load more/ }),
  ).toHaveCount(0);
});

test("Library files: invalid local uploads reserve nothing and foreign reservation metadata sends no bytes", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  await openLibrary(page);
  const input = page.getByLabel("Upload file", { exact: true });
  await expect(input).toBeEnabled();
  const accepted = await input.getAttribute("accept");
  for (const extension of [
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".docx",
    ".xlsx",
    ".pptx",
  ])
    expect(accepted?.split(",")).toContain(extension);
  await chooseLibraryFile(page, "Empty.pdf", Buffer.alloc(0));
  await expect(
    page.getByRole("alert").filter({ hasText: "larger than 0 bytes" }),
  ).toBeVisible();
  await chooseLibraryFile(
    page,
    "Large.pdf",
    Buffer.alloc(25 * 1024 * 1024 + 1),
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "25 MiB" }),
  ).toBeVisible();
  await chooseLibraryFile(page, "bad/name.pdf");
  await expect(
    page.getByRole("alert").filter({ hasText: "plain file name" }),
  ).toBeVisible();
  expect(fixture.calls.some((call) => call.method !== "GET")).toBe(false);
  fixture.reserveBroken = true;
  await chooseLibraryFile(page);
  await expect(
    page.getByRole("alert").filter({ hasText: /invalid.*response/i }),
  ).toBeVisible();
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(
    1,
  );
  expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
});

test("Library files: wrong exact-ID status metadata cannot unlock a reservation retry", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.uploadMode = "awaiting";
  fixture.readbackBroken = true;
  await openLibrary(page);
  await chooseLibraryFile(page);
  const check = page.getByRole("button", { name: "Check status", exact: true });
  await expect(check).toBeEnabled();
  await expect(
    page.getByRole("alert").filter({ hasText: /invalid.*response/i }),
  ).toBeVisible();
  await expect(page.getByLabel("Upload file", { exact: true })).toBeDisabled();
  fixture.readbackBroken = false;
  await check.click();
  await expect(page.getByLabel("Upload file", { exact: true })).toBeEnabled();
  expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

test("Library files: uploading reservations stay guarded until an explicit status read confirms readiness", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.uploadMode = "uploading";
  await openLibrary(page);
  await chooseLibraryFile(page);
  const check = page.getByRole("button", { name: "Check status", exact: true });
  await expect(check).toBeEnabled();
  await expect(page.getByLabel("Upload file", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Download Upload guide.pdf",
      exact: true,
    }),
  ).toHaveCount(0);
  await sendOpenViewEvent(page, "resync");
  await sendOpenViewEvent(page, "resync");
  await expect(check).toBeEnabled();
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(
    1,
  );
  expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  const reserved = fixture.files.find(
    (file) => file.filename === "Upload guide.pdf",
  )!;
  reserved.state = "ready";
  reserved.actual_size = reserved.expected_size;
  reserved.media_type = "application/pdf";
  await check.click();
  await expect(
    page.getByRole("button", {
      name: "Download Upload guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  await expect(check).toHaveCount(0);
  expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

for (const terminal of ["rejected", "purged", "deleting", "archived"] as const)
  test(`Library files: ${terminal} upload outcomes release the known reservation without an unsafe download`, async ({
    page,
  }) => {
    const fixture = await installLibrary(page);
    fixture.uploadMode = terminal;
    await openLibrary(page);
    await chooseLibraryFile(page);
    await expect(page.getByLabel("Upload file", { exact: true })).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Check status", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Download Upload guide.pdf",
        exact: true,
      }),
    ).toHaveCount(0);
    if (terminal === "purged" || terminal === "deleting")
      await expect(
        page.getByRole("button", {
          name: "Archive Upload guide.pdf",
          exact: true,
        }),
      ).toHaveCount(0);
    expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(
      1,
    );
  });

test("Library files: settled pending uploads do not block closed-department archive and only exact confirmation clears recovery", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.uploadMode = "awaiting";
  await openLibrary(page);
  await chooseLibraryFile(page);
  const check = page.getByRole("button", { name: "Check status", exact: true });
  await expect(check).toBeEnabled();
  fixture.departments.find(
    (department) => department.id === LIBRARY_DEPARTMENT,
  )!.is_deleted = true;
  await sendOpenViewEvent(page, "invalidate", { entity: "departments" });
  await expect(page.getByLabel("Upload file", { exact: true })).toHaveCount(0);
  const priorArchive = page
    .getByRole("button", { name: "Archive Safety guide.pdf", exact: true })
    .first();
  await expect(priorArchive).toBeEnabled();
  await priorArchive.click();
  await expect(check).toBeEnabled();
  fixture.archiveStatus = 503;
  const matchingArchive = page.getByRole("button", {
    name: "Archive Upload guide.pdf",
    exact: true,
  });
  await matchingArchive.click();
  await expect(
    page.getByRole("heading", { name: /Could not archive the file/ }),
  ).toBeVisible();
  await expect(check).toBeEnabled();
  fixture.archiveStatus = 200;
  await matchingArchive.click();
  await expect(check).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: "The upload did not finish." }),
  ).toHaveCount(0);
  expect(
    fixture.calls.filter(
      (call) => call.method === "POST" && call.path === "/api/files",
    ),
  ).toHaveLength(1);
});

for (const status of [401, 403, 404])
  test(`Library files: ${status} read refusal hides private cached rows, usage, creators and recovery across filters`, async ({
    page,
  }) => {
    const fixture = await installLibrary(page);
    await openLibrary(page);
    await expect(
      page.getByRole("list", { name: "Library files", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "File status", exact: true })
      .selectOption({ label: "Archived" });
    await expect(
      page.getByRole("button", {
        name: "Download Archived handbook.pdf",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "File status", exact: true })
      .selectOption({ label: "Active" });
    fixture.uploadMode = "awaiting";
    await chooseLibraryFile(page);
    await expect(
      page.getByRole("button", { name: "Check status", exact: true }),
    ).toBeEnabled();
    fixture.listStatus = status;
    fixture.readbackStatus = status;
    await sendOpenViewEvent(page, "invalidate", { entity: "files" });
    if (status === 401) await expect(page).toHaveURL(/\/login$/);
    else
      await expect(
        page.getByRole("button", { name: "Retry files", exact: true }),
      ).toBeVisible();
    await expect(
      page.getByText("Safety guide.pdf", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Upload guide.pdf", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Added by Mara Santos", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(/Storage used/)).toHaveCount(0);
    await expect(page.getByLabel("Upload file", { exact: true })).toHaveCount(
      0,
    );
    if (status === 401) {
      fixture.listStatus = 200;
      fixture.readbackStatus = 200;
      await openLibrary(page);
      await expect(
        page.getByRole("button", {
          name: "Download Safety guide.pdf",
          exact: true,
        }),
      ).toHaveCount(2);
      await expect(
        page.getByRole("button", { name: "Check status", exact: true }),
      ).toHaveCount(0);
      return;
    }
    await page
      .getByRole("combobox", { name: "File status", exact: true })
      .selectOption({ label: "Archived" });
    await expect(
      page.getByRole("button", {
        name: "Download Archived handbook.pdf",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Upload guide.pdf", { exact: true }),
    ).toHaveCount(0);
    fixture.listStatus = 200;
    fixture.readbackStatus = 200;
    await page
      .getByRole("button", { name: "Retry files", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Download Archived handbook.pdf",
        exact: true,
      }),
    ).toBeVisible();
  });

test("Library files: later-page and download refusals hide the full department collection", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.files = Array.from({ length: 30 }, (_, index) =>
    libraryFile({
      id: libraryUuid(100 + index),
      filename: `Private guide ${index + 1}.pdf`,
    }),
  );
  await openLibrary(page);
  await expect(
    page
      .getByRole("list", { name: "Library files", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(25);
  fixture.listStatus = 403;
  await page
    .getByRole("button", { name: "Load more files", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry files", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Private guide 1.pdf", { exact: true }),
  ).toHaveCount(0);
  fixture.listStatus = 200;
  await page.getByRole("button", { name: "Retry files", exact: true }).click();
  const download = page.getByRole("button", {
    name: "Download Private guide 1.pdf",
    exact: true,
  });
  await expect(download).toBeEnabled();
  fixture.downloadStatus = 404;
  await download.click();
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/Storage used/)).toHaveCount(0);
});

test("Library files: invalid download headers create no download and recover without exposing server detail", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.downloadBroken = true;
  const downloads: string[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  await openLibrary(page);
  const button = page
    .getByRole("button", { name: "Download Safety guide.pdf", exact: true })
    .first();
  await button.click();
  await expect(
    page.getByRole("heading", { name: /invalid.*response/i }),
  ).toBeVisible();
  expect(downloads).toEqual([]);
  fixture.downloadBroken = false;
  const downloaded = page.waitForEvent("download");
  await button.click();
  expect(await readFile((await (await downloaded).path())!)).toEqual(
    libraryPdf,
  );
});

test("Library files: cached department revisits and shared invalidations preserve pending work and current permissions", async ({
  page,
}) => {
  const fixture = await installLibrary(page, {
    role: "member",
    access: [
      { department_id: LIBRARY_DEPARTMENT, module_id: null, level: "manage" },
      {
        department_id: LIBRARY_SECOND_DEPARTMENT,
        module_id: null,
        level: "read",
      },
    ],
  });
  await openLibrary(page);
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toBeVisible();
  const before = fixture.listReads.filter(
    (read) => read.department === LIBRARY_DEPARTMENT,
  ).length;
  const picker = page.getByRole("combobox", {
    name: "Department",
    exact: true,
  });
  await picker.selectOption(LIBRARY_SECOND_DEPARTMENT);
  await expect(
    page.getByRole("button", {
      name: "Download Operations guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  await picker.selectOption(LIBRARY_DEPARTMENT);
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toBeVisible();
  expect(
    fixture.listReads.filter((read) => read.department === LIBRARY_DEPARTMENT),
  ).toHaveLength(before);
  fixture.files.push(
    libraryFile({ id: libraryUuid(800), filename: "Shared update.pdf" }),
  );
  await sendOpenViewEvent(page, "resync");
  await sendOpenViewEvent(page, "invalidate", { entity: "files" });
  await expect(
    page.getByRole("button", {
      name: "Download Shared update.pdf",
      exact: true,
    }),
  ).toBeVisible();
  fixture.access = [
    {
      department_id: LIBRARY_DEPARTMENT,
      module_id: LIBRARY_MODULE,
      level: "manage",
    },
  ];
  await sendOpenViewEvent(page, "invalidate", { entity: "group_members" });
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Download Shared update.pdf",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Upload file", { exact: true })).toHaveCount(0);
});

test("Library files: a cold response predating stream connection is replaced by a fresh read", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  const held = libraryGate();
  fixture.listHold.set(LIBRARY_DEPARTMENT, held);
  await openLibrary(page);
  await held.entered;
  fixture.files = [libraryFile({ filename: "Fresh stream guide.pdf" })];
  fixture.listHold.delete(LIBRARY_DEPARTMENT);
  await sendOpenViewEvent(page, "resync");
  await expect(
    page.getByRole("button", {
      name: "Download Fresh stream guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  held.release();
  await expect(page.getByText("Safety guide.pdf", { exact: true })).toHaveCount(
    0,
  );
  expect(fixture.listReads.length).toBeGreaterThanOrEqual(2);
});

test("Library files: old account transfer results cannot announce or restore private file data", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  const downloads: string[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  const held = libraryGate();
  fixture.uploadHold = held;
  await openLibrary(page);
  await chooseLibraryFile(page);
  await held.entered;
  fixture.userId = LIBRARY_OTHER_USER;
  fixture.files = [
    libraryFile({
      id: libraryUuid(900),
      filename: "Second account guide.pdf",
      creator_id: LIBRARY_OTHER_USER,
    }),
  ];
  fixture.labels = { [LIBRARY_OTHER_USER]: "Eli Rivera" };
  await page.evaluate(() =>
    window.dispatchEvent(new Event("openslate:session-recheck")),
  );
  await expect(
    page.getByRole("button", {
      name: "Download Second account guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  held.release();
  await held.completed;
  await expect(page.getByText("Safety guide.pdf", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Upload guide.pdf", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Upload guide.pdf uploaded.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Check status", exact: true }),
  ).toHaveCount(0);
  const heldDownload = libraryGate();
  fixture.downloadHold = heldDownload;
  await page
    .getByRole("button", {
      name: "Download Second account guide.pdf",
      exact: true,
    })
    .click();
  await heldDownload.entered;
  fixture.userId = libraryUuid(999);
  fixture.files = [
    libraryFile({
      filename: "Third account guide.pdf",
      creator_id: fixture.userId,
    }),
  ];
  fixture.labels = { [fixture.userId]: "Tessa Reyes" };
  await page.evaluate(() =>
    window.dispatchEvent(new Event("openslate:session-recheck")),
  );
  await expect(
    page.getByRole("button", {
      name: "Download Third account guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  heldDownload.release();
  await heldDownload.completed;
  expect(downloads).toEqual([]);
  await expect(
    page.getByRole("button", {
      name: "Download Second account guide.pdf",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("Library files: old department downloads and upload producers cannot follow a new parent", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  const downloads: string[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  await openLibrary(page);
  const heldDownload = libraryGate();
  fixture.downloadHold = heldDownload;
  await page
    .getByRole("button", { name: "Download Safety guide.pdf", exact: true })
    .first()
    .click();
  await heldDownload.entered;
  const picker = page.getByRole("combobox", {
    name: "Department",
    exact: true,
  });
  await picker.selectOption(LIBRARY_SECOND_DEPARTMENT);
  await expect(
    page.getByRole("button", {
      name: "Download Operations guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  heldDownload.release();
  await heldDownload.completed;
  expect(downloads).toEqual([]);
  await picker.selectOption(LIBRARY_DEPARTMENT);
  await expect(
    page
      .getByRole("button", { name: "Download Safety guide.pdf", exact: true })
      .first(),
  ).toBeVisible();
  const heldUpload = libraryGate();
  fixture.uploadHold = heldUpload;
  await chooseLibraryFile(page);
  await heldUpload.entered;
  await picker.selectOption(LIBRARY_SECOND_DEPARTMENT);
  await expect(
    page.getByRole("button", {
      name: "Download Operations guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  heldUpload.release();
  await heldUpload.completed;
  await expect(
    page.getByText("Upload guide.pdf uploaded.", { exact: true }),
  ).toHaveCount(0);
  await picker.selectOption(LIBRARY_DEPARTMENT);
  await expect(
    page.getByRole("button", {
      name: "Download Upload guide.pdf",
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(
    fixture.calls.filter(
      (call) => call.path === "/api/files" && call.method === "POST",
    ),
  ).toHaveLength(1);
});

test("Library files: mobile long names and keyboard controls keep the same authorized actions reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await installLibrary(page);
  const filename =
    "A long department safety and equipment operating manual ".repeat(3) +
    ".pdf";
  fixture.files = [libraryFile({ filename })];
  await openLibrary(page);
  const search = page.getByRole("searchbox", { name: "Search files by name" });
  await search.focus();
  await expect(search).toBeFocused();
  await search.fill("safety");
  const download = page.getByRole("button", {
    name: `Download ${filename}`,
    exact: true,
  });
  await expect(download).toBeEnabled();
  await download.focus();
  await expect(download).toBeFocused();
  const completed = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect((await completed).suggestedFilename()).toBe(filename);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: `Archive ${filename}`, exact: true }),
  ).toBeVisible();
});

test("Library files: a list response predating a refused status read cannot restore private cached data", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.uploadMode = "awaiting";
  await openLibrary(page);
  await chooseLibraryFile(page);
  const check = page.getByRole("button", { name: "Check status", exact: true });
  await expect(check).toBeEnabled();
  const held = libraryGate();
  fixture.listHold.set(LIBRARY_DEPARTMENT, held);
  await sendOpenViewEvent(page, "invalidate", { entity: "files" });
  await held.entered;
  fixture.readbackStatus = 403;
  await check.click();
  await expect(
    page.getByRole("button", { name: "Retry files", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Upload guide.pdf", { exact: true })).toHaveCount(
    0,
  );
  fixture.listHold.delete(LIBRARY_DEPARTMENT);
  held.release();
  await expect(page.getByText("Safety guide.pdf", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(/Storage used/)).toHaveCount(0);
  fixture.readbackStatus = 200;
  await page.getByRole("button", { name: "Retry files", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toBeVisible();
});

test("Library files: transient access refresh preserves filters and pending work while refusal hides it", async ({
  page,
}) => {
  const fixture = await installLibrary(page);
  fixture.uploadMode = "awaiting";
  await openLibrary(page);
  await chooseLibraryFile(page);
  const check = page.getByRole("button", { name: "Check status", exact: true });
  await expect(check).toBeEnabled();
  const search = page.getByRole("searchbox", { name: "Search files by name" });
  await search.fill("Safety");
  await expect
    .poll(() => fixture.listReads.at(-1)?.parameters.get("search"))
    .toBe("Safety");
  const sort = page.getByRole("combobox", { name: "Sort files", exact: true });
  await sort.selectOption({ label: "Size (largest first)" });
  const status = page.getByRole("combobox", {
    name: "File status",
    exact: true,
  });
  await status.selectOption({ label: "Archived" });
  await expect(
    page.getByText("No archived files in this department.", { exact: true }),
  ).toBeVisible();
  fixture.identityStatus = 503;
  await sendOpenViewEvent(page, "invalidate", { entity: "group_access" });
  await expect(
    page.getByRole("button", { name: "Retry access", exact: true }),
  ).toBeVisible();
  await expect(search).toHaveValue("Safety");
  await expect(sort).toHaveValue("size-desc");
  await expect(status).toHaveValue("only");
  await expect(check).toBeEnabled();
  await expect(
    page.getByText("Upload guide.pdf", { exact: true }),
  ).toBeVisible();
  fixture.identityStatus = 200;
  await page.getByRole("button", { name: "Retry access", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry access", exact: true }),
  ).toHaveCount(0);
  await expect(search).toHaveValue("Safety");
  await expect(status).toHaveValue("only");
  fixture.identityStatus = 403;
  await sendOpenViewEvent(page, "invalidate", { entity: "users" });
  await expect(
    page.getByRole("button", { name: "Retry access", exact: true }),
  ).toBeVisible();
  await expect(search).toHaveCount(0);
  await expect(check).toHaveCount(0);
  await expect(page.getByText("Upload guide.pdf", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(/Storage used/)).toHaveCount(0);
  expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(
    1,
  );
});

test("Library files: losing direct eligibility during a held upload hides the producer and its recovery data", async ({
  page,
}) => {
  const fixture = await installLibrary(page, {
    role: "member",
    access: [
      { department_id: LIBRARY_DEPARTMENT, module_id: null, level: "manage" },
    ],
  });
  const held = libraryGate();
  fixture.uploadHold = held;
  await openLibrary(page);
  await chooseLibraryFile(page);
  await held.entered;
  fixture.access = [
    {
      department_id: LIBRARY_DEPARTMENT,
      module_id: LIBRARY_MODULE,
      level: "manage",
    },
  ];
  await sendOpenViewEvent(page, "invalidate", { entity: "group_access" });
  await expect(page.getByLabel("Upload file", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Library files", exact: true }),
  ).toHaveCount(0);
  held.release();
  await held.completed;
  await expect(page.getByText("Upload guide.pdf", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Upload guide.pdf uploaded.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Check status", exact: true }),
  ).toHaveCount(0);
});
