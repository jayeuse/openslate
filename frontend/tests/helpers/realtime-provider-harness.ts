import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { Page } from "@playwright/test";

// Real React/ReactDOM lifecycle in a server-free browser; only the SDK boundary
// is replaced. Keep each script's source map and source filename for coverage.
export async function mountRealtimeProvider(page: Page, token: string) {
  await page.goto("about:blank");
  await page.clock.install();
  const root = path.resolve(__dirname, "../..");
  const modules: Record<string, string> = {};
  for (const [name, filename] of Object.entries({
    react: "react/cjs/react.development.js",
    "react/jsx-runtime": "react/cjs/react-jsx-runtime.development.js",
    "react-dom": "react-dom/cjs/react-dom.development.js",
    "react-dom/client": "react-dom/cjs/react-dom-client.development.js",
    scheduler: "scheduler/cjs/scheduler.development.js",
  }))
    modules[name] = readFileSync(
      path.join(root, "node_modules", filename),
      "utf8",
    );
  const filename = path.join(root, "src/components/realtime-provider.tsx");
  modules.provider =
    ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        inlineSourceMap: true,
        inlineSources: true,
      },
    }).outputText + `\n//# sourceURL=${pathToFileURL(filename).href}`;
  // V8 includes new Function's two-line anonymous-function wrapper in its
  // generated source. Shift generated mappings only; preserve original content.
  modules.provider = modules.provider.replace(
    /sourceMappingURL=data:application\/json;base64,([^\s]+)/,
    (_match, encoded: string) => {
      const map = JSON.parse(Buffer.from(encoded, "base64").toString()) as {
        mappings: string;
      };
      map.mappings = `;;${map.mappings}`;
      return `sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
    },
  );
  await page.evaluate(
    ({ modules, token }) => {
      const state = {
        token,
        status: 200,
        requests: 0,
        auth: [] as string[],
        removed: [] as string[],
        cleared: 0,
        broadcasts: [] as unknown[],
        events: [] as unknown[],
        subscriptions: [] as { name: string; options: unknown }[],
        callbacks: {} as Record<string, (value: { payload: unknown }) => void>,
      };
      const client = {
        realtime: { setAuth: (value: string) => state.auth.push(value) },
        removeAllChannels: async () => {
          state.cleared++;
        },
        removeChannel: async (channel: { name: string }) => {
          state.removed.push(channel.name);
        },
        channel: (name: string, options: unknown) => {
          state.subscriptions.push({ name, options });
          const channel = {
            name,
            on: (
              _type: string,
              _filter: unknown,
              callback: (value: { payload: unknown }) => void,
            ) => {
              state.callbacks[name] = callback;
              return channel;
            },
            subscribe: () => channel,
          };
          return channel;
        },
      };
      let receive: ((event: { data: unknown }) => void) | null = null;
      class Broadcast {
        set onmessage(value: (event: { data: unknown }) => void) {
          receive = value;
        }
        postMessage(value: unknown) {
          state.broadcasts.push(value);
        }
        close() {
          receive = null;
        }
      }
      Object.assign(window, { BroadcastChannel: Broadcast });
      window.fetch = async () => {
        state.requests++;
        return new Response(JSON.stringify({ access_token: state.token }), {
          status: state.status,
        });
      };
      const cache: Record<string, { exports: unknown }> = {};
      function load(name: string): unknown {
        if (name === "@/lib/supabase/browser")
          return { getSupabaseBrowserClient: () => client };
        if (cache[name]) return cache[name].exports;
        const loadedModule = { exports: {} };
        cache[name] = loadedModule;
        new Function("require", "module", "exports", "process", modules[name])(
          load,
          loadedModule,
          loadedModule.exports,
          { env: { NODE_ENV: "development" } },
        );
        return loadedModule.exports;
      }
      const React = load("react") as typeof import("react");
      const ReactDOM = load(
        "react-dom/client",
      ) as typeof import("react-dom/client");
      const provider = load(
        "provider",
      ) as typeof import("../../src/components/realtime-provider");
      let context: ReturnType<typeof provider.useRealtime>;
      function Consumer() {
        context = provider.useRealtime();
        return React.createElement("p", null, "Realtime consumer ready");
      }
      const container = document.createElement("div");
      document.body.append(container);
      const app = ReactDOM.createRoot(container);
      app.render(
        React.createElement(
          provider.RealtimeProvider,
          null,
          React.createElement(Consumer),
        ),
      );
      window.addEventListener("openslate:invalidation", (event) =>
        state.events.push((event as CustomEvent).detail),
      );
      Object.assign(window, {
        realtimeHarness: {
          state,
          token: () => context.getAccessToken(),
          invalidate: () => context.invalidate(),
          receive: (data: unknown) => receive?.({ data }),
          broadcast: (payload: unknown) =>
            state.callbacks["openslate:invalidation"]({ payload }),
          unmount: () => app.unmount(),
        },
      });
    },
    { modules, token },
  );
  await page.getByText("Realtime consumer ready").waitFor();
}

export type RealtimeHarness = {
  state: {
    token: string;
    status: number;
    requests: number;
    auth: string[];
    removed: string[];
    cleared: number;
    broadcasts: unknown[];
    events: unknown[];
    subscriptions: { name: string; options: unknown }[];
  };
  token: () => Promise<string | null>;
  invalidate: () => void;
  receive: (data: unknown) => void;
  broadcast: (payload: unknown) => void;
  unmount: () => void;
};
declare global {
  interface Window {
    realtimeHarness: RealtimeHarness;
  }
}
