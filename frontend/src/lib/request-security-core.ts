const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false;
  const number = Number(port);
  return Number.isInteger(number) && number >= 1 && number <= 65535;
}

function expectedOriginForRequest(request: Request): string | null {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return null;
  }

  const protocol = requestUrl.protocol;
  if (!HTTP_PROTOCOLS.has(protocol)) return null;

  const host = request.headers.get("host");
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    /[\s\p{Cc},@/?#\\]/u.test(host)
  ) {
    return null;
  }

  let port: string | undefined;
  if (host.startsWith("[")) {
    const closingBracket = host.indexOf("]");
    if (closingBracket < 0) return null;
    const suffix = host.slice(closingBracket + 1);
    if (suffix !== "") {
      if (!suffix.startsWith(":")) return null;
      port = suffix.slice(1);
    }
  } else {
    const firstColon = host.indexOf(":");
    if (firstColon >= 0) {
      if (firstColon !== host.lastIndexOf(":")) return null;
      port = host.slice(firstColon + 1);
    }
  }
  if (port !== undefined && !isValidPort(port)) return null;

  try {
    const authorityUrl = new URL(`${protocol}//${host}/`);
    if (
      authorityUrl.username !== "" ||
      authorityUrl.password !== "" ||
      authorityUrl.pathname !== "/" ||
      authorityUrl.search !== "" ||
      authorityUrl.hash !== "" ||
      authorityUrl.hostname === ""
    ) {
      return null;
    }
    return authorityUrl.origin;
  } catch {
    return null;
  }
}

export function isSameOriginRequest(request: Request): boolean {
  const expectedOrigin = expectedOriginForRequest(request);
  if (expectedOrigin === null) return false;

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (origin === null && referer === null) return false;
  if (origin !== null && origin !== expectedOrigin) return false;
  if (referer === null) return true;

  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}
