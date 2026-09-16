import { expect, test } from "@playwright/test";
import {
  BOARD_FILE_LIMITS,
  admitBoardFiles,
  boardAttachmentUrl,
  cacheBoardAttachment,
  createBoardAttachmentMetadata,
  isSafeBoardUrl,
  releaseRemovedBoardAttachments,
  releaseBoardAttachment,
} from "../../../src/components/sample/boards/files";

function file(name: string, type: string, size = 100): File {
  return new File([new Uint8Array(size)], name, { type });
}

test("file admission enforces the supported types and 10 MiB per-file limit", () => {
  const result = admitBoardFiles(
    [
      file("briefing.pdf", "application/pdf"),
      file("photo.svg", "image/svg+xml"),
      file("too-large.csv", "text/csv", BOARD_FILE_LIMITS.maxBytes + 1),
    ],
    [],
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("photo.svg");

  const valid = admitBoardFiles([file("briefing.pdf", "application/pdf")], []);
  expect(valid).toEqual({
    ok: true,
    attachments: [
      expect.objectContaining({
        name: "briefing.pdf",
        type: "application/pdf",
      }),
    ],
  });
});

test("file admission respects the five-file total and metadata excludes blob URLs", () => {
  const result = admitBoardFiles(
    [file("one.txt", "text/plain"), file("two.csv", "text/csv")],
    [
      ...Array.from({ length: BOARD_FILE_LIMITS.maxFiles - 1 }, (_, index) => ({
        id: `existing-${index}`,
        name: `existing-${index}.txt`,
        size: 100,
        type: "text/plain",
      })),
    ],
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("5");

  const metadata = createBoardAttachmentMetadata(
    file("one.txt", "text/plain"),
    "attachment-one",
  );
  expect(metadata).toEqual({
    id: "attachment-one",
    name: "one.txt",
    size: 100,
    type: "text/plain",
  });
  expect("url" in metadata).toBe(false);
});

test("external links accept only absolute HTTP(S) URLs without credentials", () => {
  expect(isSafeBoardUrl("https://example.invalid/docs?q=1")).toBe(
    "https://example.invalid/docs?q=1",
  );
  expect(isSafeBoardUrl("http://example.invalid")).toBe(
    "http://example.invalid/",
  );
  expect(isSafeBoardUrl("javascript:alert(1)")).toBeNull();
  expect(isSafeBoardUrl("data:text/plain,unsafe")).toBeNull();
  expect(isSafeBoardUrl("https://user:pass@example.invalid")).toBeNull();
  expect(isSafeBoardUrl("/relative/path")).toBeNull();
});

test("board attachment caching delegates to the shared local attachment registry", () => {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:board-one";
  const revoked: string[] = [];
  URL.revokeObjectURL = (url) => revoked.push(url);

  try {
    const url = cacheBoardAttachment(
      "attachment-one",
      file("one.png", "image/png"),
    );
    expect(url).toBe("blob:board-one");
    expect(boardAttachmentUrl("attachment-one")).toBe("blob:board-one");
    releaseBoardAttachment("attachment-one");
    expect(boardAttachmentUrl("attachment-one")).toBeUndefined();
    expect(revoked).toEqual(["blob:board-one"]);
  } finally {
    releaseBoardAttachment("attachment-one");
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

test("removed attachment cleanup releases only IDs absent from the next metadata set", () => {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  let nextUrl = 0;
  URL.createObjectURL = () => `blob:${++nextUrl}`;
  const revoked: string[] = [];
  URL.revokeObjectURL = (url) => revoked.push(url);

  try {
    cacheBoardAttachment("keep", file("keep.png", "image/png", 1));
    cacheBoardAttachment("remove", file("remove.png", "image/png", 2));
    releaseRemovedBoardAttachments(
      [{ id: "keep" }, { id: "remove" }],
      [{ id: "keep" }],
    );
    expect(revoked).toEqual(["blob:2"]);
    expect(boardAttachmentUrl("keep")).toBe("blob:1");
    expect(boardAttachmentUrl("remove")).toBeUndefined();
  } finally {
    releaseBoardAttachment("keep");
    releaseBoardAttachment("remove");
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});
