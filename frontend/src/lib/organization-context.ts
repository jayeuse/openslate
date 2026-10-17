/**
 * The organization this tab works in. Each tab keeps its own choice in
 * session storage; a tab without one follows the session's active
 * organization, which the server applies when no `X-Org` header is sent.
 */
const ORGANIZATION_KEY = "openslate-organization";
// The last organization opened in this browser. Not secret: the signed-out
// pages ask for its look, so an administrator's change shows at next sign-in.
const LAST_ORGANIZATION_KEY = "openslate-last-organization";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let loaded = false;
let current: string | null = null;

function readStoredOrganization(): string | null {
  try {
    const value = sessionStorage.getItem(ORGANIZATION_KEY);
    return value && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The tab's organization id, or null when the tab follows the session. */
export function currentOrganizationId(): string | null {
  if (typeof window === "undefined") return null;
  if (!loaded) {
    loaded = true;
    current = readStoredOrganization();
  }
  return current;
}

/** Sets (or clears) the tab's organization. Storage failure keeps it in memory. */
export function setCurrentOrganizationId(orgId: string | null): void {
  const next = orgId && UUID_PATTERN.test(orgId) ? orgId.toLowerCase() : null;
  loaded = true;
  current = next;
  try {
    if (next) sessionStorage.setItem(ORGANIZATION_KEY, next);
    else sessionStorage.removeItem(ORGANIZATION_KEY);
  } catch {
    // Without storage the choice lasts until this page unloads.
  }
  if (next) {
    try {
      localStorage.setItem(LAST_ORGANIZATION_KEY, next);
    } catch {
      // The signed-out look then falls back to the cached look or Slate.
    }
  }
}

/** The last organization opened in this browser, for the signed-out look. */
export function lastOrganizationId(): string | null {
  try {
    const value = localStorage.getItem(LAST_ORGANIZATION_KEY);
    return value && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}
