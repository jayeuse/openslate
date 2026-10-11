import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "./helpers/test";
import { profilePreferences } from "./helpers/profile-api";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { readFile } from "node:fs/promises";
import { hideDevOverlay } from "./helpers/test-styles";

const userId = "00000000-0000-4000-8000-000000000001";
test.use({ trace: "off", screenshot: "off", video: "off" });
const moduleId = "00000000-0000-4000-8000-000000000010";
const departmentId = "00000000-0000-4000-8000-000000000011";
const nameFieldId = "00000000-0000-4000-8000-000000000012";
const statusFieldId = "00000000-0000-4000-8000-000000000013";
const inServiceChoiceId = "00000000-0000-4000-8000-000000000031";
const inspectionDueChoiceId = "00000000-0000-4000-8000-000000000032";
const serialFieldId = "00000000-0000-4000-8000-000000000020";
const unselectedQueryFieldId = "00000000-0000-4000-8000-000000000021";
const timelineStartFieldId = "00000000-0000-4000-8000-000000000022";
const timelineEndFieldId = "00000000-0000-4000-8000-000000000023";
const calendarDateFieldId = "00000000-0000-4000-8000-000000000024";
const timelineDeadlineFieldId = "00000000-0000-4000-8000-000000000025";
const timelineProgressFieldId = "00000000-0000-4000-8000-000000000026";
const timelineTimestampDeadlineFieldId = "00000000-0000-4000-8000-000000000027";
const numberFieldId = "00000000-0000-4000-8000-000000000028";
const integerFieldId = "00000000-0000-4000-8000-000000000029";
const viewId = "00000000-0000-4000-8000-000000000014";
const secondViewId = "00000000-0000-4000-8000-000000000019";
const duplicateViewId = "00000000-0000-4000-8000-000000000030";
const recordOneId = "00000000-0000-4000-8000-000000000015";
const recordTwoId = "00000000-0000-4000-8000-000000000016";

const attachmentId = "00000000-0000-4000-8000-000000000091";
const pendingAttachmentId = "00000000-0000-4000-8000-000000000092";
const otherAccountId = "00000000-0000-4000-8000-000000000093";

function recordAttachment(
  id = attachmentId,
  parent = recordOneId,
  filename = "Equipment guide.pdf",
) {
  return {
    id,
    purpose: "record_attachment",
    record_id: parent,
    department_id: null as string | null,
    board_id: null,
    creator_id: userId,
    filename,
    media_type: "application/pdf" as string | null,
    expected_size: 4,
    actual_size: 4 as number | null,
    state: "ready",
    failure_code: null,
    is_deleted: false,
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
  };
}

async function installRecordFilesApi(
  page: Page,
  options: { role?: "admin" | "member" | "guest"; deleted?: boolean } = {},
) {
  const viewOptions = {
    disableInitialSearch: true,
    deletedRecord: options.deleted,
  };
  const views = await installViewsApi(page, viewOptions);
  let activeUser = userId;
  const files = [recordAttachment()];
  const calls: { method: string; path: string; body: unknown }[] = [];
  let listStatus = 200;
  let listBroken: "foreign" | "department" | "pagination" | null = null;
  let archiveStatus = 200;
  let downloadBroken = false;
  let uploadMode:
    "ready" | "ready-error" | "awaiting" | "uploading" | "rejected" = "ready";
  let readbackStatus = 200;
  let uploadHold: { started: () => void; wait: Promise<void> } | null = null;
  let archiveHold: { started: () => void; wait: Promise<void> } | null = null;
  const readHold = new Map<string, Promise<void>>();
  const listReads: {
    parent: string | null;
    offset: number;
    account: string;
  }[] = [];
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: activeUser,
        setup_required: false,
      },
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: activeUser,
        role: options.role ?? "admin",
        access:
          options.role && options.role !== "admin"
            ? [
                {
                  department_id: departmentId,
                  module_id: moduleId,
                  level: options.role === "guest" ? "write" : "read",
                },
              ]
            : [],
      },
    }),
  );
  await page.route("**/api/files**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    calls.push({
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
      const parent = url.searchParams.get("record_id");
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const account = activeUser;
      listReads.push({ parent, offset, account });
      await readHold.get(parent ?? "");
      if (listStatus !== 200)
        return route.fulfill({
          status: listStatus,
          json: { detail: "Private database path must not be shown" },
        });
      expect(url.searchParams.get("purpose")).toBe("record_attachment");
      expect(url.searchParams.get("deleted")).toBe("exclude");
      const matching = files.filter(
        (file) => file.record_id === parent && !file.is_deleted,
      );
      const available =
        account === userId
          ? matching
          : [
              recordAttachment(
                attachmentId,
                parent ?? recordOneId,
                "Second account guide.pdf",
              ),
            ];
      const items = available.slice(offset, offset + limit);
      const response = pageResponse(
        items,
        limit,
        offset,
        available.length,
        offset + items.length < available.length,
      );
      if (listBroken === "foreign")
        response.items = [
          recordAttachment(
            attachmentId,
            recordTwoId,
            "Foreign private file.pdf",
          ),
        ];
      if (listBroken === "pagination")
        response.pagination.count = items.length + 1;
      if (listBroken === "department")
        response.items = items.map((file) => ({
          ...file,
          department_id: departmentId,
          filename: "Foreign private file.pdf",
        }));
      return route.fulfill({ json: response });
    }
    if (url.pathname === "/api/files" && method === "POST") {
      const body = request.postDataJSON() as {
        record_id: string;
        filename: string;
        expected_size: number;
        purpose: string;
      };
      expect(body.purpose).toBe("record_attachment");
      const reserved = {
        ...recordAttachment(pendingAttachmentId, body.record_id, body.filename),
        expected_size: body.expected_size,
        actual_size: null,
        state: "awaiting_upload",
        media_type: null,
      };
      files.push(reserved);
      return route.fulfill({ status: 201, json: reserved });
    }
    const id = url.pathname.split("/")[3];
    const file = files.find((item) => item.id === id);
    if (!file)
      return route.fulfill({ status: 404, json: { detail: "Missing" } });
    if (method === "PUT") {
      const barrier = uploadHold;
      uploadHold = null;
      barrier?.started();
      if (barrier) await barrier.wait;
      file.state =
        uploadMode === "ready-error"
          ? "ready"
          : uploadMode === "awaiting"
            ? "awaiting_upload"
            : uploadMode;
      file.actual_size = file.state === "ready" ? file.expected_size : null;
      if (file.state === "ready") file.media_type = "application/pdf";
      if (uploadMode !== "ready")
        return route.fulfill({
          status: uploadMode === "rejected" ? 422 : 503,
          json: { detail: "Private storage exception must not be shown" },
        });
      return route.fulfill({ json: file });
    }
    if (url.pathname.endsWith("/archive")) {
      const barrier = archiveHold;
      archiveHold = null;
      barrier?.started();
      if (barrier) await barrier.wait;
      if (archiveStatus !== 200)
        return route.fulfill({
          status: archiveStatus,
          json: { detail: "Private archive exception must not be shown" },
        });
      file.is_deleted = true;
      return route.fulfill({ json: file });
    }
    if (url.pathname.endsWith("/content"))
      return route.fulfill({
        contentType: "application/pdf",
        body: Buffer.from("%PDF"),
        headers: {
          "Content-Disposition": 'attachment; filename="Equipment guide.pdf"',
          "X-Content-Type-Options": downloadBroken ? "sniff" : "nosniff",
        },
      });
    if (readbackStatus !== 200)
      return route.fulfill({
        status: readbackStatus,
        json: { detail: "Private status exception must not be shown" },
      });
    return route.fulfill({ json: file });
  });
  const hold = () => {
    let started: () => void = () => undefined;
    let release: () => void = () => undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { began, release, barrier: { started, wait } };
  };
  return {
    views,
    closeRecord: () => {
      viewOptions.deletedRecord = true;
    },
    files,
    calls,
    listReads,
    setListStatus: (value: number) => {
      listStatus = value;
    },
    breakList: (value: typeof listBroken) => {
      listBroken = value;
    },
    setArchiveStatus: (value: number) => {
      archiveStatus = value;
    },
    breakDownload: (value: boolean) => {
      downloadBroken = value;
    },
    setUploadMode: (value: typeof uploadMode) => {
      uploadMode = value;
    },
    setReadbackStatus: (value: number) => {
      readbackStatus = value;
    },
    setUser: (value: string) => {
      activeUser = value;
    },
    holdUpload: () => {
      const held = hold();
      uploadHold = held.barrier;
      return held;
    },
    holdArchive: () => {
      const held = hold();
      archiveHold = held.barrier;
      return held;
    },
    holdList: (parent: string) => {
      const held = hold();
      readHold.set(parent, held.barrier.wait);
      return () => {
        readHold.delete(parent);
        held.release();
      };
    },
  };
}

async function openRecordFiles(page: Page, parent = recordOneId) {
  await page.goto(
    `/openview?section=views&module=${moduleId}&view=${viewId}&record=${parent}`,
  );
  const dialog = page.getByRole("dialog", { name: "Record details" });
  await dialog.getByRole("tab", { name: "Files", exact: true }).click();
  return dialog.getByRole("tabpanel", { name: "Files", exact: true });
}

const attachmentUpload = {
  name: "Maintenance notes.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF"),
};

