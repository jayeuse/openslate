import { expect, test } from "@playwright/test";

import { ApiError } from "../../../src/lib/api";
import { getAuditFieldName } from "../../../src/components/systems/manage/adapters/audit-fields-api";
import { installFetch } from "../platform/fixtures";

// Audit names a record's changed values by their field (MD16): one
// `GET /fields/{id}` per field, readable by anyone who can read its module.
// A field the viewer cannot read keeps its short id; the http journey shows
// the names in the event sheet once.

const fieldId = "9e8d7c6b-0000-4000-8000-000000000009";

function field(patch: Record<string, unknown> = {}) {
  return {
    id: fieldId,
    module_id: "00000000-0000-4000-8000-000000000301",
    name: "Status",
    type: "text",
    required: false,
    position: 0,
    audit_redacted: false,
    config: {},
    relationship_target_module_id: null,
    relationship_multiple_targets: null,
    relationship_multiple_sources: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
    ...patch,
  };
}

test("a field id resolves to the field's name with one read of that field", async () => {
  const mock = installFetch(() => Response.json(field()));
  try {
    expect(await getAuditFieldName(fieldId)).toBe("Status");
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      `/api/fields/${fieldId}`,
    ]);
  } finally {
    mock.restore();
  }
});

test("a deleted field still names its old values", async () => {
  const mock = installFetch(() =>
    Response.json(
      field({
        name: "Old notes",
        is_deleted: true,
        deleted_at: "2026-10-01T00:00:00Z",
      }),
    ),
  );
  try {
    expect(await getAuditFieldName(fieldId)).toBe("Old notes");
  } finally {
    mock.restore();
  }
});

for (const status of [403, 404]) {
  test(`a ${status} field read gives no name, so the short id stays`, async () => {
    const mock = installFetch(() =>
      Response.json({ detail: "Field not found" }, { status }),
    );
    try {
      expect(await getAuditFieldName(fieldId)).toBeNull();
    } finally {
      mock.restore();
    }
  });
}

test("another field read failure stays an error", async () => {
  const mock = installFetch(() =>
    Response.json({ detail: "Unavailable" }, { status: 503 }),
  );
  try {
    await expect(getAuditFieldName(fieldId)).rejects.toBeInstanceOf(ApiError);
  } finally {
    mock.restore();
  }
});

test("a response for another field is refused", async () => {
  const mock = installFetch(() =>
    Response.json(field({ id: "9e8d7c6b-0000-4000-8000-000000000010" })),
  );
  try {
    await expect(getAuditFieldName(fieldId)).rejects.toThrow();
  } finally {
    mock.restore();
  }
});
