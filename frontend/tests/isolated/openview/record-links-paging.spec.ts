import { expect, test } from "@playwright/test";

const recordId = "00000000-0000-4000-8000-000000000015";
const fieldId = "00000000-0000-4000-8000-000000000016";

function edge(index: number) {
  const suffix = String(index).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${suffix}`,
    field_id: fieldId,
    source_record_id: recordId,
    target_record_id: `10000000-0000-4000-8000-${suffix}`,
    created_at: "2026-10-01T00:00:00Z",
    visibility: "available",
  };
}

test("record links page through every visible link instead of the first 100", async () => {
  // The links panel treats this list as complete, so a truncated page hid links.
  const { listOpenViewRecordLinks } =
    await import("../../../src/components/systems/openview/adapters/records-api");
  const all = Array.from({ length: 101 }, (_, index) => edge(index + 1));
  const offsets: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    offsets.push(String(offset));
    const items = all.slice(offset, offset + 100);
    return Promise.resolve(
      Response.json({
        items,
        pagination: {
          limit: 100,
          offset,
          count: items.length,
          total: all.length,
          has_more: offset + items.length < all.length,
        },
      }),
    );
  }) as typeof fetch;
  try {
    const links = await listOpenViewRecordLinks(recordId);
    expect(links).toHaveLength(101);
    expect(offsets).toEqual(["0", "100"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
