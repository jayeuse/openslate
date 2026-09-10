import { expect, test } from "@playwright/test";
import { apiFetch, ApiError } from "../../../src/lib/api";
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
