import { expect, test } from "@playwright/test";
import { fileSelectionError } from "../../../src/lib/files";
test("rejects unsupported uploads and logo size before reserving an object", () => {
  expect(fileSelectionError({ name: "run.html", size: 100 })).toContain("PDF");
  expect(
    fileSelectionError({ name: "logo.png", size: 2 * 1024 * 1024 + 1 }, true),
  ).toContain("2 MiB");
  expect(
    fileSelectionError({ name: "report.docx", size: 25 * 1024 * 1024 }),
  ).toBeNull();
  expect(
    fileSelectionError({ name: "logo.jpg", size: 2 * 1024 * 1024 }, true),
  ).toBeNull();
});

test("an uncertain upload sends bytes once and exposes the failure without replay", async () => {
  const { uploadFile } = await import("../../../src/lib/files");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    expect(String(input)).toBe("/bff/files/f/content");
    expect(init?.headers).toEqual({
      "Content-Type": "application/octet-stream",
    });
    expect(init?.body).toBeInstanceOf(File);
    return new Response(
      JSON.stringify({ detail: { message: "Upload outcome is unresolved" } }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    await expect(
      uploadFile("f", new File(["bytes"], "report.pdf")),
    ).rejects.toThrow("Upload outcome is unresolved");
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = original;
  }
});
