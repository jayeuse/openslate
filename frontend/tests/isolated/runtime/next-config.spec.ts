import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

import { expect, test } from "@playwright/test";
import type { NextConfig } from "next";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
} from "next/constants";

import createNextConfig from "../../../next.config";

const frontendRoot = process.cwd();
const sourceRoot = resolve(frontendRoot, "src");
const nextLauncher = resolve(frontendRoot, "tooling", "run-next.mjs");

test.describe.configure({ mode: "serial" });

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

function createLauncherFixture({
  rootEnvironment,
  localEnvironment,
}: {
  rootEnvironment: string;
  localEnvironment?: string;
}): {
  capturePath: string;
  cleanup: () => void;
  frontend: string;
  launcher: string;
} {
  const root = mkdtempSync(resolve(tmpdir(), "openslate-next-launcher-"));
  const frontend = resolve(root, "frontend");
  const launcher = resolve(frontend, "tooling", basename(nextLauncher));
  const capturePath = resolve(root, "next-invocation.json");
  const nextBinary = resolve(
    frontend,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );

  mkdirSync(resolve(frontend, "tooling"), { recursive: true });
  mkdirSync(resolve(nextBinary, ".."), { recursive: true });
  cpSync(nextLauncher, launcher);
  writeFileSync(resolve(root, ".env"), rootEnvironment);
  if (localEnvironment !== undefined)
    writeFileSync(resolve(frontend, ".env.local"), localEnvironment);
  writeFileSync(
    nextBinary,
    [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(",
      '  "../next-invocation.json",',
      "  JSON.stringify({ arguments: process.argv.slice(2), environment: process.env, execArguments: process.execArgv }),",
      ");",
    ].join("\n"),
  );
  const nextPackage = resolve(frontend, "node_modules", "next");
  writeFileSync(
    resolve(nextPackage, "package.json"),
    JSON.stringify({ main: "index.js" }),
  );
  writeFileSync(
    resolve(nextPackage, "index.js"),
    [
      'const { writeFileSync } = require("node:fs");',
      "module.exports = () => {",
      '  writeFileSync("../next-invocation.json", JSON.stringify({',
      '    arguments: ["dev", ...process.argv.slice(3)], environment: process.env, execArguments: process.execArgv',
      "  }));",
      "  process.exit(0);",
      "};",
    ].join("\n"),
  );

  return {
    capturePath,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    frontend,
    launcher,
  };
}

function invokeFixture(
  fixture: ReturnType<typeof createLauncherFixture>,
  command: "build" | "dev",
  environment: Record<string, string> = {},
  arguments_: string[] = [],
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [fixture.launcher, command, ...arguments_],
    {
      cwd: fixture.frontend,
      encoding: "utf8",
      env: {
        ...environment,
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
      },
    },
  );
}

test("production frontend is configured only for static export", () => {
  const originalNodeEnvironment = process.env.NODE_ENV;
  let nextConfig: NextConfig;
  try {
    setEnvironment("NODE_ENV", "development");
    nextConfig = createNextConfig(PHASE_PRODUCTION_BUILD);
  } finally {
    setEnvironment("NODE_ENV", originalNodeEnvironment);
  }

  expect(nextConfig.output).toBe("export");
  expect(nextConfig.images?.unoptimized).toBe(true);
  expect(nextConfig.rewrites).toBeUndefined();
  expect(nextConfig.headers).toBeUndefined();
  expect(nextConfig.experimental?.proxyClientMaxBodySize).toBeUndefined();
  expect(readFileSync(nextLauncher, "utf8")).not.toContain("--from-process");
});

