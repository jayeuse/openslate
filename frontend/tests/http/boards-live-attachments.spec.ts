import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "./helpers/test";
import {
  authorAccess,
  boardId,
  installBoardApi,
  userId,
} from "./helpers/boards-api";
import { dummyFile, type DummyFile } from "../helpers/dummy-files";
import { pageOf } from "../helpers/pagination";

const UNCLEAR_UPLOAD =
  "The upload result is unclear. Use Attach file to finish, or choose the file again.";
const postId = "00000000-0000-4000-8000-000000000061";
const now = "2026-09-25T00:00:00Z";
const title = "Dock 3 handover";

type StoredFile = { id: string; file: DummyFile };
type Mutation = { method: string; path: string; body: unknown };

function fileWire(stored: StoredFile, state: string, uploaded: boolean) {
  return {
    id: stored.id,
    purpose: "board_attachment",
    record_id: null,
    department_id: null,
    board_id: boardId,
    creator_id: userId,
    filename: stored.file.name,
    media_type: uploaded ? stored.file.mimeType : null,
    expected_size: stored.file.buffer.length,
    actual_size: uploaded ? stored.file.buffer.length : null,
    state,
    failure_code: null,
    is_deleted: false,
    created_at: now,
    updated_at: now,
  };
}

function postWire(
  status: "draft" | "published",
  postRevision: number | null,
  boardRevision = 1,
) {
  return {
    id: postId,
    board_id: boardId,
    author_id: userId,
    title,
    body: "Loading plan and yard photos for the morning shift.",
    links: [],
    status,
    publish_at: status === "published" ? now : null,
    expires_at: null,
    pinned: false,
    post_revision: postRevision,
    board_revision: boardRevision,
    publication_number: status === "published" ? 1 : null,
    published_at: status === "published" ? now : null,
    edited: false,
    created_at: now,
    updated_at: now,
  };
}

function listPage(items: unknown[], extra: Record<string, unknown> = {}) {
  return { ...pageOf(items, { limit: 25 }), ...extra };
}

type Options = {
  status: "draft" | "published";
  uploadStatus?: number;
  uploadBody?: "truncated";
  uploadState?: string;
  failFirstAttach?: boolean;
  seeded?: string[];
};

function fileId(index: number): string {
  return `00000000-0000-4000-8000-0000000007${String(index).padStart(2, "0")}`;
}

