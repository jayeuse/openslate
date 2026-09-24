import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import { listBoardContentAudienceTargets } from "../../../src/components/systems/boards/adapters/board-content-audience-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000002";

test("Board content audience chooser requests only bounded minimal active choices", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ path: string; cache: RequestCache | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path: String(input), cache: init?.cache });
    return Response.json({
      items: [{ id: targetId, label: "Operations" }],
      pagination: {
        limit: 25,
        offset: 0,
        count: 1,
        total: 1,
        has_more: false,
      },
    });
  }) as typeof fetch;
  try {
    await expect(
      listBoardContentAudienceTargets(boardId, "department", "Operations"),
    ).resolves.toEqual({
      items: [{ id: targetId, label: "Operations" }],
      hasMore: false,
    });
    expect(requests).toEqual([
      {
        path: `/api/boards/${boardId}/content-audience-targets?kind=department&search=Operations&limit=25&offset=0`,
        cache: "no-store",
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Board content audience chooser rejects expanded or mismatched pages", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      items: [{ id: targetId, label: "Operations", permissions: {} }],
      pagination: {
        limit: 25,
        offset: 0,
        count: 1,
        total: 1,
        has_more: false,
      },
    })) as typeof fetch;
  try {
    await expect(
      listBoardContentAudienceTargets(boardId, "role", "Operations"),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    globalThis.fetch = original;
  }
});