test("development config proxies only API traffic to loopback FastAPI", async () => {
  const originalBackendBindHost = process.env.BACKEND_BIND_HOST;
  const originalBackendPort = process.env.BACKEND_PORT;
  const originalNodeEnvironment = process.env.NODE_ENV;
  const originalDevOriginHost = process.env.OPENSLATE_DEV_ORIGIN_HOST;
  let nextConfig: NextConfig;
  try {
    setEnvironment("BACKEND_BIND_HOST", "127.0.0.1");
    setEnvironment("BACKEND_PORT", "8000");
    setEnvironment("NODE_ENV", "production");
    setEnvironment("OPENSLATE_DEV_ORIGIN_HOST", "localhost");
    nextConfig = createNextConfig(PHASE_DEVELOPMENT_SERVER);
  } finally {
    setEnvironment("BACKEND_BIND_HOST", originalBackendBindHost);
    setEnvironment("BACKEND_PORT", originalBackendPort);
    setEnvironment("NODE_ENV", originalNodeEnvironment);
    setEnvironment("OPENSLATE_DEV_ORIGIN_HOST", originalDevOriginHost);
  }

  expect(nextConfig.output).toBeUndefined();
  expect(nextConfig.allowedDevOrigins).toEqual(["localhost"]);
  expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe("25mb");
  expect(await nextConfig.rewrites?.()).toEqual([
    {
      source: "/api/:path*",
      destination: "http://127.0.0.1:8000/api/:path*",
    },
  ]);
});

test("development config reaches an IPv6 loopback backend through localhost", async () => {
  const originalBackendBindHost = process.env.BACKEND_BIND_HOST;
  const originalBackendPort = process.env.BACKEND_PORT;
  const originalDevOriginHost = process.env.OPENSLATE_DEV_ORIGIN_HOST;
  let nextConfig: NextConfig;
  try {
    setEnvironment("BACKEND_BIND_HOST", "::1");
    setEnvironment("BACKEND_PORT", "8000");
    setEnvironment("OPENSLATE_DEV_ORIGIN_HOST", "::1");
    nextConfig = createNextConfig(PHASE_DEVELOPMENT_SERVER);
  } finally {
    setEnvironment("BACKEND_BIND_HOST", originalBackendBindHost);
    setEnvironment("BACKEND_PORT", originalBackendPort);
    setEnvironment("OPENSLATE_DEV_ORIGIN_HOST", originalDevOriginHost);
  }

  expect(await nextConfig.rewrites?.()).toEqual([
    {
      source: "/api/:path*",
      destination: "http://localhost:8000/api/:path*",
    },
  ]);
});

test("development config allows only the projected LAN browser host", () => {
  const originalBackendBindHost = process.env.BACKEND_BIND_HOST;
  const originalBackendPort = process.env.BACKEND_PORT;
  const originalDevOriginHost = process.env.OPENSLATE_DEV_ORIGIN_HOST;
  try {
    setEnvironment("BACKEND_BIND_HOST", "127.0.0.1");
    setEnvironment("BACKEND_PORT", "8000");
    setEnvironment("OPENSLATE_DEV_ORIGIN_HOST", "192.168.254.178");
    expect(
      createNextConfig(PHASE_DEVELOPMENT_SERVER).allowedDevOrigins,
    ).toEqual(["192.168.254.178"]);
  } finally {
    setEnvironment("BACKEND_BIND_HOST", originalBackendBindHost);
    setEnvironment("BACKEND_PORT", originalBackendPort);
    setEnvironment("OPENSLATE_DEV_ORIGIN_HOST", originalDevOriginHost);
  }
});

test("development config rejects wildcard dev-origin entries", () => {
  const originalBackendBindHost = process.env.BACKEND_BIND_HOST;
  const originalBackendPort = process.env.BACKEND_PORT;
  const originalDevOriginHost = process.env.OPENSLATE_DEV_ORIGIN_HOST;
  try {
    setEnvironment("BACKEND_BIND_HOST", "127.0.0.1");
    setEnvironment("BACKEND_PORT", "8000");
    setEnvironment("OPENSLATE_DEV_ORIGIN_HOST", "*.local");
    expect(() => createNextConfig(PHASE_DEVELOPMENT_SERVER)).toThrow(
      "OPENSLATE_DEV_ORIGIN_HOST must be one exact hostname",
    );
  } finally {
    setEnvironment("BACKEND_BIND_HOST", originalBackendBindHost);
    setEnvironment("BACKEND_PORT", originalBackendPort);
    setEnvironment("OPENSLATE_DEV_ORIGIN_HOST", originalDevOriginHost);
  }
});

