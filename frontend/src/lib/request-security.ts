import "server-only";

export function isSameOriginRequest(request: Request) {
  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  if (!origin && !referer) return false;
  if (origin && origin !== expectedOrigin) return false;
  if (!referer) return true;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}
