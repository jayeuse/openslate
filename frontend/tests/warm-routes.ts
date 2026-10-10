import type { FullConfig } from "@playwright/test";

// The HTTP tests run against `next dev`, which compiles each route on its
// first request. On a loaded CI runner a cold compile can outlast a test's
// 5s expectation (a sign-in that lands on /openview or /sandbox), so every
// route the tests open is compiled once before they start.
const routes = [
  "/login",
  "/setup",
  "/auth/setup",
  "/auth/recovery",
  "/openview",
  "/sandbox",
  "/boards",
  "/comms",
  "/access",
  "/manage",
  "/platform",
  "/settings/appearance",
  "/profile",
  "/auth/email-change",
  "/",
];

export default async function warmRoutes(config: FullConfig): Promise<void> {
  const baseURL = config.projects.find((project) => project.use.baseURL)?.use
    .baseURL;
  if (!baseURL || !config.webServer) return;
  const deadline = AbortSignal.timeout(120_000);
  for (const route of routes) {
    if (deadline.aborted) break;
    try {
      await fetch(new URL(route, baseURL), {
        signal: deadline,
      });
    } catch {
      // A route that fails to warm still compiles on first use in its test.
      if (deadline.aborted) break;
    }
  }
}
