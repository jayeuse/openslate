// Only source-owned templates are written; never copy arbitrary URL segments.
const resources = [
  "departments",
  "modules",
  "fields",
  "records",
  "relationships",
  "roles",
  "users",
  "audit-logs",
  "security-events",
];
const templates = new Set([
  ...resources.flatMap((resource) => [
    `/bff/${resource}`,
    `/bff/${resource}/{id}`,
    `/bff/${resource}/{id}/restore`,
  ]),
  ...["departments", "modules", "fields", "records"].flatMap((resource) =>
    ["close", "close/preview", "reopen", "purge", "purge/preview"].map(
      (action) => `/bff/${resource}/{id}/${action}`,
    ),
  ),
  "/bff/modules/{id}/schema/accept",
  "/bff/relationships/fields/{id}/sources/{id}",
  "/bff/users/{id}/reconcile-auth",
  "/bff/modules/{id}/fields/reorder",
  "/bff/auth/me",
  "/bff/auth/invitations",
  "/bff/auth/invitations/accept",
  "/bff/auth/invitations/{id}/resend",
  "/bff/audit-logs/export",
  "/bff/security-events/export",
  "/bff/internal/security-events",
  "/bff/health",
  "/bff/ready",
  "/auth/callback",
  ...["login", "logout", "status", "password", "realtime-token"].map(
    (name) => `/session/${name}`,
  ),
]);
export function safeLogRoute(route: string): string {
  const normalized = route.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "{id}",
  );
  return templates.has(normalized) ? normalized : "unmatched";
}
