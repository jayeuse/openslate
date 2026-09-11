import { expect, test } from "@playwright/test";
import * as localAttachments from "../../../src/components/sample/comms/local-attachments";

test("releases every cached local attachment and remains idempotent", () => {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const revoked: string[] = [];
  let nextUrl = 0;

  URL.createObjectURL = () => `blob:local-${++nextUrl}`;
  URL.revokeObjectURL = (url) => revoked.push(url);

  try {
    localAttachments.cacheLocalAttachment("first", new File([], "first.txt"));
    localAttachments.cacheLocalAttachment("second", new File([], "second.txt"));

    const releaseAll: unknown = Reflect.get(
      localAttachments,
      "releaseAllLocalAttachments",
    );
    expect(typeof releaseAll).toBe("function");
    if (typeof releaseAll !== "function") return;

    releaseAll();
    expect(revoked).toEqual(["blob:local-1", "blob:local-2"]);
    expect(localAttachments.localAttachmentUrl("first")).toBeUndefined();
    expect(localAttachments.localAttachmentUrl("second")).toBeUndefined();

    releaseAll();
    expect(revoked).toEqual(["blob:local-1", "blob:local-2"]);
  } finally {
    localAttachments.releaseLocalAttachment("first");
    localAttachments.releaseLocalAttachment("second");
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});
