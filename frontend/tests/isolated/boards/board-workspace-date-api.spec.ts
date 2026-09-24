import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import { getBoardWorkspaceToday } from "../../../src/components/systems/boards/adapters/board-workspace-date-api";

test("Board chart date comes from the authenticated workspace response", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ path: string; cache: RequestCache | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path: String(input), cache: init?.cache });
    return Response.json({ today: "2026-09-24", timezone: "Asia/Manila" });
  }) as typeof fetch;
  try {
    await expect(getBoardWorkspaceToday()).resolves.toBe("2026-09-24");
    expect(requests).toEqual([{ path: "/api/workspace", cache: "no-store" }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Board chart date rejects a malformed server response", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ today: "not-a-date" })) as typeof fetch;
  try {
    await expect(getBoardWorkspaceToday()).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    globalThis.fetch = original;
  }
});