test("development config rejects a non-loopback backend bind", () => {
  const originalBackendBindHost = process.env.BACKEND_BIND_HOST;
  const originalBackendPort = process.env.BACKEND_PORT;
  try {
    setEnvironment("BACKEND_BIND_HOST", "192.168.1.20");
    setEnvironment("BACKEND_PORT", "8000");
    expect(() => createNextConfig(PHASE_DEVELOPMENT_SERVER)).toThrow(
      "BACKEND_BIND_HOST must be a loopback host for Next development",
    );
  } finally {
    setEnvironment("BACKEND_BIND_HOST", originalBackendBindHost);
    setEnvironment("BACKEND_PORT", originalBackendPort);
  }
});

test("frontend source has no Next request-time server boundary", () => {
  expect(existsSync(resolve(sourceRoot, "proxy.ts"))).toBe(false);
  expect(existsSync(resolve(sourceRoot, "app", "api"))).toBe(false);

  const requestTimeImports = [
    "next/server",
    "next/headers",
    '"use server"',
    "'use server'",
  ];
  const violations = sourceFiles(sourceRoot).flatMap((file) => {
    const contents = readFileSync(file, "utf8");
    return requestTimeImports
      .filter((needle) => contents.includes(needle))
      .map((needle) => `${file.replace(frontendRoot, "")} contains ${needle}`);
  });

  expect(violations).toEqual([]);
});

test("development launcher accepts caller host and port overrides", () => {
  const fixture = createLauncherFixture({
    rootEnvironment:
      "FRONTEND_DEV_PORT=3200\nBACKEND_PORT=8200\nBACKEND_BIND_HOST=127.0.0.1\nPUBLIC_ORIGIN=http://localhost:3200\n",
  });
  try {
    for (const override of [
      ["--hostname", "localhost"],
      ["--hostname=127.0.0.1"],
      ["-H", "::1"],
      ["--hostname", "0.0.0.0"],
      ["--port=9999"],
    ]) {
      const result = invokeFixture(fixture, "dev", {}, [...override, "--help"]);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("fixed by OpenSlate configuration");
    }
  } finally {
    fixture.cleanup();
  }
});

