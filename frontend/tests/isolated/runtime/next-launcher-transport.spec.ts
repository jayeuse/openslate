import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { resolve } from "node:path";

import { chromium, expect, test } from "@playwright/test";

const frontendRoot = process.cwd();

async function stopLauncher(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.kill("SIGTERM");
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}

function forgedRequest(port: number): Promise<{
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  peer: string | undefined;
}> {
  return new Promise((resolveRequest, reject) => {
    let peer: string | undefined;
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/capture",
        headers: [
          "Host",
          `127.0.0.1:${port}`,
          "X-Forwarded-For",
          "203.0.113.20",
          "X-Forwarded-For",
          "198.51.100.30",
          "X-Forwarded-Host",
          "forged.example",
          "X-Forwarded-Port",
          "443",
          "X-Forwarded-Proto",
          "https",
          "Forwarded",
          "for=203.0.113.20;proto=https",
        ],
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolveRequest({ ...JSON.parse(body), peer });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on("socket", (socket) => {
      socket.once("connect", () => {
        peer = socket.localAddress;
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("actual development ingress replaces spoofed headers and preserves HMR and shutdown", async () => {
  test.setTimeout(120_000);
  const fixtureRoot = mkdtempSync(resolve(frontendRoot, ".proxy-transport-"));
  const fixtureFrontend = resolve(fixtureRoot, "frontend");
  const fixtureLauncher = resolve(fixtureFrontend, "tooling/run-next.mjs");
  const pageFile = resolve(fixtureFrontend, "app/page.jsx");
  mkdirSync(resolve(fixtureFrontend, "tooling"), { recursive: true });
  mkdirSync(resolve(fixtureFrontend, "app"), { recursive: true });
  cpSync(resolve(frontendRoot, "tooling/run-next.mjs"), fixtureLauncher);
  cpSync(
    resolve(frontendRoot, "next.config.ts"),
    resolve(fixtureFrontend, "next.config.ts"),
  );
  symlinkSync(
    resolve(frontendRoot, "node_modules"),
    resolve(fixtureFrontend, "node_modules"),
    "dir",
  );
  writeFileSync(
    resolve(fixtureFrontend, "package.json"),
    JSON.stringify({ name: "owned-proxy-fixture", private: true }),
  );
  writeFileSync(
    resolve(fixtureFrontend, "app/layout.jsx"),
    "export default function Layout({children}) { return <html><body>{children}</body></html>; }\n",
  );
  const pageSource = (label: string) =>
    `export default function Page() { return <main><h1>${label}</h1></main>; }\n`;
  writeFileSync(pageFile, pageSource("Owned transport fixture before"));

  const capture = createServer((incoming, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        headers: incoming.headers,
        rawHeaders: incoming.rawHeaders,
      }),
    );
  });
  capture.listen(0, "127.0.0.1");
  await once(capture, "listening");
  const capturePort = (capture.address() as AddressInfo).port;
  const frontendPort = 3116;
  writeFileSync(
    resolve(fixtureRoot, ".env"),
    [
      "FRONTEND_DEV_PORT=1",
      "BACKEND_BIND_HOST=127.0.0.1",
      `BACKEND_PORT=${capturePort}`,
      `PUBLIC_ORIGIN=http://127.0.0.1:${frontendPort}`,
    ].join("\n"),
  );
  let logs = "";
  const child = spawn(
    process.execPath,
    [fixtureLauncher, "dev", "--hostname=127.0.0.1", `--port=${frontendPort}`],
    {
      cwd: fixtureFrontend,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });
  const origin = `http://127.0.0.1:${frontendPort}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null)
            throw new Error(`Launcher exited: ${logs}`);
          try {
            return (await fetch(`${origin}/api/capture`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(200);

    const captured = await forgedRequest(frontendPort);
    expect(captured.headers["x-forwarded-for"]).toBe(captured.peer);
    expect(captured.peer).toBe("127.0.0.1");
    expect(
      captured.rawHeaders
        .filter((_, index) => index % 2 === 0)
        .map((name) => name.toLowerCase())
        .filter((name) => name === "x-forwarded-for"),
    ).toHaveLength(1);
    expect(captured.headers["x-forwarded-host"]).toBe(
      `127.0.0.1:${frontendPort}`,
    );
    expect(captured.headers["x-forwarded-port"]).toBe(String(frontendPort));
    expect(captured.headers["x-forwarded-proto"]).toBe("http");
    expect(captured.headers.forwarded).toBeUndefined();

    // Next installs its own upgrade handler after the first HTTP request.
    // Exercise the same sanitizer before Next's API websocket rewrite.
    const upgraded = new Promise<IncomingHttpHeaders>((resolveUpgrade) => {
      capture.once("upgrade", (incoming, socket) => {
        resolveUpgrade(incoming.headers);
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      });
    });
    const socket = connect(frontendPort, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      [
        "GET /api/capture HTTP/1.1",
        `Host: 127.0.0.1:${frontendPort}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "X-Forwarded-For: 203.0.113.20",
        "X-Forwarded-For: 198.51.100.30",
        "X-Forwarded-Proto: https",
        "Forwarded: for=203.0.113.20",
        "",
        "",
      ].join("\r\n"),
    );
    const upgradeHeaders = await upgraded;
    socket.destroy();
    expect(upgradeHeaders["x-forwarded-for"]).toBe("127.0.0.1");
    expect(upgradeHeaders["x-forwarded-proto"]).toBe("http");
    expect(upgradeHeaders.forwarded).toBeUndefined();

    // Cold compilation belongs to fixture setup, before the bounded HMR wait.
    const warmup = await fetch(origin);
    expect(warmup.status).toBe(200);
    await warmup.arrayBuffer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    const hmr = page.waitForEvent("websocket", {
      predicate: (webSocket) => webSocket.url().includes("/_next/hmr"),
      timeout: 10_000,
    });
    await page.goto(origin);
    await expect(
      page.getByRole("heading", { name: "Owned transport fixture before" }),
    ).toBeVisible();
    const hmrSocket = await hmr;
    expect(hmrSocket.isClosed()).toBe(false);
    writeFileSync(pageFile, pageSource("Owned transport fixture after"));
    await expect(
      page.getByRole("heading", { name: "Owned transport fixture after" }),
    ).toBeVisible({ timeout: 30_000 });
    expect(hmrSocket.isClosed()).toBe(false);
    await browser.close();
    browser = undefined;
    await stopLauncher(child);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    await expect
      .poll(async () => {
        try {
          await fetch(`${origin}/api/capture`);
          return "listening";
        } catch {
          return "closed";
        }
      })
      .toBe("closed");
  } finally {
    await browser?.close();
    await stopLauncher(child);
    capture.closeAllConnections();
    await new Promise<void>((done) => capture.close(() => done()));
    await test.info().attach("launcher-transport.log", {
      body: logs,
      contentType: "text/plain",
    });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