test("Record files: a settled unfinished upload does not block archiving under a closed record", async ({
  page,
}) => {
  const api = await installRecordFilesApi(page);
  api.setUploadMode("awaiting");
  const files = await openRecordFiles(page);
  await expect(files.getByLabel("Upload file")).toBeEnabled();
  await files.getByLabel("Upload file").setInputFiles(attachmentUpload);
  await expect(
    files.getByText("Choose the same file to retry this upload."),
  ).toBeVisible();
  api.closeRecord();
  await api.views.triggerInvalidation("records");
  const dialog = page.getByRole("dialog", { name: "Record details" });
  await expect(dialog.getByText("Deleted", { exact: true })).toBeVisible();
  await expect(files.getByLabel("Upload file")).toHaveCount(0);
  const archiveGuide = files.getByRole("button", {
    name: "Archive Equipment guide.pdf",
  });
  await expect(archiveGuide).toBeEnabled();
  await archiveGuide.click();
  await expect(
    files.getByRole("button", { name: "Download Equipment guide.pdf" }),
  ).toHaveCount(0);
  await expect(
    files.getByRole("button", { name: "Check status" }),
  ).toBeVisible();
  api.setArchiveStatus(503);
  await files
    .getByRole("button", { name: "Archive Maintenance notes.pdf" })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Status messages" })
      .getByText("Could not archive the file. Try again.", { exact: true }),
  ).toBeVisible();
  await expect(
    files.getByRole("button", { name: "Check status" }),
  ).toBeVisible();
  api.setArchiveStatus(200);
  await files
    .getByRole("button", { name: "Archive Maintenance notes.pdf" })
    .click();
  await expect(files.getByText("No files attached.")).toBeVisible();
  await expect(files.getByRole("button", { name: "Check status" })).toHaveCount(
    0,
  );
  await expect(files.getByRole("alert")).toHaveCount(0);
  expect(
    api.calls.filter(
      (call) => call.method === "POST" && call.path === "/api/files",
    ),
  ).toHaveLength(1);
  expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

for (const terminal of ["purged", "deleting", "archived"] as const) {
  test(`Record files: ${terminal} upload status releases the guard without offering a download`, async ({
    page,
  }) => {
    const api = await installRecordFilesApi(page);
    api.setUploadMode("uploading");
    const files = await openRecordFiles(page);
    await expect(files.getByLabel("Upload file")).toBeEnabled();
    await files.getByLabel("Upload file").setInputFiles(attachmentUpload);
    await expect(
      files.getByRole("button", { name: "Check status" }),
    ).toBeVisible();
    await expect(files.getByLabel("Upload file")).toBeDisabled();
    // The upload reads the file back once itself; change the server state only
    // after that readback has settled and Check status can be clicked.
    await expect(
      files.getByRole("button", { name: "Check status" }),
    ).toBeEnabled();
    const pending = api.files.find((file) => file.id === pendingAttachmentId)!;
    if (terminal === "archived") pending.is_deleted = true;
    else pending.state = terminal;
    await files.getByRole("button", { name: "Check status" }).click();
    await expect(files.getByRole("alert")).toContainText("no longer available");
    await expect(files.getByLabel("Upload file")).toBeEnabled();
    await expect(
      files.getByRole("button", { name: "Download Maintenance notes.pdf" }),
    ).toHaveCount(0);
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
}

test("Record files: an old account upload producer cannot announce completion in the next account", async ({
  page,
}) => {
  const api = await installRecordFilesApi(page);
  const held = api.holdUpload();
  const files = await openRecordFiles(page);
  await expect(files.getByLabel("Upload file")).toBeEnabled();
  await files.getByLabel("Upload file").setInputFiles(attachmentUpload);
  await held.began;
  api.setUser(otherAccountId);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  const dialog = page.getByRole("dialog", { name: "Record details" });
  await dialog.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(
    files.getByRole("button", { name: "Download Second account guide.pdf" }),
  ).toBeVisible();
  held.release();
  await expect(
    page.getByText("Maintenance notes.pdf", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Status messages" })
      .getByText("Maintenance notes.pdf uploaded.", { exact: true }),
  ).toHaveCount(0);
  expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

for (const status of [401, 403, 404]) {
  test(`Record files: ${status} read refusal hides cached files and upload recovery data`, async ({
    page,
  }) => {
    const api = await installRecordFilesApi(page);
    const files = await openRecordFiles(page);
    await expect(
      files.getByRole("button", { name: "Download Equipment guide.pdf" }),
    ).toBeVisible();
    api.setUploadMode("uploading");
    await expect(files.getByLabel("Upload file")).toBeEnabled();
    await files.getByLabel("Upload file").setInputFiles(attachmentUpload);
    await expect(
      files.getByRole("button", { name: "Check status" }),
    ).toBeVisible();
    api.setListStatus(status);
    await api.views.triggerInvalidation("files");
    await expect(
      page.getByText("Equipment guide.pdf", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Maintenance notes.pdf", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Check status" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Download/ })).toHaveCount(
      0,
    );
    await expect(page.getByText(/Private database path/)).toHaveCount(0);
  });
}

test("Record files: cached revisits and shared invalidations refresh file reads", async ({
  page,
}) => {
  const api = await installRecordFilesApi(page);
  const files = await openRecordFiles(page);
  await expect(
    files.getByRole("button", { name: "Download Equipment guide.pdf" }),
  ).toBeVisible();
  const initialReads = api.listReads.length;
  const dialog = page.getByRole("dialog", { name: "Record details" });
  await dialog.getByRole("tab", { name: "Details", exact: true }).click();
  await dialog.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(
    files.getByRole("button", { name: "Download Equipment guide.pdf" }),
  ).toBeVisible();
  expect(api.listReads).toHaveLength(initialReads);
  api.files[0].filename = "Updated equipment guide.pdf";
  await api.views.triggerInvalidation("files");
  await expect(
    files.getByRole("button", { name: "Download Updated equipment guide.pdf" }),
  ).toBeVisible();
  api.breakDownload(true);
  await files
    .getByRole("button", { name: "Download Updated equipment guide.pdf" })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Status messages" })
      .getByText(/invalid attachment response/),
  ).toBeVisible();
  api.files[0].filename = "Resynced equipment guide.pdf";
  await sendOpenViewEvent(page, "resync");
  await expect(
    files.getByRole("button", {
      name: "Download Resynced equipment guide.pdf",
    }),
  ).toBeVisible();
  expect(api.listReads.length).toBeGreaterThan(initialReads);
});

for (const broken of ["foreign", "department", "pagination"] as const) {
  test(`Record files: ${broken} list responses fail safely and pagination retries complete the list`, async ({
    page,
  }) => {
    const api = await installRecordFilesApi(page);
    api.breakList(broken);
    const files = await openRecordFiles(page);
    await expect(files.getByRole("alert")).toBeVisible();
    await expect(files.getByRole("button", { name: /^Download/ })).toHaveCount(
      0,
    );
    await expect(page.getByText("Foreign private file.pdf")).toHaveCount(0);
    api.breakList(null);
    for (let index = 0; index < 26; index += 1)
      api.files.push(
        recordAttachment(
          `00000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
          recordOneId,
          `Manual ${index + 1}.pdf`,
        ),
      );
    await files.getByRole("button", { name: "Retry files" }).click();
    await expect(
      files.getByRole("button", { name: "Download Manual 24.pdf" }),
    ).toBeVisible();
    api.setListStatus(503);
    await files.getByRole("button", { name: "Load more files" }).click();
    await expect(files.getByRole("alert")).toBeVisible();
    await expect(
      files.getByRole("button", { name: "Download Equipment guide.pdf" }),
    ).toBeVisible();
    api.setListStatus(200);
    await files.getByRole("button", { name: "Load more files" }).click();
    await expect(
      files.getByRole("button", { name: "Download Manual 26.pdf" }),
    ).toBeVisible();
    expect(api.listReads.filter((read) => read.offset === 25)).toHaveLength(2);
    await expect(
      files.getByRole("button", { name: "Load more files" }),
    ).toHaveCount(0);
    await api.views.triggerInvalidation("files");
    await expect(
      files.getByRole("button", { name: "Load more files" }),
    ).toBeVisible();
    await expect(
      files.getByRole("button", { name: "Download Manual 26.pdf" }),
    ).toHaveCount(0);
    // Another writer archived later rows after the first page was read.
    // A terminal empty page beyond the new total is still a valid response.
    api.files.splice(3);
    await files.getByRole("button", { name: "Load more files" }).click();
    await expect(
      files.getByRole("button", { name: "Load more files" }),
    ).toHaveCount(0);
    await expect(files.getByRole("alert")).toHaveCount(0);
  });
}

test("Record files: an uncertain committed upload is read back without reserving or sending it twice", async ({
  page,
}) => {
  const api = await installRecordFilesApi(page);
  api.setUploadMode("ready-error");
  const files = await openRecordFiles(page);
  await expect(files.getByLabel("Upload file")).toBeEnabled();
  await files.getByLabel("Upload file").setInputFiles(attachmentUpload);
  await expect(
    files.getByRole("button", { name: "Download Maintenance notes.pdf" }),
  ).toBeVisible();
  expect(
    api.calls.filter(
      (call) => call.method === "POST" && call.path === "/api/files",
    ),
  ).toHaveLength(1);
  expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(
    api.calls.filter(
      (call) =>
        call.method === "GET" &&
        call.path === `/api/files/${pendingAttachmentId}`,
    ),
  ).toHaveLength(1);
  await expect(page.getByText(/Private storage exception/)).toHaveCount(0);
});

test("Record files: unresolved uploads survive tab unmount and require a matching explicit retry", async ({
  page,
}) => {
  const api = await installRecordFilesApi(page);
  api.setUploadMode("awaiting");
  api.setReadbackStatus(503);
  const files = await openRecordFiles(page);
  await expect(files.getByLabel("Upload file")).toBeEnabled();
  await files.getByLabel("Upload file").setInputFiles(attachmentUpload);
  await expect(
    files.getByRole("button", { name: "Check status" }),
  ).toBeVisible();
  await expect(files.getByLabel("Upload file")).toBeDisabled();
  await api.views.triggerInvalidation("files");
  await sendOpenViewEvent(page, "resync");
  const dialog = page.getByRole("dialog", { name: "Record details" });
  await dialog.getByRole("tab", { name: "Details", exact: true }).click();
  api.setReadbackStatus(200);
  await dialog.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(
    files.getByText("Choose the same file to retry this upload."),
  ).toBeVisible();
  await expect(files.getByLabel("Upload file")).toBeEnabled();
  await files
    .getByLabel("Upload file")
    .setInputFiles({ ...attachmentUpload, name: "Wrong file.pdf" });
  await expect(files.getByRole("alert")).toContainText(
    "same file name and size",
  );
  expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  api.setUploadMode("ready");
  await expect(files.getByLabel("Upload file")).toBeEnabled();
  await files.getByLabel("Upload file").setInputFiles(attachmentUpload);
  await expect(
    files.getByRole("button", { name: "Download Maintenance notes.pdf" }),
  ).toBeVisible();
  expect(
    api.calls.filter(
      (call) => call.method === "POST" && call.path === "/api/files",
    ),
  ).toHaveLength(1);
  expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
});

test("Record files: in-flight upload results cannot follow another record or a changed account", async ({
  page,
}) => {
  const api = await installRecordFilesApi(page);
  const held = api.holdUpload();
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await page
    .getByRole("button", { name: "Centrifugal pump 04", exact: true })
    .click();
  const initialDialog = page.getByRole("dialog", { name: "Record details" });
  await initialDialog.getByRole("tab", { name: "Files", exact: true }).click();
  const files = initialDialog.getByRole("tabpanel", {
    name: "Files",
    exact: true,
  });
  await expect(files.getByLabel("Upload file")).toBeEnabled();
  await files.getByLabel("Upload file").setInputFiles(attachmentUpload);
  await held.began;
  await expect(files.getByLabel("Upload file")).toBeDisabled();
  const dialog = page.getByRole("dialog", { name: "Record details" });
  await dialog.getByRole("tab", { name: "Details", exact: true }).click();
  await dialog.getByRole("button", { name: "Next record" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Cooling panel 02", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(files.getByText("No files attached.")).toBeVisible();
  held.release();
  await expect(
    page
      .getByRole("region", { name: "Status messages" })
      .getByText("Maintenance notes.pdf uploaded.", { exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Previous record" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Centrifugal pump 04", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(
    files.getByRole("button", { name: "Download Maintenance notes.pdf" }),
  ).toBeVisible();
  expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  api.setUser(otherAccountId);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(
    page.getByText("Maintenance notes.pdf", { exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(
    files.getByRole("button", { name: "Download Second account guide.pdf" }),
  ).toBeVisible();
  await expect(
    page.getByText("Maintenance notes.pdf", { exact: true }),
  ).toHaveCount(0);
});

for (const role of ["member", "guest"] as const) {
  test(`Record files: ${role} readers download ready files without mutation controls`, async ({
    page,
  }) => {
    const api = await installRecordFilesApi(page, { role });
    api.files.push({
      ...recordAttachment(
        pendingAttachmentId,
        recordOneId,
        "Unfinished scan.pdf",
      ),
      state: "uploading",
      actual_size: null,
    });
    const files = await openRecordFiles(page);
    await expect(
      files.getByRole("button", { name: "Download Equipment guide.pdf" }),
    ).toBeVisible();
    await expect(
      files.getByRole("button", { name: /Download Unfinished/ }),
    ).toHaveCount(0);
    await expect(
      files.getByText("Unfinished scan.pdf", { exact: true }),
    ).toBeVisible();
    await expect(files.getByLabel("Upload file")).toHaveCount(0);
    await expect(files.getByRole("button", { name: /^Archive/ })).toHaveCount(
      0,
    );
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      files
        .getByRole("button", { name: "Download Equipment guide.pdf" })
        .click(),
    ]);
    expect(download.suggestedFilename()).toBe("Equipment guide.pdf");
    const path = await download.path();
    expect(path).not.toBeNull();
    expect((await readFile(path!)).toString()).toBe("%PDF");
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
}

test("Record files: a writer uploads, downloads and archives with guarded list actions", async ({
  page,
}) => {
  const api = await installRecordFilesApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const files = await openRecordFiles(page);
  await expect(files.getByLabel("Upload file")).toBeEnabled();
  await files.getByLabel("Upload file").setInputFiles(attachmentUpload);
  await expect(
    files.getByRole("button", { name: "Download Maintenance notes.pdf" }),
  ).toBeVisible();
  expect(
    api.calls.find(
      (call) => call.method === "POST" && call.path === "/api/files",
    )?.body,
  ).toEqual({
    purpose: "record_attachment",
    record_id: recordOneId,
    filename: attachmentUpload.name,
    expected_size: 4,
  });
  expect(api.calls.find((call) => call.method === "PUT")?.body).toBe("%PDF");
  await expect(
    page
      .getByRole("region", { name: "Status messages" })
      .getByText("Maintenance notes.pdf uploaded.", { exact: true }),
  ).toBeVisible();
  const held = api.holdArchive();
  await files
    .getByRole("button", { name: "Archive Maintenance notes.pdf" })
    .click();
  await held.began;
  await expect(
    files.getByRole("button", { name: "Archive Maintenance notes.pdf" }),
  ).toBeDisabled();
  await expect(files.getByLabel("Upload file")).toBeDisabled();
  held.release();
  await expect(
    files.getByRole("button", { name: "Download Maintenance notes.pdf" }),
  ).toHaveCount(0);
  expect(
    api.calls.filter(
      (call) => call.path === `/api/files/${pendingAttachmentId}/archive`,
    ),
  ).toHaveLength(1);
  expect(
    await files.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  api.setArchiveStatus(503);
  await files
    .getByRole("button", { name: "Archive Equipment guide.pdf" })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Status messages" })
      .getByText("Could not archive the file. Try again.", { exact: true }),
  ).toBeVisible();
  await expect(
    files.getByRole("button", { name: "Download Equipment guide.pdf" }),
  ).toBeVisible();
  await expect(page.getByText(/Private archive exception/)).toHaveCount(0);
  api.setArchiveStatus(200);
  await files
    .getByRole("button", { name: "Archive Equipment guide.pdf" })
    .click();
  await expect(files.getByText("No files attached.")).toBeVisible();
});

test("Record files: closed records allow archive without uploads", async ({
  page,
}) => {
  const api = await installRecordFilesApi(page, { deleted: true });
  const files = await openRecordFiles(page);
  await expect(files.getByLabel("Upload file")).toHaveCount(0);
  await files
    .getByRole("button", { name: "Archive Equipment guide.pdf" })
    .click();
  await expect(files.getByText("No files attached.")).toBeVisible();
  expect(
    api.calls.filter((call) => call.method === "POST").map((call) => call.path),
  ).toEqual([`/api/files/${attachmentId}/archive`]);
});

test("Record files: local validation writes nothing and a server rejection offers no download", async ({
  page,
}) => {
  const api = await installRecordFilesApi(page);
  const files = await openRecordFiles(page);
  const upload = files.getByLabel("Upload file");
  await expect(upload).toBeEnabled();
  await upload.setInputFiles({ ...attachmentUpload, buffer: Buffer.alloc(0) });
  await expect(files.getByRole("alert")).toContainText("larger than 0 bytes");
  await upload.setInputFiles({
    ...attachmentUpload,
    buffer: Buffer.alloc(25 * 1024 * 1024 + 1),
  });
  await expect(files.getByRole("alert")).toContainText("no larger than 25 MB");
  await upload.setInputFiles({
    ...attachmentUpload,
    name: "x".repeat(256) + ".pdf",
  });
  await expect(files.getByRole("alert")).toContainText("plain file name");
  expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
  api.setUploadMode("rejected");
  await upload.setInputFiles(attachmentUpload);
  await expect(files.getByRole("alert")).toContainText("rejected");
  await expect(
    files.getByRole("button", { name: "Download Maintenance notes.pdf" }),
  ).toHaveCount(0);
  await expect(page.getByText(/Private storage exception/)).toHaveCount(0);
});

type QueryDefinition = {
  version: 1;
  logic: "and" | "or";
  columns: { field_id: string; expected_type: string }[];
  filters: {
    field_id: string;
    expected_type: string;
    operator: string;
    value?: string | number | boolean | string[] | null;
  }[];
  sort: {
    field_id: string;
    expected_type: string;
    direction: "asc" | "desc";
  }[];
  deleted: "exclude" | "include" | "only";
  search: string | null;
  search_fields: { field_id: string; expected_type: string }[];
};

type SavedView = {
  id: string;
  module_id: string;
  name: string;
  is_default: boolean;
  definition: QueryDefinition;
  presentation: {
    version: 1;
    layout: "table" | "grid" | "kanban" | "calendar" | "timeline" | "gallery";
    column_field_ids: string[];
    pinned_field_ids: string[];
    density: "comfortable" | "compact";
    wrap: boolean;
    card_size: "comfortable" | "compact";
    primary_field_id: string | null;
    secondary_field_id: string | null;
    date_field_id: string | null;
    timeline_start_field_id?: string | null;
    timeline_end_field_id?: string | null;
    timeline_deadline_field_id?: string | null;
    timeline_progress_field_id?: string | null;
    group_by_field_id: string | null;
    date_range: "week" | "month" | "quarter" | "year";
    scale: "month" | "list" | null;
  };
  revision: number;
  is_deleted: boolean;
  can_edit: boolean;
  created_at: string;
  updated_at: string;
};

type SavedViewLayout = SavedView["presentation"]["layout"];

function baseView(): SavedView {
  return {
    id: viewId,
    module_id: moduleId,
    name: "Equipment register",
    is_default: false,
    definition: {
      version: 1,
      logic: "and",
      columns: [
        { field_id: nameFieldId, expected_type: "text" },
        { field_id: statusFieldId, expected_type: "select" },
      ],
      filters: [],
      sort: [],
      deleted: "exclude",
      search: "pump",
      search_fields: [{ field_id: nameFieldId, expected_type: "text" }],
    },
    presentation: {
      version: 1,
      layout: "table",
      column_field_ids: [nameFieldId, statusFieldId],
      pinned_field_ids: [],
      density: "comfortable",
      wrap: false,
      card_size: "comfortable",
      primary_field_id: nameFieldId,
      secondary_field_id: null,
      date_field_id: null,
      group_by_field_id: null,
      date_range: "month",
      scale: null,
    },
    revision: 1,
    is_deleted: false,
    can_edit: true,
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
  };
}

function pageResponse<T>(
  items: T[],
  limit = 100,
  offset = 0,
  total = items.length,
  hasMore = false,
) {
  return {
    items,
    pagination: {
      limit,
      offset,
      count: items.length,
      total,
      has_more: hasMore,
    },
  };
}

function record(id: string, name: string, status: string) {
  const statusValue =
    status === "In service"
      ? inServiceChoiceId
      : status === "Inspection due"
        ? inspectionDueChoiceId
        : status;
  return {
    id,
    module_id: moduleId,
    data: {
      [nameFieldId]: name,
      [statusFieldId]: statusValue,
      [serialFieldId]: id === recordOneId ? "S" : `SN-${id.slice(-2)}`,
      [unselectedQueryFieldId]: "Do not surface this query-only field",
      [timelineStartFieldId]: "2026-09-01",
      [timelineEndFieldId]: "2026-09-02",
      [calendarDateFieldId]: "2026-09-01T18:30:00.000Z",
      [timelineDeadlineFieldId]: "2026-09-06",
      [timelineProgressFieldId]: "50.00",
      [timelineTimestampDeadlineFieldId]: "2026-09-06T18:30:00.000Z",
    },
    display_values: { [statusFieldId]: status },
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
    deleted_at: null,
    is_deleted: false,
    performed_by: userId,
  };
}

async function installViewsApi(
  page: Page,
  options: {
    initialDefault?: boolean;
    initialName?: string;
    initialLayout?: SavedView["presentation"]["layout"];
    initialGroupByFieldId?: string;
    initialPresentation?: Partial<SavedView["presentation"]>;
    disableInitialSearch?: boolean;
    recordName?: string;
    serialFieldName?: string;
    viewerRole?: "admin" | "member";
    deletedRecord?: boolean;
    cardFieldsNotInColumns?: boolean;
    additionalViews?: SavedView[];
    deepViewBeyondBound?: boolean;
    calendarDateTimeValue?: string;
    weekStart?: "monday" | "sunday";
  } = {},
) {
  await installOpenViewEventSource(page);
  let saved = baseView();
  if (options.initialName) saved = { ...saved, name: options.initialName };
  if (options.disableInitialSearch)
    saved = {
      ...saved,
      definition: { ...saved.definition, search: null },
    };
  if (options.cardFieldsNotInColumns) {
    saved = {
      ...saved,
      definition: {
        ...saved.definition,
        columns: [
          ...saved.definition.columns,
          { field_id: serialFieldId, expected_type: "text" },
          { field_id: unselectedQueryFieldId, expected_type: "text" },
        ],
      },
      presentation: {
        ...saved.presentation,
        column_field_ids: [nameFieldId],
        primary_field_id: serialFieldId,
        secondary_field_id: statusFieldId,
      },
    };
  }
  if (options.initialGroupByFieldId) {
    saved = {
      ...saved,
      presentation: {
        ...saved.presentation,
        group_by_field_id: options.initialGroupByFieldId,
      },
    };
  }
  if (options.initialLayout) {
    saved = {
      ...saved,
      definition: {
        ...saved.definition,
        columns:
          options.initialLayout === "timeline"
            ? [
                ...saved.definition.columns,
                { field_id: timelineStartFieldId, expected_type: "date" },
                { field_id: timelineEndFieldId, expected_type: "date" },
                { field_id: timelineDeadlineFieldId, expected_type: "date" },
                {
                  field_id: timelineTimestampDeadlineFieldId,
                  expected_type: "datetime",
                },
                { field_id: timelineProgressFieldId, expected_type: "decimal" },
              ]
            : options.initialLayout === "calendar"
              ? [
                  ...saved.definition.columns,
                  {
                    field_id: calendarDateFieldId,
                    expected_type: "datetime",
                  },
                ]
              : saved.definition.columns,
        ...(options.initialLayout === "kanban" ? { search: null } : {}),
      },
      presentation: {
        ...saved.presentation,
        layout: options.initialLayout,
        ...(options.initialLayout === "timeline"
          ? {
              timeline_start_field_id: timelineStartFieldId,
              timeline_end_field_id: timelineEndFieldId,
              timeline_deadline_field_id: timelineDeadlineFieldId,
              timeline_progress_field_id: timelineProgressFieldId,
            }
          : options.initialLayout === "calendar"
            ? { date_field_id: calendarDateFieldId }
            : {}),
      },
    };
  }
  if (options.initialPresentation) {
    saved = {
      ...saved,
      presentation: {
        ...saved.presentation,
        ...options.initialPresentation,
      },
    };
  }
  // The module's shared default view; every view response carries it.
  let defaultViewId: string | null = options.initialDefault ? viewId : null;
  const withDefault = (view: SavedView): SavedView => ({
    ...view,
    is_default: view.id === defaultViewId,
  });
  const createdViews: SavedView[] = [];
  let nextPatchIsStale = false;
  let failNextGroupedQuery = false;
  let nextMutationFailure: "archive" | "restore" | "default-clear" | null =
    null;
  // Only a manager of the module sees save and change controls.
  await page.route("**/api/auth/me", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: userId,
        role: options.viewerRole ?? "admin",
        access:
          options.viewerRole === "member"
            ? [
                {
                  department_id: departmentId,
                  module_id: moduleId,
                  level: "write",
                },
              ]
            : [],
      }),
    }),
  );
  let nextPatchBarrier: {
    wait: Promise<void>;
    signalStarted: () => void;
  } | null = null;
  const apiRequests: string[] = [];
  const recordQueryRequests: {
    definition: QueryDefinition;
    limit?: number;
    offset?: number;
  }[] = [];
  const groupedQueryRequests: {
    definition: QueryDefinition;
    group_by: { field_id: string; expected_type: string };
    limit: number;
    offset: number;
    group_limit: number;
    group_offset: number;
    selected_group?:
      { kind: "value"; value: string } | { kind: "unspecified" } | null;
  }[] = [];
  const windowQueryRequests: Record<string, unknown>[] = [];
  let failNextWindowQuery = false;
  const workspace = {
    display_name: "OpenSlate",
    mark: "OS",
    logo_file_id: null,
    revision: 1,
    today: "2026-09-20",
    week_start: options.weekStart ?? "monday",
    locale: "en-US",
    timezone: "UTC",
    purge_enabled: true as boolean | undefined,
  };
  let workspaceFailure = false;
  let denyRecordQueries = false;
  let deniedRecordId: string | null = null;
  let nextRecordLookupBarrier: {
    wait: Promise<void>;
    signalStarted: () => void;
  } | null = null;
  const kanbanRows = Array.from({ length: 38 }, (_, index) =>
    record(
      `00000000-0000-4000-8000-${(index + 100).toString().padStart(12, "0")}`,
      index < 26
        ? "In service"
        : `Category ${String(index - 25).padStart(2, "0")}`,
      "In service",
    ),
  );
  const windowRows = Array.from({ length: 26 }, (_, index) => {
    const item = record(
      `00000000-0000-4000-8000-${(index + 200).toString().padStart(12, "0")}`,
      `Window equipment ${String(index + 1).padStart(2, "0")}`,
      "In service",
    );
    return {
      ...item,
      data: {
        ...item.data,
        [timelineStartFieldId]: index === 0 ? "2026-08-29" : "2026-09-01",
        [timelineEndFieldId]: index === 0 ? "2026-09-04" : "2026-09-10",
        [calendarDateFieldId]:
          options.calendarDateTimeValue ?? "2026-09-01T18:30:00.000Z",
        [timelineDeadlineFieldId]: "2026-09-06",
        [timelineProgressFieldId]: index === 0 ? "40.50" : "50.00",
        [timelineTimestampDeadlineFieldId]: "2026-09-06T18:30:00.000Z",
      },
    };
  });
  await page.route("**/api/workspace", (route) =>
    route.fulfill(
      workspaceFailure
        ? {
            status: 503,
            json: { detail: "Organization settings temporarily unavailable" },
          }
        : { json: workspace },
    ),
  );
  await page.route("**/api/departments**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: departmentId,
            department_name: "Field service",
            created_at: "2026-09-23T00:00:00Z",
            updated_at: "2026-09-23T00:00:00Z",
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
        ],
        pagination: {
          limit: 100,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      },
    }),
  );
  await page.route("**/api/views**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    apiRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/views/data-sources") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageResponse([
            {
              id: moduleId,
              name: "Equipment",
              department_id: departmentId,
              title_field_id: null,
            },
          ]),
        ),
      });
    }
    if (url.pathname === `/api/views/data-sources/${moduleId}/fields`) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageResponse([
            {
              id: nameFieldId,
              module_id: moduleId,
              name: "Equipment name",
              type: "text",
              required: true,
              position: 0,
              config: {},
            },
            {
              id: statusFieldId,
              module_id: moduleId,
              name: "Status",
              type: "select",
              required: false,
              position: 1,
              config: {
                options: [
                  { id: inServiceChoiceId, label: "In service" },
                  { id: inspectionDueChoiceId, label: "Inspection due" },
                ],
              },
            },
            {
              id: serialFieldId,
              module_id: moduleId,
              name: options.serialFieldName ?? "Serial number",
              type: "text",
              required: false,
              position: 2,
              config: {},
            },
            {
              id: unselectedQueryFieldId,
              module_id: moduleId,
              name: "Unselected query field",
              type: "text",
              required: false,
              position: 3,
              config: {},
            },
            {
              id: timelineStartFieldId,
              module_id: moduleId,
              name: "Start date",
              type: "date",
              required: false,
              position: 4,
              config: {},
            },
            {
              id: timelineEndFieldId,
              module_id: moduleId,
              name: "End date",
              type: "date",
              required: false,
              position: 5,
              config: {},
            },
            {
              id: calendarDateFieldId,
              module_id: moduleId,
              name: "Scheduled at",
              type: "datetime",
              required: false,
              position: 6,
              config: {},
            },
            {
              id: timelineDeadlineFieldId,
              module_id: moduleId,
              name: "Deadline",
              type: "date",
              required: false,
              position: 7,
              config: {},
            },
            {
              id: timelineProgressFieldId,
              module_id: moduleId,
              name: "Progress",
              type: "decimal",
              required: false,
              position: 8,
              config: {},
            },
            {
              id: timelineTimestampDeadlineFieldId,
              module_id: moduleId,
              name: "Timestamp deadline",
              type: "datetime",
              required: false,
              position: 9,
              config: {},
            },
            {
              id: numberFieldId,
              module_id: moduleId,
              name: "Measurement",
              type: "number",
              required: false,
              position: 10,
              config: {},
            },
            {
              id: integerFieldId,
              module_id: moduleId,
              name: "Item count",
              type: "int",
              required: false,
              position: 11,
              config: {},
            },
          ]),
        ),
      });
    }
    if (url.pathname === "/api/views" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        module_id: string;
        name: string;
        is_default: boolean;
        definition: QueryDefinition;
        presentation: SavedView["presentation"];
      };
      if (body.is_default) defaultViewId = duplicateViewId;
      const created: SavedView = {
        ...saved,
        id: duplicateViewId,
        module_id: body.module_id,
        name: body.name,
        is_default: body.is_default,
        definition: body.definition,
        presentation: body.presentation,
        revision: 1,
        is_deleted: false,
        can_edit: true,
        created_at: "2026-09-23T00:00:00Z",
        updated_at: "2026-09-23T00:00:00Z",
      };
      createdViews.push(created);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(created),
      });
    }
    if (url.pathname === "/api/views" && request.method() === "GET") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      if (options.deepViewBeyondBound) {
        const total = 101;
        const items = Array.from(
          { length: Math.min(limit, Math.max(0, total - offset)) },
          (_, index) => {
            const absoluteIndex = offset + index;
            const sequence = (offset + index + 1)
              .toString(16)
              .padStart(12, "0");
            if (absoluteIndex === total - 1) return withDefault(saved);
            // The older views are separate, active records: archiving or
            // restoring the deep-linked view must not change them.
            return {
              ...withDefault(saved),
              id: `10000000-0000-4000-8000-${sequence}`,
              name: `Older view ${offset + index + 1}`,
              is_deleted: false,
            };
          },
        );
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            pageResponse(
              items,
              limit,
              offset,
              total,
              offset + items.length < total,
            ),
          ),
        });
      }
      const includeDeleted = url.searchParams.get("deleted") === "include";
      const allViews = [
        saved,
        ...(options.additionalViews ?? []),
        ...createdViews,
      ];
      const views = allViews
        .filter(
          (view) =>
            view.module_id === url.searchParams.get("module_id") &&
            (includeDeleted || !view.is_deleted),
        )
        .map(withDefault);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pageResponse(views, limit, offset, views.length)),
      });
    }
    if (url.pathname === `/api/views/${viewId}` && request.method() === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(withDefault(saved)),
      });
    }
    if (
      url.pathname === `/api/views/${viewId}` &&
      request.method() === "PATCH"
    ) {
      const barrier = nextPatchBarrier;
      if (barrier) {
        nextPatchBarrier = null;
        barrier.signalStarted();
        await barrier.wait;
      }
      if (nextPatchIsStale) {
        nextPatchIsStale = false;
        saved = {
          ...saved,
          revision: saved.revision + 1,
          definition: { ...saved.definition, search: "external edit" },
        };
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            detail: {
              code: "stale_revision",
              message: "View changed; reload before saving",
              current_revision: saved.revision,
            },
          }),
        });
      }
      const body = request.postDataJSON() as {
        revision: number;
        name?: string;
        is_default?: boolean;
        definition?: QueryDefinition;
        presentation?: SavedView["presentation"];
      };
      if (
        body.is_default === false &&
        nextMutationFailure === "default-clear"
      ) {
        nextMutationFailure = null;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Default could not be cleared." }),
        });
      }
      if (body.revision !== saved.revision) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ detail: { code: "stale_revision" } }),
        });
      }
      saved = {
        ...saved,
        revision: saved.revision + 1,
        name: body.name ?? saved.name,
        definition: body.definition ?? saved.definition,
        presentation: body.presentation ?? saved.presentation,
        updated_at: new Date().toISOString(),
      };
      if (body.is_default === true) defaultViewId = viewId;
      if (body.is_default === false && defaultViewId === viewId)
        defaultViewId = null;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(withDefault(saved)),
      });
    }
    if (
      url.pathname === `/api/views/${viewId}` &&
      request.method() === "DELETE"
    ) {
      if (nextMutationFailure === "archive") {
        nextMutationFailure = null;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Archive temporarily failed." }),
        });
      }
      saved = { ...saved, revision: saved.revision + 1, is_deleted: true };
      if (defaultViewId === viewId) defaultViewId = null;
      return route.fulfill({ status: 204, body: "" });
    }
    if (
      url.pathname === `/api/views/${viewId}/restore` &&
      request.method() === "POST"
    ) {
      if (nextMutationFailure === "restore") {
        nextMutationFailure = null;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Restore temporarily failed." }),
        });
      }
      saved = { ...saved, revision: saved.revision + 1, is_deleted: false };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(withDefault(saved)),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.route("**/api/records/query", async (route: Route) => {
    const body = route.request().postDataJSON() as {
      definition: QueryDefinition;
      limit?: number;
      offset?: number;
    };
    recordQueryRequests.push(body);
    if (denyRecordQueries) {
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Forbidden" }),
      });
    }
    const search = body.definition.search?.toLowerCase() ?? "";
    if (nextRecordLookupBarrier && search.includes("-")) {
      const barrier = nextRecordLookupBarrier;
      nextRecordLookupBarrier = null;
      barrier.signalStarted();
      await barrier.wait;
    }
    const firstRecord = record(
      recordOneId,
      options.recordName ?? "Centrifugal pump 04",
      "In service",
    );
    const regularRows = [
      options.deletedRecord
        ? {
            ...firstRecord,
            deleted_at: "2026-09-24T00:00:00Z",
            is_deleted: true,
          }
        : firstRecord,
      record(recordTwoId, "Cooling panel 02", "Inspection due"),
      ...Array.from({ length: 28 }, (_, index) =>
        record(
          `00000000-0000-4000-8000-${(index + 32).toString().padStart(12, "0")}`,
          index === 0 ? "Compressor 01" : `Equipment ${index + 3}`,
          "In service",
        ),
      ),
    ];
    const allRows = [
      ...regularRows,
      ...(kanbanRows.some((row) => row.id.toLowerCase() === search)
        ? kanbanRows
        : []),
      ...(windowRows.some((row) => row.id.toLowerCase() === search)
        ? windowRows
        : []),
    ].filter(
      (row) =>
        row.id !== deniedRecordId &&
        (!search ||
          row.id.toLowerCase().includes(search) ||
          String(row.data[nameFieldId]).toLowerCase().includes(search)),
    );
    const limit = body.limit ?? 25;
    const offset = body.offset ?? 0;
    const requestedFieldIds = new Set(
      body.definition.columns.map(({ field_id }) => field_id),
    );
    const rows = allRows.slice(offset, offset + limit).map((row) => ({
      ...row,
      data: Object.fromEntries(
        Object.entries(row.data).filter(([fieldId]) =>
          requestedFieldIds.has(fieldId),
        ),
      ),
    }));
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        pageResponse(
          rows,
          limit,
          offset,
          allRows.length,
          offset + rows.length < allRows.length,
        ),
      ),
    });
  });
  await page.route("**/api/records/grouped-query", async (route: Route) => {
    const body = route
      .request()
      .postDataJSON() as (typeof groupedQueryRequests)[number];
    groupedQueryRequests.push(body);
    if (failNextGroupedQuery) {
      failNextGroupedQuery = false;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Private grouped failure canary" }),
      });
    }
    const rows = kanbanRows;
    const fieldId = body.group_by.field_id;
    const groupValue = (row: ReturnType<typeof record>) =>
      (row.data as Record<string, unknown>)[fieldId];
    const groupLabel = (value: string) => {
      const row = rows.find(
        (candidate) => String(groupValue(candidate) ?? "") === value,
      );
      const display = Object.entries(row?.display_values ?? {}).find(
        ([id]) => id === fieldId,
      )?.[1];
      return typeof display === "string" ? display : value;
    };
    const groups = Array.from(
      new Set(rows.map((row) => String(groupValue(row) ?? ""))),
    )
      .sort((left, right) => left.localeCompare(right))
      .map((value) => ({
        value,
        label: groupLabel(value),
        count: rows.filter((row) => String(groupValue(row) ?? "") === value)
          .length,
      }));
    const groupOffset = body.group_offset ?? 0;
    const groupLimit = body.group_limit ?? 12;
    const selectedGroup = body.selected_group ?? null;
    const selectedRows =
      selectedGroup?.kind === "value"
        ? rows.filter((row) => groupValue(row) === selectedGroup.value)
        : [];
    const offset = body.offset ?? 0;
    const limit = body.limit ?? 25;
    const selectedFieldIds = new Set(
      saved.definition.columns.map(({ field_id }) => field_id),
    );
    const items = selectedRows.slice(offset, offset + limit).map((row) => ({
      ...row,
      data: Object.fromEntries(
        Object.entries(row.data).filter(([id]) => selectedFieldIds.has(id)),
      ),
    }));
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items,
        pagination:
          selectedGroup === null
            ? null
            : {
                limit,
                offset,
                count: items.length,
                total: selectedRows.length,
                has_more: offset + items.length < selectedRows.length,
              },
        groups: groups.slice(groupOffset, groupOffset + groupLimit),
        group_pagination: {
          limit: groupLimit,
          offset: groupOffset,
          count: Math.min(groupLimit, Math.max(0, groups.length - groupOffset)),
          total: groups.length,
          has_more: groupOffset + groupLimit < groups.length,
        },
        selected_group: selectedGroup,
      }),
    });
  });
  await page.route("**/api/records/window-query", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    windowQueryRequests.push(body);
    if (failNextWindowQuery) {
      failNextWindowQuery = false;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Window query temporarily failed." }),
      });
    }
    const definition = body.definition as QueryDefinition;
    const selectedFieldIds = new Set(
      definition.columns.map(({ field_id }) => field_id),
    );
    const undated = record(
      recordTwoId,
      "Unscheduled equipment",
      "Inspection due",
    );
    const allRows =
      body.scope === "undated" || body.scope === "unscheduled"
        ? [
            {
              ...undated,
              data: {
                ...undated.data,
                [calendarDateFieldId]: null,
                [timelineStartFieldId]: null,
                [timelineEndFieldId]: null,
              },
            },
          ]
        : windowRows;
    const limit = Number(body.limit ?? 25);
    const offset = Number(body.offset ?? 0);
    const items = allRows.slice(offset, offset + limit).map((item) => ({
      ...item,
      data: Object.fromEntries(
        Object.entries(item.data).filter(([id]) => selectedFieldIds.has(id)),
      ),
    }));
    const includesDatetime = definition.columns.some(
      ({ expected_type }) => expected_type === "datetime",
    );
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...pageResponse(
          items,
          limit,
          offset,
          allRows.length,
          offset + items.length < allRows.length,
        ),
        timezone: includesDatetime ? "Asia/Manila" : null,
      }),
    });
  });
  return {
    workspace,
    windowRows,
    failWorkspaceRead: (failed: boolean) => {
      workspaceFailure = failed;
    },
    requests: apiRequests,
    triggerInvalidation: (entity: string) =>
      sendOpenViewEvent(page, "invalidate", { entity }),
    makeNextPatchStale: () => {
      nextPatchIsStale = true;
    },
    rejectNextMutation: (mutation: "archive" | "restore" | "default-clear") => {
      nextMutationFailure = mutation;
    },
    pauseNextPatch: () => {
      let signalStarted: () => void = () => undefined;
      let releasePatch: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        releasePatch = resolve;
      });
      nextPatchBarrier = { wait, signalStarted };
      return { started, release: releasePatch };
    },
    saved: () => saved,
    changeSavedViewElsewhere: (search: string) => {
      saved = {
        ...saved,
        revision: saved.revision + 1,
        definition: { ...saved.definition, search },
        updated_at: new Date().toISOString(),
      };
    },
    createdViews: () => createdViews,
    defaultView: () => defaultViewId,
    changeDefaultElsewhere: (viewId: string) => {
      defaultViewId = viewId;
    },
    recordQueryRequests,
    denyRecordQueries() {
      denyRecordQueries = true;
    },
    allowRecordQueries() {
      denyRecordQueries = false;
    },
    denyRecordId: (id: string) => {
      deniedRecordId = id;
    },
    pauseNextRecordLookup: () => {
      let signalStarted: () => void = () => undefined;
      let release: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextRecordLookupBarrier = { wait, signalStarted };
      return { started, release };
    },
    groupedQueryRequests,
    failNextGroupedQuery: () => {
      failNextGroupedQuery = true;
    },
    windowQueryRequests,
    failNextWindowQuery: () => {
      failNextWindowQuery = true;
    },
  };
}

async function openFilters(page: Page) {
  const button = page.getByRole("button", { name: "More filters" });
  const region = page.getByRole("region", {
    name: "Search Equipment filters",
  });
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
  await expect(region).toBeVisible();
  return region;
}

async function openLayoutSettings(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Layout settings" });
  if (!(await dialog.isVisible()))
    await page.getByRole("button", { name: "Layout settings" }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openColumns(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Columns" });
  if (!(await dialog.isVisible()))
    await page.getByRole("button", { name: "Columns", exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeDialog(dialog: Locator) {
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
}

async function setLayoutFromSettings(page: Page, layout: SavedViewLayout) {
  const dialog = await openLayoutSettings(page);
  await dialog.getByLabel("Presentation layout").selectOption(layout);
  await closeDialog(dialog);
}

async function expectLayoutFromSettings(page: Page, layout: SavedViewLayout) {
  const dialog = await openLayoutSettings(page);
  await expect(dialog.getByLabel("Presentation layout")).toHaveValue(layout);
  await closeDialog(dialog);
}

async function openViewAction(page: Page, action: string) {
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

async function addFilterForField(page: Page, fieldId: string) {
  const filtersRegion = await openFilters(page);
  await filtersRegion.getByRole("button", { name: "Add filter" }).click();
  await filtersRegion
    .getByRole("combobox", { name: "Field", exact: true })
    .selectOption(fieldId);
}

async function enterFilterAndWaitForQuery(
  page: Page,
  fieldId: string,
  value: string,
) {
  const filtersRegion = await openFilters(page);
  const requestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    if (url.pathname !== "/api/records/query" || request.method() !== "POST")
      return false;
    const body = request.postDataJSON() as { definition: QueryDefinition };
    return body.definition.filters.some(
      (filter) =>
        filter.field_id === fieldId &&
        (filter.value === value || filter.value === Number(value)),
    );
  });
  await filtersRegion.getByLabel("Value").fill(value);
  return requestPromise;
}

test("decimal View filters retain ordinary and high-precision strings", async ({
  page,
}) => {
  await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, timelineProgressFieldId);

  for (const value of ["1.25", "9007199254740993"]) {
    const request = await enterFilterAndWaitForQuery(
      page,
      timelineProgressFieldId,
      value,
    );
    const body = request.postDataJSON() as { definition: QueryDefinition };
    const filter = body.definition.filters.find(
      (item) => item.field_id === timelineProgressFieldId,
    );

    expect(filter).toEqual({
      field_id: timelineProgressFieldId,
      expected_type: "decimal",
      operator: "eq",
      value,
    });
  }
});

test("number View filters continue sending numeric values", async ({
  page,
}) => {
  await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, numberFieldId);

  const request = await enterFilterAndWaitForQuery(page, numberFieldId, "12.5");
  const body = request.postDataJSON() as { definition: QueryDefinition };
  const filter = body.definition.filters.find(
    (item) => item.field_id === numberFieldId,
  );

  expect(filter).toEqual({
    field_id: numberFieldId,
    expected_type: "number",
    operator: "eq",
    value: 12.5,
  });
});

test("membership View filters select choices by label and submit stable IDs", async ({
  page,
}) => {
  const api = await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, statusFieldId);

  const filtersRegion = await openFilters(page);
  const operator = filtersRegion.getByRole("combobox", {
    name: "Condition",
  });
  await operator.selectOption("in");

  const value = filtersRegion.getByRole("group", { name: "Value" });
  await value.getByRole("checkbox", { name: "In service" }).check();
  await value.getByRole("checkbox", { name: "Inspection due" }).check();
  const expectedMembershipFilter = {
    field_id: statusFieldId,
    expected_type: "select",
    operator: "in",
    value: [inServiceChoiceId, inspectionDueChoiceId],
  };
  await expect
    .poll(() =>
      api.recordQueryRequests.some(({ definition }) =>
        definition.filters.some(
          (filter) =>
            filter.field_id === statusFieldId &&
            JSON.stringify(filter.value) ===
              JSON.stringify(expectedMembershipFilter.value),
        ),
      ),
    )
    .toBe(true);
  const submittedQueryFilter = api.recordQueryRequests
    .find(({ definition }) =>
      definition.filters.some(
        (filter) =>
          filter.field_id === statusFieldId &&
          JSON.stringify(filter.value) ===
            JSON.stringify(expectedMembershipFilter.value),
      ),
    )
    ?.definition.filters.find((filter) => filter.field_id === statusFieldId);
  expect(submittedQueryFilter).toEqual(expectedMembershipFilter);
  const saveRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === `/api/views/${viewId}` && request.method() === "PATCH"
    );
  });
  await page.getByRole("button", { name: "Save changes" }).click();
  await saveRequestPromise;
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Equipment register” was saved." }),
  ).toHaveText("“Equipment register” was saved.");
  expect(api.saved().definition.filters).toEqual([
    {
      field_id: statusFieldId,
      expected_type: "select",
      operator: "in",
      value: [inServiceChoiceId, inspectionDueChoiceId],
    },
  ]);
});

for (const layout of ["kanban", "calendar", "timeline"] as const) {
  test(`${layout} does not query incomplete filters and sends typed membership values`, async ({
    page,
  }) => {
    const api = await installViewsApi(page, { initialLayout: layout });
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const layoutDialog = await openLayoutSettings(page);
    await expect(layoutDialog.getByLabel("Presentation layout")).toHaveValue(
      layout,
    );
    if (layout === "kanban") {
      await layoutDialog
        .getByRole("combobox", { name: "Group lanes by" })
        .selectOption(nameFieldId);
      await expect
        .poll(() => api.groupedQueryRequests.length)
        .toBeGreaterThan(0);
    } else {
      await expect
        .poll(() => api.windowQueryRequests.length)
        .toBeGreaterThan(0);
    }
    await closeDialog(layoutDialog);
    const requests =
      layout === "kanban" ? api.groupedQueryRequests : api.windowQueryRequests;
    const initialRequestCount = requests.length;

    await addFilterForField(page, statusFieldId);
    const filtersRegion = await openFilters(page);
    await expect(
      filtersRegion.getByText(
        "Complete this condition or remove it before saving.",
      ),
    ).toBeVisible();
    expect(
      requests
        .slice(initialRequestCount)
        .some((request) =>
          (request.definition as QueryDefinition).filters.some(
            (filter) => filter.value === "",
          ),
        ),
    ).toBe(false);

    await filtersRegion
      .getByRole("combobox", { name: "Condition" })
      .selectOption("in");
    expect(
      requests
        .slice(initialRequestCount)
        .some((request) =>
          (request.definition as QueryDefinition).filters.some(
            (filter) => filter.operator === "in" && filter.value === "",
          ),
        ),
    ).toBe(false);
    const value = filtersRegion.getByRole("group", { name: "Value" });
    await value.getByRole("checkbox", { name: "In service" }).check();
    await value.getByRole("checkbox", { name: "Inspection due" }).check();
    await expect
      .poll(() =>
        requests.some((request) => {
          const definition = request.definition as QueryDefinition;
          return definition.filters.some(
            (filter) =>
              filter.field_id === statusFieldId &&
              filter.operator === "in" &&
              JSON.stringify(filter.value) ===
                JSON.stringify([inServiceChoiceId, inspectionDueChoiceId]),
          );
        }),
      )
      .toBe(true);
  });
}

test("switching scalar and membership View filters clears incompatible values", async ({
  page,
}) => {
  await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, statusFieldId);

  const filtersRegion = await openFilters(page);
  const operator = filtersRegion.getByRole("combobox", {
    name: "Condition",
  });
  const value = filtersRegion.getByLabel("Value");
  await value.selectOption(inServiceChoiceId);
  await operator.selectOption("in");
  const membership = filtersRegion.getByRole("group", { name: "Value" });
  await expect(
    membership.getByRole("checkbox", { name: "In service" }),
  ).not.toBeChecked();
  await expect(
    page.getByText("Complete this condition or remove it before saving."),
  ).toBeVisible();
  await membership.getByRole("checkbox", { name: "In service" }).check();
  await membership.getByRole("checkbox", { name: "Inspection due" }).check();
  await operator.selectOption("eq");
  await expect(value).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save view" })).toHaveCount(0);
});

test("changing a Views filter field with the keyboard retains focus", async ({
  page,
}) => {
  await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const filtersRegion = await openFilters(page);
  await filtersRegion.getByRole("button", { name: "Add filter" }).click();

  const field = filtersRegion.getByRole("combobox", { name: "Field" });
  await expect(field).toHaveValue(nameFieldId);
  await field.focus();
  await page.keyboard.press("s");

  await expect(field).toHaveValue(statusFieldId);
  await expect(field).toBeFocused();
});

test("clearing a number View filter stays blank instead of querying zero", async ({
  page,
}) => {
  const api = await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, numberFieldId);
  const filtersRegion = await openFilters(page);

  const value = filtersRegion.getByLabel("Value");
  await value.fill("12.5");
  await expect
    .poll(() =>
      api.recordQueryRequests.some(({ definition }) =>
        definition.filters.some(
          (filter) =>
            filter.field_id === numberFieldId && filter.value === 12.5,
        ),
      ),
    )
    .toBe(true);
  const requestCountBeforeClear = api.recordQueryRequests.length;

  await value.fill("");
  await expect(value).toHaveValue("");
  await expect(
    filtersRegion.getByText(
      "Complete this condition or remove it before saving.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save view" })).toHaveCount(0);
  expect(
    api.recordQueryRequests
      .slice(requestCountBeforeClear)
      .some(({ definition }) =>
        definition.filters.some(
          (filter) => filter.field_id === numberFieldId && filter.value === 0,
        ),
      ),
  ).toBe(false);
});

test("unsafe integer View filters fail locally without sending a rounded value", async ({
  page,
}) => {
  const api = await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, integerFieldId);
  const filtersRegion = await openFilters(page);

  const valueInput = filtersRegion.getByLabel("Value");
  for (const value of ["9007199254740993", "1.0000000000000001"]) {
    await valueInput.fill(value);

    await expect(valueInput).toHaveValue(value);
    await expect(valueInput).toHaveAttribute("aria-invalid", "true");
    await expect(valueInput).toHaveAttribute(
      "aria-describedby",
      "openview-filter-value-error-0",
    );
    await expect(
      page.getByText(
        "Enter a whole number from -9007199254740991 to 9007199254740991.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      api.recordQueryRequests.some(({ definition }) =>
        definition.filters.some(
          (filter) =>
            filter.field_id === integerFieldId &&
            filter.value !== "" &&
            filter.value !== null &&
            filter.value !== undefined,
        ),
      ),
    ).toBe(false);
  }
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
});

test("server-backed Views preserve edits through save, conflict, archive, restore, and module default changes", async ({
  page,
}) => {
  const api = await installViewsApi(page);

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(page.getByRole("heading", { name: "Views" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    viewId,
  );
  await expect(page.getByText("Centrifugal pump 04")).toBeVisible();
  await expect(
    page.getByText("Field service · 12 active fields"),
  ).toBeVisible();
  await expect(page.getByText("Search: pump")).toBeVisible();
  await expect(page.getByText("No active filters")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save view" })).toHaveCount(0);
  await openViewAction(page, "Rename view…");
  const renameDialog = page.getByRole("dialog", { name: "Rename view" });
  await expect(renameDialog).toBeVisible();
  await renameDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(
    new RegExp(`module=${moduleId}.*view=${viewId}`),
  );

  const search = page.getByRole("searchbox", { name: "Search Equipment" });
  await search.fill("panel");
  await expect(page.getByText("Cooling panel 02")).toBeVisible();
  await expect(page.getByText("Centrifugal pump 04")).toHaveCount(0);
  await page.getByRole("link", { name: "Dashboards" }).click();
  const discardDialog = page.getByRole("alertdialog", {
    name: "Discard unsaved view changes?",
  });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(
    new RegExp(`module=${moduleId}.*view=${viewId}`),
  );
  const firstSave = api.pauseNextPatch();
  await page.getByRole("button", { name: "Save changes" }).click();
  await firstSave.started;
  await search.fill("panel 02");
  firstSave.release();
  await expect(
    page.getByRole("status").filter({ hasText: "newer edits remain" }),
  ).toHaveText(
    "“Equipment register” was saved. Your newer edits remain open as an unsaved draft.",
  );
  await expect(search).toHaveValue("panel 02");
  expect(api.saved().definition.search).toBe("panel");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toHaveText("“Equipment register” was saved.");
  expect(api.saved().definition.search).toBe("panel 02");

  await page.reload();
  await expect(
    page.getByRole("searchbox", { name: "Search Equipment" }),
  ).toHaveValue("panel 02");
  await expect(page.getByText("Cooling panel 02")).toBeVisible();

  api.makeNextPatchStale();
  await page
    .getByRole("searchbox", { name: "Search Equipment" })
    .fill("compressor");
  await page.getByRole("button", { name: "Save changes" }).click();
  const conflictDialog = page.getByRole("dialog", {
    name: "Update saved view",
  });
  await expect(conflictDialog).toBeVisible();
  await expect(
    conflictDialog.getByText(/Query, filters, or sort/),
  ).toBeVisible();
  await expect(
    conflictDialog.getByText(/local search “compressor”/),
  ).toBeVisible();
  await expect(
    conflictDialog.getByRole("button", { name: "Update view" }),
  ).toHaveCount(0);
  expect(api.saved().definition.search).toBe("external edit");

  api.makeNextPatchStale();
  await conflictDialog
    .getByRole("button", { name: "Save my version over latest" })
    .click();
  await expect(conflictDialog).toBeVisible();
  expect(api.saved().definition.search).toBe("external edit");
  await conflictDialog
    .getByRole("button", { name: "Save my version over latest" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toHaveText("“Equipment register” was saved.");
  expect(api.saved().definition.search).toBe("compressor");

  await page
    .getByRole("searchbox", { name: "Search Equipment" })
    .fill("draft before archive");
  await openViewAction(page, "Archive view");
  const archiveDialog = page.getByRole("alertdialog", {
    name: "Archive saved view?",
  });
  await archiveDialog.getByRole("button", { name: "Archive view" }).click();
  await expect(discardDialog).toBeVisible();
  expect(api.saved().is_deleted).toBe(false);
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await archiveDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByLabel("Search Equipment", { exact: true }),
  ).toHaveValue("draft before archive");
  expect(api.saved().is_deleted).toBe(false);
  await openViewAction(page, "Archive view");
  api.rejectNextMutation("archive");
  await archiveDialog.getByRole("button", { name: "Archive view" }).click();
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    archiveDialog.getByRole("alert").filter({ hasText: "Archive" }),
  ).toBeVisible();
  expect(api.saved().is_deleted).toBe(false);
  await expect(
    page.getByLabel("Search Equipment", { exact: true }),
  ).toHaveValue("draft before archive");
  await archiveDialog.getByRole("button", { name: "Cancel" }).click();

  await openViewAction(page, "Archive view");
  await archiveDialog.getByRole("button", { name: "Archive view" }).click();
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "archived" }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/openview?section=views&module=${moduleId}`);

  await page
    .getByRole("searchbox", { name: "Search Equipment" })
    .fill("draft before restore");
  await expect(page.getByText("Temporary changes")).toBeVisible();
  // The unsaved draft is a temporary change of the same address.
  await expect(page).toHaveURL(
    new RegExp(`/openview\\?section=views&module=${moduleId}&changes=`),
  );
  await page.getByRole("button", { name: "Archived views" }).click();
  const archivedDialog = page.getByRole("dialog", { name: "Archived views" });
  await expect(
    archivedDialog.getByText("Equipment register", { exact: true }),
  ).toBeVisible();
  await archivedDialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Temporary changes")).toBeVisible();
  await page.getByRole("button", { name: "Archived views" }).click();
  await archivedDialog
    .getByRole("button", { name: "Restore Equipment register" })
    .click();
  await expect(discardDialog).toBeVisible();
  expect(api.saved().is_deleted).toBe(true);
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await archivedDialog.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByLabel("Search Equipment", { exact: true }),
  ).toHaveValue("draft before restore");
  expect(api.saved().is_deleted).toBe(true);
  await page.getByRole("button", { name: "Archived views" }).click();
  await archivedDialog
    .getByRole("button", { name: "Restore Equipment register" })
    .click();
  api.rejectNextMutation("restore");
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    archivedDialog.getByRole("alert").filter({ hasText: "Restore" }),
  ).toBeVisible();
  expect(api.saved().is_deleted).toBe(true);
  await expect(
    page.getByLabel("Search Equipment", { exact: true }),
  ).toHaveValue("draft before restore");
  await archivedDialog
    .getByRole("button", { name: "Restore Equipment register" })
    .click();
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    archivedDialog.getByRole("status").filter({ hasText: "restored" }),
  ).toBeVisible();
  // The restore selects the view and refreshes the module behind the dialog.
  await expect(page).toHaveURL(new RegExp(`view=${viewId}`));
  await archivedDialog.getByRole("button", { name: "Close" }).click();

  await openViewAction(page, "Make default view");
  await expect(
    page.getByRole("status").filter({ hasText: "default" }),
  ).toBeVisible();
  await expect(page.getByText("Module default", { exact: true })).toBeVisible();
  expect(api.defaultView()).toBe(viewId);
  expect(
    api.requests.some((request) => request.includes("deleted=include")),
  ).toBe(true);
});

test("clearing an implicit default asks before discarding its local draft", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialDefault: true });

  await page.goto(`/openview?section=views&module=${moduleId}`);
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    viewId,
  );
  const search = page.getByRole("searchbox", { name: "Search Equipment" });
  await search.fill("unpublished default draft");
  await openViewAction(page, "Clear default view");

  const discardDialog = page.getByRole("alertdialog", {
    name: "Discard unsaved view changes?",
  });
  await expect(discardDialog).toBeVisible();
  expect(api.defaultView()).toBe(viewId);
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(search).toHaveValue("unpublished default draft");
  expect(api.defaultView()).toBe(viewId);

  await openViewAction(page, "Clear default view");
  api.rejectNextMutation("default-clear");
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Default" }),
  ).toBeVisible();
  expect(api.defaultView()).toBe(viewId);
  await expect(search).toHaveValue("unpublished default draft");

  await openViewAction(page, "Clear default view");
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "default view was cleared" }),
  ).toBeVisible();
  expect(api.defaultView()).toBe(null);
  await expect(search).toHaveValue("");
  await expect(page).toHaveURL(`/openview?section=views&module=${moduleId}`);
});