test("development launcher reads the root configuration without a gateway wrapper", () => {
  const fixture = createLauncherFixture({
    rootEnvironment:
      "FRONTEND_DEV_PORT=3200\nBACKEND_PORT=8200\nBACKEND_BIND_HOST=127.0.0.1\nPUBLIC_ORIGIN=http://localhost:3200\n",
  });
  try {
    const result = invokeFixture(fixture, "dev", {}, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Caddy");
    expect(result.stderr).not.toContain("scripts/dev.py frontend");
  } finally {
    fixture.cleanup();
  }
});

test("development launcher parses standard root dotenv syntax", () => {
  const fixture = createLauncherFixture({
    rootEnvironment:
      "export FRONTEND_DEV_PORT=3200 # local Next port\nBACKEND_PORT=8200 # local FastAPI port\nBACKEND_BIND_HOST=127.0.0.1\nPUBLIC_ORIGIN=http://192.168.254.178:\${FRONTEND_DEV_PORT}\nAUTH_JWT_SECRET=secret-canary\nDATABASE_URL=database-canary\n",
  });
  try {
    const result = invokeFixture(fixture, "dev");
    expect(result.status).toBe(0);
    const invocation = JSON.parse(readFileSync(fixture.capturePath, "utf8"));
    expect(invocation).toMatchObject({
      arguments: ["dev", "--hostname", "127.0.0.1", "--port", "3200"],
      environment: {
        BACKEND_BIND_HOST: "127.0.0.1",
        BACKEND_PORT: "8200",
        FRONTEND_DEV_PORT: "3200",
        NODE_ENV: "development",
        OPENSLATE_DEV_ORIGIN_HOST: "192.168.254.178",
      },
      execArguments: [],
    });
    expect(invocation.environment).not.toHaveProperty("AUTH_JWT_SECRET");
    expect(invocation.environment).not.toHaveProperty("DATABASE_URL");
  } finally {
    fixture.cleanup();
  }
});

test("development launcher derives but does not forward a process-level public origin", () => {
  const fixture = createLauncherFixture({
    rootEnvironment:
      "FRONTEND_DEV_PORT=3200\nBACKEND_PORT=8200\nBACKEND_BIND_HOST=127.0.0.1\nPUBLIC_ORIGIN=http://localhost:3200\n",
  });
  try {
    const result = invokeFixture(fixture, "dev", {
      PUBLIC_ORIGIN: "http://192.168.254.178:3200",
    });
    expect(result.status).toBe(0);
    const invocation = JSON.parse(readFileSync(fixture.capturePath, "utf8"));
    expect(invocation.environment.OPENSLATE_DEV_ORIGIN_HOST).toBe(
      "192.168.254.178",
    );
    expect(invocation.environment).not.toHaveProperty("PUBLIC_ORIGIN");
  } finally {
    fixture.cleanup();
  }
});

test("development launcher forces IPv6-first localhost resolution for an IPv6 backend", () => {
  const fixture = createLauncherFixture({
    rootEnvironment:
      "FRONTEND_DEV_PORT=3200\nBACKEND_PORT=8200\nBACKEND_BIND_HOST=::1\nPUBLIC_ORIGIN=http://[::1]:3200\n",
  });
  try {
    const result = invokeFixture(fixture, "dev");
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(fixture.capturePath, "utf8"))).toMatchObject(
      {
        execArguments: ["--dns-result-order=ipv6first"],
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test("development launcher rejects a malformed public origin", () => {
  const fixture = createLauncherFixture({
    rootEnvironment:
      "FRONTEND_DEV_PORT=3200\nBACKEND_PORT=8200\nBACKEND_BIND_HOST=127.0.0.1\nPUBLIC_ORIGIN=not-a-url\n",
  });
  try {
    const result = invokeFixture(fixture, "dev");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "PUBLIC_ORIGIN must be an absolute HTTP(S) URL",
    );
  } finally {
    fixture.cleanup();
  }
});

test("development launcher admits only permitted local and LAN browser hosts", () => {
  const base =
    "FRONTEND_DEV_PORT=3200\nBACKEND_PORT=8200\nBACKEND_BIND_HOST=127.0.0.1\n";
  for (const origin of [
    "http://localhost:3200",
    "http://127.0.0.1:3200",
    "http://10.2.3.4:3200",
    "http://172.16.0.1:3200",
    "http://192.168.254.178:3200",
    "http://169.254.10.20:3200",
    "http://[::1]:3200",
    "http://[fd12::1]:3200",
    "http://[fe80::1]:3200",
  ]) {
    const fixture = createLauncherFixture({
      rootEnvironment: `${base}PUBLIC_ORIGIN=${origin}\n`,
    });
    try {
      expect(invokeFixture(fixture, "dev").status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }
});

test("development launcher rejects public and non-unicast browser hosts", () => {
  const base =
    "FRONTEND_DEV_PORT=3200\nBACKEND_PORT=8200\nBACKEND_BIND_HOST=127.0.0.1\n";
  for (const origin of [
    "https://example.com:3200",
    "http://8.8.8.8:3200",
    "http://0.0.0.0:3200",
    "http://224.0.0.1:3200",
    "http://192.0.2.1:3200",
    "http://[::]:3200",
    "http://[2001:db8::1]:3200",
    "http://[ff02::1]:3200",
  ]) {
    const fixture = createLauncherFixture({
      rootEnvironment: `${base}PUBLIC_ORIGIN=${origin}\n`,
    });
    try {
      const result = invokeFixture(fixture, "dev");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "PUBLIC_ORIGIN must use a permitted local or LAN hostname",
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("launcher environment-file behavior uses an isolated fixture", () => {
  const fixture = createLauncherFixture({
    rootEnvironment:
      "FRONTEND_DEV_PORT=3200\nBACKEND_PORT=8200\nBACKEND_BIND_HOST=127.0.0.1\nPUBLIC_ORIGIN=http://localhost:3200\n",
    localEnvironment: "NEXT_PUBLIC_LEGACY_VALUE=unsafe\n",
  });
  try {
    expect(invokeFixture(fixture, "dev").status).toBe(0);
    const build = invokeFixture(fixture, "build");
    expect(build.status).not.toBe(0);
    expect(build.stderr).toContain(
      "Frontend-local environment files are not supported for production builds",
    );
  } finally {
    fixture.cleanup();
  }
});
