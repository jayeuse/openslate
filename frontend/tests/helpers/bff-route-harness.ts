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
        TextDecoder,
        AbortController,
        crypto,
        Date,
        process: { env: {}, cwd: () => "/tmp" },
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
    request: (method = "POST") =>
      (route[method] as Handler)(
        new Request("http://localhost/bff/records", {
          method,
          headers: {
            host: "localhost",
            origin: "http://localhost",
            "content-type": "application/json",
          },
          ...(method === "GET" ? {} : { body: "{}" }),
        }),
        { params: Promise.resolve({ path: ["records"] }) },
      ),
  };
}