test("selecting Unsaved view overrides the module default after discard confirmation", async ({
  page,
}) => {
  await installViewsApi(page, { initialDefault: true });

  await page.goto(`/openview?section=views&module=${moduleId}`);
  const savedView = page.getByRole("combobox", { name: "Saved view" });
  await expect(savedView).toHaveValue(viewId);
  const search = page.getByRole("searchbox", { name: "Search Equipment" });
  await search.fill("keep until confirmed");
  await savedView.selectOption("");

  const discardDialog = page.getByRole("alertdialog", {
    name: "Discard unsaved view changes?",
  });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(savedView).toHaveValue(viewId);
  await expect(search).toHaveValue("keep until confirmed");

  await savedView.selectOption("");
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();

  await expect(savedView).toHaveValue("");
  await expect(search).toHaveValue("");
  await expect(page).toHaveURL(`/openview?section=views&module=${moduleId}`);
  await page.reload();
  await expect(savedView).toHaveValue(viewId);
});

test("duplicating a saved view saves the current draft as a selected copy", async ({
  page,
}) => {
  const existingCopy = {
    ...baseView(),
    id: secondViewId,
    name: "Equipment register (copy)",
  };
  const api = await installViewsApi(page, {
    additionalViews: [existingCopy],
  });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await page
    .getByRole("searchbox", { name: "Search Equipment" })
    .fill("draft query");
  await setLayoutFromSettings(page, "grid");
  await openViewAction(page, "Duplicate view");

  await expect(
    page.getByRole("status").filter({ hasText: "was duplicated" }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    duplicateViewId,
  );
  await expect(page).toHaveURL(
    `/openview?section=views&module=${moduleId}&view=${duplicateViewId}`,
  );
  await expect(
    page.getByRole("searchbox", { name: "Search Equipment" }),
  ).toHaveValue("draft query");

  expect(api.createdViews()).toHaveLength(1);
  expect(api.createdViews()[0]).toMatchObject({
    name: "Equipment register (copy 2)",
    is_default: false,
    definition: { search: "draft query" },
    presentation: { layout: "grid" },
    can_edit: true,
  });
  expect(api.saved()).toMatchObject({
    name: "Equipment register",
    definition: { search: "pump" },
  });
});

test("duplicating a long Unicode view keeps the copy name within the API limit", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialName: "🚜".repeat(100) });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await openViewAction(page, "Duplicate view");

  await expect(
    page.getByRole("status").filter({ hasText: "was duplicated" }),
  ).toBeVisible();
  expect(api.createdViews()).toHaveLength(1);
  expect(api.createdViews()[0].name.length).toBeLessThanOrEqual(200);
  expect(api.createdViews()[0].name.endsWith(" (copy)")).toBe(true);
});

test("resetting changes restores the saved base or clears an unsaved draft", async ({
  page,
}) => {
  const api = await installViewsApi(page);

  await page.goto(`/openview?section=views&module=${moduleId}`);
  const search = page.getByRole("searchbox", { name: "Search Equipment" });
  await expectLayoutFromSettings(page, "table");
  await search.fill("unsaved draft");
  await setLayoutFromSettings(page, "grid");
  await page.getByRole("button", { name: "Reset changes" }).click();
  await expect(search).toHaveValue("");
  await expectLayoutFromSettings(page, "table");
  await expect(page.getByText("Temporary changes")).toHaveCount(0);
  await expect(page).toHaveURL(`/openview?section=views&module=${moduleId}`);

  await page.getByRole("combobox", { name: "Saved view" }).selectOption(viewId);
  await expect(search).toHaveValue("pump");
  await search.fill("saved draft");
  await setLayoutFromSettings(page, "grid");
  await page.getByRole("button", { name: "Reset changes" }).click();

  await expect(search).toHaveValue("pump");
  await expectLayoutFromSettings(page, "table");
  await expect(page.getByText("Temporary changes")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    viewId,
  );
  await expect(page).toHaveURL(
    `/openview?section=views&module=${moduleId}&view=${viewId}`,
  );
  expect(api.saved()).toMatchObject({
    definition: { search: "pump" },
    presentation: { layout: "table" },
  });
});

test("temporary View changes live in the address, survive reload, and are never saved", async ({
  page,
}) => {
  const api = await installViewsApi(page);
  const viewWrites: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/views") && request.method() !== "GET")
      viewWrites.push(`${request.method()} ${path}`);
  });
  const viewUrl = `/openview?section=views&module=${moduleId}&view=${viewId}`;
  await page.goto(viewUrl);
  const search = page.getByRole("searchbox", { name: "Search Equipment" });
  await expect(search).toHaveValue("pump");

  await search.fill("valve");
  await setLayoutFromSettings(page, "grid");
  await expect(page).toHaveURL(/[?&]changes=[A-Za-z0-9_-]+/);
  const temporaryUrl = page.url();
  expect(new URL(temporaryUrl).searchParams.get("view")).toBe(viewId);

  await page.reload();
  await expect(search).toHaveValue("valve");
  await expectLayoutFromSettings(page, "grid");
  await expect(page.getByText("Temporary changes")).toBeVisible();

  await page.getByRole("button", { name: "Reset changes" }).click();
  await expect(search).toHaveValue("pump");
  await expect(page).toHaveURL(viewUrl);
  expect(viewWrites).toEqual([]);
  expect(api.saved()).toMatchObject({
    definition: { search: "pump" },
    presentation: { layout: "table" },
  });
});

