import { expect, test } from "@playwright/test";
import { z, ZodError } from "zod";

import {
  ApiContractError,
  ApiError,
  apiRequest,
  type LifecycleErrorCode,
} from "../../../src/lib/api";
import {
  MAX_FILE_BYTES,
  fileErrorMessage,
  formatFileSize,
  isFilesBusy,
  requestFileContent,
  reserveFile,
  retryFilesBusy,
  throwFileRequestError,
  uploadFileContent,
  type FilesBusyTiming,
} from "../../../src/components/systems/shared/adapters/files-api";
import { ids, installFetch } from "./fixtures";

// The shared file rules that the Library and Board attachments both use: a
// reservation names one plain file of 1 byte to 25 MB, a download is trusted
// only as a nosniff attachment of exactly the expected size, and an upload
// reply must describe the reserved file. The Files screen checks size and
// name itself before it reserves (files.tsx), so the http journey "Library
// files: invalid local uploads reserve nothing and foreign reservation
// metadata sends no bytes" still owns those messages.

const reservable = { filename: "manual.pdf", expectedSize: 2048 };

const refusedNames: { name: string; filename: string }[] = [
  { name: "a single dot", filename: "." },
  { name: "two dots", filename: ".." },
  { name: "a slash", filename: "bad/name.pdf" },
  { name: "a backslash", filename: "bad\\name.pdf" },
  { name: "a null character", filename: "bad\u0000name.pdf" },
  { name: "a unit separator", filename: "bad\u001fname.pdf" },
  { name: "a delete character", filename: "bad\u007fname.pdf" },
];

for (const row of refusedNames)
  test(`file reservation refuses ${row.name} in the name`, async () => {
    let requests = 0;
    await expect(
      reserveFile({ ...reservable, filename: row.filename }, async () => {
        requests += 1;
      }),
    ).rejects.toThrow("Choose a plain file name.");
    expect(requests).toBe(0);
  });

const refusedReservations: {
  name: string;
  input: { filename: string; expectedSize: number };
}[] = [
  { name: "an empty name", input: { ...reservable, filename: "" } },
  {
    name: "a name over 255 characters",
    input: { ...reservable, filename: `${"a".repeat(252)}.pdf` },
  },
  { name: "an empty file", input: { ...reservable, expectedSize: 0 } },
  {
    name: "a file over 25 MB",
    input: { ...reservable, expectedSize: 25 * 1024 * 1024 + 1 },
  },
  { name: "a fractional size", input: { ...reservable, expectedSize: 1.5 } },
];

