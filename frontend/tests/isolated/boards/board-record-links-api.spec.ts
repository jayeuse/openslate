import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import {
  addBoardRecordLink,
  listBoardRecordLinks,
  removeBoardRecordLink,
} from "../../../src/components/systems/boards/adapters/board-record-links-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const contentId = "00000000-0000-4000-8000-000000000002";
const recordId = "00000000-0000-4000-8000-000000000003";
const moduleId = "00000000-0000-4000-8000-000000000004";
const linkId = "00000000-0000-4000-8000-000000000005";
const link = {
  id: linkId,
  record_id: recordId,
  module_id: moduleId,
  label: "Supplier",
  available: true,
  url: `/openview?module=${moduleId}&record=${recordId}`,
};

test("Board Record links stay content-scoped and carry dual revisions", async () => {
  const original = globalThis.fetch;
  const requests: { path: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path: String(input), init });
    if (init?.method === "DELETE")
      return Promise.resolve(new Response(null, { status: 204 }));
    if (init?.method === "POST") return Promise.resolve(Response.json(link));
    return Promise.resolve(
      Response.json({ items: [link], limit: 20, offset: 0, has_more: false }),
    );
  }) as typeof fetch;
  try {
    const target = { kind: "event" as const, boardId, contentId };
    const listed = await listBoardRecordLinks(target);
    expect(listed.items).toMatchObject([{ id: linkId, recordId, moduleId }]);
    await addBoardRecordLink(target, recordId, "Supplier", {
      boardRevision: 3,
      contentRevision: 5,
    });
    await removeBoardRecordLink(target, linkId, {
      boardRevision: 4,
      contentRevision: 6,
    });
    expect(requests.map((request) => request.path)).toEqual([
      `/api/boards/${boardId}/events/${contentId}/record-links?limit=20&offset=0`,
      `/api/boards/${boardId}/events/${contentId}/record-links`,
      `/api/boards/${boardId}/events/${contentId}/record-links/${linkId}`,
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      record_id: recordId,
      label: "Supplier",
      board_revision: 3,
      content_revision: 5,
    });
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      board_revision: 4,
      content_revision: 6,
    });
    expect(
      requests.every((request) => request.init?.credentials === "same-origin"),
    ).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});

test("published Post links are read-only and reject unsafe server URLs", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    requests.push(String(input));
    return Promise.resolve(
      Response.json({ items: [link], limit: 20, offset: 0, has_more: false }),
    );
  }) as typeof fetch;
  try {
    await listBoardRecordLinks({
      kind: "post",
      boardId,
      contentId,
      view: "published",
    });
    expect(requests).toEqual([
      `/api/boards/${boardId}/posts/${contentId}/record-links?limit=20&offset=0&view=published`,
    ]);
  } finally {
    globalThis.fetch = original;
  }
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        items: [{ ...link, url: "https://evil.invalid" }],
        limit: 20,
        offset: 0,
        has_more: false,
      }),
    )) as typeof fetch;
  try {
    await expect(
      listBoardRecordLinks({ kind: "event", boardId, contentId }),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    globalThis.fetch = original;
  }
});
