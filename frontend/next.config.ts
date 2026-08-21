import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  typedRoutes: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.BACKEND_URL ?? "http://localhost:8000"}/api/:path*`,
      },
      {
        source: "/docs",
        destination: `${process.env.BACKEND_URL ?? "http://localhost:8000"}/docs`,
      },
      {
        source: "/docs/:path*",
        destination: `${process.env.BACKEND_URL ?? "http://localhost:8000"}/docs/:path*`,
      },
      {
        source: "/redoc",
        destination: `${process.env.BACKEND_URL ?? "http://localhost:8000"}/redoc`,
      },
      {
        source: "/openapi.json",
        destination: `${process.env.BACKEND_URL ?? "http://localhost:8000"}/openapi.json`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=(), payment=()",
          },
          {
            key: "Content-Security-Policy-Report-Only",
            value:
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