for (const row of refusedReservations)
  test(`file reservation refuses ${row.name}`, async () => {
    let requests = 0;
    await expect(
      reserveFile(row.input, async () => {
        requests += 1;
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(requests).toBe(0);
  });

test("file reservation sends the plain name and exact size", async () => {
  const bodies: unknown[] = [];
  await reserveFile(
    { filename: "Plan de sécurité 2026.pdf", expectedSize: 25 * 1024 * 1024 },
    async (body) => {
      bodies.push(body);
    },
  );
  expect(bodies).toEqual([
    { filename: "Plan de sécurité 2026.pdf", expected_size: 26214400 },
  ]);
});

const attachment = {
  "Content-Type": "application/pdf",
  "Content-Disposition": "attachment; filename*=UTF-8''guide.pdf",
  "X-Content-Type-Options": "nosniff",
};

test("file download returns exactly the expected attachment bytes", async () => {
  const mock = installFetch(
    () =>
      new Response("hello", {
        headers: { ...attachment, "Content-Length": "5" },
      }),
  );
  try {
    const blob = await requestFileContent(`/files/${ids.file}/content`, 5);
    expect(blob.type).toBe("application/pdf");
    expect(await blob.text()).toBe("hello");
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/files/${ids.file}/content`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

const refusedDownloads: {
  name: string;
  body: string;
  headers: Record<string, string>;
}[] = [
  {
    name: "an inline disposition",
    body: "hello",
    headers: { ...attachment, "Content-Disposition": "inline" },
  },
  {
    name: "a missing nosniff header",
    body: "hello",
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": attachment["Content-Disposition"],
    },
  },
  {
    name: "a declared length that differs from the file",
    body: "hello",
    headers: { ...attachment, "Content-Length": "6" },
  },
  {
    name: "a declared length that is not a whole number",
    body: "hello",
    headers: { ...attachment, "Content-Length": "5.0" },
  },
  { name: "a body shorter than the file", body: "hell", headers: attachment },
];

test("file download stops reading a body that passes the expected size", async () => {
  // Each pull sends 1 MiB more. The download must cancel after the first
  // chunk passes the 5 expected bytes, not read on to the 25 MB ceiling.
  let pulls = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const mock = installFetch(
    () => new Response(endless, { headers: attachment }),
  );
  try {
    await expect(
      requestFileContent(`/files/${ids.file}/content`, 5),
    ).rejects.toBeInstanceOf(ApiContractError);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
  } finally {
    mock.restore();
  }
});

for (const row of refusedDownloads)
  test(`file download refuses ${row.name}`, async () => {
    const mock = installFetch(
      () => new Response(row.body, { headers: row.headers }),
    );
    try {
      await expect(
        requestFileContent(`/files/${ids.file}/content`, 5),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  });

for (const row of [
  { name: "an empty file", size: 0 },
  { name: "a file over 25 MB", size: 25 * 1024 * 1024 + 1 },
  { name: "a fractional size", size: 1.5 },
])
  test(`file download refuses ${row.name} before a request`, async () => {
    const mock = installFetch(
      () => new Response("hello", { headers: attachment }),
    );
    try {
      await expect(
        requestFileContent(`/files/${ids.file}/content`, row.size),
      ).rejects.toBeInstanceOf(ApiContractError);
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

test("file download refusal keeps the server detail private", async () => {
  const mock = installFetch(() =>
    Response.json({ detail: "Private storage path" }, { status: 404 }),
  );
  try {
    const failure = await requestFileContent(
      `/files/${ids.file}/content`,
      5,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 404,
      message: "File request could not be completed",
    });
  } finally {
    mock.restore();
  }
});

const uploadReply = z.object({ id: z.string() }).strict();

test("file upload accepts the reply for the reserved file", async () => {
  await expect(
    uploadFileContent(ids.file, new Blob(["pdf"]), uploadReply, async () =>
      Response.json({ id: ids.file }),
    ),
  ).resolves.toEqual({ id: ids.file });
});

for (const row of [
  { name: "an empty file", content: new Blob([]) },
  {
    name: "a file over 25 MB",
    content: new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]),
  },
])
  test(`file upload refuses ${row.name} before a request`, async () => {
    let requests = 0;
    await expect(
      uploadFileContent(ids.file, row.content, uploadReply, async () => {
        requests += 1;
        return Response.json({ id: ids.file });
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
    expect(requests).toBe(0);
  });

for (const row of [
  {
    name: "an unreadable reply",
    reply: () => new Response("unreadable", { status: 200 }),
  },
  {
    name: "a reply for another file",
    reply: () => Response.json({ id: ids.otherFile }),
  },
])
  test(`file upload refuses ${row.name}`, async () => {
    await expect(
      uploadFileContent(ids.file, new Blob(["pdf"]), uploadReply, async () =>
        row.reply(),
      ),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

const apiError = (status: number, code?: string) =>
  new ApiError(
    status,
    "Private server detail",
    undefined,
    code as LifecycleErrorCode | undefined,
  );

const messages: { name: string; error: unknown; message: string }[] = [
  {
    name: "a full upload queue",
    error: apiError(429, "file_uploads_full"),
    message: "Too many uploads are still unfinished. Try again later.",
  },
  {
    name: "a conflict",
    error: apiError(409),
    message: "This content changed. Try again, or reload the editor.",
  },
  {
    name: "a sign-in refusal",
    error: apiError(401),
    message: "This content or file is no longer available to you.",
  },
  {
    name: "a permission refusal",
    error: apiError(403),
    message: "This content or file is no longer available to you.",
  },
  {
    name: "a missing file",
    error: apiError(404),
    message: "This content or file is no longer available to you.",
  },
  {
    name: "a file over the size limit",
    error: apiError(413),
    message: "This file is larger than 25 MB.",
  },
  {
    name: "a rejected file",
    error: apiError(422),
    message:
      "The file or attachment request was rejected. Check the file and try again.",
  },
  {
    name: "an invalid response",
    error: new ApiContractError(),
    message:
      "The server returned an invalid attachment response. Refresh and try again.",
  },
  {
    name: "file capacity that stayed busy",
    error: apiError(503, "files_busy"),
    message: "The server is busy. Try again in a moment.",
  },
  {
    name: "any other server failure",
    error: apiError(503),
    message: "Could not upload the file. Try again.",
  },
  {
    name: "a network failure",
    error: new TypeError("Failed to fetch"),
    message: "Could not upload the file. Try again.",
  },
];

for (const row of messages)
  test(`file error message for ${row.name}`, () => {
    expect(fileErrorMessage(row.error, "upload the file")).toBe(row.message);
  });

// File capacity refusals (503 files_busy) are retried after Retry-After for
// about 30 s by every upload and download; the time here is a fake clock.
const busyAnswer = (retryAfter?: string) =>
  Response.json(
    { detail: { code: "files_busy", message: "File capacity is busy" } },
    {
      status: 503,
      headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
    },
  );

function fakeTiming() {
  let clock = 0;
  const waits: number[] = [];
  const timing: FilesBusyTiming = {
    now: () => clock,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
  };
  return { timing, waits };
}

/** Sends the bytes the way the file adapters do. */
const sendBytes = (content: Blob, signal?: AbortSignal) => async () => {
  const response = await apiRequest(`/files/${ids.file}/content`, {
    method: "PUT",
    body: content,
    signal,
  });
  if (!response.ok) return throwFileRequestError(response);
  return response;
};

test("a refused file request keeps the files_busy code and its Retry-After", async () => {
  const failure = await throwFileRequestError(busyAnswer("3")).catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({
    status: 503,
    code: "files_busy",
    retryAfter: 3,
    message: "File request could not be completed",
  });
  expect(isFilesBusy(failure)).toBe(true);
});

test("a busy file request waits Retry-After, clamped to 1 to 10 s, and sends the same bytes again", async () => {
  const content = new Blob(["pdf"]);
  const answers = [
    busyAnswer("0"),
    busyAnswer("30"),
    busyAnswer(),
    Response.json({ id: ids.file }),
  ];
  const refused = answers.slice(0, 3);
  const mock = installFetch(() => answers.shift() ?? busyAnswer());
  const { timing, waits } = fakeTiming();
  const waiting: boolean[] = [];
  try {
    const response = await retryFilesBusy(
      sendBytes(content),
      { onWaiting: (value) => waiting.push(value) },
      timing,
    );
    expect(await response.json()).toEqual({ id: ids.file });
    expect(waits).toEqual([1000, 10000, 1000]);
    expect(mock.requests).toHaveLength(4);
    for (const request of mock.requests)
      expect(request.init?.body).toBe(content);
    for (const answer of refused) expect(answer.bodyUsed).toBe(true);
    expect(waiting).toEqual([true, false]);
  } finally {
    mock.restore();
  }
});

test("a file request that stays busy fails with the busy error after about 30 s", async () => {
  const mock = installFetch(() => busyAnswer("1"));
  const { timing, waits } = fakeTiming();
  const waiting: boolean[] = [];
  try {
    const failure = await retryFilesBusy(
      sendBytes(new Blob(["pdf"])),
      { onWaiting: (value) => waiting.push(value) },
      timing,
    ).catch((error: unknown) => error);
    expect(isFilesBusy(failure)).toBe(true);
    expect(fileErrorMessage(failure, "upload the file")).toBe(
      "The server is busy. Try again in a moment.",
    );
    expect(waits.reduce((total, wait) => total + wait, 0)).toBe(30000);
    expect(mock.requests).toHaveLength(31);
    expect(waiting).toEqual([true, false]);
  } finally {
    mock.restore();
  }
});

for (const row of [
  {
    name: "another 503 code",
    answer: () =>
      Response.json(
        { detail: { code: "comms_unavailable", message: "Unavailable" } },
        { status: 503, headers: { "Retry-After": "1" } },
      ),
    status: 503,
  },
  {
    name: "a 503 without a JSON body",
    answer: () => new Response("Service Unavailable", { status: 503 }),
    status: 503,
  },
  {
    name: "files_busy on another status",
    answer: () =>
      Response.json(
        { detail: { code: "files_busy", message: "File capacity is busy" } },
        { status: 429, headers: { "Retry-After": "1" } },
      ),
    status: 429,
  },
])
  test(`a file request is not retried for ${row.name}`, async () => {
    const mock = installFetch(row.answer);
    const { timing, waits } = fakeTiming();
    const waiting: boolean[] = [];
    try {
      const failure = await retryFilesBusy(
        sendBytes(new Blob(["pdf"])),
        { onWaiting: (value) => waiting.push(value) },
        timing,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ status: row.status });
      expect(isFilesBusy(failure)).toBe(false);
      expect(mock.requests).toHaveLength(1);
      expect(waits).toEqual([]);
      expect(waiting).toEqual([]);
    } finally {
      mock.restore();
    }
  });

test("an abort stops the wait for file capacity at once", async () => {
  const mock = installFetch(() => busyAnswer("10"));
  const controller = new AbortController();
  const waiting: boolean[] = [];
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const retry = retryFilesBusy(
      sendBytes(new Blob(["pdf"]), controller.signal),
      {
        signal: controller.signal,
        onWaiting: (value) => {
          waiting.push(value);
          if (value) controller.abort();
        },
      },
    );
    // A hang guard well below the 10 s wait, not a measured duration.
    const hang = new Promise<never>((_, reject) => {
      guard = setTimeout(() => reject(new Error("still waiting")), 3000);
    });
    await expect(Promise.race([retry, hang])).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mock.requests).toHaveLength(1);
    expect(waiting).toEqual([true, false]);
  } finally {
    clearTimeout(guard);
    mock.restore();
  }
});

for (const row of [
  { bytes: 1023, label: "1023 bytes" },
  { bytes: 1024, label: "1 KB" },
  { bytes: 1048576, label: "1 MB" },
  { bytes: 26214400, label: "25 MB" },
])
  test(`file size ${row.bytes} reads as ${row.label}`, () => {
    expect(formatFileSize(row.bytes)).toBe(row.label);
  });
