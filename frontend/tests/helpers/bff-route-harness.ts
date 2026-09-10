import { testSecret } from "./test-secret";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { NextResponse } from "next/server";
import ts from "typescript";

const failureCanary = testSecret();
const expiredAccess = testSecret();
const originalRefresh = testSecret();

type Session = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};
type Handler = (
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) => Promise<NextResponse>;

export function createBffHarness(options: {
  transport: typeof fetch;
  failLogWrites?: boolean;
  refresh: () => Promise<{ data: { session: Session | null }; error: unknown }>;
}) {
  const jar = new Map<string, string>([
    ["openslate_access", expiredAccess],
    ["openslate_refresh", originalRefresh],
  ]);
  const logs: string[] = [];
  const cache = new Map<string, Record<string, unknown>>();
  const root = resolve(__dirname, "../../src");
  let expire: (() => void) | undefined;
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
          if (name === "node:fs")
            return {
              mkdirSync: () => undefined,
              appendFileSync: (_path: string, line: string) => {
                if (options.failLogWrites) throw new Error(failureCanary);
                logs.push(line);
              },
            };
          if (name === "node:path") return { resolve };
          if (name === "next/server") return { NextResponse };
          if (name === "next/headers")
            return {
              cookies: async () => ({
                get: (key: string) =>
                  jar.has(key) ? { value: jar.get(key) } : undefined,
              }),
            };
          if (name === "@/lib/supabase/server")
            return {
              createSupabaseServerClient: () => ({
                auth: { refreshSession: options.refresh },
              }),
            };
          const dependency = name.startsWith("@/")
            ? resolve(root, name.slice(2) + ".ts")
            : resolve(dirname(filename), name + ".ts");
          return load(dependency);
        },
        Request,
        Response,
        Headers,
        URL,
        Uint8Array,
        ArrayBuffer,
        ReadableStream,
        TextDecoder,
        AbortController,
        crypto,
        Date,
        process: {
          env: {
            BACKEND_URL: "http://backend.invalid",
            SUPABASE_SERVER_URL: "http://supabase.invalid",
            LOG_DIR: "/tmp/openslate-logs",
            BFF_REQUEST_BODY_LIMIT_BYTES: "1048576",
            BFF_RESPONSE_BODY_LIMIT_BYTES: "8388608",
            BFF_REQUEST_DEADLINE_MS: "60000",
            PORT: "3000",
            HOSTNAME: "127.0.0.1",
            NEXT_PUBLIC_SUPABASE_URL: "http://supabase.invalid",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-key",
            NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED: "false",
          },
          cwd: () => "/tmp",
        },
        fetch: options.transport,
        console: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        // Explicitly advance the deadline after refresh without a wall-clock sleep.
        setTimeout: (callback: () => void) => {
          expire = callback;
          return 1;
        },
        clearTimeout: () => {
          expire = undefined;
        },
      },
      { filename },
    );
    return exports;
  };
  const route = load(resolve(root, "app/bff/[...path]/route.ts"));
  return {
    logs,
    expire: () => {
      if (!expire) throw new Error("No active deadline");
      expire();
    },
    applyCookies: (response: NextResponse) => {
      for (const cookie of response.cookies.getAll()) {
        if (cookie.maxAge === 0) jar.delete(cookie.name);
        else jar.set(cookie.name, cookie.value);
      }
    },
    request: (
      method = "POST",
      input: { path?: string[]; body?: BodyInit; headers?: HeadersInit } = {},
    ) =>
      (route[method] as Handler)(
        new Request(
          `http://localhost/bff/${(input.path ?? ["records"]).join("/")}`,
          {
            method,
            headers: {
              host: "localhost",
              origin: "http://localhost",
              "content-type": "application/json",
              ...Object.fromEntries(new Headers(input.headers).entries()),
            },
            ...(method === "GET" ? {} : { body: input.body ?? "{}" }),
          },
        ),
        { params: Promise.resolve({ path: input.path ?? ["records"] }) },
      ),
  };
}
