import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const frontendRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(frontendRoot, "..");
const arguments_ = process.argv.slice(2);
const command = arguments_.shift();

if (!["dev", "build", "__dev-server"].includes(command))
  throw new Error("Expected next dev or next build");

const localEnvironmentFiles =
  command === "build"
    ? readdirSync(frontendRoot).filter(
        (name) => name.startsWith(".env") && name !== ".env.example",
      )
    : [];
if (localEnvironmentFiles.length)
  throw new Error(
    `Frontend-local environment files are not supported for production builds: ${localEnvironmentFiles.join(", ")}`,
  );

function hasOption(argumentsToInspect, longOption, shortOption) {
  return argumentsToInspect.some(
    (argument) =>
      argument === longOption ||
      argument.startsWith(`${longOption}=`) ||
      argument === shortOption ||
      argument.startsWith(`${shortOption}=`) ||
      (argument.startsWith(shortOption) &&
        argument.length > shortOption.length),
  );
}

const developmentEnvironment =
  command === "dev" ? loadDevelopmentEnvironment() : {};
const nextNodeArguments =
  command === "dev" && developmentEnvironment.BACKEND_BIND_HOST === "::1"
    ? ["--dns-result-order=ipv6first"]
    : [];

function loadDevelopmentEnvironment() {
  const names = ["FRONTEND_DEV_PORT", "BACKEND_BIND_HOST", "BACKEND_PORT"];
  const configured = readEnvironmentFile();
  const developmentEnvironment = Object.fromEntries(
    names.map((name) => {
      const value =
        process.env[name] ?? resolveEnvironmentValue(name, configured);
      if (name.endsWith("PORT") && !isValidPort(value))
        throw new Error(`${name} must be a valid port number`);
      if (name === "BACKEND_BIND_HOST" && !value)
        throw new Error(
          "BACKEND_BIND_HOST must be configured for Next development",
        );
      return [name, value];
    }),
  );
  const publicOrigin =
    process.env.PUBLIC_ORIGIN ??
    resolveEnvironmentValue("PUBLIC_ORIGIN", configured);

  return {
    ...developmentEnvironment,
    OPENSLATE_DEV_ORIGIN_HOST: developmentOriginHost(publicOrigin),
  };
}

function readEnvironmentFile() {
  const environmentPath = existsSync(resolve(repositoryRoot, ".env"))
    ? resolve(repositoryRoot, ".env")
    : resolve(repositoryRoot, ".env.example");
  return parseEnv(readFileSync(environmentPath, "utf8"));
}

function resolveEnvironmentValue(name, values, chain = []) {
  if (chain.includes(name))
    throw new Error(`Environment reference cycle includes ${name}`);
  const value = values[name];
  if (value === undefined) return undefined;

  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, reference) => {
    const resolved = resolveEnvironmentValue(reference, values, [
      ...chain,
      name,
    ]);
    if (resolved === undefined)
      throw new Error(`${name} references missing ${reference}`);
    return resolved;
  });
}

function developmentRealtime() {
  const configured = readEnvironmentFile();
  const value = (name) =>
    process.env[name] ?? resolveEnvironmentValue(name, configured);
  const origin = value("SUPABASE_URL");
  const publishableKey = value("SUPABASE_PUBLISHABLE_KEY");
  if (!origin || !publishableKey) return null;
  let gateway;
  try {
    gateway = new URL(origin);
  } catch {
    throw new Error("SUPABASE_URL must be an owned HTTP loopback origin");
  }
  if (
    gateway.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(gateway.hostname) ||
    !isValidPort(gateway.port) ||
    gateway.username ||
    gateway.password ||
    gateway.pathname !== "/" ||
    gateway.search ||
    gateway.hash
  )
    throw new Error("SUPABASE_URL must be an owned HTTP loopback origin");
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))
    throw new Error("SUPABASE_PUBLISHABLE_KEY must be a publishable key");
  // Only this server-side closure retains the key; Next's environment is unchanged.
  return { gateway, publishableKey };
}

function developmentOriginHost(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    !origin.hostname ||
    origin.username ||
    origin.password
  )
    throw new Error("PUBLIC_ORIGIN must be an absolute HTTP(S) URL");
  if (!isPermittedDevelopmentHost(origin.hostname))
    throw new Error("PUBLIC_ORIGIN must use a permitted local or LAN hostname");
  return origin.hostname;
}

function isPermittedDevelopmentHost(hostname) {
  if (hostname === "localhost") return true;
  const address = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  const family = isIP(address);
  if (family === 4) return isPermittedIpv4(address);
  if (family === 6) return isPermittedIpv6(address);
  return false;
}

