import { expect, test } from "@playwright/test";

import { isSameOriginRequest } from "../../../src/lib/request-security-core";

type HeaderValues = Readonly<{
  host?: string;
  origin?: string;
  referer?: string;
}>;

const EXPECTED_ORIGIN = "http://127.0.0.1:3001";

function requestWithHeaders(url: string, values: HeaderValues): Request {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) headers[name] = value;
  }

  try {
    return new Request(url, { headers });
  } catch {
    return {
      url,
      headers: {
        get(name: string): string | null {
          return headers[name.toLowerCase()] ?? null;
        },
      },
    } as unknown as Request;
  }
}

function sameOriginRequest(
  values: HeaderValues,
  url = "http://frontend.internal/bff",
) {
  return isSameOriginRequest(
    requestWithHeaders(url, { host: "127.0.0.1:3001", ...values }),
  );
}

test.describe("same-origin request security", () => {
  test("accepts an internal request URL when Host supplies the public authority", () => {
    expect(
      sameOriginRequest(
        { origin: EXPECTED_ORIGIN },
        "http://next-internal:4000/session/login",
      ),
    ).toBe(true);
  });

  test("accepts a same-origin Referer with a path", () => {
    expect(
      sameOriginRequest({
        referer: `${EXPECTED_ORIGIN}/login?next=/workspace`,
      }),
    ).toBe(true);
  });

  for (const [name, headers, url] of [
    ["a wrong origin", { origin: "http://127.0.0.1:3000" }],
    ["a wrong scheme", { origin: "https://127.0.0.1:3001" }],
    ["a wrong port", { origin: "http://127.0.0.1:3002" }],
    ["a wrong subdomain", { origin: "http://sub.127.0.0.1:3001" }],
    ["a null origin", { origin: "null" }],
    ["a malformed origin", { origin: "not an origin" }],
    ["no provenance", {}],
    [
      "an unsupported request URL scheme",
      { origin: "ftp://127.0.0.1:3001" },
      "ftp://next-internal:4000/session/login",
    ],
  ] as const) {
    test(`rejects ${name}`, () => {
      expect(sameOriginRequest(headers, url)).toBe(false);
    });
  }

  test("rejects a matching Origin with a cross-origin Referer", () => {
    expect(
      sameOriginRequest({
        origin: EXPECTED_ORIGIN,
        referer: "http://attacker.example/login",
      }),
    ).toBe(false);
  });

  for (const host of [
    undefined,
    "",
    "127.0.0.1, 127.0.0.1:3001",
    "user@127.0.0.1:3001",
    "127.0.0.1/path",
    "127.0.0.1?query=1",
    "127.0.0.1#fragment",
    "127.0.0.1\\path",
    "127.0.0.1:",
    "127.0.0.1:abc",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1 3001",
    "127.0.0.1\t:3001",
    "127.0.0.1\u0000:3001",
  ] as const) {
    test(`rejects malformed or missing Host ${JSON.stringify(host)}`, () => {
      expect(
        isSameOriginRequest(
          requestWithHeaders("http://frontend.internal/bff", {
            host,
            origin: EXPECTED_ORIGIN,
          }),
        ),
      ).toBe(false);
    });
  }
});
