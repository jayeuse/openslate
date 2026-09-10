import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Load the real handler and helpers; replace only external I/O boundaries.
export function sessionRouteHarness(
  route:
    | "session/login"
    | "session/logout"
    | "session/status"
    | "session/realtime-token"
    | "auth/callback",
  auth: Record<string, (...args: unknown[]) => Promise<unknown>>,
  cookies: Record<string, string> = {},
) {
  const root = path.resolve(__dirname, "../..");
  const nativeRequire = createRequire(path.join(root, "package.json"));
  const logs: string[] = [];
  const cache = new Map<string, Record<string, unknown>>();
  const context = vm.createContext({
    Request,
    Response,
    Headers,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    DOMException,
    Uint8Array,
    crypto,
    setTimeout,
    clearTimeout,
    process: {
      cwd: () => "/tmp",
      env: {
        NODE_ENV: "test",
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
    },
    console: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    fetch: () => {
      throw new Error("Unexpected network request");
    },
  });
  function load(filename: string): Record<string, unknown> {
    const cached = cache.get(filename);
    if (cached) return cached;
    const loadedModule = { exports: {} as Record<string, unknown> };
    cache.set(filename, loadedModule.exports);
    const requireModule = (name: string): unknown => {
      if (name === "server-only") return {};
      if (name === "node:fs")
        return {
          mkdirSync: () => undefined,
          appendFileSync: (_path: string, line: string) => logs.push(line),
        };
      if (name === "next/headers")
        return {
          cookies: async () => ({
            get: (key: string) =>
              cookies[key] === undefined ? undefined : { value: cookies[key] },
          }),
        };
      if (name === "@/lib/supabase/server")
        return { createSupabaseServerClient: () => ({ auth }) };
      if (name.startsWith("@/"))
        return load(path.join(root, "src", `${name.slice(2)}.ts`));
      if (name.startsWith("."))
        return load(path.resolve(path.dirname(filename), `${name}.ts`));
      return nativeRequire(name);
    };
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        inlineSourceMap: true,
        inlineSources: true,
      },
      fileName: filename,
    }).outputText;
    const evaluate = vm.runInContext(
      `(function(require,module,exports){${source}\n})`,
      context,
      { filename },
    ) as (
      require: typeof requireModule,
      loadedModule: { exports: Record<string, unknown> },
      exports: Record<string, unknown>,
    ) => void;
    evaluate(requireModule, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  const handlers = load(path.join(root, `src/app/${route}/route.ts`));
  return {
    logs,
    request: (
      options: {
        method?: "GET" | "POST";
        query?: string;
        origin?: string;
        body?: string;
      } = {},
    ) => {
      const method =
        options.method ??
        (route === "session/login" || route === "session/logout"
          ? "POST"
          : "GET");
      const handler = handlers[method] as (
        request: Request,
      ) => Promise<Response>;
      return handler(
        new Request(`http://frontend.invalid/${route}${options.query ?? ""}`, {
          method,
          headers: {
            host: "frontend.invalid",
            origin: options.origin ?? "http://frontend.invalid",
            "content-type": "application/json",
          },
          ...(options.body === undefined ? {} : { body: options.body }),
        }),
      );
    },
  };
}