test("a reader keeps temporary View filters in the address without save controls", async ({
  page,
}) => {
  await installViewsApi(page);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: userId,
        role: "member",
        access: [
          { department_id: departmentId, module_id: null, level: "read" },
        ],
      },
    }),
  );
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const search = page.getByRole("searchbox", { name: "Search Equipment" });
  await expect(search).toHaveValue("pump");
  await search.fill("valve");
  await expect(page).toHaveURL(/[?&]changes=/);
  await expect(page.getByRole("button", { name: /^Save view/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "View actions" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Archived views" }),
  ).toBeVisible();
  await expect(page.getByText("Temporary changes")).toBeVisible();
  await expect(
    page.getByText(/These changes live in the page address/),
  ).toBeVisible();
  await page.reload();
  await expect(search).toHaveValue("valve");
  await expect(page.getByText("Temporary changes")).toBeVisible();
});

test("a module reader can browse archived Views without a Restore action", async ({
  page,
}) => {
  await installViewsApi(page, {
    additionalViews: [
      {
        ...baseView(),
        id: secondViewId,
        name: "Old equipment view",
        is_deleted: true,
        can_edit: true,
      },
    ],
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: userId,
        role: "member",
        access: [
          { department_id: departmentId, module_id: null, level: "read" },
        ],
      },
    }),
  );
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await page.getByRole("button", { name: /Archived views/ }).click();
  const dialog = page.getByRole("dialog", { name: "Archived views" });
  await expect(dialog.getByText("Old equipment view")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Restore Old equipment view" }),
  ).toHaveCount(0);
});

test("a malformed temporary View address is ignored and removed", async ({
  page,
}) => {
  await installViewsApi(page);
  const viewUrl = `/openview?section=views&module=${moduleId}&view=${viewId}`;
  await page.goto(`${viewUrl}&changes=not-a-view`);
  await expect(
    page.getByRole("searchbox", { name: "Search Equipment" }),
  ).toHaveValue("pump");
  await expect(page).toHaveURL(viewUrl);
  await expect(page.getByText("Temporary changes")).toHaveCount(0);
});

test("saved Views send, save, and reload up to three ordered sort rules", async ({
  page,
}) => {
  const api = await installViewsApi(page, { disableInitialSearch: true });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const settings = await openLayoutSettings(page);
  const addSort = page.getByRole("button", { name: "Add sort rule" });
  await addSort.click();
  await page.getByLabel("Sort field 1").selectOption(statusFieldId);
  await page.getByLabel("Sort direction 1").selectOption("desc");
  await addSort.click();
  await page.getByLabel("Sort field 2").selectOption(nameFieldId);
  await page.getByLabel("Sort direction 2").selectOption("asc");
  await addSort.click();
  await page.getByLabel("Sort field 3").selectOption(serialFieldId);
  await page.getByLabel("Sort direction 3").selectOption("desc");
  await expect(addSort).toBeDisabled();

  const expectedSort = [
    { field_id: statusFieldId, expected_type: "select", direction: "desc" },
    { field_id: nameFieldId, expected_type: "text", direction: "asc" },
    { field_id: serialFieldId, expected_type: "text", direction: "desc" },
  ];
  await expect
    .poll(() => api.recordQueryRequests.at(-1)?.definition.sort)
    .toEqual(expectedSort);
  await closeDialog(settings);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "was saved" }),
  ).toBeVisible();
  expect(api.saved().definition.sort).toEqual(expectedSort);

  await page.reload();
  const reloadedSettings = await openLayoutSettings(page);
  await expect(reloadedSettings.getByLabel("Sort field 1")).toHaveValue(
    statusFieldId,
  );
  await expect(reloadedSettings.getByLabel("Sort direction 1")).toHaveValue(
    "desc",
  );
  await expect(reloadedSettings.getByLabel("Sort field 2")).toHaveValue(
    nameFieldId,
  );
  await expect(reloadedSettings.getByLabel("Sort direction 2")).toHaveValue(
    "asc",
  );
  await expect(reloadedSettings.getByLabel("Sort field 3")).toHaveValue(
    serialFieldId,
  );
  await expect(reloadedSettings.getByLabel("Sort direction 3")).toHaveValue(
    "desc",
  );
  await expect(
    reloadedSettings.getByRole("button", { name: "Add sort rule" }),
  ).toBeDisabled();
  await closeDialog(reloadedSettings);

  await page.getByRole("combobox", { name: "Sort" }).selectOption("");
  await expect
    .poll(() => api.recordQueryRequests.at(-1)?.definition.sort)
    .toEqual([]);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => api.saved().definition.sort).toEqual([]);
});

for (const layout of ["table", "grid", "gallery"] as const) {
  test(`${layout} grouping uses server counts and separately paginates selected records`, async ({
    page,
  }) => {
    const api = await installViewsApi(page, { disableInitialSearch: true });

    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const settings = await openLayoutSettings(page);
    await settings.getByLabel("Presentation layout").selectOption(layout);
    await settings.getByLabel("Group records by").selectOption(statusFieldId);
    await closeDialog(settings);

    const group = page.getByRole("button", {
      name: "In service, 38 records",
    });
    await expect(group).toBeVisible();
    await expect(group).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("Groups 1–1 of 1").first()).toBeVisible();
    const ordinaryRequestCount = api.recordQueryRequests.length;
    expect(api.groupedQueryRequests.at(-1)).toMatchObject({
      group_by: { field_id: statusFieldId, expected_type: "select" },
      limit: 25,
      offset: 0,
      group_limit: 12,
      group_offset: 0,
      selected_group: null,
    });
    await group.click();
    await expect(group).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Showing 1–25 of 38")).toBeVisible();
    if (layout === "table") {
      await expect(page.getByRole("table").getByRole("row")).toHaveCount(26);
    } else {
      await expect(
        page
          .getByRole("list", {
            name: layout === "grid" ? "Grid records" : "Gallery records",
          })
          .getByRole("listitem"),
      ).toHaveCount(25);
    }
    expect(api.groupedQueryRequests.at(-1)).toMatchObject({
      limit: 25,
      offset: 0,
      group_offset: 0,
      selected_group: { kind: "value", value: inServiceChoiceId },
    });
    expect(api.recordQueryRequests).toHaveLength(ordinaryRequestCount);

    if (layout === "table") api.failNextGroupedQuery();
    await page
      .getByRole("navigation", { name: "Record result pages" })
      .getByRole("button", { name: "Go to next page" })
      .click();
    if (layout === "table") {
      const grouping = page.getByRole("region", {
        name: "Grouping results",
        exact: true,
      });
      await expect(grouping.getByRole("alert")).toHaveAttribute(
        "data-variant",
        "destructive",
      );
      await expect(grouping.getByRole("alert")).toContainText(
        "Grouped records could not be loaded.",
      );
      await expect(grouping).not.toContainText(
        "Private grouped failure canary",
      );
      await expect(
        grouping.getByText("No groups match this view.", { exact: true }),
      ).toHaveCount(0);
      await grouping
        .getByRole("button", { name: "Retry group records", exact: true })
        .click();
    }
    await expect(page.getByText("Showing 26–38 of 38")).toBeVisible();
    if (layout === "table") {
      await expect(page.getByRole("table").getByRole("row")).toHaveCount(14);
    } else {
      await expect(
        page
          .getByRole("list", {
            name: layout === "grid" ? "Grid records" : "Gallery records",
          })
          .getByRole("listitem"),
      ).toHaveCount(13);
    }
    expect(api.groupedQueryRequests.at(-1)).toMatchObject({
      limit: 25,
      offset: 25,
      group_offset: 0,
      selected_group: { kind: "value", value: inServiceChoiceId },
    });
    expect(api.recordQueryRequests).toHaveLength(ordinaryRequestCount);
    if (layout === "table") {
      await page
        .getByRole("table")
        .getByRole("row")
        .nth(1)
        .getByRole("button", { name: "In service" })
        .click();
      const inspector = page.getByRole("dialog", { name: "Record details" });
      await expect(
        inspector.getByRole("heading", { name: "In service" }),
      ).toBeVisible();
      await inspector.getByRole("button", { name: "Previous record" }).click();
      await expect(page).toHaveURL(
        /record=00000000-0000-4000-8000-000000000124/,
      );
      await inspector.getByRole("button", { name: "Next record" }).click();
      await expect(page).toHaveURL(
        /record=00000000-0000-4000-8000-000000000125/,
      );
      expect(api.groupedQueryRequests.slice(-2)).toMatchObject([
        {
          offset: 0,
          selected_group: { kind: "value", value: inServiceChoiceId },
        },
        {
          offset: 25,
          selected_group: { kind: "value", value: inServiceChoiceId },
        },
      ]);
    }
  });
}

for (const layout of ["calendar", "timeline"] as const) {
  test(`${layout} preserves saved general grouping as inactive while querying its window`, async ({
    page,
  }) => {
    const api = await installViewsApi(page, {
      initialLayout: layout,
      initialGroupByFieldId: statusFieldId,
    });

    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const settings = await openLayoutSettings(page);
    const layoutLabel = layout === "calendar" ? "Calendar" : "Timeline";
    await expect(
      settings.getByText(
        `General grouping is inactive in ${layoutLabel}; the saved group field is preserved.`,
      ),
    ).toBeVisible();
    await expect(settings.getByLabel("Group records by")).toHaveCount(0);
    await closeDialog(settings);

    await page.getByLabel("Window starts").fill("2026-09-01");
    await page.getByLabel("Window ends").fill("2026-09-30");
    await expect
      .poll(() => api.windowQueryRequests.at(-1))
      .toMatchObject({
        mode: layout,
        scope: "window",
        from_date: "2026-09-01",
        to_date: "2026-09-30",
      });
    expect(api.groupedQueryRequests).toHaveLength(0);
    expect(api.saved().presentation.group_by_field_id).toBe(statusFieldId);
  });
}