function isPermittedIpv4(address) {
  const [first, second] = address.split(".").map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isPermittedIpv6(address) {
  if (address === "::1") return true;
  const firstSegment = address.split(":", 1)[0];
  const first = Number.parseInt(firstSegment, 16);
  return (
    (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf)
  );
}

function isValidPort(value) {
  return (
    Boolean(value) &&
    /^\d+$/.test(value) &&
    Number(value) >= 1 &&
    Number(value) <= 65_535
  );
}

const nextArguments = [
  command,
  ...(command === "dev"
    ? [
        ...(hasOption(arguments_, "--hostname", "-H")
          ? []
          : ["--hostname", "127.0.0.1"]),
        ...(hasOption(arguments_, "--port", "-p")
          ? []
          : ["--port", developmentEnvironment.FRONTEND_DEV_PORT]),
      ]
    : []),
  ...arguments_,
];
const inheritedEnvironment = { ...process.env };
delete inheritedEnvironment.PUBLIC_ORIGIN;
if (command === "__dev-server") {
  await startDevelopmentServer(arguments_);
} else {
  const customDevelopment =
    command === "dev" &&
    !arguments_.some((argument) => ["--help", "-h"].includes(argument));
  const child = spawn(
    process.execPath,
    [
      ...nextNodeArguments,
      ...(customDevelopment
        ? [process.argv[1], "__dev-server", ...nextArguments.slice(1)]
        : [
            resolve(frontendRoot, "node_modules/next/dist/bin/next"),
            ...nextArguments,
          ]),
    ],
    {
      cwd: frontendRoot,
      env: {
        ...inheritedEnvironment,
        ...developmentEnvironment,
        NODE_ENV: command === "dev" ? "development" : "production",
      },
      stdio: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  process.once("exit", () => child.kill("SIGKILL"));
  child.on("error", (error) => {
    throw error;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}

function developmentOptions(argumentsToInspect) {
  const options = {};
  for (let index = 0; index < argumentsToInspect.length; index += 1) {
    const argument = argumentsToInspect[index];
    if (["--webpack", "--turbopack", "--turbo"].includes(argument)) {
      options[argument === "--webpack" ? "webpack" : "turbopack"] = true;
      continue;
    }
    const match = /^(--hostname|--port|-H|-p)(?:=(.*))?$/.exec(argument);
    const attached = /^(-H|-p)(.+)$/.exec(argument);
    if (!match && !attached)
      throw new Error(`Unsupported development option: ${argument}`);
    const name = (match ?? attached)[1];
    const value =
      (match ? match[2] : attached[2]) ?? argumentsToInspect[++index];
    if (!value || value.startsWith("-"))
      throw new Error(`${name} requires a value`);
    options[name === "--hostname" || name === "-H" ? "hostname" : "port"] =
      value;
  }
  if (!isValidPort(options.port))
    throw new Error("--port must be a valid port number");
  return { ...options, port: Number(options.port) };
}

function sanitizeForwardingHeaders(request) {
  const peer = request.socket.remoteAddress;
  if (!peer || !isIP(peer)) return false;
  const receivedHost = request.headers.host ?? "";
  const protocol = request.socket.encrypted ? "https" : "http";
  let port = protocol === "https" ? "443" : "80";
  try {
    port = new URL(`${protocol}://${receivedHost}`).port || port;
  } catch {
    /* Next's existing host handling remains responsible for invalid hosts. */
  }
  const forwarding = {
    "x-forwarded-for": peer,
    "x-forwarded-host": receivedHost,
    "x-forwarded-port": port,
    "x-forwarded-proto": protocol,
  };
  delete request.headers.forwarded;
  Object.assign(request.headers, forwarding);
  request.rawHeaders = request.rawHeaders.filter(
    (name, index, headers) =>
      !["forwarded", ...Object.keys(forwarding)].includes(
        (index % 2 === 0 ? name : headers[index - 1]).toLowerCase(),
      ),
  );
  for (const [name, value] of Object.entries(forwarding))
    request.rawHeaders.push(name, value);
  return true;
}

function realtimeTarget(request) {
  try {
    const target = new URL(request.url, "http://localhost");
    const path = decodeURIComponent(target.pathname);
    if (
      path === "/realtime" ||
      path.startsWith("/realtime/") ||
      path === "/api/broadcast" ||
      path.startsWith("/api/broadcast/")
    )
      return target;
  } catch {
    /* Other malformed paths remain with Next's normal request handling. */
  }
  return null;
}

function rejectUpgrade(socket, status) {
  if (!socket.destroyed)
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
}

function proxyRealtime(
  request,
  downstream,
  head,
  target,
  realtime,
  origin,
  sockets,
) {
  if (
    request.method !== "GET" ||
    target.pathname !== "/realtime/v1/websocket" ||
    request.url.split("?", 1)[0] !== target.pathname ||
    request.headers.upgrade?.toLowerCase() !== "websocket"
  )
    return rejectUpgrade(downstream, 404);
  if (
    [...target.searchParams.keys()].some(
      (name) => name.toLowerCase() === "apikey",
    )
  )
    return rejectUpgrade(downstream, 400);
  if (!origin || request.headers.origin !== origin)
    return rejectUpgrade(downstream, 403);
  if (!realtime) return rejectUpgrade(downstream, 503);
  const { gateway, publishableKey } = realtime;
  const headers = {
    host: gateway.host,
    apikey: publishableKey,
    connection: "Upgrade",
    upgrade: "websocket",
  };
  for (const name of [
    "origin",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
  ]) {
    if (request.headers[name] !== undefined)
      headers[name] = request.headers[name];
  }
  downstream.pause();
  let upgraded = false;
  const upstream = httpRequest({
    hostname: gateway.hostname.startsWith("[")
      ? gateway.hostname.slice(1, -1)
      : gateway.hostname,
    port: gateway.port,
    method: "GET",
    path: target.pathname + target.search,
    headers,
    timeout: 10_000,
  });
  upstream.on("socket", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  downstream.once("close", () => upstream.destroy());
  downstream.on("error", () => upstream.destroy());
  upstream.on("timeout", () => upstream.destroy());
  upstream.on("error", () =>
    upgraded ? downstream.destroy() : rejectUpgrade(downstream, 502),
  );
  upstream.on("response", (response) => {
    rejectUpgrade(downstream, response.statusCode ?? 502);
    response.resume();
  });
  upstream.on("upgrade", (response, socket, upstreamHead) => {
    upgraded = true;
    if (downstream.destroyed) {
      socket.destroy();
      return;
    }
    socket.setTimeout(0);
    downstream.setTimeout(0);
    const allowed = new Set([
      "connection",
      "upgrade",
      "sec-websocket-accept",
      "sec-websocket-protocol",
      "sec-websocket-extensions",
    ]);
    let reply = "HTTP/1.1 101 Switching Protocols\r\n";
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      if (allowed.has(response.rawHeaders[index].toLowerCase()))
        reply += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`;
    }
    downstream.write(reply + "\r\n");
    if (upstreamHead.length) downstream.write(upstreamHead);
    if (head.length) socket.write(head);
    downstream.once("close", () => socket.destroy());
    socket.on("error", () => downstream.destroy());
    socket.once("close", () => downstream.destroy());
    downstream.pipe(socket).pipe(downstream);
    downstream.resume();
  });
  upstream.end();
}

async function startDevelopmentServer(argumentsToInspect) {
  const options = developmentOptions(argumentsToInspect);
  const realtime = developmentRealtime();
  const originHost = process.env.OPENSLATE_DEV_ORIGIN_HOST;
  const realtimeOrigin = originHost
    ? new URL(`http://${originHost}:${options.port}`).origin
    : null;
  const { default: next } = await import("next");
  const sockets = new Set();
  let handler;
  const server = createServer((request, response) => {
    if (!sanitizeForwardingHeaders(request)) {
      response.writeHead(400, { Connection: "close" });
      response.end();
      return;
    }
    if (realtimeTarget(request)) {
      response.writeHead(404);
      response.end();
      return;
    }
    Promise.resolve(handler(request, response)).catch((error) => {
      console.error(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  // Installed Next leaves unmatched upgrades to custom handlers; it still owns HMR.
  server.prependListener("upgrade", (request, socket, head) => {
    if (!sanitizeForwardingHeaders(request)) {
      socket.destroy();
      return;
    }
    const target = realtimeTarget(request);
    if (target)
      proxyRealtime(
        request,
        socket,
        head,
        target,
        realtime,
        realtimeOrigin,
        sockets,
      );
  });
  const application = next({
    dev: true,
    dir: frontendRoot,
    ...options,
    httpServer: server,
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let closing = false;
  async function close(exitCode = 0) {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 5000);
    timeout.unref();
    server.close();
    for (const socket of sockets) socket.destroy();
    await application.close();
    clearTimeout(timeout);
    process.exit(exitCode);
  }
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => close());
  await application.prepare();
  handler = application.getRequestHandler();
  server.once("error", async (error) => {
    console.error(error);
    await close(1);
  });
  server.listen(options.port, options.hostname, () => {
    console.log(
      `> OpenSlate Next development listening on ${options.hostname}:${options.port}`,
    );
  });
}
