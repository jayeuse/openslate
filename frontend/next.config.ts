import type { NextConfig } from "next";
import { isIP } from "node:net";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

function isLoopbackBackendHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

function developmentBackendOrigin(): string {
  const backendHost = process.env.BACKEND_BIND_HOST;
  const backendPort = Number(process.env.BACKEND_PORT);

  if (!backendHost || !isLoopbackBackendHost(backendHost))
    throw new Error(
      "BACKEND_BIND_HOST must be a loopback host for Next development",
    );
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65_535)
    throw new Error(
      "BACKEND_PORT must be set to a valid port for Next development",
    );

  // Next parses external rewrite hostnames with path-to-regexp, which cannot
  // compile a literal IPv6 address. The launcher forces localhost to resolve
  // IPv6 first when the FastAPI listener is bound to ::1.
  const hostname = backendHost === "::1" ? "localhost" : backendHost;
  return `http://${hostname}:${backendPort}`;
}

function developmentOriginHost(): string {
  const hostname = process.env.OPENSLATE_DEV_ORIGIN_HOST;
  if (!hostname || /[\s*/?#]/.test(hostname))
    throw new Error(
      "OPENSLATE_DEV_ORIGIN_HOST must be one exact hostname for Next development",
    );
  return hostname;
}

export default function createNextConfig(phase: string): NextConfig {
  const isDevelopment = phase === PHASE_DEVELOPMENT_SERVER;
  const baseConfig = {
    reactStrictMode: true,
    typedRoutes: true,
    images: { unoptimized: true },
  };

  if (!isDevelopment) return { ...baseConfig, output: "export" };

  const backendOrigin = developmentBackendOrigin();
  const allowedDevOrigin = developmentOriginHost();

  return {
    ...baseConfig,
    allowedDevOrigins: [allowedDevOrigin],
    // Keep every compiled route. Disposing an idle route recompiles and sends a
    // Fast Refresh to every open page; mid-test that refresh dropped a pending
    // router.push (Dashboards deep-link test: up to 48 of 60 failed at 10 workers).
    onDemandEntries: { maxInactiveAge: 60 * 60 * 1000, pagesBufferLength: 100 },
    experimental: { proxyClientMaxBodySize: "25mb" },
    async rewrites() {
      return [
        {
          source: "/api/:path*",
          destination: `${backendOrigin}/api/:path*`,
        },
      ];
    },
  };
}
