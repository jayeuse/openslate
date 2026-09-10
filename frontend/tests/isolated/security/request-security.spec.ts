import { expect, test } from "@playwright/test";
import { NextRequest } from "next/server";

import { isSameOriginRequest } from "../../../src/lib/request-security-core";
import { proxy } from "../../../src/proxy";

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

function contentSecurityPolicy(url: string, headers?: HeadersInit): string {
  const policy = proxy(new NextRequest(url, { headers })).headers.get(
    "Content-Security-Policy",
  );
  if (policy === null) throw new Error("Proxy did not set a CSP header");
  return policy;
}

test.describe("same-origin request security", () => {
  test("omits HTTPS upgrading only for production HTTP loopback requests", () => {
    const localhostPolicy = contentSecurityPolicy(
      "http://localhost:3104/workspace",
      { host: "localhost:3104" },
    );
    expect(localhostPolicy).not.toContain("upgrade-insecure-requests");
    expect(localhostPolicy).toMatch(
      /script-src 'self' 'nonce-[^']+' 'strict-dynamic';/,
    );
    expect(localhostPolicy).toContain("object-src 'none';");
    expect(
      contentSecurityPolicy("http://localhost:3104/workspace", {
        host: "localhost",
      }),
    ).not.toContain("upgrade-insecure-requests");

    for (const [url, host] of [
      ["http://127.0.0.1:3104/workspace", "127.0.0.1:3104"],
      ["http://[::1]:3104/workspace", "[::1]:3104"],
    ]) {
      expect(contentSecurityPolicy(url, { host })).not.toContain(
        "upgrade-insecure-requests",
      );
    }
  });

  test("keeps HTTPS upgrading for public HTTPS and external HTTP requests", () => {
    for (const url of [
      "https://127.0.0.1:3104/workspace",
      "https://app.example/workspace",
      "http://app.example/workspace",
    ]) {
      expect(contentSecurityPolicy(url, { host: new URL(url).host })).toContain(
        "upgrade-insecure-requests",
      );
    }
  });

  test("does not trust forwarded headers to exempt a public origin", () => {
    expect(
      contentSecurityPolicy("https://app.example/workspace", {
        host: "app.example",
        "x-forwarded-host": "127.0.0.1:3104",
        "x-forwarded-proto": "http",
      }),
    ).toContain("upgrade-insecure-requests");
  });

  test("requires the actual Host header to be loopback before exempting HTTPS upgrading", () => {
    expect(
      contentSecurityPolicy("http://127.0.0.1:3104/workspace", {
        host: "app.example",
      }),
    ).toContain("upgrade-insecure-requests");
    expect(contentSecurityPolicy("http://127.0.0.1:3104/workspace")).toContain(
      "upgrade-insecure-requests",
    );
  });

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

test("same-origin validation accepts bracketed IPv6 authority but rejects malformed variants", () => {
  expect(
    isSameOriginRequest(
      requestWithHeaders("http://internal/bff", {
        host: "[::1]:3104",
        origin: "http://[::1]:3104",
      }),
    ),
  ).toBe(true);
  expect(
    isSameOriginRequest(
      requestWithHeaders("http://internal/bff", {
        host: "[::1]",
        origin: "http://[::1]",
      }),
    ),
  ).toBe(true);
  for (const host of ["[::1", "[::1]suffix", "::1", "[invalid]:3104"]) {
    expect(
      isSameOriginRequest(
        requestWithHeaders("http://internal/bff", {
          host,
          origin: "http://[::1]:3104",
        }),
      ),
      host,
    ).toBe(false);
  }
});

test("same-origin validation fails closed on malformed request URL or Referer", () => {
  expect(sameOriginRequest({ origin: EXPECTED_ORIGIN }, "not-a-url")).toBe(
    false,
  );
  expect(
    sameOriginRequest({ origin: EXPECTED_ORIGIN, referer: "not-a-url" }),
  ).toBe(false);
});
