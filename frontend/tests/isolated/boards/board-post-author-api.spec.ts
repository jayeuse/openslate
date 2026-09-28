import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import { listBoardPostAuthors } from "../../../src/components/systems/boards/adapters/board-post-author-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const firstId = "00000000-0000-4000-8000-000000000002";
const secondId = "00000000-0000-4000-8000-000000000003";

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

test("author choices use one private bounded Board read and only returned labels", async () => {
  const mock = installFetch(() =>
    Response.json([
      { id: firstId, label: "Avery" },
      { id: secondId, label: "Jordan" },
    ]),
  );
  try {
    const choices = await listBoardPostAuthors(boardId);
    expect(choices).toEqual([
      { id: firstId, label: "Avery" },
      { id: secondId, label: "Jordan" },
    ]);
    expect(mock.paths).toEqual([`/api/boards/${boardId}/post-authors`]);
    expect(mock.initValues[0]?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("author choices reject fabricated, duplicate, and oversized data without leaking hidden details", async () => {
  const duplicate = installFetch(() =>
    Response.json([
      { id: firstId, label: "Avery" },
      { id: firstId, label: "Avery" },
    ]),
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
      Array.from({ length: 501 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        label: `Author ${index}`,
      })),
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