// A stateful Board file API: reserve, upload, attach, list, download and
// detach on one post. Attach and detach raise the post revision.
async function installAttachmentApi(page: Page, options: Options) {
  await installBoardApi(page, () => true, authorAccess);
  const prefix = `/api/boards/${boardId}`;
  const reserved = new Map<string, StoredFile>();
  const attached: StoredFile[] = [];
  for (const name of options.seeded ?? []) {
    const stored = { id: fileId(reserved.size), file: dummyFile(name) };
    reserved.set(stored.id, stored);
    attached.push(stored);
  }
  const mutations: Mutation[] = [];
  let postRevision = 2;
  let boardRevision = 1;
  let attachFailures = options.failFirstAttach ? 1 : 0;
  const handler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (method !== "GET")
      mutations.push({
        method,
        path,
        body:
          method === "PUT"
            ? request.postDataBuffer()
            : (request.postDataJSON() as unknown),
      });
    const post =
      options.status === "draft"
        ? postWire("draft", postRevision, boardRevision)
        : postWire("published", null, boardRevision);
    if (path === `${prefix}/posts` && method === "GET") {
      const view = url.searchParams.get("view");
      const visible =
        options.status === "draft"
          ? view !== "published"
          : view === "published";
      return reply(
        200,
        listPage(visible ? [post] : [], { board_revision: boardRevision }),
      );
    }
    if (path === `${prefix}/posts/${postId}` && method === "GET")
      return reply(200, post);
    if (path === `${prefix}/files` && method === "POST") {
      const body = request.postDataJSON() as { filename: string };
      const stored = {
        id: fileId(reserved.size),
        file: dummyFile(body.filename),
      };
      reserved.set(stored.id, stored);
      return reply(201, fileWire(stored, "awaiting_upload", false));
    }
    const content = new RegExp(`^${prefix}/files/([^/]+)/content$`).exec(path);
    if (content && method === "PUT") {
      const stored = reserved.get(content[1] ?? "");
      if (!stored) return reply(404, { detail: "File not found" });
      if (options.uploadStatus === 422)
        return reply(422, {
          detail: { code: "file_invalid", message: "File is not inspectable" },
        });
      if (options.uploadBody === "truncated")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"id":',
        });
      return reply(200, fileWire(stored, options.uploadState ?? "ready", true));
    }
    const attachments = `${prefix}/posts/${postId}/attachments`;
    if (path === attachments && method === "GET")
      return reply(200, {
        items: attached.map((stored) => fileWire(stored, "ready", true)),
        limit: 25,
        offset: 0,
        has_more: false,
      });
    if (path === attachments && method === "POST") {
      const body = request.postDataJSON() as { file_id: string };
      const stored = reserved.get(body.file_id);
      if (!stored) return reply(404, { detail: "File not found" });
      if (attachFailures > 0) {
        attachFailures -= 1;
        return reply(500, { detail: "Attach failed" });
      }
      attached.push(stored);
      postRevision += 1;
      boardRevision += 1;
      return reply(200, fileWire(stored, "ready", true));
    }
    const item = new RegExp(`^${attachments}/([^/]+)(/content)?$`).exec(path);
    const stored = attached.find((file) => file.id === item?.[1]);
    if (item && stored && item[2] && method === "GET")
      return route.fulfill({
        status: 200,
        body: stored.file.buffer,
        headers: {
          "Content-Type": stored.file.mimeType,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(stored.file.name)}`,
          "X-Content-Type-Options": "nosniff",
          "Content-Length": String(stored.file.buffer.length),
        },
      });
    if (item && stored && !item[2] && method === "DELETE") {
      attached.splice(attached.indexOf(stored), 1);
      postRevision += 1;
      boardRevision += 1;
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  };
  await page.route(`**${prefix}/posts**`, handler);
  await page.route(`**${prefix}/files**`, handler);
  return {
    mutations,
    revision: () => postRevision,
    boardRevision: () => boardRevision,
  };
}

async function openDraftAttachments(page: Page) {
  await page.goto(`/boards?board=${boardId}&section=posts&show=drafts`);
  await page
    .getByRole("article", { name: title, exact: true })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Edit post", exact: true });
  const panel = editor.getByRole("region", { name: "Post attachments" });
  await expect(panel.getByText("No attachments yet.")).toBeVisible();
  return panel;
}

test("an author uploads, downloads and removes post attachments in one step each", async ({
  page,
}) => {
  const api = await installAttachmentApi(page, { status: "draft" });
  const panel = await openDraftAttachments(page);
  const input = panel.getByLabel("Add an attachment");
  await expect(
    panel.getByText("Files up to 25 MB. PDF, PNG, JPEG, DOCX, XLSX or PPTX."),
  ).toBeVisible();
  const names = [
    "Dock 3 loading plan.pdf",
    "Yard layout.png",
    "Forklift inspection checklist.docx",
  ];

  for (const [index, name] of names.entries()) {
    const file = dummyFile(name);
    const start = api.mutations.length;
    const revision = api.revision();
    const boardRevision = api.boardRevision();
    await input.setInputFiles(file);
    await expect(panel.getByText(`${name} attached.`)).toBeVisible();
    const id = fileId(index);
    const sent = api.mutations.slice(start);
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST /api/boards/${boardId}/files`,
      `PUT /api/boards/${boardId}/files/${id}/content`,
      `POST /api/boards/${boardId}/posts/${postId}/attachments`,
    ]);
    expect(sent[0]?.body).toEqual({
      filename: name,
      expected_size: file.buffer.length,
    });
    expect(Buffer.from(sent[1]?.body as Buffer).equals(file.buffer)).toBe(true);
    expect(sent[2]?.body).toEqual({
      file_id: id,
      board_revision: boardRevision,
      content_revision: revision,
    });
    await expect(
      panel.getByRole("button", { name: `Download ${name}` }),
    ).toBeVisible();
  }

  const pdf = dummyFile(names[0]!);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    panel.getByRole("button", { name: `Download ${pdf.name}` }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(pdf.name);
  expect((await readFile(await download.path())).equals(pdf.buffer)).toBe(true);

  for (const [index, name] of names.entries()) {
    const start = api.mutations.length;
    const revision = api.revision();
    const boardRevision = api.boardRevision();
    await panel.getByRole("button", { name: `Remove ${name}` }).click();
    await expect(panel.getByText(`${name} removed.`)).toBeVisible();
    const id = fileId(index);
    expect(api.mutations.slice(start)).toEqual([
      {
        method: "DELETE",
        path: `/api/boards/${boardId}/posts/${postId}/attachments/${id}`,
        body: { board_revision: boardRevision, content_revision: revision },
      },
    ]);
  }
  await expect(panel.getByText("No attachments yet.")).toBeVisible();
});

