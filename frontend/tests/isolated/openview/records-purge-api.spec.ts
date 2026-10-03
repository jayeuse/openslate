import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import { lifecycleErrorMessage } from "../../../src/lib/lifecycle";

const recordId = "00000000-0000-4000-8000-000000000015";
const actorId = "00000000-0000-4000-8000-000000000001";

type RecordPurgeAdapters = {
  previewRecordPurge: (recordId: string) => Promise<unknown>;
  purgeRecord: (
    recordId: string,
    input: { token: string; confirmationName: string; password: string },
  ) => Promise<unknown>;
};

const impact = {
  target_type: "record",
  target_id: recordId,
  operation: "purge",
  actor_id: actorId,
  rows: [
    {
      entity_type: "record",
      entity_id: recordId,
      is_deleted: true,
      deleted_at: "2026-09-24T00:00:00Z",
      updated_at: "2026-09-24T00:00:00Z",
      state_fingerprint: "record-state",
      byte_count: null,
    },
  ],
  external_impacts: [],
  key_strips: [],
  blockers: [],
  impact_digest: "a".repeat(64),
};

const preview = {
  impact,
  token: "synthetic-record-challenge",
  expires_at: "2026-09-25T00:00:00Z",
  confirmation_name: recordId,
};

test("shared lifecycle failures describe any purge target without exposing server detail", () => {
  for (const [code, message] of [
    [
      "purge_requires_closed",
      "Close this item before permanently deleting it.",
    ],
    ["preflight_failed", "Dependencies prevent permanent deletion."],
    [
      "impact_changed",
      "This item or its dependencies changed. Request a new review.",
    ],
  ]) {
    expect(
      lifecycleErrorMessage(
        new ApiError(409, "Private server detail", undefined, code),
        "Unable to delete.",
      ),
    ).toBe(message);
  }
});

test("record purge uses the lifecycle route DTO and rejects mismatched targets", async () => {
  const api =
    (await import("../../../src/components/systems/openview/adapters/records-api")) as unknown as RecordPurgeAdapters;
  expect(typeof api.previewRecordPurge).toBe("function");
  expect(typeof api.purgeRecord).toBe("function");

  const originalFetch = globalThis.fetch;
  const requests: { url: string; method: string; body?: string }[] = [];
  const responses = [
    Response.json(preview),
    Response.json({ impact, operation_id: null }),
  ];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Promise.resolve(responses.shift() ?? Response.json({}));
  }) as typeof fetch;
  try {
    await expect(api.previewRecordPurge(recordId)).resolves.toEqual(preview);
    await expect(
      api.purgeRecord(recordId, {
        token: preview.token,
        confirmationName: recordId,
        password: "synthetic-test-passphrase",
      }),
    ).resolves.toMatchObject({ impact, operation_id: null });
    expect(requests).toEqual([
      {
        url: `/api/records/${recordId}/purge/preview`,
        method: "POST",
      },
      {
        url: `/api/records/${recordId}/purge`,
        method: "POST",
        body: JSON.stringify({
          token: preview.token,
          confirmation_name: recordId,
          password: "synthetic-test-passphrase",
        }),
      },
    ]);

    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          ...preview,
          impact: { ...impact, target_id: actorId },
        }),
      )) as typeof fetch;
    await expect(api.previewRecordPurge(recordId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