test("saved table presentation controls persist and drive the rendered table", async ({
  page,
}) => {
  const longName =
    "Centrifugal pump assembly with a deliberately long equipment description";
  const api = await installViewsApi(page, {
    cardFieldsNotInColumns: true,
    disableInitialSearch: true,
    recordName: longName,
    initialPresentation: {
      column_field_ids: [nameFieldId, statusFieldId, serialFieldId],
      pinned_field_ids: [],
      density: "comfortable",
      wrap: false,
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText([
    "Equipment name",
    "Status",
    "Serial number",
    "Updated",
  ]);
  const longCell = table.getByRole("cell").filter({ hasText: longName });
  // Measure painted text against its own cell, allowing any local clipping
  // mechanism. Page scroll width alone cannot detect overlap into a neighbour.
  const noWrapBounds = await longCell.evaluate((cell) => {
    const value = cell.querySelector("button") ?? cell;
    const range = document.createRange();
    range.selectNodeContents(value);
    let paintedRight = range.getBoundingClientRect().right;
    for (
      let ancestor: Element | null = value;
      ancestor && cell.contains(ancestor);
      ancestor = ancestor.parentElement
    ) {
      if (getComputedStyle(ancestor).overflowX !== "visible")
        paintedRight = Math.min(
          paintedRight,
          ancestor.getBoundingClientRect().right,
        );
    }
    return {
      rawText: cell.textContent,
      paintedRight,
      cellRight: cell.getBoundingClientRect().right,
    };
  });
  await test.info().attach("table-no-wrap-paint-bounds", {
    body: JSON.stringify(noWrapBounds),
    contentType: "application/json",
  });
  expect(noWrapBounds.rawText).toBe(longName);
  expect(noWrapBounds.paintedRight).toBeLessThanOrEqual(noWrapBounds.cellRight);

  const columnsDialog = await openColumns(page);
  await columnsDialog.getByRole("button", { name: "Move Status up" }).click();
  await columnsDialog.getByRole("checkbox", { name: "Pin Status" }).click();
  await columnsDialog
    .getByRole("checkbox", { name: "Show Serial number" })
    .click();
  await columnsDialog.getByLabel("Row density").selectOption("compact");
  await columnsDialog.getByRole("checkbox", { name: "Wrap long text" }).click();
  await closeDialog(columnsDialog);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "“Equipment register” was saved.",
    }),
  ).toBeVisible();
  expect(api.saved().presentation).toMatchObject({
    column_field_ids: [statusFieldId, nameFieldId],
    pinned_field_ids: [statusFieldId],
    density: "compact",
    wrap: true,
  });

  await page.reload();
  await expect(table.getByRole("columnheader")).toHaveText([
    "Status",
    "Equipment name",
    "Updated",
  ]);
  const reloadedColumns = await openColumns(page);
  await expect(
    reloadedColumns.getByRole("checkbox", { name: "Show Serial number" }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    reloadedColumns.getByRole("checkbox", { name: "Pin Status" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(reloadedColumns.getByLabel("Row density")).toHaveValue(
    "compact",
  );
  await expect(
    reloadedColumns.getByRole("checkbox", { name: "Wrap long text" }),
  ).toHaveAttribute("aria-checked", "true");
  await closeDialog(reloadedColumns);

  const pinnedHeader = table.getByRole("columnheader", { name: "Status" });
  const pinnedCell = table
    .getByRole("rowgroup")
    .nth(1)
    .getByRole("row")
    .first()
    .getByRole("cell")
    .first();
  await expect(pinnedHeader).toHaveCSS("position", "sticky");
  await expect(pinnedHeader).toHaveCSS("left", "0px");
  await expect(pinnedCell).toHaveCSS("position", "sticky");
  await expect(pinnedCell).toHaveCSS("left", "0px");
  const initialPinnedLeft = await pinnedHeader.evaluate(
    (element) => element.getBoundingClientRect().left,
  );
  const scrolled = await table.evaluate((element) => {
    const container = element.parentElement;
    if (!container) return false;
    container.scrollLeft = container.scrollWidth;
    return container.scrollLeft > 0;
  });
  expect(scrolled).toBe(true);
  await expect
    .poll(() =>
      pinnedHeader.evaluate((element) => element.getBoundingClientRect().left),
    )
    .toBe(initialPinnedLeft);

  const firstDataRow = table
    .getByRole("rowgroup")
    .nth(1)
    .getByRole("row")
    .first();
  await expect(firstDataRow.getByRole("cell").first()).toHaveCSS(
    "padding-top",
    "6px",
  );
  await expect(firstDataRow.getByRole("cell").nth(1)).toHaveCSS(
    "white-space",
    "normal",
  );
  await expect(firstDataRow.getByText(longName)).toBeVisible();
});

for (const layout of ["grid", "gallery"] as const) {
  test(`${layout} consumes saved card fields, wrapping, and size after reload`, async ({
    page,
  }) => {
    const longName =
      "Centrifugal pump assembly with a deliberately long equipment description";
    const api = await installViewsApi(page, {
      cardFieldsNotInColumns: true,
      disableInitialSearch: true,
      recordName: longName,
      initialPresentation: {
        layout,
        column_field_ids: [
          nameFieldId,
          statusFieldId,
          unselectedQueryFieldId,
          serialFieldId,
        ],
        pinned_field_ids: [],
        primary_field_id: nameFieldId,
        secondary_field_id: null,
        card_size: "comfortable",
        wrap: false,
      },
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const records = page.getByRole("list", {
      name: layout === "grid" ? "Grid records" : "Gallery records",
    });
    const firstCard = records
      .getByRole("listitem")
      .first()
      .getByRole("article");
    await expect(
      firstCard.getByRole("button", {
        name: `Open record: ${longName}`,
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await firstCard.locator("dt").allTextContents()).map((text) =>
        text.trim(),
      ),
    ).toEqual(["Status", "Unselected query field", "Serial number"]);

    const columnsDialog = await openColumns(page);
    await columnsDialog
      .getByRole("button", { name: "Move Serial number up" })
      .click();
    const hiddenDetail = columnsDialog.getByRole("checkbox", {
      name: "Show Unselected query field",
    });
    await hiddenDetail.click();
    await expect(hiddenDetail).toHaveAttribute("aria-checked", "false");
    await columnsDialog.getByLabel("Card size").selectOption("compact");
    await columnsDialog
      .getByRole("checkbox", { name: "Wrap long text" })
      .click();
    await closeDialog(columnsDialog);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("status").filter({
        hasText: "“Equipment register” was saved.",
      }),
    ).toBeVisible();
    expect(api.saved().presentation).toMatchObject({
      column_field_ids: [nameFieldId, statusFieldId, serialFieldId],
      card_size: "compact",
      wrap: true,
    });

    await page.reload();
    const reloadedColumns = await openColumns(page);
    await expect(reloadedColumns.getByLabel("Card size")).toHaveValue(
      "compact",
    );
    await expect(
      reloadedColumns.getByRole("checkbox", { name: "Wrap long text" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      reloadedColumns.getByRole("checkbox", {
        name: "Show Unselected query field",
      }),
    ).toHaveAttribute("aria-checked", "false");
    await closeDialog(reloadedColumns);

    const firstVisibleCard = records.getByRole("listitem").first();
    const article = firstVisibleCard.getByRole("article");
    await expect(article).toHaveCSS("padding-top", "12px");
    const title = firstVisibleCard.getByRole("button", {
      name: `Open record: ${longName}`,
      exact: true,
    });
    await expect(title.locator("span")).toHaveCSS("white-space", "normal");
    expect(
      (await firstVisibleCard.locator("dt").allTextContents()).map((text) =>
        text.trim(),
      ),
    ).toEqual(["Status", "Serial number"]);
    await expect(
      firstVisibleCard.getByText("Unselected query field"),
    ).toHaveCount(0);
  });
}

test("Grid and Gallery use the current server page and save only the selected layout", async ({
  page,
}) => {
  const api = await installViewsApi(page, { cardFieldsNotInColumns: true });
  const initialPresentation = structuredClone(api.saved().presentation);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(
    page.getByRole("heading", { name: "Equipment register" }),
  ).toBeVisible();

  const layout = page.getByRole("combobox", { name: "Layout" });
  await expect(layout).toHaveValue("table");
  await page.getByRole("searchbox", { name: "Search Equipment" }).fill("");
  await expect(
    page.getByText("30 matching records · live workspace data"),
  ).toBeVisible();
  await layout.selectOption("grid");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toBeVisible();

  expect(api.saved().presentation).toMatchObject({
    ...initialPresentation,
    layout: "grid",
  });
  const grid = page.getByRole("list", { name: "Grid records" });
  await expect(grid.getByRole("listitem")).toHaveCount(25);
  const firstGridRecord = grid.getByRole("listitem").first();
  await expect(
    firstGridRecord.getByRole("button", {
      name: "Open record: S",
      exact: true,
    }),
  ).toBeVisible();
  await expect(firstGridRecord.getByText("Status: In service")).toBeVisible();
  await expect(
    grid.getByText("Do not surface this query-only field", { exact: true }),
  ).toHaveCount(0);
  const shortTitle = firstGridRecord.getByRole("button", {
    name: "Open record: S",
    exact: true,
  });
  const shortTitleBounds = await shortTitle.boundingBox();
  expect(shortTitleBounds?.width).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByText("Showing 1–25 of 30")).toBeVisible();

  await layout.selectOption("gallery");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toBeVisible();
  expect(api.saved().presentation).toMatchObject({
    ...initialPresentation,
    layout: "gallery",
  });
  const gallery = page.getByRole("list", { name: "Gallery records" });
  await expect(gallery.getByRole("listitem")).toHaveCount(25);
  await expect(
    gallery.getByRole("listitem").first().getByText("Status: In service"),
  ).toBeVisible();
  await expect(
    gallery.getByText("Do not surface this query-only field", { exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(page.getByText("Showing 26–30 of 30")).toBeVisible();
  await expect(gallery.getByRole("listitem")).toHaveCount(5);
  await gallery.getByRole("button", { name: "Open record: SN-55" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`record=00000000-0000-4000-8000-000000000055`),
  );
});

test("Views exposes its filter, column, and layout editors on demand", async ({
  page,
}) => {
  const api = await installViewsApi(page, {
    disableInitialSearch: true,
    cardFieldsNotInColumns: true,
  });
  await page.goto(
    "/openview?section=views&module=" + moduleId + "&view=" + viewId,
  );

  const initialRevision = api.saved().revision;
  for (const layout of [
    "Table",
    "Grid",
    "Gallery",
    "Kanban",
    "Calendar",
    "Timeline",
  ]) {
    await expect(
      page.getByRole("tab", { name: layout, exact: true }),
    ).toBeVisible();
  }
  const sort = page.getByRole("combobox", { name: "Sort" });
  await sort.selectOption(statusFieldId + ":desc");
  await expect
    .poll(() =>
      api.recordQueryRequests.some(
        ({ definition }) =>
          definition.sort[0]?.field_id === statusFieldId &&
          definition.sort[0]?.direction === "desc",
      ),
    )
    .toBe(true);

  const columnsDialog = page.getByRole("dialog", { name: "Columns" });
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await expect(columnsDialog).toBeVisible();
  await columnsDialog.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByText("Temporary changes", { exact: true }),
  ).toHaveCount(1);
  expect(api.saved().revision).toBe(initialRevision);

  const filtersRegion = await openFilters(page);

  await filtersRegion.getByRole("button", { name: "Add filter" }).click();
  await filtersRegion
    .getByRole("combobox", { name: "Field", exact: true })
    .selectOption(statusFieldId);
  await filtersRegion
    .getByRole("combobox", { name: "Condition" })
    .selectOption("eq");
  await filtersRegion.getByLabel("Value").selectOption(inspectionDueChoiceId);
  await expect
    .poll(() =>
      api.recordQueryRequests.some(({ definition }) =>
        definition.filters.some(
          (filter) =>
            filter.field_id === statusFieldId &&
            filter.operator === "eq" &&
            filter.value === inspectionDueChoiceId,
        ),
      ),
    )
    .toBe(true);
  await expect(
    page.getByText("Status is Inspection due", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "More filters" }),
  ).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await expect(columnsDialog).toBeVisible();
  await columnsDialog
    .getByRole("checkbox", { name: "Show Serial number" })
    .click();
  await columnsDialog.getByRole("button", { name: "Close" }).click();

  const layoutDialog = page.getByRole("dialog", { name: "Layout settings" });
  await page
    .getByRole("button", { name: "Layout settings", exact: true })
    .click();
  await expect(layoutDialog).toBeVisible();
  await layoutDialog.getByRole("button", { name: "Add sort rule" }).click();
  await layoutDialog.getByLabel("Sort field 2").selectOption(serialFieldId);
  await layoutDialog.getByLabel("Sort direction 2").selectOption("asc");
  await layoutDialog.getByRole("button", { name: "Close" }).click();

  expect(api.saved().revision).toBe(1);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => api.saved().revision).toBe(2);
  expect(api.saved().definition.filters).toEqual([
    {
      field_id: statusFieldId,
      expected_type: "select",
      operator: "eq",
      value: inspectionDueChoiceId,
    },
  ]);
  expect(api.saved().definition.sort).toEqual([
    { field_id: statusFieldId, expected_type: "select", direction: "desc" },
    { field_id: serialFieldId, expected_type: "text", direction: "asc" },
  ]);
  expect(api.saved().presentation.column_field_ids).toEqual([
    nameFieldId,
    serialFieldId,
  ]);
});

for (const layout of ["calendar", "timeline"] as const) {
  test(`${layout} record details navigate across the server page and close back to it`, async ({
    page,
  }) => {
    const api = await installViewsApi(page, { initialLayout: layout });
    await page.goto(
      "/openview?section=views&module=" + moduleId + "&view=" + viewId,
    );
    await page.getByLabel("Window starts").fill("2026-09-01");
    await page.getByLabel("Window ends").fill("2026-09-30");
    await expect(
      page.getByRole("button", { name: "Open record: Window equipment 25" }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Open record: Window equipment 25" })
      .click();
    const details = page.getByRole("dialog", { name: "Record details" });
    await expect(
      details.getByRole("heading", { name: "Window equipment 25" }),
    ).toBeVisible();
    await expect(
      details.getByRole("button", { name: "Next record" }),
    ).toBeEnabled();
    await details.getByRole("button", { name: "Next record" }).click();
    await expect(
      details.getByRole("heading", { name: "Window equipment 26" }),
    ).toBeVisible();
    await expect.poll(() => api.windowQueryRequests.at(-1)?.offset).toBe(25);

    await details.getByRole("button", { name: "Close" }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("record"))
      .toBeNull();
    await expect(
      page.getByRole("button", { name: "Open record: Window equipment 26" }),
    ).toBeVisible();
    await expect(
      page.getByText("Showing 26–26 of 26 matching records"),
    ).toBeVisible();
  });
}

test("Views inspector follows the filtered page in both directions and reopens safe links through record authorization", async ({
  page,
}) => {
  const api = await installViewsApi(page, { disableInitialSearch: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(page.getByText("Showing 1–25 of 30")).toBeVisible();

  await page.getByRole("button", { name: "Equipment 25", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Record details" });
  await expect(
    inspector.getByRole("heading", { name: "Equipment 25" }),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "Next record" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Equipment 26" }),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Showing 26–30 of 30")).toBeVisible();
  await page.getByRole("button", { name: "Equipment 26", exact: true }).click();
  await inspector.getByRole("button", { name: "Previous record" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Equipment 25" }),
  ).toBeVisible();
  const resultOffsets = api.recordQueryRequests
    .filter(({ definition }) => definition.search === null)
    .map(({ offset }) => offset);
  expect(resultOffsets).toContain(25);
  expect(resultOffsets.at(-1)).toBe(0);
  expect(api.saved().definition.search).toBeNull();

  await page.evaluate(() => {
    const copiedWindow = window as Window & { copiedSafeLink?: string };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copiedWindow.copiedSafeLink = value;
        },
      },
    });
  });
  await inspector.getByRole("button", { name: "Copy safe link" }).click();
  const copiedLink = await page.evaluate(
    () => (window as Window & { copiedSafeLink?: string }).copiedSafeLink,
  );
  expect(copiedLink).toBe(page.url());
  if (!copiedLink) throw new Error("The safe link was not copied");
  const copiedUrl = new URL(copiedLink);
  expect([...copiedUrl.searchParams.keys()]).toEqual([
    "section",
    "module",
    "view",
    "record",
  ]);

  await page.goto(copiedLink);
  await expect(
    inspector.getByRole("heading", { name: "Equipment 25" }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Next record" }),
  ).toHaveCount(0);
  api.denyRecordId("00000000-0000-4000-8000-000000000054");
  await page.reload();
  await expect(inspector.getByText("This record is unavailable")).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Equipment 25" }),
  ).toHaveCount(0);
});

test("Views page size drives server offsets and inspector adjacency", async ({
  page,
}) => {
  const api = await installViewsApi(page, { disableInitialSearch: true });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);

  const results = page.getByRole("region", { name: "Record results" });
  const pageSize = results.getByLabel("Rows per page");
  await expect(pageSize).toHaveValue("25");
  await expect(pageSize.locator("option")).toHaveText(["5", "10", "25", "50"]);
  await pageSize.selectOption("5");
  await expect.poll(() => api.recordQueryRequests.at(-1)?.limit).toBe(5);
  expect(api.recordQueryRequests.at(-1)).toMatchObject({
    limit: 5,
    offset: 0,
  });
  await expect(results.getByText("Showing 1–5 of 30")).toBeVisible();

  const resultPages = page.getByRole("navigation", {
    name: "Record result pages",
  });
  await resultPages.getByRole("button", { name: "Go to next page" }).click();
  await expect.poll(() => api.recordQueryRequests.at(-1)?.offset).toBe(5);
  expect(api.recordQueryRequests.at(-1)).toMatchObject({
    limit: 5,
    offset: 5,
  });
  await expect(results.getByText("Showing 6–10 of 30")).toBeVisible();

  await pageSize.selectOption("10");
  await expect.poll(() => api.recordQueryRequests.at(-1)?.limit).toBe(10);
  expect(api.recordQueryRequests.at(-1)).toMatchObject({
    limit: 10,
    offset: 0,
  });
  await expect(results.getByText("Showing 1–10 of 30")).toBeVisible();

  await resultPages.getByRole("button", { name: "Go to next page" }).click();
  await expect(results.getByText("Showing 11–20 of 30")).toBeVisible();
  await page.getByRole("button", { name: "Equipment 20", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Record details" });
  const requestsBeforeNextRecord = api.recordQueryRequests.length;
  await inspector.getByRole("button", { name: "Next record" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Equipment 21" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      api.recordQueryRequests
        .slice(requestsBeforeNextRecord)
        .some(({ limit, offset }) => limit === 10 && offset === 20),
    )
    .toBe(true);

  const requestsBeforePreviousRecord = api.recordQueryRequests.length;
  await inspector.getByRole("button", { name: "Previous record" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Equipment 20" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      api.recordQueryRequests
        .slice(requestsBeforePreviousRecord)
        .some(({ limit, offset }) => limit === 10 && offset === 10),
    )
    .toBe(true);
  await inspector.getByRole("button", { name: "Close" }).click();
  await expect(results.getByText("Showing 11–20 of 30")).toBeVisible();
});

test("Views grouped member page size preserves twelve-group directory paging", async ({
  page,
}) => {
  const api = await installViewsApi(page, { disableInitialSearch: true });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);

  const settings = await openLayoutSettings(page);
  await settings.getByLabel("Group records by").selectOption(statusFieldId);
  await closeDialog(settings);
  const group = page.getByRole("button", {
    name: "In service, 38 records",
  });
  await expect(group).toBeVisible();
  await expect(page.getByText("Groups 1–1 of 1").first()).toBeVisible();
  await group.click();

  const results = page.getByRole("region", { name: "Record results" });
  await results.getByLabel("Rows per page").selectOption("5");
  await expect.poll(() => api.groupedQueryRequests.at(-1)?.limit).toBe(5);
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    limit: 5,
    offset: 0,
    group_limit: 12,
    group_offset: 0,
    selected_group: { kind: "value", value: inServiceChoiceId },
  });
  await expect(results.getByText("Showing 1–5 of 38")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Record result pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect.poll(() => api.groupedQueryRequests.at(-1)?.offset).toBe(5);
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    limit: 5,
    offset: 5,
    group_limit: 12,
    group_offset: 0,
    selected_group: { kind: "value", value: inServiceChoiceId },
  });
  await expect(results.getByText("Showing 6–10 of 38")).toBeVisible();
  await expect(page.getByText("Groups 1–1 of 1").first()).toBeVisible();
});

test("Views inspector does not reveal a stale list row before record authorization finishes", async ({
  page,
}) => {
  const api = await installViewsApi(page, { disableInitialSearch: true });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(
    page.getByRole("button", { name: "Centrifugal pump 04" }),
  ).toBeVisible();

  api.denyRecordId(recordOneId);
  const lookup = api.pauseNextRecordLookup();
  await page.getByRole("button", { name: "Centrifugal pump 04" }).click();
  await lookup.started;
  const inspector = page.getByRole("dialog", { name: "Record details" });
  await expect(inspector.getByText("Loading linked record…")).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Centrifugal pump 04" }),
  ).toHaveCount(0);
  lookup.release();
  await expect(inspector.getByText("This record is unavailable")).toBeVisible();
});

test("closing record details returns to the page reached through inspector navigation", async ({
  page,
}) => {
  await installViewsApi(page, { disableInitialSearch: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(page.getByText("Showing 1–25 of 30")).toBeVisible();

  await page.getByRole("button", { name: "Equipment 25", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Record details" });
  await inspector.getByRole("button", { name: "Next record" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Equipment 26" }),
  ).toBeVisible();
  await expect(
    inspector.getByText(
      "Showing this linked record. The saved view query remains unchanged.",
    ),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "Close" }).click();

  await expect(page.getByText("Showing 26–30 of 30")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Equipment 26", exact: true }),
  ).toBeVisible();
});

test("Kanban uses paginated server lane counts and only pages the selected lane", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialLayout: "kanban" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const settings = await openLayoutSettings(page);
  const groupField = settings.getByRole("combobox", { name: "Group lanes by" });
  await expect(groupField).toBeVisible();
  await expect(
    groupField.getByRole("option", { name: "Serial number" }),
  ).toHaveCount(0);
  let lanesUnavailable = true;
  // Keep the dependency unavailable across draft-driven reads until explicit recovery.
  await page.route("**/api/records/grouped-query", (route) => {
    if (lanesUnavailable)
      return route.fulfill({
        status: 500,
        json: { detail: "Private grouped failure canary" },
      });
    return route.fallback();
  });
  await groupField.selectOption(nameFieldId);
  await closeDialog(settings);
  const kanban = page.getByRole("region", {
    name: "Kanban results",
    exact: true,
  });
  await expect(kanban.getByRole("alert")).toContainText(
    "The last successful page remains visible when available.",
  );
  // New presentation check is soft so the same RED also reaches privacy.
  await expect
    .soft(kanban.getByRole("alert"))
    .toHaveAttribute("data-variant", "destructive");
  await expect(kanban).not.toContainText("Private grouped failure canary");
  await expect(kanban.getByRole("alert")).toContainText(
    "Kanban lanes could not be loaded.",
  );
  await expect(
    kanban.getByText("No lanes match this view.", { exact: true }),
  ).toHaveCount(0);
  lanesUnavailable = false;
  await kanban
    .getByRole("button", { name: "Retry lanes", exact: true })
    .click();
  await expect(page.getByText("Lanes 1–12 of 13").first()).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toBeVisible();
  expect(api.saved().presentation).toMatchObject({
    layout: "kanban",
    group_by_field_id: nameFieldId,
  });

  await expect(page.getByText("Lanes 1–12 of 13").first()).toBeVisible();
  expect(api.groupedQueryRequests[0]).toMatchObject({
    group_by: { field_id: nameFieldId, expected_type: "text" },
    limit: 25,
    offset: 0,
    group_limit: 12,
    group_offset: 0,
    selected_group: null,
  });
  await page
    .getByRole("navigation", { name: "Kanban lane pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(page.getByText("Lanes 13–13 of 13").first()).toBeVisible();
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    group_offset: 12,
    selected_group: null,
  });
  const lane = page.getByRole("button", {
    name: "In service, 26 records",
  });
  await expect(lane).toBeVisible();
  expect((await lane.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await lane.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Showing 1–25 of 26 records").first(),
  ).toBeVisible();
  const laneRecords = page.getByRole("list", { name: "Kanban lane records" });
  await expect(laneRecords.getByRole("listitem")).toHaveCount(25);
  await expect(
    laneRecords.getByText("Do not surface this query-only field", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    limit: 25,
    offset: 0,
    group_limit: 12,
    group_offset: 12,
    selected_group: { kind: "value", value: "In service" },
  });
  api.failNextGroupedQuery();
  await page
    .getByRole("navigation", { name: "Kanban lane record pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(kanban.getByRole("alert")).toHaveAttribute(
    "data-variant",
    "destructive",
  );
  await expect(kanban.getByRole("alert")).toContainText(
    "Kanban lanes could not be loaded.",
  );
  await expect(kanban).not.toContainText("Private grouped failure canary");
  await expect(
    page.getByText("Showing 1–25 of 26 records").first(),
  ).toBeVisible();
  await expect(laneRecords.getByRole("listitem")).toHaveCount(25);
  await page.getByRole("button", { name: "Retry lane records" }).click();
  await expect(
    page.getByText("Showing 26–26 of 26 records").first(),
  ).toBeVisible();
  await expect(laneRecords.getByRole("listitem")).toHaveCount(1);
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    offset: 25,
    group_offset: 12,
    selected_group: { kind: "value", value: "In service" },
  });
  expect(api.recordQueryRequests).toHaveLength(0);

  const groupedRequestsBeforeInvalidation = api.groupedQueryRequests.length;
  await api.triggerInvalidation("records");
  await expect
    .poll(() => api.groupedQueryRequests.length)
    .toBe(groupedRequestsBeforeInvalidation + 1);
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    offset: 25,
    group_offset: 12,
    selected_group: { kind: "value", value: "In service" },
  });

  const linkedRecordId = "00000000-0000-4000-8000-000000000125";
  const groupedRequestCount = api.groupedQueryRequests.length;
  await laneRecords
    .getByRole("button", { name: "Open record: In service" })
    .click();
  await expect(page).toHaveURL(new RegExp(`record=${linkedRecordId}`));
  const linkedRecord = page.getByRole("dialog", { name: "Record details" });
  await expect(linkedRecord).toBeVisible();
  await expect(
    linkedRecord.getByRole("heading", { name: "In service" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Kanban lanes and counts continue to use the saved view query.",
    ),
  ).toBeVisible();
  expect(api.recordQueryRequests).toHaveLength(1);
  expect(api.groupedQueryRequests).toHaveLength(groupedRequestCount);
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    selected_group: { kind: "value", value: "In service" },
  });
  await linkedRecord.getByRole("button", { name: "Close" }).click();
  await expect(laneRecords.getByRole("listitem")).toHaveCount(1);
});

test.describe("organization calendar week start", () => {
  test.use({
    timezoneId: "UTC",
  });
  for (const weekStart of ["monday", "sunday"] as const) {
    test(`OpenView ${weekStart} preference aligns the initial week query and month columns`, async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date("2026-09-20T12:00:00Z"));
      const api = await installViewsApi(page, {
        initialLayout: "calendar",
        initialPresentation: { date_range: "week", scale: "month" },
        weekStart,
      });
      await page.goto(
        `/openview?section=views&module=${moduleId}&view=${viewId}`,
      );
      await expect(page.getByLabel("Window starts")).toHaveValue(
        weekStart === "monday" ? "2026-09-14" : "2026-09-20",
      );
      await expect(page.getByLabel("Window ends")).toHaveValue(
        weekStart === "monday" ? "2026-09-20" : "2026-09-26",
      );
      await expect
        .poll(() => api.windowQueryRequests.at(-1))
        .toMatchObject({
          from_date: weekStart === "monday" ? "2026-09-14" : "2026-09-20",
          to_date: weekStart === "monday" ? "2026-09-20" : "2026-09-26",
        });
      const calendar = page.getByRole("region", {
        name: "September 2026 calendar",
        exact: true,
      });
      await expect(calendar).toBeVisible();
      await expect(
        calendar.getByText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/),
      ).toHaveText(
        weekStart === "monday"
          ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
          : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      );
      const tuesday = await calendar
        .getByText("Tue", { exact: true })
        .boundingBox();
      const firstDay = await calendar
        .getByText("1", { exact: true })
        .boundingBox();
      expect(tuesday).not.toBeNull();
      expect(firstDay).not.toBeNull();
      expect(
        Math.abs(
          firstDay!.x + firstDay!.width / 2 - (tuesday!.x + tuesday!.width / 2),
        ),
      ).toBeLessThan(2);
    });
  }

  test("OpenView waits for organization settings, retries failures, and retains a manual range during preference refresh", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-09-20T12:00:00Z"));
    const api = await installViewsApi(page, {
      initialLayout: "calendar",
      initialPresentation: { date_range: "week", scale: "month" },
      weekStart: "sunday",
    });
    api.failWorkspaceRead(true);
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    await expect(
      page.getByRole("button", {
        name: "Retry calendar settings",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Window starts")).toHaveCount(0);
    expect(api.windowQueryRequests).toEqual([]);

    api.failWorkspaceRead(false);
    await page
      .getByRole("button", { name: "Retry calendar settings", exact: true })
      .click();
    await expect(page.getByLabel("Window starts")).toHaveValue("2026-09-20");
    await page.getByLabel("Window starts").fill("2026-09-01");
    await page.getByLabel("Window ends").fill("2026-09-30");
    await expect(
      page.getByRole("button", {
        name: "Open record: Window equipment 01",
        exact: true,
      }),
    ).toBeVisible();
    api.failWorkspaceRead(true);
    await api.triggerInvalidation("workspace_profiles");
    await expect(
      page.getByRole("button", {
        name: "Retry calendar settings",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Window starts")).toHaveValue("2026-09-01");
    await expect(page.getByLabel("Window ends")).toHaveValue("2026-09-30");
    await expect(
      page.getByRole("button", {
        name: "Open record: Window equipment 01",
        exact: true,
      }),
    ).toBeVisible();

    api.workspace.week_start = "monday";
    api.failWorkspaceRead(false);
    await page
      .getByRole("button", { name: "Retry calendar settings", exact: true })
      .click();
    const calendar = page.getByRole("region", {
      name: "September 2026 calendar",
      exact: true,
    });
    await expect(
      calendar.getByText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/),
    ).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    await expect(page.getByLabel("Window starts")).toHaveValue("2026-09-01");
    await expect(page.getByLabel("Window ends")).toHaveValue("2026-09-30");
    await expect
      .poll(() => api.windowQueryRequests.at(-1))
      .toMatchObject({ from_date: "2026-09-01", to_date: "2026-09-30" });
  });
});

test("Calendar displays workspace-local window matches, pages results, and retries failures", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialLayout: "calendar" });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    viewId,
  );
  await expectLayoutFromSettings(page, "calendar");
  await page.getByLabel("Window starts").fill("2026-09-01");
  await page.getByLabel("Window ends").fill("2026-09-30");
  await expect(
    page.getByRole("heading", { name: "Sep 2, 2026" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open record: Window equipment 01" }),
  ).toBeVisible();
  await expect(page.getByText("Workspace timezone: Asia/Manila")).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({
    mode: "calendar",
    scope: "window",
    module_id: moduleId,
    date_field: {
      field_id: calendarDateFieldId,
      expected_type: "datetime",
    },
    from_date: "2026-09-01",
    to_date: "2026-09-30",
  });

  api.failNextWindowQuery();
  await page
    .getByRole("navigation", { name: "Date window record pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Window records could not be loaded.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open record: Window equipment 01" }),
  ).toBeVisible();
  await expect(page.getByText(/showing previous page 1–25/i)).toBeVisible();
  await page.getByRole("button", { name: "Retry window records" }).click();
  await expect(
    page.getByRole("button", { name: "Open record: Window equipment 26" }),
  ).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({ offset: 25 });

  api.failNextWindowQuery();
  await page.getByRole("button", { name: "Undated records" }).click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Window records could not be loaded.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Open record: Window equipment/ }),
  ).toHaveCount(0);
  expect(api.windowQueryRequests.at(-1)).toMatchObject({ scope: "undated" });
  await page.getByRole("button", { name: "Retry window records" }).click();
  await expect(
    page.getByRole("button", { name: "Open record: Unscheduled equipment" }),
  ).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({
    mode: "calendar",
    scope: "undated",
    date_field: { field_id: calendarDateFieldId, expected_type: "datetime" },
  });
});

test("saved Calendar range and Month/List scale drive and persist the live layouts", async ({
  page,
}) => {
  const api = await installViewsApi(page, {
    initialLayout: "calendar",
    initialPresentation: { date_range: "quarter", scale: null },
  });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const settings = await openLayoutSettings(page);
  await expect(settings.getByLabel("Calendar date range")).toHaveValue(
    "quarter",
  );
  await expect(settings.getByLabel("Calendar scale")).toHaveValue("month");
  await closeDialog(settings);
  await expect(
    page.getByRole("region", { name: "Calendar", exact: true }),
  ).toBeVisible();

  const editSettings = await openLayoutSettings(page);
  await editSettings.getByLabel("Calendar date range").selectOption("year");
  await editSettings.getByLabel("Calendar scale").selectOption("list");
  await closeDialog(editSettings);
  await expect(
    page.getByRole("region", { name: "Calendar list view" }),
  ).toBeVisible();
  await expect
    .poll(() => api.windowQueryRequests.at(-1)?.from_date)
    .toMatch(/^\d{4}-01-01$/);
  await expect
    .poll(() => api.windowQueryRequests.at(-1)?.to_date)
    .toMatch(/^\d{4}-12-31$/);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => api.saved().presentation.date_range).toBe("year");
  await expect.poll(() => api.saved().presentation.scale).toBe("list");

  await page.reload();
  const reloadedSettings = await openLayoutSettings(page);
  await expect(reloadedSettings.getByLabel("Calendar date range")).toHaveValue(
    "year",
  );
  await expect(reloadedSettings.getByLabel("Calendar scale")).toHaveValue(
    "list",
  );
  await closeDialog(reloadedSettings);
  await expect(
    page.getByRole("region", { name: "Calendar list view" }),
  ).toBeVisible();

  const scaleSettings = await openLayoutSettings(page);
  await scaleSettings.getByLabel("Calendar scale").selectOption("month");
  await closeDialog(scaleSettings);
  await expect(
    page.getByRole("region", { name: "Calendar", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => api.saved().presentation.scale).toBe("month");
  await page.reload();
  const savedScaleSettings = await openLayoutSettings(page);
  await expect(savedScaleSettings.getByLabel("Calendar scale")).toHaveValue(
    "month",
  );
  await closeDialog(savedScaleSettings);
  await expect(
    page.getByRole("region", { name: "Calendar", exact: true }),
  ).toBeVisible();
});

test("OpenView invalidations refresh Views while preserving dirty edits and clear denied records", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialLayout: "table" });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);

  const search = page.getByRole("searchbox", {
    name: "Search Equipment",
    exact: true,
  });
  await search.fill("compressor");
  await expect(page.getByText("Compressor 01")).toBeVisible();
  await expect
    .poll(() => api.recordQueryRequests.at(-1)?.definition.search)
    .toBe("compressor");
  const viewReadsBefore = api.requests.filter((request) =>
    request.startsWith("GET /api/views?"),
  ).length;

  api.saved().name = "Changed in another session";
  await api.triggerInvalidation("saved_views");
  await expect
    .poll(
      () =>
        api.requests.filter((request) => request.startsWith("GET /api/views?"))
          .length,
    )
    .toBeGreaterThan(viewReadsBefore);
  await expect(search).toHaveValue("compressor");

  const recordQueriesBefore = api.recordQueryRequests.length;
  await api.triggerInvalidation("records");
  await expect
    .poll(() => api.recordQueryRequests.length)
    .toBeGreaterThan(recordQueriesBefore);
  await expect(search).toHaveValue("compressor");

  const deniedQueriesBefore = api.recordQueryRequests.length;
  api.denyRecordQueries();
  await api.triggerInvalidation("records");
  await expect
    .poll(() => api.recordQueryRequests.length)
    .toBeGreaterThan(deniedQueriesBefore);
  // A refused read hides every OpenView name and row, the editor included,
  // behind one message; the typed draft stays in state.
  await expect(page.getByText("Compressor 01")).toHaveCount(0);
  await expect(search).toHaveCount(0);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /unavailable|no longer have access/i }),
  ).toHaveCount(1);

  // After an authorized read, the editor returns with the draft intact.
  api.allowRecordQueries();
  await page.getByRole("button", { name: "Retry catalog" }).click();
  await expect(search).toHaveValue("compressor");
  await expect(page.getByText("Compressor 01")).toBeVisible();
});

test("default invalidation keeps an implicit selected view and its dirty draft anchored", async ({
  page,
}) => {
  const otherView = {
    ...baseView(),
    id: secondViewId,
    name: "Other register",
    definition: { ...baseView().definition, search: "panel" },
  };
  const api = await installViewsApi(page, {
    initialDefault: true,
    additionalViews: [otherView],
  });
  await page.goto(`/openview?section=views&module=${moduleId}`);
  const selected = page.getByRole("combobox", { name: "Saved view" });
  await expect(selected).toHaveValue(viewId);
  const search = page.getByRole("searchbox", { name: "Search Equipment" });
  await search.fill("compressor");
  await expect(search).toHaveValue("compressor");

  api.changeDefaultElsewhere(secondViewId);
  const defaultsReadCount = api.requests.filter((request) =>
    request.startsWith("GET /api/views?module_id"),
  ).length;
  await api.triggerInvalidation("saved_views");
  await expect
    .poll(
      () =>
        api.requests.filter((request) =>
          request.startsWith("GET /api/views?module_id"),
        ).length,
    )
    .toBeGreaterThan(defaultsReadCount);
  await expect(
    selected.locator(`option[value="${secondViewId}"]`),
  ).toContainText("default");
  await expect(selected).toHaveValue(viewId);
  await expect(search).toHaveValue("compressor");
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeEnabled();
  await expect(page).not.toHaveURL(new RegExp(`[?&]view=${secondViewId}`));
});

test("default invalidation follows the new default after an implicit draft is reverted", async ({
  page,
}) => {
  const otherView = {
    ...baseView(),
    id: secondViewId,
    name: "Other register",
    definition: { ...baseView().definition, search: "panel" },
  };
  const api = await installViewsApi(page, {
    initialDefault: true,
    additionalViews: [otherView],
  });
  await page.goto(`/openview?section=views&module=${moduleId}`);
  const selected = page.getByRole("combobox", { name: "Saved view" });
  const search = page.getByRole("searchbox", { name: "Search Equipment" });
  await expect(selected).toHaveValue(viewId);
  await search.fill("compressor");
  await search.fill("pump");
  await expect(search).toHaveValue("pump");

  api.changeDefaultElsewhere(secondViewId);
  await api.triggerInvalidation("saved_views");
  await expect(
    selected.locator(`option[value="${secondViewId}"]`),
  ).toContainText("default");
  await expect(selected).toHaveValue(secondViewId);
  await expect(search).toHaveValue("panel");
});

for (const localAction of ["revert", "save"] as const) {
  test(`same-view invalidation refreshes a clean implicit editor after local ${localAction}`, async ({
    page,
  }) => {
    const api = await installViewsApi(page, { initialDefault: true });
    await page.goto(`/openview?section=views&module=${moduleId}`);
    const selected = page.getByRole("combobox", { name: "Saved view" });
    const search = page.getByRole("searchbox", { name: "Search Equipment" });
    await expect(selected).toHaveValue(viewId);
    await search.fill("compressor");
    if (localAction === "revert") {
      await search.fill("pump");
    } else {
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect.poll(() => api.saved().definition.search).toBe("compressor");
    }
    await expect(
      page.getByRole("button", { name: "Save changes" }),
    ).toHaveCount(0);

    api.changeSavedViewElsewhere("panel");
    await api.triggerInvalidation("saved_views");
    await expect(selected).toHaveValue(viewId);
    await expect(search).toHaveValue("panel");
    await expect(page.getByText("Cooling panel 02")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save changes" }),
    ).toHaveCount(0);
    await expect(page.getByText("Temporary changes")).toHaveCount(0);
    await expect(
      page.getByText(`Revision ${api.saved().revision}`),
    ).toBeVisible();
  });
}

