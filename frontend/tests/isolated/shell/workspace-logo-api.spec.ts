import { expect, test } from "@playwright/test";

import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  getWorkspaceLogo,
  validLogoSelection,
  WorkspaceLogoBindingChanged,
} from "../../../src/components/systems/manage/adapters/workspace-logo-api";
import { installFetch } from "../platform/fixtures";

// A logo is a PNG or JPEG of 1 byte to 2 MB. Inline logo bytes are trusted
// only when they are typed, bounded, uncached and still bound to the saved
// File after the read. The http journeys keep one example of each class with
// its exact input: "Logo rejects vector.svg before reservation ..." and "Logo
// invalid inline media type falls back to saved mark and explicitly retries".

const savedLogo = "22222222-2222-4222-8222-222222222222";
const otherLogo = "44444444-4444-4444-8444-444444444444";
const twoMegabytes = 2 * 1024 * 1024;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGMoCDgARAwQCgAozgYBqU59jgAAAABJRU5ErkJggg==",
  "base64",
);

const selections: {
  name: string;
  size: number;
  type: string;
  valid: boolean;
}[] = [
  { name: "a 1-byte PNG", size: 1, type: "image/png", valid: true },
  { name: "a 2 MB JPEG", size: twoMegabytes, type: "image/jpeg", valid: true },
  { name: "an SVG", size: 6, type: "image/svg+xml", valid: false },
  { name: "an empty PNG", size: 0, type: "image/png", valid: false },
  {
    name: "a PNG of 2 MB and 1 byte",
    size: twoMegabytes + 1,
    type: "image/png",
    valid: false,
  },
];

for (const row of selections)
  test(`logo selection ${row.valid ? "accepts" : "refuses"} ${row.name}`, () => {
    const file = new File([new Uint8Array(row.size)], "logo", {
      type: row.type,
    });
    expect(validLogoSelection(file)).toBe(row.valid);
  });

function logoResponse(
  overrides: { type?: string; cache?: string; nosniff?: string; body?: Buffer },
  brandLogo = savedLogo,
) {
  return installFetch((input) =>
    String(input) === "/api/workspace/logo"
      ? new Response(new Uint8Array(overrides.body ?? png), {
          headers: {
            "Content-Type": overrides.type ?? "image/png",
            "Cache-Control": overrides.cache ?? "no-store",
            "X-Content-Type-Options": overrides.nosniff ?? "nosniff",
          },
        })
      : Response.json({
          display_name: "Harbor Services",
          mark: "HS",
          logo_file_id: brandLogo,
          revision: 4,
        }),
  );
}

test("inline logo bytes bound to the saved File become a typed image", async () => {
  const mock = logoResponse({ type: "image/PNG; charset=binary" });
  try {
    const blob = await getWorkspaceLogo(savedLogo);
    expect(blob.type).toBe("image/png");
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(png);
    expect(mock.requests.map((request) => String(request.input))).toEqual([
      "/api/workspace/logo",
      "/api/workspace",
    ]);
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

const refusedBytes: {
  name: string;
  overrides: Parameters<typeof logoResponse>[0];
}[] = [
  { name: "an SVG media type", overrides: { type: "image/svg+xml" } },
  {
    name: "a body of 2 MB and 1 byte",
    overrides: { body: Buffer.alloc(twoMegabytes + 1) },
  },
  { name: "an empty body", overrides: { body: Buffer.alloc(0) } },
  { name: "a public cache header", overrides: { cache: "public" } },
  { name: "a missing nosniff header", overrides: { nosniff: "" } },
];

for (const row of refusedBytes)
  test(`inline logo bytes with ${row.name} are refused before the binding check`, async () => {
    const mock = logoResponse(row.overrides);
    try {
      await expect(getWorkspaceLogo(savedLogo)).rejects.toBeInstanceOf(
        ApiContractError,
      );
      expect(mock.requests.map((request) => String(request.input))).toEqual([
        "/api/workspace/logo",
      ]);
    } finally {
      mock.restore();
    }
  });

test("inline logo bytes whose File is no longer the saved logo are dropped", async () => {
  const mock = logoResponse({}, otherLogo);
  try {
    await expect(getWorkspaceLogo(savedLogo)).rejects.toBeInstanceOf(
      WorkspaceLogoBindingChanged,
    );
  } finally {
    mock.restore();
  }
});

test("a refused inline logo read keeps its status without a binding check", async () => {
  const mock = installFetch(() =>
    Response.json({ detail: "Private detail" }, { status: 403 }),
  );
  try {
    const error = await getWorkspaceLogo(savedLogo).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403 });
    expect(mock.requests).toHaveLength(1);
  } finally {
    mock.restore();
  }
});
