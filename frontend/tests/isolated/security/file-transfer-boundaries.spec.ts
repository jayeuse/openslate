import { expect, test } from "@playwright/test";
import { createBffHarness } from "../../helpers/bff-route-harness";

const fileId = "019c0000-0000-7000-8000-000000000001";
const limit = 25 * 1024 * 1024;
const noRefresh = async () => ({ data: { session: null }, error: null });

test("file upload permits 25 MiB without raising JSON limits", async () => {
  let calls = 0;
  const harness = createBffHarness({
    refresh: noRefresh,
    transport: async (_url, init) => {
      calls++;
      expect((init?.body as ArrayBuffer).byteLength).toBe(limit);
      return Response.json({ state: "pending_scan" });
    },
  });
  const upload = await harness.request("PUT", {
    path: ["files", fileId, "content"],
    body: new ArrayBuffer(limit),
    headers: { "content-type": "application/octet-stream" },
  });
  expect(upload.status).toBe(200);
  expect(await upload.json()).toEqual({ state: "pending_scan" });
  const ordinary = await harness.request("POST", {
    body: new ArrayBuffer(1024 * 1024 + 1),
  });
  expect(ordinary.status).toBe(413);
  const forged = await harness.request("PUT", {
    path: ["files", "not-an-id", "content"],
    body: new ArrayBuffer(1024 * 1024 + 1),
  });
  expect(forged.status).toBe(413);
  expect(calls).toBe(1);
});

test("file downloads preserve private attachment headers and enforce actual bytes", async () => {
  let overflow = false;
  const harness = createBffHarness({
    refresh: noRefresh,
    transport: async () =>
      new Response(new ArrayBuffer(limit + (overflow ? 1 : 0)), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename=test.pdf",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-length": "1",
        },
      }),
  });
  const result = await harness.request("GET", {
    path: ["files", fileId, "content"],
  });
  expect(result.status).toBe(200);
  expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  expect(result.headers.get("content-disposition")).toContain("attachment");
  expect((await result.arrayBuffer()).byteLength).toBe(limit);
  overflow = true;
  const rejected = await harness.request("GET", {
    path: ["files", fileId, "content"],
  });
  expect(rejected.status).toBe(502);
});

for (const action of ["reconcile", "purge"] as const) {
  test(`two active ${action} operations reject a third and recover after delivery`, async () => {
    const releases: Array<() => void> = [];
    const harness = createBffHarness({
      refresh: noRefresh,
      transport: async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return Response.json({ state: "pending_scan" });
      },
    });
    const first = harness.request("POST", { path: ["files", fileId, action] });
    const second = harness.request("POST", { path: ["files", fileId, action] });
    await expect.poll(() => releases.length).toBe(2);
    const third = await harness.request("POST", {
      path: ["files", fileId, action],
    });
    expect(third.status).toBe(503);
    releases.splice(0).forEach((release) => release());
    await (await first).json();
    await (await second).json();
    const next = harness.request("POST", { path: ["files", fileId, action] });
    await expect.poll(() => releases.length).toBe(1);
    releases[0]();
    expect((await next).status).toBe(200);
  });
}

test("scan enqueue uses ordinary metadata admission during binary transfers", async () => {
  const releases: Array<() => void> = [];
  const harness = createBffHarness({
    refresh: noRefresh,
    transport: async (url) => {
      if (String(url).endsWith("/scan"))
        return Response.json({ state: "pending_scan" }, { status: 202 });
      await new Promise<void>((resolve) => releases.push(resolve));
      return new Response("safe");
    },
  });
  const first = harness.request("GET", { path: ["files", fileId, "content"] });
  const second = harness.request("GET", { path: ["files", fileId, "content"] });
  await expect.poll(() => releases.length).toBe(2);
  try {
    const queued = await harness.request("POST", {
      path: ["files", fileId, "scan"],
    });
    expect(queued.status).toBe(202);
    expect(await queued.json()).toEqual({ state: "pending_scan" });
  } finally {
    releases.forEach((release) => release());
    await (await first).text();
    await (await second).text();
  }
});