test.describe("Calendar DATETIME rendering in a non-UTC browser timezone", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("interprets timezone-free DATETIME values as UTC before workspace conversion", async ({
    page,
  }) => {
    const api = await installViewsApi(page, {
      initialLayout: "calendar",
      calendarDateTimeValue: "2026-09-01T10:00:00",
    });

    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    await page.getByLabel("Window starts").fill("2026-09-01");
    await page.getByLabel("Window ends").fill("2026-09-30");
    await expect(
      page.getByRole("heading", { name: "Sep 1, 2026" }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(/Sep 1, 2026(?:,| at) 6:00 PM/).first(),
    ).toBeVisible();
    expect(api.windowQueryRequests.at(-1)).toMatchObject({
      mode: "calendar",
      scope: "window",
      from_date: "2026-09-01",
      to_date: "2026-09-30",
    });
  });
});

test.describe("OpenView workspace regional dates", () => {
  test.use({ locale: "en-US", timezoneId: "UTC" });

  for (const layout of ["table", "grid", "gallery", "kanban"] as const) {
    test(`${layout} Updated dates use the workspace locale and cross-midnight date`, async ({
      page,
    }) => {
      const api = await installViewsApi(page, {
        initialLayout: layout,
        initialGroupByFieldId: layout === "kanban" ? nameFieldId : undefined,
        disableInitialSearch: true,
      });
      api.workspace.locale = "fr-FR";
      api.workspace.timezone = "America/Los_Angeles";
      await page.goto(
        `/openview?section=views&module=${moduleId}&view=${viewId}`,
      );
      if (layout === "kanban") {
        await page
          .getByRole("navigation", { name: "Kanban lane pages", exact: true })
          .getByRole("button", { name: "Go to next page", exact: true })
          .click();
        await page
          .getByRole("button", { name: "In service, 26 records", exact: true })
          .click();
        await expect(
          page
            .getByRole("list", { name: "Kanban lane records" })
            .getByText("22 sept. 2026", { exact: false })
            .first(),
        ).toBeVisible();
      } else {
        await expect(
          page
            .getByLabel("Record results", { exact: true })
            .getByText("22 sept. 2026", { exact: false })
            .first(),
        ).toBeVisible();
      }
    });
  }

  test("record details and history localize workspace timestamps with their existing precision", async ({
    page,
  }) => {
    const api = await installViewsApi(page, { disableInitialSearch: true });
    api.workspace.locale = "fr-FR";
    api.workspace.timezone = "America/Los_Angeles";
    await page.route("**/api/audit-logs?**", (route) =>
      route.fulfill({
        json: pageResponse(
          [
            {
              id: "00000000-0000-4000-8000-000000000199",
              created_at: "2026-09-23T00:00:00Z",
              performed_by: userId,
              action: "update",
              before: { data: { [nameFieldId]: "Earlier title" } },
              after: { data: { [nameFieldId]: "Centrifugal pump 04" } },
              actor_label: "Regional test actor",
            },
          ],
          50,
        ),
      }),
    );
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}&record=${recordOneId}`,
    );
    const inspector = page.getByRole("dialog", {
      name: "Record details",
      exact: true,
    });
    await expect(
      inspector.getByText("Updated 22 sept. 2026", { exact: false }),
    ).toBeVisible();
    await inspector.getByRole("tab", { name: "History", exact: true }).click();
    await expect(
      inspector.getByText(/22 sept\. 2026.*17:00/).first(),
    ).toBeVisible();
  });

  test("Calendar localizes visible dates while retaining its response timezone and machine keys", async ({
    page,
  }) => {
    const api = await installViewsApi(page, {
      initialLayout: "calendar",
      calendarDateTimeValue: "2026-09-01T10:00:00",
    });
    api.workspace.locale = "fr-FR";
    api.workspace.timezone = "America/Los_Angeles";
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    await page.getByLabel("Window starts").fill("2026-09-01");
    await page.getByLabel("Window ends").fill("2026-09-30");
    await expect(
      page
        .getByRole("heading", { name: "1 sept. 2026, 18:00", exact: true })
        .first(),
    ).toBeVisible();
    await expect(page.getByText(/1 sept\. 2026.*18:00/).first()).toBeVisible();
    await expect(
      page.getByText("Workspace timezone: Asia/Manila", { exact: false }),
    ).toBeVisible();
    expect(api.windowQueryRequests.at(-1)).toMatchObject({
      mode: "calendar",
      scope: "window",
      from_date: "2026-09-01",
      to_date: "2026-09-30",
    });
  });

  test("Timeline localizes date-only and response-zone intervals without changing window requests", async ({
    page,
  }) => {
    const api = await installViewsApi(page, {
      initialLayout: "timeline",
      initialPresentation: {
        timeline_deadline_field_id: timelineTimestampDeadlineFieldId,
      },
    });
    api.workspace.locale = "fr-FR";
    api.workspace.timezone = "America/Los_Angeles";
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    await page.getByLabel("Window starts").fill("2026-08-25");
    await page.getByLabel("Window ends").fill("2026-09-15");
    const intervals = page.getByRole("list", {
      name: "Timeline intervals",
      exact: true,
    });
    await expect(
      intervals.getByText("25 août 2026", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      intervals.getByText("15 sept. 2026", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByLabel("Window starts")).toHaveValue("2026-08-25");
    await expect(page.getByLabel("Window ends")).toHaveValue("2026-09-15");
    await expect(
      page.getByText("29 août 2026", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByText(/7 sept\. 2026.*0?2:30/).first()).toBeVisible();
    expect(api.windowQueryRequests.at(-1)).toMatchObject({
      mode: "timeline",
      from_date: "2026-08-25",
      to_date: "2026-09-15",
    });
  });

  test("Calendar personal dates and week start change presentation only, retaining workspace grouping and requests", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.setFixedTime(new Date("2026-09-01T12:00:00Z"));
    const api = await installViewsApi(page, {
      initialLayout: "calendar",
      disableInitialSearch: true,
      calendarDateTimeValue: "2026-09-01T00:30:00Z",
      initialPresentation: { date_range: "week", scale: "month" },
    });
    Object.assign(api.workspace, {
      locale: "en-US",
      timezone: "Asia/Manila",
      today: "2026-09-01",
      week_start: "monday",
    });
    let preferences = profilePreferences(userId, {
      timezone: "America/Los_Angeles",
      date_format: "ymd",
      time_format: "24h",
      week_start: "monday",
    });
    await page.route(`**/api/users/${userId}/preferences`, (route) =>
      route.fulfill({ json: preferences }),
    );
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const calendar = page.getByRole("region", {
      name: "September 2026 calendar",
      exact: true,
    });
    await expect(calendar).toBeVisible();
    // Aug 31 in the personal zone still belongs to the response's Sep 1 group.
    const workspaceDay = calendar.getByRole("group", {
      name: "Move to 2026-09-01",
      exact: true,
    });
    const record = workspaceDay.getByRole("button", {
      name: "Open record: Window equipment 01",
      exact: true,
    });
    await expect(record).toContainText("2026-08-31");
    await expect(record).toContainText("17:30");
    await expect(
      page.getByText(/Workspace timezone: Asia\/Manila/),
    ).toBeVisible();
    await expect(
      calendar.getByText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/),
    ).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(api.windowQueryRequests.at(-1)).toMatchObject({
      mode: "calendar",
      scope: "window",
      date_field: { field_id: calendarDateFieldId, expected_type: "datetime" },
      from_date: "2026-08-31",
      to_date: "2026-09-06",
      limit: 25,
      offset: 0,
    });
    const windowReads = api.windowQueryRequests.length;
    // Use the incumbent cross-tab signal to obtain a confirmed preference
    // read without leaving Calendar or changing its query/workspace data.
    preferences = profilePreferences(userId, {
      timezone: "America/Los_Angeles",
      date_format: "ymd",
      time_format: "24h",
      week_start: "sunday",
    });
    await page.evaluate(() =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: "openslate-theme" }),
      ),
    );
    await expect(
      calendar.getByText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/),
    ).toHaveText(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    await expect(record).toContainText("2026-08-31");
    expect(api.windowQueryRequests).toHaveLength(windowReads);
    await expect(page.getByLabel("Window starts", { exact: true })).toHaveValue(
      "2026-08-31",
    );
    await expect(page.getByLabel("Window ends", { exact: true })).toHaveValue(
      "2026-09-06",
    );
    const batches: {
      module_id: string;
      items: {
        record_id: string;
        revision: string;
        field_id: string;
        value: string;
      }[];
    }[] = [];
    await page.route("**/api/records/batch-update", (route) => {
      expect(route.request().method()).toBe("POST");
      const body = route.request().postDataJSON() as (typeof batches)[number];
      batches.push(body);
      const results = body.items.map((item) => {
        const row = api.windowRows.find(({ id }) => id === item.record_id);
        if (!row) throw new Error("Unknown move target");
        if (item.revision !== row.updated_at)
          return { record_id: item.record_id, status: "stale" };
        Object.assign(row.data, { [item.field_id]: item.value });
        row.updated_at = "2026-09-23T00:01:00Z";
        return {
          record_id: row.id,
          status: "updated",
          record: structuredClone(row),
        };
      });
      return route.fulfill({ json: { results } });
    });
    const moveCard = workspaceDay.getByRole("article").filter({
      has: page.getByRole("button", {
        name: "Open record: Window equipment 01",
        exact: true,
      }),
    });
    await moveCard
      .getByRole("button", { name: "Move to…", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Move date…", exact: true })
      .click();
    const move = page.getByRole("dialog", {
      name: "Move Window equipment 01",
      exact: true,
    });
    // The move starts on the workspace day, not the personal Aug 31 label.
    await expect(move.getByLabel("Move date", { exact: true })).toHaveValue(
      "2026-09-01",
    );
    await move.getByLabel("Move date", { exact: true }).fill("2026-09-02");
    await move.getByRole("button", { name: "Stage move", exact: true }).click();
    await page
      .getByRole("button", { name: "Save changes (1)", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved 1 move." }),
    ).toBeVisible();
    expect(batches).toEqual([
      {
        module_id: moduleId,
        items: [
          {
            record_id: "00000000-0000-4000-8000-000000000200",
            revision: "2026-09-23T00:00:00Z",
            field_id: calendarDateFieldId,
            value: "2026-09-02T00:30:00Z",
          },
        ],
      },
    ]);
    expect(api.windowRows[0]?.data[calendarDateFieldId]).toBe(
      "2026-09-02T00:30:00Z",
    );
    await expect(
      calendar
        .getByRole("group", { name: "Move to 2026-09-02", exact: true })
        .getByRole("button", {
          name: "Open record: Window equipment 01",
          exact: true,
        }),
    ).toContainText("2026-09-01");
  });

  test("Timeline personal formatting preserves date-only days and the workspace window", async ({
    page,
  }) => {
    const api = await installViewsApi(page, {
      initialLayout: "timeline",
      disableInitialSearch: true,
      initialPresentation: {
        timeline_deadline_field_id: timelineTimestampDeadlineFieldId,
      },
    });
    Object.assign(api.workspace, { locale: "en-US", timezone: "Asia/Manila" });
    await page.route(`**/api/users/${userId}/preferences`, (route) =>
      route.fulfill({
        json: profilePreferences(userId, {
          timezone: "America/Los_Angeles",
          date_format: "ymd",
          time_format: "24h",
        }),
      }),
    );
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    await page.getByLabel("Window starts", { exact: true }).fill("2026-09-01");
    await page.getByLabel("Window ends", { exact: true }).fill("2026-09-30");
    const intervals = page.getByRole("list", {
      name: "Timeline intervals",
      exact: true,
    });
    const row = intervals
      .getByRole("listitem")
      .filter({ hasText: "Window equipment 01" });
    await expect(row).toContainText("2026-08-29");
    await expect(row).toContainText("2026-09-04");
    // Sep 6 18:30 UTC is Sep 7 02:30 in the response zone, Sep 6 11:30
    // in the personal zone; date-only interval endpoints never shift.
    await expect(row).toContainText("2026-09-06");
    await expect(row).toContainText("11:30");
    await expect(
      page.getByText(/Workspace timezone: Asia\/Manila/).first(),
    ).toBeVisible();
    expect(api.windowQueryRequests.at(-1)).toMatchObject({
      mode: "timeline",
      from_date: "2026-09-01",
      to_date: "2026-09-30",
      scope: "window",
      start_field: { field_id: timelineStartFieldId, expected_type: "date" },
      end_field: { field_id: timelineEndFieldId, expected_type: "date" },
      offset: 0,
    });
  });

  test("failed regional reads keep record content usable and recover dates separately", async ({
    page,
  }) => {
    const api = await installViewsApi(page, { disableInitialSearch: true });
    api.workspace.locale = "fr-FR";
    api.workspace.timezone = "America/Los_Angeles";
    api.failWorkspaceRead(true);
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const results = page.getByLabel("Record results", { exact: true });
    await expect(
      results.getByRole("button", { name: "Centrifugal pump 04", exact: true }),
    ).toBeVisible();
    await expect(
      results.getByText("Date unavailable", { exact: true }).first(),
    ).toBeVisible();
    api.failWorkspaceRead(false);
    await page
      .getByRole("button", { name: "Retry regional settings", exact: true })
      .click();
    await expect(
      results.getByText("22 sept. 2026", { exact: false }).first(),
    ).toBeVisible();
    api.failWorkspaceRead(true);
    await api.triggerInvalidation("workspace_profiles");
    await expect(
      page.getByRole("button", {
        name: "Retry regional settings",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      results.getByText("22 sept. 2026", { exact: false }).first(),
    ).toBeVisible();
  });

  test("regional invalidation replaces a cold old read without discarding a local view draft", async ({
    page,
  }) => {
    const api = await installViewsApi(page, { disableInitialSearch: true });
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = true;
    await page.route("**/api/workspace", async (route) => {
      if (held) {
        await pending;
        await route
          .fulfill({
            json: { ...api.workspace, locale: "en-US", timezone: "UTC" },
          })
          .catch(() => {});
      } else await route.fulfill({ json: api.workspace });
    });
    try {
      await page.goto(
        `/openview?section=views&module=${moduleId}&view=${viewId}`,
      );
      const results = page.getByLabel("Record results", { exact: true });
      await expect(
        results.getByRole("button", {
          name: "Centrifugal pump 04",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        results.getByText("Date unavailable", { exact: true }).first(),
      ).toBeVisible();
      await page
        .getByRole("searchbox", { name: "Search Equipment", exact: true })
        .fill("Cooling");
      held = false;
      api.workspace.locale = "fr-FR";
      api.workspace.timezone = "America/Los_Angeles";
      await api.triggerInvalidation("workspace_profiles");
      await expect(
        results.getByText("22 sept. 2026", { exact: false }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("searchbox", { name: "Search Equipment", exact: true }),
      ).toHaveValue("Cooling");
      release();
      await expect(
        results.getByText("22 sept. 2026", { exact: false }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Save changes", exact: true }),
      ).toBeEnabled();
    } finally {
      release();
    }
  });

  test("a prior account regional response cannot replace the next account dates", async ({
    page,
  }) => {
    const api = await installViewsApi(page, { disableInitialSearch: true });
    let actor = userId;
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: { authenticated: true, user_id: actor, setup_required: false },
      }),
    );
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({ json: { id: actor, role: "admin", access: [] } }),
    );
    await page.route("**/api/workspace", async (route) => {
      if (actor === userId) {
        await pending;
        await route
          .fulfill({
            json: {
              ...api.workspace,
              locale: "fr-FR",
              timezone: "America/Los_Angeles",
            },
          })
          .catch(() => {});
      } else
        await route.fulfill({
          json: { ...api.workspace, locale: "ja-JP", timezone: "Asia/Tokyo" },
        });
    });
    try {
      await page.goto(
        `/openview?section=views&module=${moduleId}&view=${viewId}`,
      );
      const results = page.getByLabel("Record results", { exact: true });
      await expect(
        results.getByText("Date unavailable", { exact: true }).first(),
      ).toBeVisible();
      actor = otherAccountId;
      await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
      await expect(
        results.getByText("2026/09/23", { exact: false }).first(),
      ).toBeVisible();
      release();
      await expect(
        results.getByText("2026/09/23", { exact: false }).first(),
      ).toBeVisible();
      await expect(
        results.getByText("22 sept. 2026", { exact: false }),
      ).toHaveCount(0);
    } finally {
      release();
    }
  });
});

test("Timeline renders complete intervals and keeps unscheduled records separate", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialLayout: "timeline" });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    viewId,
  );
  await page.getByLabel("Window starts").fill("2026-09-01");
  await page.getByLabel("Window ends").fill("2026-09-30");
  await expect(
    page.getByRole("list", { name: "Timeline intervals" }),
  ).toBeVisible();
  const firstInterval = page
    .getByRole("list", { name: "Timeline intervals" })
    .getByRole("listitem")
    .first();
  await expect(firstInterval).toContainText("Aug 29, 2026 – Sep 4, 2026");
  await expect(firstInterval).toContainText("Deadline: Sep 6, 2026");
  await expect(firstInterval).toContainText("Progress: 40.50%");
  await expect(
    firstInterval.getByRole("progressbar", {
      name: "Window equipment 01 progress",
    }),
  ).toHaveAttribute("aria-valuenow", "40.5");
  expect(api.windowQueryRequests.at(-1)).toMatchObject({
    mode: "timeline",
    scope: "window",
    from_date: "2026-09-01",
    to_date: "2026-09-30",
    start_field: { field_id: timelineStartFieldId, expected_type: "date" },
    end_field: { field_id: timelineEndFieldId, expected_type: "date" },
  });
  expect(
    (api.windowQueryRequests.at(-1)?.definition as QueryDefinition).columns.map(
      ({ field_id }) => field_id,
    ),
  ).toEqual(
    expect.arrayContaining([
      timelineDeadlineFieldId,
      timelineTimestampDeadlineFieldId,
      timelineProgressFieldId,
    ]),
  );

  api.failNextWindowQuery();
  await page
    .getByRole("navigation", { name: "Date window record pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  const timeline = page.getByRole("region", {
    name: "Timeline records",
    exact: true,
  });
  await expect(timeline.getByRole("alert")).toHaveAttribute(
    "data-variant",
    "destructive",
  );
  await expect(timeline.getByRole("alert")).toContainText(
    "Window records could not be loaded.",
  );
  await expect(timeline.getByRole("alert")).toContainText(
    "Requested page 2; showing previous page 1–25.",
  );
  await expect(timeline).not.toContainText("Window query temporarily failed.");
  await expect(
    page.getByRole("button", { name: "Open record: Window equipment 01" }),
  ).toBeVisible();
  await expect(
    timeline
      .getByRole("list", { name: "Timeline intervals" })
      .getByRole("listitem"),
  ).toHaveCount(25);
  await timeline
    .getByRole("button", { name: "Retry timeline records", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open record: Window equipment 26" }),
  ).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({ offset: 25 });
  await page
    .getByRole("navigation", { name: "Date window record pages" })
    .getByRole("button", { name: "Go to previous page" })
    .click();
  await expect(
    page.getByRole("button", { name: "Open record: Window equipment 01" }),
  ).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({ offset: 0 });

  const unscheduledResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname === "/api/records/window-query" &&
      request.method() === "POST" &&
      (request.postDataJSON() as { scope?: string }).scope === "unscheduled"
    );
  });
  await page.getByRole("button", { name: "Unscheduled records" }).click();
  expect((await unscheduledResponse).status()).toBe(200);
  const openRecord = page.getByRole("button", {
    name: "Open record: Unscheduled equipment",
  });
  await expect(openRecord).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({
    mode: "timeline",
    scope: "unscheduled",
  });
  const timelineRequestsBeforeInvalidation = api.windowQueryRequests.length;
  await api.triggerInvalidation("records");
  await expect
    .poll(() => api.windowQueryRequests.length)
    .toBe(timelineRequestsBeforeInvalidation + 1);
  expect(api.windowQueryRequests.at(-1)).toMatchObject({
    mode: "timeline",
    scope: "unscheduled",
  });
  await expect(openRecord).toBeVisible();
  await openRecord.click();
  await expect(page).toHaveURL(new RegExp(`record=${recordTwoId}`));
  await expect(
    page
      .getByRole("dialog", { name: "Record details" })
      .getByText("Showing this linked record."),
  ).toBeVisible();
});

test("Timeline accepts a DATETIME deadline alongside DATE interval fields", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialLayout: "timeline" });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const settings = await openLayoutSettings(page);
  const deadlineField = settings.getByRole("combobox", {
    name: "Deadline field (optional)",
  });
  await deadlineField.selectOption(timelineTimestampDeadlineFieldId);
  const save = page.getByRole("button", { name: "Save changes" });
  await closeDialog(settings);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toBeVisible();
  await expect(
    page.getByText(/Deadline: Sep 7, 2026(?:,| at) 2:30 AM/).first(),
  ).toBeVisible();
  expect(api.saved().presentation).toMatchObject({
    timeline_start_field_id: timelineStartFieldId,
    timeline_end_field_id: timelineEndFieldId,
    timeline_deadline_field_id: timelineTimestampDeadlineFieldId,
  });
});

test("stale conflict can reload the authoritative saved version without losing it implicitly", async ({
  page,
}) => {
  const api = await installViewsApi(page);

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(
    page.getByRole("heading", { name: "Equipment register" }),
  ).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search Equipment" });
  await search.fill("my local edit");
  api.makeNextPatchStale();
  await page.getByRole("button", { name: "Save changes" }).click();

  const conflictDialog = page.getByRole("dialog", {
    name: "Update saved view",
  });
  await expect(
    conflictDialog.getByText(/Query, filters, or sort/),
  ).toBeVisible();
  await expect(
    conflictDialog.getByText(/local search “my local edit”/),
  ).toBeVisible();
  expect(api.saved().definition.search).toBe("external edit");
  await conflictDialog.getByRole("button", { name: "Reload latest" }).click();

  await expect(conflictDialog).toBeHidden();
  await expect(search).toHaveValue("external edit");
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(
    0,
  );
  expect(api.saved().definition.search).toBe("external edit");
});

test("a saved view beyond the first page loads through its UUID deep link", async ({
  page,
}) => {
  const api = await installViewsApi(page, { deepViewBeyondBound: true });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(
    page.getByRole("heading", { name: "Equipment register" }),
  ).toBeVisible();
  await expect(page.getByLabel("Saved view")).toHaveValue(viewId);
  await expect(
    page.getByRole("button", { name: "Load more metadata" }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "unavailable" }),
  ).toHaveCount(0);
  expect(api.requests).toContain(`GET /api/views/${viewId}`);
  await page.getByRole("button", { name: "Load more metadata" }).click();
  await expect(
    page.getByRole("button", { name: "Load more metadata" }),
  ).toHaveCount(0);
  await expect(
    page.locator(`#openview-saved-view option[value="${viewId}"]`),
  ).toHaveCount(1);

  await openViewAction(page, "Archive view");
  await page
    .getByRole("alertdialog", { name: "Archive saved view?" })
    .getByRole("button", { name: "Archive view" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "archived" }),
  ).toBeVisible();
  expect(api.saved().is_deleted).toBe(true);

  await expect(page).toHaveURL((url) => !url.searchParams.has("view"), {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Archived views" }).click();
  const archivedDialog = page.getByRole("dialog", { name: "Archived views" });
  await expect(
    archivedDialog.getByText("Equipment register", { exact: true }),
  ).toBeVisible();
  await expect(
    archivedDialog.getByRole("button", {
      name: "Restore Equipment register",
    }),
  ).toHaveCount(1);
  await archivedDialog
    .getByRole("button", { name: "Restore Equipment register" })
    .click();
  await expect(
    archivedDialog.getByRole("status").filter({ hasText: "restored" }),
  ).toBeVisible();
  expect(api.saved().is_deleted).toBe(false);
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("view") === viewId,
    { timeout: 15_000 },
  );
  await archivedDialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("Saved view")).toHaveValue(viewId);
});

test("changing saved views resets record pagination", async ({ page }) => {
  const secondView = {
    ...baseView(),
    id: secondViewId,
    name: "Compressor queue",
    definition: {
      ...baseView().definition,
      search: "compressor",
    },
  };
  await installViewsApi(page, { additionalViews: [secondView] });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(page.getByText("Centrifugal pump 04")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search Equipment" }).fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Equipment register” was saved" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(page.getByText("Showing 26–30 of 30")).toBeVisible();

  await page.getByLabel("Saved view").selectOption(secondViewId);
  await expect(page.getByText("Compressor 01")).toBeVisible();
  await expect(page.getByText("Showing 1–1 of 1")).toBeVisible();
});

test("invalid UUID view links recover to the first active catalog source", async ({
  page,
}) => {
  await installViewsApi(page);

  await page.goto("/openview?section=views&module=bad-module&view=bad-view");
  await expect(page.getByRole("heading", { name: "Views" })).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "unavailable" }),
  ).toBeVisible();
  await expect(page.getByLabel("Data source")).toHaveValue(moduleId);
  await page.getByRole("button", { name: "Return to workspace" }).click();
  await expect(page).toHaveURL(`/openview?section=views&module=${moduleId}`);
  await expect(
    page.getByRole("alert").filter({ hasText: "unavailable" }),
  ).toHaveCount(0);
});

