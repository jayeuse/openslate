import type { NextConfig } from "next";

import { validatePublicEnvironment } from "./src/lib/environment";

validatePublicEnvironment();

const nextConfig: NextConfig = {
  logging: {
    incomingRequests: {
      ignore: [
        /^\/bff(?:\/|$)/,
        /^\/session(?:\/|$)/,
        /^\/auth\/callback(?:\?|$)/,
      ],
    },
  },
  output: "standalone",
  reactStrictMode: true,
  typedRoutes: true,
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
        ],
      },
    ];
  },
};

export default nextConfig;
