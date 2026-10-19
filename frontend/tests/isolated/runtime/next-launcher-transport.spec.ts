import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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

function realtimeUpgrade(
  port: number,
  path: string,
  headers: IncomingHttpHeaders = {},
  method = "GET",
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolveUpgrade, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    outgoing.setTimeout(5_000, () =>
      outgoing.destroy(new Error("Realtime upgrade deadline")),
    );
    outgoing.on("error", reject);
    outgoing.on("response", (response) => {
      response.resume();
      resolveUpgrade({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: "",
      });
    });
    outgoing.on("upgrade", (response, socket, head) => {
      let body = head.toString();
      const finish = () => {
        if (!body.includes("upstream-marker")) return;
        socket.destroy();
        resolveUpgrade({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
        });
      };
      socket.setTimeout(5_000, () =>
        socket.destroy(new Error("Realtime relay deadline")),
      );
      socket.on("error", reject);
      socket.on("data", (chunk: Buffer) => {
        body += chunk.toString();
        finish();
      });
      socket.write("client-marker");
      finish();
    });
    outgoing.end();
  });
}

test("actual development ingress replaces spoofed headers and preserves HMR and shutdown", async () => {
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
  const gatewayHeaders: IncomingHttpHeaders[] = [];
  const gatewayPayloads: string[] = [];
  const gatewayHttpPaths: string[] = [];
  const gatewaySockets = new Set<import("node:stream").Duplex>();
  const gateway = createServer((incoming, response) => {
    gatewayHttpPaths.push(incoming.url ?? "");
    response.writeHead(500).end();
  });
  gateway.on("upgrade", (incoming, socket) => {
    gatewayHeaders.push(incoming.headers);
    gatewaySockets.add(socket);
    socket.on("close", () => gatewaySockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const accept = createHash("sha1")
      .update(
        `${incoming.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\napikey: upstream-key-canary\r\nSet-Cookie: upstream-cookie-canary\r\n\r\n`,
    );
    let body = "";
    socket.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body === "client-marker") {
        gatewayPayloads.push(body);
        socket.write("upstream-marker");
      }
    });
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const gatewayPort = (gateway.address() as AddressInfo).port;
  const frontendPort = 3116;
  writeFileSync(
    resolve(fixtureRoot, ".env"),
    [
      "FRONTEND_DEV_PORT=1",
      "BACKEND_BIND_HOST=127.0.0.1",
      `BACKEND_PORT=${capturePort}`,
      `PUBLIC_ORIGIN=http://127.0.0.1:${frontendPort}`,
      `SUPABASE_URL=http://127.0.0.1:${gatewayPort}`,
      "SUPABASE_PUBLISHABLE_KEY=sb_publishable_launcher_fixture",
      "SUPABASE_SECRET_KEY=server-key-canary",
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
        // A cold `next dev` start must fit inside the 30 s test timeout with
        // its "Launcher exited" diagnostic intact.
        { timeout: 20_000 }, // measured: ready in 0.9-1.9 s (alone and in the isolated lane, load 3-8); the whole test takes 1.8-5.9 s
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

    const realtime = await realtimeUpgrade(
      frontendPort,
      "/realtime/v1/websocket?vsn=1.0.0",
      {
        origin,
        apikey: "caller-key-canary",
        "x-api-key": "caller-provider-key",
        authorization: "Bearer caller-token",
        cookie: "openslate_access=caller-cookie",
        "x-forwarded-for": "203.0.113.20",
      },
    );
    expect(realtime.status).toBe(101);
    expect(realtime.body).toBe("upstream-marker");
    expect(gatewayPayloads).toEqual(["client-marker"]);
    expect(gatewayHeaders).toHaveLength(1);
    expect(gatewayHeaders[0].apikey).toBe("sb_publishable_launcher_fixture");
    expect(gatewayHeaders[0]["x-api-key"]).toBeUndefined();
    expect(gatewayHeaders[0].authorization).toBeUndefined();
    expect(gatewayHeaders[0].cookie).toBeUndefined();
    expect(gatewayHeaders[0]["x-forwarded-for"]).toBe("127.0.0.1");
    expect(realtime.headers.apikey).toBeUndefined();
    expect(realtime.headers["set-cookie"]).toBeUndefined();
    for (const path of [
      "/realtime/v1/api/broadcast",
      "/realtime/v1/api/tenants",
      "/api/broadcast",
      "/realtime/v1/websocket",
    ]) {
      expect((await fetch(`${origin}${path}`, { method: "POST" })).status).toBe(
        404,
      );
    }
    for (const row of [
      { path: "/realtime/v1/api/broadcast", headers: { origin }, status: 404 },
      {
        path: "/realtime/v1/websocket?apikey=untrusted",
        headers: { origin },
        status: 400,
      },
      {
        path: "/realtime/v1/websocket",
        headers: { origin: "http://outside.invalid" },
        status: 403,
      },
      { path: "/realtime/v1/websocket", headers: {}, status: 403 },
    ])
      expect(
        (await realtimeUpgrade(frontendPort, row.path, row.headers)).status,
      ).toBe(row.status);
    expect(gatewayHeaders).toHaveLength(1);
    expect(gatewayHttpPaths).toEqual([]);
    expect(logs).not.toContain("server-key-canary");
    expect(logs).not.toContain("sb_publishable_launcher_fixture");

    // Cold compilation belongs to fixture setup, before the bounded HMR wait.
    const warmup = await fetch(origin);
    expect(warmup.status).toBe(200);
    await warmup.arrayBuffer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    const hmr = page.waitForEvent("websocket", {
      predicate: (webSocket) => webSocket.url().includes("/_next/hmr"),
      timeout: 5_000,
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
    ).toBeVisible();
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
    for (const socket of gatewaySockets) socket.destroy();
    gateway.closeAllConnections();
    await new Promise<void>((done) => gateway.close(() => done()));
    await test.info().attach("launcher-transport.log", {
      body: logs,
      contentType: "text/plain",
    });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
