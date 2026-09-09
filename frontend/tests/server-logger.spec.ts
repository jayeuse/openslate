import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { safeLogRoute } from "../src/lib/log-routes";

function harness(directory: string) {
  let timestamp = "2026-09-09T23:59:59.000Z";
  const terminal: string[] = [];
  const exports: { logSafeEvent?: (event: Record<string, unknown>) => void } =
    {};
  const source = ts.transpileModule(
    fs.readFileSync(
      path.resolve(__dirname, "../src/lib/server-logger.ts"),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  runInNewContext(source, {
    exports,
    require: (name: string) => {
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "./log-routes") return { safeLogRoute };
      return {};
    },
    process: { env: { LOG_DIR: directory }, cwd: () => directory },
    Date: class extends Date {
      constructor() {
        super(timestamp);
      }
    },
    console: Object.fromEntries(
      ["info", "warn", "error"].map((level) => [
        level,
        (line: string) => terminal.push(`${level} ${line}`),
      ]),
    ),
  });
  return {
    terminal,
    log: (event: Record<string, unknown>) => exports.logSafeEvent!(event),
    time: (value: string) => {
      timestamp = value;
    },
  };
}
const event = {
  event: "request_completed",
  requestId: "019c0000-0000-7000-8000-000000000001",
  route: "/bff/records",
  method: "POST",
  status: 201,
  elapsedMs: 12,
};

test("daily files append full correlation and terminal distinguishes outcomes", () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "openslate-logs-"));
  try {
    const h = harness(directory);
    h.log(event);
    h.log({
      ...event,
      event: "backend_attempt_completed",
      status: 401,
      backendRequestId: event.requestId,
    });
    h.log({ ...event, status: 409, reason: "backend_error" });
    h.time("2026-09-10T00:00:00.000Z");
    h.log({ ...event, status: 504, reason: "deadline_exceeded" });
    const rows = fs
      .readFileSync(path.join(directory, "2026-09-09.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      backend_request_id: event.requestId,
      severity: "warn",
      timestamp: "2026-09-09T23:59:59.000Z",
    });
    expect(
      fs.readFileSync(path.join(directory, "2026-09-10.log"), "utf8"),
    ).toContain('"status":504');
    expect(h.terminal).toHaveLength(3);
    expect(h.terminal[0]).not.toContain(event.requestId);
    expect(h.terminal[0]).toContain("INFO frontend POST /bff/records 201 12ms");
    expect(h.terminal[1]).toContain("WARN frontend");
    expect(h.terminal[2]).toContain("ERROR frontend");
    expect(
      fs.statSync(path.join(directory, "2026-09-09.log")).mode & 0o777,
    ).toBe(0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown fields, paths, IDs and reasons never disclose secret canaries", () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "openslate-logs-"));
  try {
    const h = harness(directory);
    h.log({
      ...event,
      event: "secret_canary",
      route: "/bff/records?secret_canary",
      method: "secret_canary",
      requestId: "secret_canary",
      backendRequestId: "secret_canary",
      reason: "secret_canary",
      body: "secret_canary",
      status: -1,
      elapsedMs: NaN,
    });
    const output = fs.readFileSync(
      path.join(directory, "2026-09-09.log"),
      "utf8",
    );
    expect(output).not.toContain("secret_canary");
    expect(output).toContain('"route":"unmatched"');
    expect(safeLogRoute(`/bff/fields/${event.requestId}/close`)).toBe(
      "/bff/fields/{id}/close",
    );
    expect(safeLogRoute("/bff/fields/private-value/close")).toBe("unmatched");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sink failure is nonfatal, rate limited and signals recovery", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "openslate-logs-"));
  const directory = path.join(root, "blocked");
  try {
    fs.writeFileSync(directory, "not a directory");
    const h = harness(directory);
    expect(() => h.log(event)).not.toThrow();
    h.log(event);
    expect(
      h.terminal.filter((line) => line.includes("log_sink_failed")),
    ).toHaveLength(1);
    h.time("2026-09-10T00:01:00.000Z");
    h.log(event);
    expect(
      h.terminal.filter((line) => line.includes("log_sink_failed")),
    ).toHaveLength(2);
    fs.unlinkSync(directory);
    h.log(event);
    expect(
      h.terminal.filter((line) => line.includes("log_sink_recovered")),
    ).toHaveLength(1);
    expect(fs.existsSync(path.join(directory, "2026-09-10.log"))).toBe(true);
    fs.rmSync(directory, { recursive: true });
    fs.writeFileSync(directory, "blocked again");
    h.log(event);
    expect(
      h.terminal.filter((line) => line.includes("log_sink_failed")),
    ).toHaveLength(3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