test("a legacy sample Board URL cannot create a local OpenView record link", async ({
  page,
}) => {
  const api = await installViewsApi(page);
  await page.route("**/api/boards**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Board unavailable" }),
    }),
  );

  await page.goto("/boards?board=sample-board-organization&section=overview");
  await expect(
    page.getByText(
      /This Board may have been removed or your account may not have access/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Organization board" }),
  ).toHaveCount(0);
  await expect(
    page.locator('a[href^="/openview?module=service-requests&record="]'),
  ).toHaveCount(0);
  await expect(page).toHaveURL(
    "/boards?board=sample-board-organization&section=overview",
  );
  expect(api.requests).toHaveLength(0);
});

test("Dashboard section loads the live Dashboard API without fetching saved Views", async ({
  page,
}) => {
  let savedViewRequests = 0;
  let dashboardListRequests = 0;
  await page.route("**/api/views**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/views/data-sources") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [],
          pagination: {
            limit: 100,
            offset: 0,
            count: 0,
            total: 0,
            has_more: false,
          },
        }),
      });
    }
    savedViewRequests += 1;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: "{}",
    });
  });
  // A new Dashboard needs a department to belong to.
  await page.route("**/api/departments**", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: departmentId,
            department_name: "Field service",
            created_at: "2026-09-23T00:00:00Z",
            updated_at: "2026-09-23T00:00:00Z",
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
        ],
        pagination: {
          limit: 100,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      }),
    }),
  );
  await page.route("**/api/dashboards**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/dashboards") {
      dashboardListRequests += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [],
          pagination: {
            limit: 25,
            offset: 0,
            count: 0,
            total: 0,
            has_more: false,
          },
        }),
      });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto("/openview?section=dashboards");
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboards" }),
  ).toBeVisible();
  await expect(
    page.getByText("No Dashboards yet.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New Dashboard" }).click();
  await expect(
    page.getByRole("textbox", { name: "Dashboard name" }),
  ).toHaveValue("");
  expect(dashboardListRequests).toBeGreaterThan(0);
  expect(savedViewRequests).toBe(0);
});

test("Views show authorized labels while filters keep stable choice and eligible user IDs", async ({
  page,
}) => {
  const choiceId = "00000000-0000-4000-8000-000000000031";
  const eligibleUserId = "00000000-0000-4000-8000-000000000032";
  const unavailableUserId = "00000000-0000-4000-8000-000000000033";
  const userFieldId = "00000000-0000-4000-8000-000000000034";
  const label = "Awaiting review";
  await installViewsApi(page, { disableInitialSearch: true });

  const view = baseView();
  view.definition = {
    ...view.definition,
    columns: [
      { field_id: nameFieldId, expected_type: "text" },
      { field_id: statusFieldId, expected_type: "select" },
      { field_id: userFieldId, expected_type: "user" },
    ],
    filters: [],
    search: null,
    search_fields: [],
  };
  view.presentation = {
    ...view.presentation,
    column_field_ids: [nameFieldId, statusFieldId, userFieldId],
    primary_field_id: nameFieldId,
    secondary_field_id: statusFieldId,
  };
  await page.route("**/api/views**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      pathname === "/api/views/data-sources/" + moduleId + "/fields"
    ) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageResponse([
            {
              id: nameFieldId,
              module_id: moduleId,
              name: "Equipment name",
              type: "text",
              required: true,
              position: 0,
              config: {},
            },
            {
              id: statusFieldId,
              module_id: moduleId,
              name: "Status",
              type: "select",
              required: false,
              position: 1,
              config: {
                options: [{ id: choiceId, label }],
              },
            },
            {
              id: userFieldId,
              module_id: moduleId,
              name: "Assignee",
              type: "user",
              required: false,
              position: 2,
              config: {},
            },
          ]),
        ),
      });
    }
    if (request.method() === "GET" && pathname === "/api/views")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pageResponse([view])),
      });
    if (request.method() === "GET" && pathname === "/api/views/" + viewId)
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(view),
      });
    return route.fallback();
  });

  let assignableUsersPath: string | null = null;
  let assignableUsersRequests = 0;
  let eligibleUserAvailable = true;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/api/modules/" + moduleId + "/assignable-users" &&
      request.method() === "GET"
    )
      assignableUsersRequests += 1;
  });
  await page.route(
    "**/api/modules/" + moduleId + "/assignable-users**",
    async (route) => {
      assignableUsersPath = new URL(route.request().url()).pathname;
      return route.fulfill({
        headers: { "cache-control": "private, no-store" },
        contentType: "application/json",
        body: JSON.stringify(
          pageResponse(
            eligibleUserAvailable
              ? [
                  {
                    id: eligibleUserId,
                    display_name: "Alex Reader",
                    username: "alex.reader",
                  },
                ]
              : [],
          ),
        ),
      });
    },
  );

  const rows = [
    {
      ...record(recordOneId, "Centrifugal pump 04", label),
      data: {
        ...record(recordOneId, "Centrifugal pump 04", label).data,
        [statusFieldId]: choiceId,
        [userFieldId]: eligibleUserId,
      },
      display_values: {
        [statusFieldId]: label,
        [userFieldId]: "Alex Reader",
      },
    },
    {
      ...record(recordTwoId, "Cooling panel 02", label),
      data: {
        ...record(recordTwoId, "Cooling panel 02", label).data,
        [statusFieldId]: choiceId,
        [userFieldId]: unavailableUserId,
      },
      display_values: {
        [statusFieldId]: label,
        [userFieldId]: "Unavailable user",
      },
    },
  ];
  let recordQueryCount = 0;
  await page.route("**/api/records/query", async (route) => {
    recordQueryCount += 1;
    const request = route.request().postDataJSON() as {
      definition: QueryDefinition;
      limit?: number;
      offset?: number;
    };
    const limit = request.limit ?? 25;
    const offset = request.offset ?? 0;
    const items = rows
      .map((row) => ({
        ...row,
        display_values: {
          ...row.display_values,
          [userFieldId]:
            row.data[userFieldId] === eligibleUserId && !eligibleUserAvailable
              ? "Unavailable user"
              : row.display_values[userFieldId],
        },
      }))
      .slice(offset, offset + limit);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(pageResponse(items, limit, offset, rows.length)),
    });
  });

  await page.goto(
    "/openview?section=views&module=" + moduleId + "&view=" + viewId,
  );
  await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Alex Reader", { exact: true })).toBeVisible();
  const eligibleRecord = page
    .getByRole("row")
    .filter({ hasText: "Centrifugal pump 04" });
  await expect(
    eligibleRecord.getByText("Alex Reader", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Unavailable user", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(new RegExp(eligibleUserId))).toHaveCount(0);
  await expect(page.getByText(unavailableUserId, { exact: true })).toHaveCount(
    0,
  );

  const filters = await openFilters(page);
  await filters.getByRole("button", { name: "Add filter" }).click();
  const filterFields = filters.getByRole("combobox", {
    name: "Field",
    exact: true,
  });
  await filterFields.nth(0).selectOption(statusFieldId);
  const choiceValue = filters.getByLabel("Value", { exact: true }).nth(0);
  await expect(choiceValue.getByRole("option", { name: label })).toBeAttached();
  const choiceRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    if (url.pathname !== "/api/records/query" || request.method() !== "POST")
      return false;
    const body = request.postDataJSON() as { definition: QueryDefinition };
    return body.definition.filters.some(
      (filter) =>
        filter.field_id === statusFieldId && filter.value === choiceId,
    );
  });
  await choiceValue.selectOption(choiceId);
  const choiceQuery = await choiceRequest;
  expect(
    (choiceQuery.postDataJSON() as { definition: QueryDefinition }).definition
      .filters,
  ).toContainEqual({
    field_id: statusFieldId,
    expected_type: "select",
    operator: "eq",
    value: choiceId,
  });

  await filters.getByRole("button", { name: "Add filter" }).click();
  await filterFields.nth(1).selectOption(userFieldId);
  await expect(
    filters
      .getByLabel("Condition", { exact: true })
      .nth(1)
      .getByRole("option", { name: "is one of", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => assignableUsersRequests).toBeGreaterThan(0);
  expect(assignableUsersPath).toBe(
    "/api/modules/" + moduleId + "/assignable-users",
  );
  const userValue = filters.getByLabel("Value", { exact: true }).nth(1);
  await expect(
    userValue.getByRole("option", { name: "Alex Reader" }),
  ).toBeAttached();
  await expect(
    userValue.getByRole("option", { name: unavailableUserId }),
  ).toHaveCount(0);
  const userRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    if (url.pathname !== "/api/records/query" || request.method() !== "POST")
      return false;
    const body = request.postDataJSON() as { definition: QueryDefinition };
    return body.definition.filters.some(
      (filter) =>
        filter.field_id === userFieldId && filter.value === eligibleUserId,
    );
  });
  await userValue.selectOption(eligibleUserId);
  const userQuery = await userRequest;
  expect(
    (userQuery.postDataJSON() as { definition: QueryDefinition }).definition
      .filters,
  ).toContainEqual({
    field_id: userFieldId,
    expected_type: "user",
    operator: "eq",
    value: eligibleUserId,
  });
  await expect(page.getByText(eligibleUserId, { exact: true })).toHaveCount(0);
  await expect(page.getByText(unavailableUserId, { exact: true })).toHaveCount(
    0,
  );
  const readsBeforeEligibilityChange = recordQueryCount;
  eligibleUserAvailable = false;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "group_access",
    module_id: moduleId,
  });
  await expect
    .poll(() => recordQueryCount)
    .toBeGreaterThan(readsBeforeEligibilityChange);
  await expect(
    eligibleRecord.getByText("Unavailable user", { exact: true }),
  ).toBeVisible();
  await expect(
    eligibleRecord.getByText("Alex Reader", { exact: true }),
  ).toHaveCount(0);
  await expect(
    userValue.getByRole("option", {
      name: "Selected person is not in the current results",
    }),
  ).toBeAttached();
});

async function installRecordCommands(page: Page) {
  const calls: {
    method: string;
    path: string;
    ifMatch?: string;
    body?: Record<string, unknown>;
  }[] = [];
  let staleNextSave = false;
  await page.route("**/api/records**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (/\/api\/records\/(query|grouped-query|window-query)$/.test(path))
      return route.fallback();
    const body = request.postData()
      ? (request.postDataJSON() as Record<string, unknown>)
      : undefined;
    calls.push({
      method: request.method(),
      path,
      ifMatch: request.headers()["if-match"],
      body,
    });
    const stored = record(recordOneId, "Centrifugal pump 04", "In service");
    if (request.method() === "PATCH" && staleNextSave) {
      staleNextSave = false;
      return route.fulfill({
        status: 412,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Record changed" }),
      });
    }
    if (request.method() === "DELETE")
      return route.fulfill({ status: 204, body: "" });
    if (request.method() === "POST" && path === "/api/records")
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          ...stored,
          id: recordTwoId,
          data: (body?.data as Record<string, unknown>) ?? {},
          display_values: {},
        }),
      });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...stored,
        updated_at:
          request.method() === "GET"
            ? stored.updated_at
            : "2026-09-24T00:00:00Z",
      }),
    });
  });
  return {
    calls,
    staleNextSave: () => {
      staleNextSave = true;
    },
  };
}

test("record details save every active value with the revision the user opened", async ({
  page,
}) => {
  await installViewsApi(page, { disableInitialSearch: true });
  const commands = await installRecordCommands(page);
  await page.goto(
    `/openview?section=views&module=${moduleId}&view=${viewId}&record=${recordOneId}`,
  );
  const details = page.getByRole("dialog", { name: "Record details" });
  await expect(
    details.getByRole("heading", { name: "Centrifugal pump 04" }),
  ).toBeVisible();

  await details.getByRole("button", { name: "Edit record" }).click();
  await details.getByLabel("Serial number").fill("SN-NEW");
  commands.staleNextSave();
  await details.getByRole("button", { name: "Save changes" }).click();
  await expect(
    details.getByText("This record changed after you opened it"),
  ).toBeVisible();
  const stale = commands.calls.find((call) => call.method === "PATCH");
  expect(stale?.ifMatch).toBe('"2026-09-23T00:00:00Z"');
  // A save replaces every active value, so unchanged values travel too.
  expect(stale?.body?.data).toMatchObject({
    [nameFieldId]: "Centrifugal pump 04",
    [serialFieldId]: "SN-NEW",
    [statusFieldId]: inServiceChoiceId,
  });
  await expect(details.getByLabel("Serial number")).toHaveValue("SN-NEW");

  await details.getByRole("button", { name: "Load latest values" }).click();
  await expect(details.getByLabel("Serial number")).toHaveValue("S");
  await details.getByLabel("Serial number").fill("SN-AGAIN");
  await details.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Record saved.")).toBeVisible();
  await expect(
    details.getByRole("button", { name: "Edit record" }),
  ).toBeVisible();
  expect(
    commands.calls.filter((call) => call.method === "PATCH").at(-1)?.body?.data,
  ).toMatchObject({ [serialFieldId]: "SN-AGAIN" });
});

test("record details delete only after confirmation", async ({ page }) => {
  await installViewsApi(page, { disableInitialSearch: true });
  const commands = await installRecordCommands(page);
  await page.goto(
    `/openview?section=views&module=${moduleId}&view=${viewId}&record=${recordOneId}`,
  );
  const details = page.getByRole("dialog", { name: "Record details" });
  await details.getByRole("button", { name: "Delete record" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Delete this record?",
  });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(commands.calls.some((call) => call.method === "DELETE")).toBe(false);

  await details.getByRole("button", { name: "Delete record" }).click();
  await confirm.getByRole("button", { name: "Delete record" }).click();
  await expect(page.getByText(/^Record deleted\./)).toBeVisible();
  expect(commands.calls.find((call) => call.method === "DELETE")?.path).toBe(
    `/api/records/${recordOneId}`,
  );
});

test("an administrator can preview and confirm deleted-record purging with a fresh password for each attempt", async ({
  page,
}) => {
  const api = await installViewsApi(page, {
    disableInitialSearch: true,
    deletedRecord: true,
  });
  await installRecordCommands(page);
  const recordPurgeCalls: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }[] = [];
  const impact = {
    target_type: "record",
    target_id: recordOneId,
    operation: "purge",
    actor_id: userId,
    rows: [
      {
        entity_type: "records",
        entity_id: recordOneId,
        is_deleted: true,
        deleted_at: "2026-09-24T00:00:00Z",
        updated_at: "2026-09-24T00:00:00Z",
        state_fingerprint: "record-state",
        byte_count: null,
      },
      ...[
        "00000000-0000-4000-8000-000000000081",
        "00000000-0000-4000-8000-000000000082",
      ].map((entity_id) => ({
        entity_type: "record_trigger_events",
        entity_id,
        is_deleted: false,
        deleted_at: null,
        updated_at: "2026-09-24T00:00:00Z",
        state_fingerprint: "trigger-event-state",
      })),
      {
        entity_type: "record_trigger_runs",
        entity_id: "00000000-0000-4000-8000-000000000083",
        is_deleted: false,
        deleted_at: null,
        updated_at: "2026-09-24T00:00:00Z",
        state_fingerprint: "trigger-run-state",
      },
      ...[
        "00000000-0000-4000-8000-000000000071",
        "00000000-0000-4000-8000-000000000072",
      ].map((entity_id) => ({
        entity_type: "relationship_edges",
        entity_id,
        is_deleted: true,
        deleted_at: "2026-09-24T00:00:00Z",
        updated_at: "2026-09-24T00:00:00Z",
        state_fingerprint: "link-state",
        byte_count: null,
      })),
    ],
    external_impacts: [
      {
        edge_id: "00000000-0000-4000-8000-000000000071",
        field_id: "00000000-0000-4000-8000-000000000073",
        external_record_id: "00000000-0000-4000-8000-000000000074",
        external_record_label: "Pump seal replacement",
        external_module_id: "00000000-0000-4000-8000-000000000075",
        external_module_name: "Work orders",
        external_department_id: "00000000-0000-4000-8000-000000000076",
        external_department_name: "Maintenance",
      },
    ],
    key_strips: [],
    blockers: [],
    impact_digest: "b".repeat(64),
  };
  const preview = {
    impact,
    token: "synthetic-record-challenge",
    expires_at: "2026-09-25T00:00:00Z",
    confirmation_name: "Server-supplied record title",
    last_successful_backup_at: null,
  };
  let rejectNextPurge = true;
  await page.route("**/api/records/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (
      path !== `/api/records/${recordOneId}/purge/preview` &&
      path !== `/api/records/${recordOneId}/purge`
    )
      return route.fallback();
    const body = request.postData()
      ? (request.postDataJSON() as Record<string, unknown>)
      : undefined;
    recordPurgeCalls.push({ method: request.method(), path, body });
    if (path.endsWith("/purge/preview"))
      return route.fulfill({ json: preview });
    if (rejectNextPurge) {
      rejectNextPurge = false;
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          detail: {
            code: "invalid_credentials",
            message: "Sensitive provider response",
          },
        }),
      });
    }
    return route.fulfill({
      json: { impact, operation_id: null },
    });
  });

  await page.goto(
    `/openview?section=views&module=${moduleId}&view=${viewId}&record=${recordOneId}`,
  );
  const details = page.getByRole("dialog", { name: "Record details" });
  await expect(
    details.getByRole("button", { name: "Restore record" }),
  ).toBeVisible();
  await expect(
    details.getByRole("button", { name: "Permanently delete" }),
  ).toBeVisible();

  await details.getByRole("button", { name: "Permanently delete" }).click();
  const impactSummary = details
    .getByRole("status")
    .filter({ hasText: "permanently removes" });
  await expect(impactSummary).toContainText("1 record");
  await expect(impactSummary).toContainText("2 links");
  await expect(impactSummary).toContainText("3 automation history entries");
  await expect(details.getByText(/Last successful backup/)).toHaveText(
    "Last successful backup: No successful backup recorded.",
  );
  await expect(details.getByText(/Work orders.*Maintenance/)).toBeVisible();
  await expect(
    details.getByText(/Pump seal replacement.*Work orders.*Maintenance/),
  ).toBeVisible();
  await expect(
    details.getByText(impact.external_impacts[0].external_record_id, {
      exact: true,
    }),
  ).toHaveCount(0);
  api.workspace.purge_enabled = false;
  await api.triggerInvalidation("workspace_profiles");
  await expect(details.getByLabel("Administrator password")).toHaveCount(0);
  await expect(
    details.getByRole("button", { name: "Restore record" }),
  ).toBeEnabled();
  api.workspace.purge_enabled = true;
  await api.triggerInvalidation("workspace_profiles");
  await details
    .getByRole("button", { name: "Permanently delete", exact: true })
    .click();
  await expect(details.getByLabel("Administrator password")).toBeVisible();
  await details
    .getByLabel("Type the record name")
    .fill(preview.confirmation_name);
  await details
    .getByLabel("Administrator password")
    .fill("synthetic-test-passphrase");
  await details.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(details.getByText("Links to other records")).toHaveCount(0);
  expect(recordPurgeCalls.map(({ path }) => path)).toEqual([
    `/api/records/${recordOneId}/purge/preview`,
    `/api/records/${recordOneId}/purge/preview`,
  ]);
  await details.getByRole("button", { name: "Permanently delete" }).click();
  await expect(
    details.getByText(/Pump seal replacement.*Work orders.*Maintenance/),
  ).toBeVisible();
  await expect(details.getByLabel("Type the record name")).toHaveValue("");
  await expect(details.getByLabel("Administrator password")).toHaveValue("");
  await details
    .getByLabel("Type the record name")
    .fill(preview.confirmation_name);
  await details
    .getByLabel("Administrator password")
    .fill("synthetic-test-passphrase");
  await details
    .getByRole("button", { name: "Confirm permanent deletion" })
    .click();
  await expect(details.getByRole("alert")).toHaveText(
    "Administrator verification failed. Confirm your password and access, then request a new review.",
  );

  await details
    .getByRole("button", { name: "Review again", exact: true })
    .click();
  await expect(details.getByLabel("Administrator password")).toHaveValue("");
  await details
    .getByLabel("Type the record name")
    .fill(preview.confirmation_name);
  await details
    .getByLabel("Administrator password")
    .fill("synthetic-test-passphrase");
  await details
    .getByRole("button", { name: "Confirm permanent deletion" })
    .click();
  await expect(page.getByText("Record permanently deleted.")).toBeVisible();
  expect(recordPurgeCalls.map(({ method, path }) => [method, path])).toEqual([
    ["POST", `/api/records/${recordOneId}/purge/preview`],
    ["POST", `/api/records/${recordOneId}/purge/preview`],
    ["POST", `/api/records/${recordOneId}/purge/preview`],
    ["POST", `/api/records/${recordOneId}/purge`],
    ["POST", `/api/records/${recordOneId}/purge/preview`],
    ["POST", `/api/records/${recordOneId}/purge`],
  ]);
  expect(recordPurgeCalls[3]?.body).toEqual({
    token: preview.token,
    confirmation_name: preview.confirmation_name,
    password: "synthetic-test-passphrase",
  });
  expect(recordPurgeCalls[5]?.body).toEqual({
    token: preview.token,
    confirmation_name: preview.confirmation_name,
    password: "synthetic-test-passphrase",
  });
});

test("a blocked record purge lists the dependency and hides password confirmation", async ({
  page,
}) => {
  await installViewsApi(page, {
    disableInitialSearch: true,
    deletedRecord: true,
  });
  await installRecordCommands(page);
  let deletions = 0;
  await page.route(`**/api/records/${recordOneId}/purge**`, (route) => {
    if (!route.request().url().endsWith("/preview")) {
      deletions += 1;
      return route.fulfill({ status: 500 });
    }
    return route.fulfill({
      json: {
        token: "blocked-record-challenge",
        expires_at: "2026-09-25T00:00:00Z",
        confirmation_name: "Centrifugal pump 04",
        last_successful_backup_at: null,
        impact: {
          target_type: "record",
          target_id: recordOneId,
          operation: "purge",
          actor_id: userId,
          rows: [
            {
              entity_type: "records",
              entity_id: recordOneId,
              is_deleted: true,
              deleted_at: "2026-09-24T00:00:00Z",
              updated_at: "2026-09-24T00:00:00Z",
              state_fingerprint: "record-state",
            },
          ],
          external_impacts: [],
          key_strips: [],
          impact_digest: "b".repeat(64),
          blockers: [
            {
              code: "purge_board_dependency",
              entity_type: "board_record_links",
              entity_id: viewId,
              detail: "Remove the Board link before deleting this record.",
              conflicting_entity_type: null,
              conflicting_entity_id: null,
              field_id: null,
              field_name: null,
              module_id: null,
              module_name: null,
              department_id: null,
              department_name: null,
            },
          ],
        },
      },
    });
  });
  await page.goto(
    `/openview?section=views&module=${moduleId}&view=${viewId}&record=${recordOneId}`,
  );
  const details = page.getByRole("dialog", { name: "Record details" });
  await details
    .getByRole("button", { name: "Permanently delete", exact: true })
    .click();
  await expect(details.getByRole("alert")).toContainText(
    "Remove the Board link before deleting this record.",
  );
  await expect(
    details.getByText("This permanently removes 1 record."),
  ).toBeVisible();
  await expect(details.getByLabel("Administrator password")).toHaveCount(0);
  await expect(
    details.getByRole("button", { name: "Confirm permanent deletion" }),
  ).toHaveCount(0);
  expect(deletions).toBe(0);
});

test("members with write access can restore a deleted record but cannot see permanent deletion", async ({
  page,
}) => {
  await installViewsApi(page, {
    disableInitialSearch: true,
    deletedRecord: true,
    viewerRole: "member",
  });
  await installRecordCommands(page);
  await page.goto(
    `/openview?section=views&module=${moduleId}&view=${viewId}&record=${recordOneId}`,
  );
  const details = page.getByRole("dialog", { name: "Record details" });
  await expect(
    details.getByRole("button", { name: "Restore record" }),
  ).toBeVisible();
  await expect(
    details.getByRole("button", { name: "Permanently delete" }),
  ).toHaveCount(0);
});

