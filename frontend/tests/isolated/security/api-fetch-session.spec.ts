import { expect, test } from "@playwright/test";
import {
  apiFetch,
  ApiError,
  getApiFieldErrors,
  listAllModuleFields,
} from "../../../src/lib/api";
for (const aborted of [true, false]) {
  test(`${aborted ? "does not navigate for an aborted" : "navigates for a current"} 401 after its body resolves`, async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    const location = { href: "/protected" };
    const controller = new AbortController();
    let release!: (body: unknown) => void;
    const body = new Promise((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async () =>
      ({ status: 401, ok: false, json: () => body }) as Response;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location },
    });
    try {
      const result = apiFetch("/auth/me", { signal: controller.signal });
      if (aborted) controller.abort();
      release({ detail: "Expired" });
      await expect(result).rejects.toBeInstanceOf(ApiError);
      expect(location.href).toBe(aborted ? "/protected" : "/login");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow)
        Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
}

test("field validation normalizes supported messages and drops malformed entries", () => {
  expect(
    getApiFieldErrors(
      new ApiError(422, "Invalid", {
        errors: {
          title: "Required",
          amount: [
            "Too small",
            { message: "Must be positive" },
            null,
            4,
            { message: 9 },
          ],
          ignored: null,
        },
      }),
    ),
  ).toEqual({ title: ["Required"], amount: ["Too small", "Must be positive"] });
  expect(
    getApiFieldErrors(
      new ApiError(422, "Invalid", {
        errors: [
          { field_id: "title", message: "Required" },
          { field_id: "title", message: "Must be unique" },
          { field_id: 12, message: "Invalid" },
          null,
        ],
      }),
    ),
  ).toEqual({ title: ["Required", "Must be unique"] });
  expect(getApiFieldErrors(new Error("Transport failure"))).toEqual({});
  expect(
    getApiFieldErrors(new ApiError(422, "Invalid", { errors: null })),
  ).toEqual({});
});

test("field loading follows server pagination until every schema field is returned", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const first = { id: "field-a", name: "Title" };
  const second = { id: "field-b", name: "Notes" };
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json({
      items: requests.length === 1 ? [first] : [second],
      pagination: { has_more: requests.length === 1 },
    });
  };
  try {
    expect(await listAllModuleFields("module-id")).toEqual([first, second]);
    expect(requests).toHaveLength(2);
    const query = new URL(requests[1], "http://frontend.invalid").searchParams;
    expect(query.get("offset")).toBe("1");
    expect(query.get("deleted")).toBe("include");
    expect(query.get("sort_by")).toBe("position");
    expect(query.get("module_id")).toBe("module-id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API errors preserve structured validation and safely handle non-JSON upstream failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json(
        {
          detail: {
            message: "Close parent first",
            code: "close_required",
            blockers: ["child"],
          },
        },
        { status: 409 },
      );
    await expect(apiFetch("/records/one")).rejects.toMatchObject({
      status: 409,
      message: "Close parent first",
      code: "close_required",
      details: { blockers: ["child"] },
    });
    globalThis.fetch = async () =>
      new Response("<html>private proxy failure</html>", { status: 502 });
    await expect(apiFetch("/records/one")).rejects.toMatchObject({
      status: 502,
      message: "Request could not be completed",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
