import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import {
  validatePublicEnvironment,
  validateRuntimeEnvironment,
} from "../../../src/lib/environment";

const environment = {
  BACKEND_URL: "http://backend.test",
  SUPABASE_SERVER_URL: "http://supabase.test",
  LOG_DIR: "/tmp/openslate-logs",
  BFF_REQUEST_BODY_LIMIT_BYTES: "1048576",
  BFF_RESPONSE_BODY_LIMIT_BYTES: "8388608",
  BFF_REQUEST_DEADLINE_MS: "60000",
  PORT: "3000",
  HOSTNAME: "127.0.0.1",
  NEXT_PUBLIC_SUPABASE_URL: "http://supabase.test",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-key",
  NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED: "false",
};

type CreateClientCall = [string, string, Record<string, unknown>];

function loadSupabaseWrappers(values: Record<string, string | undefined>) {
  const root = resolve(__dirname, "../../../src");
  const cache = new Map<string, Record<string, unknown>>();
  const calls: CreateClientCall[] = [];
  const load = (filename: string): Record<string, unknown> => {
    const cached = cache.get(filename);
    if (cached) return cached;
    const exports: Record<string, unknown> = {};
    cache.set(filename, exports);
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        inlineSourceMap: true,
        inlineSources: true,
      },
    }).outputText;
    runInNewContext(
      source,
      {
        exports,
        require: (name: string): unknown => {
          if (name === "server-only") return {};
          if (name === "@supabase/supabase-js")
            return {
              createClient: (
                url: string,
                key: string,
                options: Record<string, unknown>,
              ) => {
                calls.push([url, key, options]);
                return { url, key };
              },
            };
          const dependency = name.startsWith("@/")
            ? resolve(root, `${name.slice(2)}.ts`)
            : resolve(dirname(filename), `${name}.ts`);
          return load(dependency);
        },
        URL,
        process: { env: values },
      },
      { filename },
    );
    return exports;
  };
  return {
    environment: load(resolve(root, "lib/environment.ts")),
    server: load(resolve(root, "lib/supabase/server.ts")),
    calls,
  };
}

test("runtime environment accepts one complete valid configuration", () => {
  expect(validateRuntimeEnvironment(environment)).toMatchObject({
    backendUrl: "http://backend.test",
    supabaseServerUrl: "http://supabase.test",
    logDir: "/tmp/openslate-logs",
    requestBodyLimitBytes: 1048576,
    responseBodyLimitBytes: 8388608,
    requestDeadlineMilliseconds: 60000,
    port: 3000,
    hostname: "127.0.0.1",
  });
  expect(validatePublicEnvironment(environment)).toEqual({
    supabaseUrl: "http://supabase.test",
    supabasePublishableKey: "synthetic-publishable-key",
    lifecyclePurgeEnabled: false,
  });
});

test("missing and malformed configuration identifies only its variable name", () => {
  const secretCanary = "must-not-appear-in-errors";
  for (const [name, value] of [
    ["BACKEND_URL", undefined],
    ["SUPABASE_SERVER_URL", `https://user:${secretCanary}@supabase.test`],
    ["LOG_DIR", ""],
    ["LOG_DIR", "logs"],
    ["BFF_REQUEST_BODY_LIMIT_BYTES", "0"],
    ["BFF_RESPONSE_BODY_LIMIT_BYTES", "1.5"],
    ["BFF_REQUEST_DEADLINE_MS", "-1"],
    ["PORT", "65536"],
    ["HOSTNAME", "\n"],
  ] as const) {
    const candidate = { ...environment, [name]: value };
    expect(() => validateRuntimeEnvironment(candidate)).toThrow(name);
    expect(() => validateRuntimeEnvironment(candidate)).not.toThrow(
      secretCanary,
    );
  }

  for (const [name, value] of [
    ["NEXT_PUBLIC_SUPABASE_URL", "ftp://supabase.test"],
    ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", ""],
    ["NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED", "yes"],
  ] as const) {
    const candidate = { ...environment, [name]: value };
    expect(() => validatePublicEnvironment(candidate)).toThrow(name);
    expect(() => validatePublicEnvironment(candidate)).not.toThrow(
      secretCanary,
    );
  }
});

test("public environment exposes canonical inline browser fields", () => {
  const wrappers = loadSupabaseWrappers({
    ...environment,
    NEXT_PUBLIC_SUPABASE_URL: "https://browser.supabase.test/",
    NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED: "true",
  });
  const current = wrappers.environment
    .currentPublicEnvironment as () => unknown;
  expect(current()).toEqual({
    supabaseUrl: "https://browser.supabase.test",
    supabasePublishableKey: "synthetic-publishable-key",
    lifecyclePurgeEnabled: true,
  });
});

test("Supabase authentication uses the server origin", () => {
  const values = {
    ...environment,
    NEXT_PUBLIC_SUPABASE_URL: "https://browser.supabase.test",
    SUPABASE_SERVER_URL: "http://supabase-internal.test",
  };
  const wrappers = loadSupabaseWrappers(values);
  const server = wrappers.server.createSupabaseServerClient as () => unknown;

  server();

  expect(wrappers.calls).toHaveLength(1);
  expect(wrappers.calls[0]).toMatchObject([
    "http://supabase-internal.test",
    "synthetic-publishable-key",
    { auth: { persistSession: false } },
  ]);

  const missingServer = loadSupabaseWrappers({
    ...values,
    SUPABASE_SERVER_URL: undefined,
  });
  const createServer = missingServer.server
    .createSupabaseServerClient as () => unknown;
  expect(createServer).toThrow("SUPABASE_SERVER_URL");
});
