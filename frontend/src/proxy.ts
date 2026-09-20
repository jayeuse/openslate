import { NextRequest, NextResponse } from "next/server";

function isLoopbackHost(host: string | null) {
  const match = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/.exec(
    host ?? "",
  );
  if (match === null) return false;
  if (match[1] === undefined) return true;
  const port = Number(match[1]);
  return port > 0 && port <= 65_535;
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDevelopment = process.env.NODE_ENV === "development";
  const isHttpLoopback =
    request.nextUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(request.nextUrl.hostname) &&
    isLoopbackHost(request.headers.get("host"));
  // Development allows 'unsafe-inline' for style-src *instead of* the nonce:
  // per the CSP spec a nonce disables 'unsafe-inline', and Turbopack HMR plus
  // the Next.js devtools inject styles without a nonce. Production stays
  // nonce-strict.
  const contentSecurityPolicy = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""};
    ${isDevelopment ? "style-src 'self' 'unsafe-inline';" : `style-src 'self' 'nonce-${nonce}';`}
    img-src 'self' data: blob:;
    font-src 'self';
    connect-src 'self';
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    worker-src 'self' blob:;
    ${isDevelopment || isHttpLoopback ? "" : "upgrade-insecure-requests;"}
  `
    .replace(/\s{2,}/g, " ")
    .trim();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
