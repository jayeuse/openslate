import { testSecret } from "./test-secret";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

export const queryCanary = testSecret();
export const callerCanary = testSecret();

export const passwordCanary = testSecret();
export const accessCanary = testSecret();
export const refreshCanary = testSecret();

type PasswordRouteHarnessOptions = {
  setSession?: (...args: unknown[]) => Promise<unknown>;
  updateUser?: (...args: unknown[]) => Promise<unknown>;
  expireDuringBodyRead?: boolean;
  cookies?: Partial<
    Record<"openslate_access" | "openslate_refresh", string | null>
  >;
};

// Load the real handler and helpers; replace only external I/O boundaries.
export function passwordRouteHarness(
  transport: typeof fetch,
  options: PasswordRouteHarnessOptions = {},
) {
  const root = path.resolve(__dirname, "../..");
  const nativeRequire = createRequire(path.join(root, "package.json"));
  const logs: string[] = [];
  const cache = new Map<string, Record<string, unknown>>();
  let expire: (() => void) | undefined;
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
    setTimeout: (callback: () => void) => {
      expire = callback;
      return 1;
    },
    clearTimeout: () => {
      expire = undefined;
    },
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
            get: (key: string) => {
              const cookieName = key as
                "openslate_access" | "openslate_refresh";
              const configured = Object.prototype.hasOwnProperty.call(
                options.cookies ?? {},
                cookieName,
              );
              const value = configured
                ? (options.cookies?.[cookieName] ?? undefined)
                : cookieName === "openslate_access"
                  ? accessCanary
                  : cookieName === "openslate_refresh"
                    ? refreshCanary
                    : undefined;
              return value === undefined ? undefined : { value };
            },
          }),
        };
      if (name === "@/lib/supabase/server")
        return {
          createSupabaseServerClient: () => ({
            auth: {
              setSession:
                options.setSession ??
                (async () => ({
                  error: null,
                  data: {
                    session: {
                      access_token: accessCanary,
                      refresh_token: refreshCanary,
                      expires_in: 3600,
                    },
                  },
                })),
              updateUser: options.updateUser ?? (async () => ({ error: null })),
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
    expire: () => {
      if (!expire) throw new Error("No active deadline");
      expire();
    },
    post: (
      origin = "http://frontend.invalid",
      requestOptions: { expireDuringBodyRead?: boolean } = {},
    ) => {
      const payload = new TextEncoder().encode(
        JSON.stringify({
          password: passwordCanary,
          confirmation: passwordCanary,
        }),
      );
      let firstRead = true;
      const body =
        options.expireDuringBodyRead || requestOptions.expireDuringBodyRead
          ? new ReadableStream<Uint8Array>({
              pull(controller) {
                if (firstRead) {
                  firstRead = false;
                  expire?.();
                }
                controller.enqueue(payload);
                controller.close();
              },
            })
          : JSON.stringify({
              password: passwordCanary,
              confirmation: passwordCanary,
            });
      return handler(
        new Request(
          `http://frontend.invalid/session/password?secret=${queryCanary}`,
          {
            method: "POST",
            headers: {
              host: "frontend.invalid",
              origin,
              "content-type": "application/json",
              "x-request-id": callerCanary,
            },
            body,
            ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
          },
        ),
      );
    },
  };
}
