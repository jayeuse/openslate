import { NextRequest, NextResponse } from "next/server";

import { currentPublicEnvironment } from "@/lib/environment";

function supabaseConnectSources() {
  const url = new URL(currentPublicEnvironment().supabaseUrl);
  const websocketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${url.origin} ${websocketProtocol}//${url.host}`;
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDevelopment = process.env.NODE_ENV === "development";
  const connectSources = ["'self'", supabaseConnectSources()]
    .filter(Boolean)
    .join(" ");
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
    connect-src ${connectSources};
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    worker-src 'self' blob:;
    ${isDevelopment ? "" : "upgrade-insecure-requests;"}
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
      source:
        "/((?!api|bff|session|auth/callback|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