test("a failed attach keeps the uploaded file ready for a retry", async ({
  page,
}) => {
  const api = await installAttachmentApi(page, {
    status: "draft",
    failFirstAttach: true,
  });
  const panel = await openDraftAttachments(page);
  const name = "Yard layout.png";
  await panel.getByLabel("Add an attachment").setInputFiles(dummyFile(name));
  await expect(panel.getByRole("alert")).toHaveText(
    "Could not attach the file. Try again.",
  );
  await expect(
    panel.getByText(`${name} is uploaded but not attached yet.`),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Attach file", exact: true }).click();
  await expect(panel.getByText(`${name} attached.`)).toBeVisible();
  await expect(
    panel.getByText(`${name} is uploaded but not attached yet.`),
  ).toHaveCount(0);
  expect(api.mutations.filter(({ method }) => method === "PUT")).toHaveLength(
    1,
  );
});

test("an unfinished upload guards removal while existing downloads remain available", async ({
  page,
}) => {
  await installAttachmentApi(page, { status: "draft" });
  const panel = await openDraftAttachments(page);
  const input = panel.getByLabel("Add an attachment");
  const existingName = "Dock 3 loading plan.pdf";
  await input.setInputFiles(dummyFile(existingName));
  await expect(panel.getByText(`${existingName} attached.`)).toBeVisible();

  let releaseUpload = () => {};
  const uploadReleased = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route(
    `**/api/boards/${boardId}/files/*/content`,
    async (route) => {
      await uploadReleased;
      await route.fallback();
    },
  );
  const nextName = "Yard layout.png";
  const remove = panel.getByRole("button", {
    name: `Remove ${existingName}`,
  });
  try {
    await Promise.all([
      page.waitForRequest(
        (request) =>
          request.method() === "PUT" &&
          new URL(request.url()).pathname.startsWith(
            `/api/boards/${boardId}/files/`,
          ),
      ),
      input.setInputFiles(dummyFile(nextName)),
    ]);
    await expect(panel.getByText(`Uploading ${nextName}…`)).toBeVisible();
    await expect(input).toBeDisabled();
    await expect(remove).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: `Download ${existingName}` }),
    ).toBeEnabled();
    releaseUpload();
    await expect(panel.getByText(`${nextName} attached.`)).toBeVisible();
    await expect(remove).toBeEnabled();
  } finally {
    releaseUpload();
  }
});

test("an upload with an unreadable response keeps the file for a retry", async ({
  page,
}) => {
  const api = await installAttachmentApi(page, {
    status: "draft",
    uploadBody: "truncated",
  });
  const panel = await openDraftAttachments(page);
  const name = "Dock 3 loading plan.pdf";
  await panel.getByLabel("Add an attachment").setInputFiles(dummyFile(name));
  await expect(panel.getByRole("alert")).toHaveText(UNCLEAR_UPLOAD);
  await expect(
    panel.getByText(`${name} is uploaded but not attached yet.`),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Attach file", exact: true }).click();
  await expect(panel.getByText(`${name} attached.`)).toBeVisible();
  expect(api.mutations.filter(({ method }) => method === "PUT")).toHaveLength(
    1,
  );
});

test("a published post's pane shows its files as downloads only", async ({
  page,
}) => {
  const api = await installAttachmentApi(page, {
    status: "published",
    seeded: ["Fire drill route.pdf"],
  });
  let listUnavailable = true;
  await page.route(
    (url) =>
      url.pathname === `/api/boards/${boardId}/posts/${postId}/attachments`,
    (route) => {
      if (route.request().method() === "GET" && listUnavailable)
        return route.fulfill({
          status: 503,
          json: { detail: "Private attachment failure canary" },
        });
      return route.fallback();
    },
  );
  const failedList = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/boards/${boardId}/posts/${postId}/attachments` &&
      response.request().method() === "GET" &&
      response.status() === 503,
  );
  await page.goto(`/boards?board=${boardId}&section=posts&post=${postId}`);
  const reader = page.getByRole("article", { name: title, exact: true });
  expect((await failedList).status()).toBe(503);
  const panel = reader.getByRole("region", { name: "Files" });
  await expect(panel.getByRole("alert")).toHaveAttribute(
    "data-variant",
    "destructive",
  );
  await expect(panel.getByRole("alert")).toContainText(
    "Attachments are unavailable for this content.",
  );
  await expect(panel).not.toContainText("Private attachment failure canary");
  await expect(
    panel.getByText("No attachments yet.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", {
      name: "Download Fire drill route.pdf",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(api.mutations).toEqual([]);
  listUnavailable = false;
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Download Fire drill route.pdf" }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await expect(panel.getByLabel("Add an attachment")).toHaveCount(0);
  expect(api.mutations).toEqual([]);
});

test("an upload refused with 422 shows an alert and leaves the list unchanged", async ({
  page,
}) => {
  const api = await installAttachmentApi(page, {
    status: "draft",
    uploadStatus: 422,
  });
  const panel = await openDraftAttachments(page);
  await panel.getByLabel("Add an attachment").setInputFiles({
    ...dummyFile("Dock 3 loading plan.pdf"),
    buffer: Buffer.from("not a pdf"),
  });
  await expect(panel.getByRole("alert")).toHaveText(
    "This file could not be stored. Check the file and try again.",
  );
  await expect(panel.getByText("No attachments yet.")).toBeVisible();
  expect(api.mutations.map(({ method }) => method)).toEqual(["POST", "PUT"]);
});

test("an upload stored as rejected is not attached", async ({ page }) => {
  const api = await installAttachmentApi(page, {
    status: "draft",
    uploadState: "rejected",
  });
  const panel = await openDraftAttachments(page);
  await panel
    .getByLabel("Add an attachment")
    .setInputFiles(dummyFile("Yard layout.png"));
  await expect(panel.getByRole("alert")).toHaveText(
    "This file could not be stored. Check the file and try again.",
  );
  await expect(panel.getByText("No attachments yet.")).toBeVisible();
  expect(api.mutations.map(({ method }) => method)).toEqual(["POST", "PUT"]);
});
