import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

export const passwordCanary = "password-secret-canary-123";
export const accessCanary = "access-secret-canary";
export const refreshCanary = "refresh-secret-canary";

// Load the real handler and helpers; replace only external I/O boundaries.
export function passwordRouteHarness(transport: typeof fetch) {
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
      env: { NODE_ENV: "test", BACKEND_URL: "http://backend.invalid" },
    },
    console: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    fetch: transport,
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
            get: (key: string) => ({
              value: key === "openslate_access" ? accessCanary : refreshCanary,
            }),
          }),
        };
      if (name === "@/lib/supabase/server")
        return {
          createSupabaseServerClient: () => ({
            auth: {
              setSession: async () => ({
                error: null,
                data: {
                  session: {
                    access_token: accessCanary,
                    refresh_token: refreshCanary,
                    expires_in: 3600,
                  },
                },
              }),
              updateUser: async () => ({ error: null }),
            },
          }),
        };
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
  const handler = load(path.join(root, "src/app/session/password/route.ts"))
    .POST as (request: Request) => Promise<Response>;
  return {
    logs,
    post: (origin = "http://frontend.invalid") =>
      handler(
        new Request(
          "http://frontend.invalid/session/password?secret=query-canary",
          {
            method: "POST",
            headers: {
              host: "frontend.invalid",
              origin,
              "content-type": "application/json",
              "x-request-id": "caller-forged-canary",
            },
            body: JSON.stringify({
              password: passwordCanary,
              confirmation: passwordCanary,
            }),
          },
        ),
      ),
  };
}
