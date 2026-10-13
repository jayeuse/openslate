import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import { listBoardPostAuthors } from "../../../src/components/systems/boards/adapters/board-post-author-api";
import { pageOf } from "../../helpers/pagination";

const boardId = "00000000-0000-4000-8000-000000000001";
const firstId = "00000000-0000-4000-8000-000000000002";
const secondId = "00000000-0000-4000-8000-000000000003";

function authorPage(
  items: { id: string; label: string }[],
  offset = 0,
  total = items.length,
  limit = 25,
) {
  return pageOf(items, { limit, offset, total });
}

function installFetch(responder: () => Response) {
  const original = globalThis.fetch;
  const paths: string[] = [];
  const initValues: (RequestInit | undefined)[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    paths.push(String(input));
    initValues.push(init);
    return Promise.resolve(responder());
  }) as typeof fetch;
  return {
    paths,
    initValues,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("author search reads only the requested Board page and preserves server labels", async () => {
  const mock = installFetch(() =>
    Response.json(
      authorPage(
        [
          { id: firstId, label: "Avery" },
          { id: secondId, label: "Jordan" },
        ],
        25,
        60,
      ),
    ),
  );
  try {
    const page = await listBoardPostAuthors(boardId, {
      limit: 25,
      offset: 25,
      search: " Avery ",
    });
    expect(page.items).toEqual([
      { id: firstId, label: "Avery" },
      { id: secondId, label: "Jordan" },
    ]);
    expect(page.pagination).toEqual({
      limit: 25,
      offset: 25,
      count: 2,
      total: 60,
      hasMore: true,
    });
    expect(mock.paths).toEqual([
      `/api/boards/${boardId}/post-authors?limit=25&offset=25&search=Avery`,
    ]);
    expect(mock.initValues[0]?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("author choices reject fabricated, duplicate, and oversized data without leaking hidden details", async () => {
  const duplicate = installFetch(() =>
    Response.json(
      authorPage([
        { id: firstId, label: "Avery" },
        { id: firstId, label: "Avery" },
      ]),
    ),
  );
  try {
    await expect(listBoardPostAuthors(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    duplicate.restore();
  }

  const oversized = installFetch(() =>
    Response.json(
      authorPage(
        Array.from({ length: 101 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          label: `Author ${index}`,
        })),
      ),
    ),
  );
  try {
    await expect(listBoardPostAuthors(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    oversized.restore();
  }

  const secret = installFetch(() =>
    Response.json({ detail: "Hidden author name" }, { status: 403 }),
  );
  try {
    await expect(listBoardPostAuthors(boardId)).rejects.toMatchObject({
      status: 403,
    });
    await expect(listBoardPostAuthors(boardId)).rejects.toBeInstanceOf(
      ApiError,
    );
  } finally {
    secret.restore();
  }
});

test("author paging rejects a mismatched offset and inconsistent server counts", async () => {
  for (const pagination of [
    { limit: 25, offset: 0, count: 1, total: 1, has_more: false },
    { limit: 25, offset: 25, count: 2, total: 60, has_more: true },
    { limit: 25, offset: 25, count: 1, total: 60, has_more: false },
    { limit: 25, offset: 25, count: 1, total: 25, has_more: false },
  ]) {
    const mock = installFetch(() =>
      Response.json({ items: [{ id: firstId, label: "Avery" }], pagination }),
    );
    try {
      await expect(
        listBoardPostAuthors(boardId, { offset: 25 }),
      ).rejects.toBeInstanceOf(ApiContractError);
      expect(mock.paths).toHaveLength(1);
    } finally {
      mock.restore();
    }
  }
});

test("invalid author page inputs fail before a request and empty more-pages are rejected", async () => {
  const mock = installFetch(() => Response.json(authorPage([])));
  try {
    for (const options of [
      { limit: 101 },
      { offset: -1 },
      { search: "x".repeat(101) },
      { limit: 25, ids: [] },
      { limit: 25, ids: ["not-a-uuid"] },
      { limit: 25, ids: Array.from({ length: 101 }, () => firstId) },
    ]) {
      await expect(listBoardPostAuthors(boardId, options)).rejects.toThrow();
    }
    expect(mock.paths).toHaveLength(0);
  } finally {
    mock.restore();
  }

  const empty = installFetch(() => Response.json(authorPage([], 0, 10)));
  try {
    await expect(listBoardPostAuthors(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
    expect(empty.paths).toHaveLength(1);
  } finally {
    empty.restore();
  }
});

test("known author IDs use one bounded Board read independent of picker search", async () => {
  const choices = [
    { id: firstId, label: "Avery" },
    { id: secondId, label: "Jordan" },
  ];
  const controller = new AbortController();
  const mock = installFetch(() =>
    Response.json(authorPage(choices, 0, choices.length, 100)),
  );
  try {
    const options = {
      limit: 100,
      ids: [firstId, secondId],
      signal: controller.signal,
    };
    const result = await listBoardPostAuthors(boardId, options);
    expect(result.items).toEqual(choices);
    const url = new URL(mock.paths[0], "http://test.invalid");
    expect(url.pathname).toBe(`/api/boards/${boardId}/post-authors`);
    expect(url.searchParams.getAll("ids")).toEqual([firstId, secondId]);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.has("search")).toBe(false);
    expect(mock.paths).toHaveLength(1);
    expect(mock.initValues[0]?.signal).toBe(controller.signal);
  } finally {
    mock.restore();
  }
});

test("known author lookup rejects unsolicited IDs but permits ineligible authors to be omitted", async () => {
  const mock = installFetch(() =>
    Response.json(authorPage([{ id: firstId, label: "Hidden author" }])),
  );
  const options = { limit: 25, ids: [secondId] };
  try {
    await expect(listBoardPostAuthors(boardId, options)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
  const omitted = installFetch(() => Response.json(authorPage([])));
  try {
    expect((await listBoardPostAuthors(boardId, options)).items).toEqual([]);
  } finally {
    omitted.restore();
  }
});
