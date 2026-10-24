import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import type { FullConfig } from "@playwright/test";

import warmRoutes from "../../../tests/warm-routes";

const frontendRoot = process.cwd();
const runnerPath = resolve(frontendRoot, "tooling", "run-playwright.mjs");

function createRunnerFixture(): {
  capturePath: string;
  cleanup: () => void;
  frontend: string;
  runner: string;
} {
  const root = mkdtempSync(resolve(tmpdir(), "openslate-playwright-runner-"));
  const frontend = resolve(root, "frontend");
  const runner = resolve(frontend, "tooling", "run-playwright.mjs");
  const cli = resolve(
    frontend,
    "node_modules",
    "@playwright",
    "test",
    "cli.js",
  );
  const capturePath = resolve(root, "playwright-invocation.json");

  mkdirSync(resolve(frontend, "tooling"), { recursive: true });
  mkdirSync(resolve(cli, ".."), { recursive: true });
  cpSync(runnerPath, runner);
  writeFileSync(
    cli,
    [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(",
      "  process.env.PLAYWRIGHT_CAPTURE_PATH,",
      "  JSON.stringify({ arguments: process.argv.slice(2), testLayer: process.env.TEST_LAYER }),",
      ");",
    ].join("\n"),
  );

  return {
    capturePath,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    frontend,
    runner,
  };
}

function invokeRunner(
  fixture: ReturnType<typeof createRunnerFixture>,
  arguments_: string[],
  layer = "all",
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [fixture.runner, ...arguments_], {
    cwd: fixture.frontend,
    encoding: "utf8",
    env: {
      NODE_ENV: "test",
      BASE_URL: "http://127.0.0.1:3104",
      PATH: process.env.PATH ?? "",
      PLAYWRIGHT_CAPTURE_PATH: fixture.capturePath,
      PLAYWRIGHT_CONFIGURATION: "synthetic",
      TEST_LAYER: layer,
    },
  });
}

test("runner infers isolated-only setup from one exact project selection", () => {
  const fixture = createRunnerFixture();
  const selections: Array<[string[], string]> = [
    [["--project=isolated"], "isolated"],
    [["--project", "isolated"], "isolated"],
    [["--project=isolated", "--project=http"], "all"],
    [["--project", "isolated", "http"], "all"],
    [["--project=isolated*"], "all"],
    [["--project=http"], "all"],
    [["--config=custom.config.ts", "--project=isolated"], "all"],
    [["-ccustom.config.ts", "--project=isolated"], "all"],
  ];

  try {
    for (const [arguments_, expectedLayer] of selections) {
      const result = invokeRunner(fixture, arguments_);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(fixture.capturePath, "utf8"))).toEqual({
        arguments: ["test", ...arguments_],
        testLayer: expectedLayer,
      });
    }

    const explicitHttpLayer = invokeRunner(
      fixture,
      ["--project=isolated"],
      "http",
    );
    expect(explicitHttpLayer.status, explicitHttpLayer.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(fixture.capturePath, "utf8")).testLayer,
    ).toBe("http");
  } finally {
    fixture.cleanup();
  }
});

test("runner runs a targeted measurement without its dependency projects", () => {
  const fixture = createRunnerFixture();
  const spec = "tests/http/comms-timeline-performance.spec.ts";
  const selections: Array<[string[], string[]]> = [
    [["--project=measure"], ["--project=measure", "--no-deps"]],
    [
      ["--project", "measure"],
      ["--project", "measure", "--no-deps"],
    ],
    [[spec], [spec, "--no-deps"]],
    [
      [`${spec}:126`, "--repeat-each=3"],
      [`${spec}:126`, "--repeat-each=3", "--no-deps"],
    ],
    [
      ["--project=measure", "--no-deps"],
      ["--project=measure", "--no-deps"],
    ],
    [[], []],
    [["--project=http"], ["--project=http"]],
    [["tests/http/comms-search.spec.ts"], ["tests/http/comms-search.spec.ts"]],
    [
      ["--project=measure", "--project=http"],
      ["--project=measure", "--project=http"],
    ],
  ];

  try {
    for (const [arguments_, forwarded] of selections) {
      const result = invokeRunner(fixture, arguments_);
      expect(result.status, result.stderr).toBe(0);
      expect(
        JSON.parse(readFileSync(fixture.capturePath, "utf8")).arguments,
      ).toEqual(["test", ...forwarded]);
    }
  } finally {
    fixture.cleanup();
  }
});

test("route warmup stops after the shared deadline expires during a request", async () => {
  const originalTimeout = AbortSignal.timeout;
  const originalFetch = globalThis.fetch;
  const deadlines: AbortController[] = [];
  let requestCount = 0;

  AbortSignal.timeout = (() => {
    const deadline = new AbortController();
    deadlines.push(deadline);
    return deadline.signal;
  }) as typeof AbortSignal.timeout;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestCount += 1;
    deadlines.find((deadline) => deadline.signal === init?.signal)?.abort();
    return new Response();
  }) as typeof fetch;

  try {
    const config = {
      projects: [{ use: { baseURL: "http://127.0.0.1:3104" } }],
      webServer: {},
    } as unknown as FullConfig;
    await warmRoutes(config);
    expect(requestCount).toBe(1);
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.fetch = originalFetch;
  }
});