for (const state of ["disabled", "unknown", "unavailable"] as const) {
  test(`a deleted record remains restorable while permanent deletion is ${state}`, async ({
    page,
  }) => {
    const api = await installViewsApi(page, {
      disableInitialSearch: true,
      deletedRecord: true,
    });
    await installRecordCommands(page);
    api.workspace.purge_enabled = state === "unknown" ? undefined : false;
    api.failWorkspaceRead(state === "unavailable");
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}&record=${recordOneId}`,
    );
    const details = page.getByRole("dialog", { name: "Record details" });
    await expect(
      details.getByRole("button", { name: "Restore record" }),
    ).toBeEnabled();
    await expect(
      details.getByRole("button", { name: "Permanently delete", exact: true }),
    ).toHaveCount(0);
  });
}

test("New record checks required values, then opens the created record", async ({
  page,
}) => {
  await installViewsApi(page, { disableInitialSearch: true });
  const commands = await installRecordCommands(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await page.getByRole("button", { name: "New record" }).click();
  const create = page.getByRole("dialog", { name: "New record" });
  await create.getByRole("button", { name: /^Create / }).click();
  await expect(create.getByText("Enter a value.")).toBeVisible();
  expect(commands.calls.some((call) => call.method === "POST")).toBe(false);

  await create.getByLabel("Equipment name").fill("Booster pump 09");
  await create.getByRole("button", { name: /^Create / }).click();
  await expect(page).toHaveURL(new RegExp(`record=${recordTwoId}`));
  const created = commands.calls.find((call) => call.method === "POST");
  expect(created?.body).toMatchObject({
    module_id: moduleId,
    data: { [nameFieldId]: "Booster pump 09" },
  });
});

test("a Comms example record link shows a notice and returns to live Views", async ({
  page,
}) => {
  await installViewsApi(page, { initialDefault: true });
  await page.goto("/openview?record=sample-sr-1004");

  const notice = page
    .getByRole("status")
    .filter({ hasText: "This example record is not in OpenView" });
  await expect(notice).toBeVisible();
  const views = notice.getByRole("link", { name: "Views", exact: true });
  await expect(views).toHaveAttribute("href", "/openview?section=views");
  await views.click();

  // Live Views then selects its module; assert the settled URL, not the moment
  // before that selection is written.
  await expect(page).toHaveURL(
    new RegExp(`/openview\\?section=views&module=${moduleId}$`),
  );
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    viewId,
  );
  await expect(
    page.getByText("This example record is not in OpenView", { exact: true }),
  ).toHaveCount(0);
});

test("OpenView request failures use safe destructive feedback without server detail", async ({
  page,
}) => {
  await installViewsApi(page);
  await page.route("**/api/views/data-sources?*", (route) =>
    route.fulfill({
      status: 503,
      json: { detail: "Private database routing detail" },
    }),
  );
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "temporarily unavailable" });
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute("data-variant", "destructive");
  await expect(page.getByText("Private database routing detail")).toHaveCount(
    0,
  );
});

for (const layout of ["table", "kanban"] as const) {
  for (const mode of ["light", "dark"] as const) {
    test(`${layout} Saved view controls fit mobile Larger Spacious in ${mode}`, async ({
      page,
    }) => {
      await installViewsApi(page, {
        initialLayout: layout,
        initialGroupByFieldId: statusFieldId,
      });
      await page.route(`**/api/users/${userId}/preferences`, (route) =>
        route.fulfill({
          json: {
            user_id: userId,
            theme: mode,
            appearance: { motion: "system", keyboard_shortcuts: true },
          },
        }),
      );
      await page.addInitScript(() => {
        localStorage.setItem("openslate-text-size", "125");
        localStorage.setItem("openslate-density", "spacious");
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(
        `/openview?section=views&module=${moduleId}&view=${viewId}`,
      );
      const saved = page.getByRole("combobox", {
        name: "Saved view",
        exact: true,
      });
      const archived = page.getByRole("button", {
        name: "Archived views",
        exact: true,
      });
      await expect(saved).toHaveValue(viewId);
      await expect(saved).toBeEnabled();
      await expect(archived).toBeEnabled();
      for (const control of [
        saved,
        archived,
        page.getByText("Saved view", { exact: true }),
      ]) {
        const box = await control.boundingBox();
        if (!box) throw new Error("Saved view control geometry unavailable");
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      await archived.click();
      await expect(
        page.getByRole("dialog", { name: "Archived views", exact: true }),
      ).toBeVisible();
    });
  }
}

// S16: synthetic attachments are independent of the production serializer.
const s16Csv =
  "Status,Equipment name,Serial number\r\n" +
  Array.from(
    { length: 13 },
    (_, index) => `In service,Export equipment ${index + 1},S${index + 1}\r\n`,
  ).join("");
const s16Workbook = Buffer.from(
  "UEsDBBQAAAAIADt8SV0cdPw42AAAAPYBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbK2RvU4DMQzHX+WUtWpcGDqgXhfKCgy8gJvz9aLLl2K3XN++uVAYUIGFyUr+Hz9L3rydE3EzeRe4VYNIegBgM5BH1jFRKEofs0cpz3yAhGbEA8H9arUGE4NQkKXMHWq72VGPRyfN01S+2cbQqkyOVfP4YZxZrcKUnDUoRYdT6L5RlleCLsnq4cEmXhSDgpuEWfkZcM29nChn21Hzilme0RcXTA7eYx73MY7695IbW8a+t4a6aI6+RDSnTNjxQCTe6Tq1RxsWf/OrmaGOu39e5Kv/cw+o595eAFBLAwQUAAAACAA7fEld/luGcooAAADwAAAACwAAAF9yZWxzLy5yZWxzjc8xDsIwDAXQq1Q+QF0YGFDaiaUr4gImddqqTRw5QZTbk7EgBkbrf70vmyuvlGcJaZpjqja/htTClHM8IyY7sadUS+RQEifqKZdTR4xkFxoZj01zQt0b0Jm9WfVDC9oPB6hur8j/2OLcbPki9uE55B8TX40ik46cW9hWfIoud5GlLihgZ/Djwe4NUEsDBBQAAAAIADt8SV2vROrqkwAAAOUAAAAPAAAAeGwvd29ya2Jvb2sueG1sjY8xDsIwDEWvEvkAuGVgqNpOLKzcICQuidrEkR0Ex6dq6c5k///l9+X+zTI/mGfzSUvWAUKtpUNUFyhZPXGhvCYTS7J1lfJELULWayCqacFz01ww2ZhhJ3TyD4OnKTq6snslynWHCC22Rs4aYlEY+61Bf9Nkm2iAOzkWr2A28+YHaMFIF9dFbr4FHHs87vB4bfwCUEsDBBQAAAAIADt8SV22VKrPjgAAAPEAAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHONzz0OwjAMBeCrVDlA3TIwoCYTS1fEBaLUbaI2P7KNgNsTMaAiMTBZfpa+Jw8X3KyEnNiHws0jbom18iLlBMDOY7Tc5oKpXuZM0UpdaYFi3WoXhEPXHYH2hjLD3mzGSSsap14112fBf+w8z8HhObtbxCQ/KuCeaWWPKBW1tKBo9YkY3qNvq6rADPD1oXkBUEsDBBQAAAAIADt8SV2d9fu6iQAAALYAAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sTY5NCgIxDIWvUnoAM+PChbQFQU/gCUqNttg/08h4fDOzEBcv5H0hj2eWRs8REVl9Sq7D6sjcjwAjRCx+7FrHKpd7o+JZLD1gdEJ/255Khv00HaD4VLUzGzt79s5QWxRZPQsN63KatWKrU82p4pVJeBrOsLu83qkXrGyAnYEVQhBJgMy/RPhVdV9QSwECFAMUAAAACAA7fEldHHT8ONgAAAD2AQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIADt8SV3+W4ZyigAAAPAAAAALAAAAAAAAAAAAAACAAQkBAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIADt8SV2vROrqkwAAAOUAAAAPAAAAAAAAAAAAAACAAbwBAAB4bC93b3JrYm9vay54bWxQSwECFAMUAAAACAA7fEldtlSqz44AAADxAAAAGgAAAAAAAAAAAAAAgAF8AgAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHNQSwECFAMUAAAACAA7fEldnfX7uokAAAC2AAAAGAAAAAAAAAAAAAAAgAFCAwAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsFBgAAAAAFAAUARQEAAAEEAAAAAA==",
  "base64",
);
const s16AttachmentHeaders = {
  "Content-Disposition":
    'attachment; filename="Equipment-register-2026-09-20.csv"',
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
type S16Reply = {
  status?: number;
  body?: string | Buffer;
  contentType?: string;
  headers?: Record<string, string>;
  json?: unknown;
};
async function installS16Export(
  page: Page,
  role: "member" | "guest" = "member",
  serialFieldName?: string,
) {
  const views = await installViewsApi(page, {
    cardFieldsNotInColumns: true,
    serialFieldName,
    initialPresentation: {
      column_field_ids: [nameFieldId, statusFieldId, serialFieldId],
      pinned_field_ids: [statusFieldId],
    },
  });
  let actor = userId;
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { authenticated: true, user_id: actor, setup_required: false },
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: actor,
        role,
        access: [
          { department_id: departmentId, module_id: moduleId, level: "read" },
        ],
      },
    }),
  );
  const requests: unknown[] = [];
  const downloads: string[] = [];
  const writes: string[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      (path.startsWith("/api/views") || path === "/api/records/batch-update") &&
      request.method() !== "GET"
    )
      writes.push(`${request.method()} ${path}`);
  });
  let reply: S16Reply = {};
  let hold: {
    started: () => void;
    wait: Promise<void>;
    finished: () => void;
  } | null = null;
  await page.route("**/api/records/export", async (route) => {
    requests.push(route.request().postDataJSON());
    const captured = reply;
    const barrier = hold;
    hold = null;
    barrier?.started();
    if (barrier) await barrier.wait;
    try {
      await route.fulfill(
        captured.json !== undefined
          ? {
              status: captured.status ?? 503,
              json: captured.json,
            }
          : {
              status: captured.status ?? 200,
              body: captured.body ?? s16Csv,
              contentType: captured.contentType ?? "text/csv; charset=utf-8",
              headers: captured.headers ?? s16AttachmentHeaders,
            },
      );
    } catch (error) {
      // A cancelled browser request may have already detached its route.
      if (!barrier) throw error;
    } finally {
      barrier?.finished();
    }
  });
  return {
    views,
    requests,
    downloads,
    writes,
    reply: (value: S16Reply) => {
      reply = value;
    },
    account: (value: string) => {
      actor = value;
    },
    hold: () => {
      let started = () => {},
        release = () => {},
        finished = () => {};
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const done = new Promise<void>((resolve) => {
        finished = resolve;
      });
      hold = { started, wait, finished };
      return { began, release, done };
    },
  };
}
async function openS16Export(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export records" });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function s16DownloadedBytes(page: Page, action: () => Promise<void>) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    action(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return {
    filename: download.suggestedFilename(),
    bytes: Buffer.concat(chunks),
  };
}

test.describe("export journeys", () => {
  test.beforeEach(async ({ context }) => {
    await context.tracing.start({ screenshots: true, snapshots: true });
  });
  test.afterEach(async ({ context }, info) => {
    await context.tracing.stop({ path: info.outputPath("trace.zip") });
  });

  for (const role of ["member", "guest"] as const) {
    test(`${role} exports current query and chosen pinned columns without saving`, async ({
      page,
    }) => {
      const api = await installS16Export(page, role);
      api.views.saved().definition.filters = [
        {
          field_id: statusFieldId,
          expected_type: "select",
          operator: "eq",
          value: inServiceChoiceId,
        },
      ];
      api.views.saved().definition.sort = [
        { field_id: nameFieldId, expected_type: "text", direction: "desc" },
      ];
      const chosenCsv =
        "Status,Serial number\r\n" +
        Array.from(
          { length: 13 },
          (_, index) => `In service,S${index + 1}\r\n`,
        ).join("");
      api.reply({ body: chosenCsv });
      await page.goto(
        `/openview?section=views&module=${moduleId}&view=${viewId}`,
      );
      const search = page.getByRole("searchbox", { name: "Search Equipment" });
      await search.fill("valve");
      await expect(page).toHaveURL(/[?&]changes=/);
      const address = page.url();
      await expect(
        page.getByRole("button", { name: "View actions" }),
      ).toHaveCount(0);
      const dialog = await openS16Export(page);
      await expect(
        dialog
          .getByRole("list", { name: "Export columns" })
          .getByRole("checkbox"),
      ).toHaveCount(3);
      await expect(
        dialog.getByRole("button", { name: "Move Status up" }),
      ).toBeDisabled();
      await dialog
        .getByRole("button", { name: "Move Serial number up" })
        .click();
      await dialog
        .getByRole("checkbox", { name: "Equipment name", exact: true })
        .click();
      const file = await s16DownloadedBytes(page, () =>
        dialog.getByRole("button", { name: "Download", exact: true }).click(),
      );
      expect(file.filename).toBe("Equipment-register-2026-09-20.csv");
      expect(file.bytes.toString("utf8")).toBe(chosenCsv);
      expect(api.requests).toEqual([
        {
          module_id: moduleId,
          view_id: viewId,
          format: "csv",
          include_record_id: false,
          definition: {
            version: 1,
            logic: "and",
            columns: [
              { field_id: statusFieldId, expected_type: "select" },
              { field_id: serialFieldId, expected_type: "text" },
            ],
            filters: [
              {
                field_id: statusFieldId,
                expected_type: "select",
                operator: "eq",
                value: inServiceChoiceId,
              },
            ],
            sort: [
              {
                field_id: nameFieldId,
                expected_type: "text",
                direction: "desc",
              },
            ],
            deleted: "exclude",
            search: "valve",
            search_fields: [{ field_id: nameFieldId, expected_type: "text" }],
          },
        },
      ]);
      await expect(dialog).toHaveCount(0);
      await expect(search).toHaveValue("valve");
      await expect(page).toHaveURL(address);
      await expect(
        page.getByText("Temporary changes", { exact: true }),
      ).toBeVisible();
      expect(api.writes).toEqual([]);
    });
  }

  test("Excel choices stay local across format changes and preserve workbook bytes", async ({
    page,
  }) => {
    const api = await installS16Export(page);
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const dialog = await openS16Export(page);
    await expect(dialog.getByLabel("Title", { exact: true })).toHaveCount(0);
    await dialog.getByLabel("Format", { exact: true }).selectOption("xlsx");
    await expect(
      dialog.getByRole("checkbox", { name: "Include details", exact: true }),
    ).toBeChecked();
    await expect(dialog.getByLabel("Accent")).toHaveValue("theme");
    await expect(
      dialog.getByRole("checkbox", { name: "Banded rows", exact: true }),
    ).not.toBeChecked();
    await expect(
      dialog.getByRole("checkbox", { name: "Numeric totals", exact: true }),
    ).not.toBeChecked();
    await dialog
      .getByLabel("Title", { exact: true })
      .fill("Maintenance register");
    await expect(dialog.getByLabel("Title", { exact: true })).toHaveAttribute(
      "maxlength",
      "120",
    );
    await dialog
      .getByRole("checkbox", { name: "Include details", exact: true })
      .uncheck();
    await dialog.getByLabel("Accent").selectOption("gray");
    await dialog
      .getByRole("checkbox", { name: "Banded rows", exact: true })
      .check();
    await dialog
      .getByRole("checkbox", { name: "Numeric totals", exact: true })
      .check();
    await dialog
      .getByRole("checkbox", { name: "Include Record ID", exact: true })
      .check();
    await dialog.getByLabel("Format", { exact: true }).selectOption("csv");
    await expect(dialog.getByLabel("Title", { exact: true })).toHaveCount(0);
    await dialog.getByLabel("Format", { exact: true }).selectOption("xlsx");
    await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue(
      "Maintenance register",
    );
    api.reply({
      body: s16Workbook,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      headers: {
        ...s16AttachmentHeaders,
        "Content-Disposition": 'attachment; filename="Equipment.xlsx"',
      },
    });
    const file = await s16DownloadedBytes(page, () =>
      dialog.getByRole("button", { name: "Download", exact: true }).click(),
    );
    expect(file.bytes).toEqual(s16Workbook);
    expect(file.filename).toBe("Equipment.xlsx");
    expect(api.requests[0]).toMatchObject({
      format: "xlsx",
      title: "Maintenance register",
      include_details: false,
      include_record_id: true,
      accent: "gray",
      banded: true,
      totals: true,
    });
  });

  test("empty columns require an explicit Record ID and never restore removed fields", async ({
    page,
  }) => {
    const api = await installS16Export(page);
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const dialog = await openS16Export(page);
    for (const name of ["Status", "Equipment name", "Serial number"])
      await dialog.getByRole("checkbox", { name, exact: true }).uncheck();
    await expect(
      dialog.getByRole("button", { name: "Download", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByText("Choose at least one column or include Record ID."),
    ).toBeVisible();
    expect(api.requests).toEqual([]);
    await dialog
      .getByRole("checkbox", { name: "Include Record ID", exact: true })
      .check();
    api.reply({ body: `Record ID\r\n${recordOneId}\r\n` });
    const file = await s16DownloadedBytes(page, () =>
      dialog.getByRole("button", { name: "Download", exact: true }).click(),
    );
    expect(file.bytes.toString("utf8")).toBe(`Record ID\r\n${recordOneId}\r\n`);
    expect(api.requests[0]).toMatchObject({
      include_record_id: true,
      definition: { columns: [] },
    });
  });

  for (const invalid of [
    { name: "wrong status", reply: { status: 201 } },
    { name: "wrong MIME", reply: { contentType: "text/html" } },
    {
      name: "missing attachment",
      reply: {
        headers: { ...s16AttachmentHeaders, "Content-Disposition": "inline" },
      },
    },
    {
      name: "unsafe filename",
      reply: {
        headers: {
          ...s16AttachmentHeaders,
          "Content-Disposition": 'attachment; filename="../private.csv"',
        },
      },
    },
    {
      name: "wrong extension",
      reply: {
        headers: {
          ...s16AttachmentHeaders,
          "Content-Disposition": 'attachment; filename="records.xlsx"',
        },
      },
    },
    {
      name: "cacheable response",
      reply: {
        headers: { ...s16AttachmentHeaders, "Cache-Control": "public" },
      },
    },
    {
      name: "sniffable response",
      reply: {
        headers: { ...s16AttachmentHeaders, "X-Content-Type-Options": "sniff" },
      },
    },
    {
      name: "oversized bytes",
      reply: { body: Buffer.alloc(8 * 1024 * 1024 + 1, 65) },
    },
  ] satisfies { name: string; reply: S16Reply }[]) {
    test(`${invalid.name} is never an attachment and Retry keeps options`, async ({
      page,
    }) => {
      const api = await installS16Export(page);
      api.reply(invalid.reply);
      await page.goto(
        `/openview?section=views&module=${moduleId}&view=${viewId}`,
      );
      const dialog = await openS16Export(page);
      await dialog
        .getByRole("checkbox", { name: "Serial number", exact: true })
        .uncheck();
      await dialog
        .getByRole("button", { name: "Download", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toContainText(
        "could not be downloaded",
      );
      expect(api.downloads).toEqual([]);
      await expect(
        dialog.getByRole("checkbox", { name: "Serial number", exact: true }),
      ).not.toBeChecked();
      api.reply({});
      await s16DownloadedBytes(page, () =>
        dialog.getByRole("button", { name: "Download", exact: true }).click(),
      );
      expect(api.requests).toHaveLength(2);
    });
  }
  for (const failure of [
    { status: 404, code: "not_found", expected: "no longer available" },
    {
      status: 503,
      code: "private_failure",
      expected: "could not be downloaded",
    },
    { status: 422, code: "export_limit_exceeded", expected: "10,000 rows" },
    {
      status: 422,
      code: "export_no_columns",
      expected: "Choose at least one column",
    },
  ]) {
    test(`safe ${failure.code} failure retains query and allows recovery`, async ({
      page,
    }) => {
      const api = await installS16Export(page);
      api.reply({
        status: failure.status,
        json: {
          detail: { code: failure.code, message: "PRIVATE_EXPORT_SENTINEL" },
        },
      });
      await page.goto(
        `/openview?section=views&module=${moduleId}&view=${viewId}`,
      );
      const address = page.url();
      const dialog = await openS16Export(page);
      await dialog
        .getByRole("button", { name: "Download", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toContainText(failure.expected);
      await expect(page.getByText("PRIVATE_EXPORT_SENTINEL")).toHaveCount(0);
      expect(api.downloads).toEqual([]);
      expect(page.url()).toBe(address);
      api.reply({});
      await s16DownloadedBytes(page, () =>
        dialog.getByRole("button", { name: "Download", exact: true }).click(),
      );
      expect(api.writes).toEqual([]);
    });
  }

  test("a denied export hides all retained read data and never exposes private details", async ({
    page,
  }) => {
    const api = await installS16Export(page);
    api.reply({
      status: 403,
      json: {
        detail: { code: "forbidden", message: "PRIVATE_EXPORT_SENTINEL" },
      },
    });
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const dialog = await openS16Export(page);
    await dialog.getByRole("button", { name: "Download", exact: true }).click();
    await expect(
      page.getByText("Equipment register", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("PRIVATE_EXPORT_SENTINEL")).toHaveCount(0);
    expect(api.downloads).toEqual([]);
    await expect(
      page.getByRole("button", { name: "Retry catalog", exact: true }),
    ).toBeVisible();
    api.reply({});
    await page
      .getByRole("button", { name: "Retry catalog", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Export",
        exact: true,
        includeHidden: true,
      }),
    ).toBeEnabled();
    // Recovery requires a new explicit export action; the refused dialog stays closed.
    await expect(dialog).toHaveCount(0);
    const fresh = await openS16Export(page);
    await s16DownloadedBytes(page, () =>
      fresh.getByRole("button", { name: "Download", exact: true }).click(),
    );
    expect(api.requests).toHaveLength(2);
  });

  for (const end of ["cancel", "account", "refusal", "navigation"] as const) {
    test(`one submit and late ${end} completion cannot download or announce success`, async ({
      page,
    }) => {
      const api = await installS16Export(page);
      await page.goto(
        `/openview?section=views&module=${moduleId}&view=${viewId}`,
      );
      const button = page.getByRole("button", { name: "Export", exact: true });
      const dialog = await openS16Export(page);
      const held = api.hold();
      await dialog
        .getByRole("button", { name: "Download", exact: true })
        .dblclick();
      await held.began;
      await expect(
        dialog.getByRole("button", { name: "Downloading…" }),
      ).toBeDisabled();
      expect(api.requests).toHaveLength(1);
      if (end === "cancel") {
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(button).toBeFocused();
      } else if (end === "account") {
        api.account(otherAccountId);
        await page.evaluate(() =>
          window.dispatchEvent(new FocusEvent("focus")),
        );
        await expect(dialog).toHaveCount(0);
      } else if (end === "refusal") {
        api.views.denyRecordQueries();
        await api.views.triggerInvalidation("records");
        await expect(
          page.getByText("Equipment register", { exact: true }),
        ).toHaveCount(0);
      } else {
        await page.goto(`/openview?section=views&module=${moduleId}`);
        await expect(dialog).toHaveCount(0);
      }
      held.release();
      await held.done;
      expect(api.downloads).toEqual([]);
      await expect(
        page.getByText("Export downloaded.", { exact: true }),
      ).toHaveCount(0);
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`${theme} keyboard, mobile and pending/error controls remain usable`, async ({
      page,
    }) => {
      const longLabel =
        "Serial number and maintenance reference for equipment with a deliberately long column label";
      const api = await installS16Export(page, "member", longLabel);
      await page.route(/\/api\/users\/[^/]+\/preferences$/, (route) =>
        route.fulfill({
          json: {
            user_id: userId,
            theme,
            appearance: { motion: "reduce", keyboard_shortcuts: true },
          },
        }),
      );
      await page.goto(
        `/openview?section=views&module=${moduleId}&view=${viewId}`,
      );
      const opener = page.getByRole("button", { name: "Export", exact: true });
      await opener.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Export records" });
      await expect(dialog).toBeVisible();
      await hideDevOverlay(page);
      await expect(
        dialog.getByText("Exports up to 10,000 rows. Your export is recorded."),
      ).toBeVisible();
      await dialog
        .getByRole("button", { name: "Move Equipment name up" })
        .focus();
      await page.keyboard.press("Enter");
      await dialog.getByLabel("Format", { exact: true }).selectOption("xlsx");
      api.reply({ status: 503, json: { detail: "PRIVATE_EXPORT_SENTINEL" } });
      await dialog
        .getByRole("button", { name: "Download", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      const held = api.hold();
      await dialog
        .getByRole("button", { name: "Download", exact: true })
        .click();
      await held.began;
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      held.release();
      await held.done;
      await expect(opener).toBeFocused();
      expect(api.downloads).toEqual([]);
    });
  }

  test("CSV after Excel omits every Excel-only option", async ({ page }) => {
    const api = await installS16Export(page);
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const dialog = await openS16Export(page);
    await dialog.getByLabel("Format", { exact: true }).selectOption("xlsx");
    await dialog.getByLabel("Title", { exact: true }).fill("Local title");
    await dialog
      .getByRole("checkbox", { name: "Banded rows", exact: true })
      .check();
    await dialog.getByLabel("Format", { exact: true }).selectOption("csv");
    await s16DownloadedBytes(page, () =>
      dialog.getByRole("button", { name: "Download", exact: true }).click(),
    );
    const request = api.requests[0] as Record<string, unknown>;
    expect(request.format).toBe("csv");
    for (const key of [
      "title",
      "include_details",
      "accent",
      "banded",
      "totals",
    ])
      expect(request).not.toHaveProperty(key);
  });

  test("an incomplete filter disables export without a request", async ({
    page,
  }) => {
    const api = await installS16Export(page);
    api.views.saved().definition.filters = [
      {
        field_id: nameFieldId,
        expected_type: "text",
        operator: "eq",
        value: "",
      },
    ];
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    await expect(
      page.getByRole("button", { name: "Export", exact: true }),
    ).toBeDisabled();
    expect(api.requests).toEqual([]);
  });
});
