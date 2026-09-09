import { expect, test } from "@playwright/test";

import { withRequestSignal } from "../../../src/lib/supabase/request-fetch";

test("Supabase request transport receives and reacts to the route deadline signal", async () => {
  let aborted = false;
  const controller = new AbortController();
  const transport: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });

  const request = withRequestSignal(
    controller.signal,
    transport,
  )("https://provider.invalid/auth/v1/token");
  controller.abort();

  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  expect(aborted).toBe(true);
});
