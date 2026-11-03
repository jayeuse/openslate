import type { Page } from "@playwright/test";

import {
  answeredHeaders,
  expect,
  expectAnsweredReference,
  signedInAs,
  test,
} from "./helpers/test";

// Manage → System health, block 3 "Your organization" (docs/specs/
// system-health.md S3-C5, D8) and the reference words by role (D6-C1). The
// rules behind each line are owned by tests/isolated/manage/
// system-health-rules.spec.ts and system-health-view.spec.ts; these journeys
// prove the block comes from the one status read and the role reaches the
// page's references.

test.use({ trace: "off", screenshot: "off", video: "off" });

const adminId = "00000000-0000-4000-8000-000000000011";

const statusBody = (organization: unknown) => ({
  parts: [
    { key: "data", status: "working" },
    { key: "signing_in", status: "working" },
    { key: "files", status: "working" },
    { key: "email", status: "set_up" },
  ],
  version: "0.1.0",
  checked_at: "2026-11-02T10:42:05Z",
  organization,
});

const lateOrganization = {
  since: "2026-10-26T10:42:05Z",
  backups: {
    state: "late",
    last_success_at: "2026-10-30T06:00:00Z",
    last_result: "failed",
  },
  failed_jobs: 2,
  failed_sign_ins: 1,
  lockouts: 2,
};

/** Answers the status read and records every `/api` request the page makes. */
async function installStatus(
  page: Page,
  answer: { json: unknown } | { status: number },
) {
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push(url.pathname);
  });
  await page.route("**/api/system/status", (route) =>
    "json" in answer
      ? route.fulfill({
          headers: { "Cache-Control": "no-store" },
          json: answer.json,
        })
      : route.fulfill({
          status: answer.status,
          headers: answeredHeaders,
          json: { detail: "Status unavailable" },
        }),
  );
  return requests;
}

const organizationBlock = (page: Page) =>
  page.getByRole("region", { name: "Your organization", exact: true });

test("S3-C5: an admin reads Your organization from the one status read", async ({
  page,
}) => {
  await signedInAs(page, { id: adminId, role: "admin", operator: false });
  const requests = await installStatus(page, {
    json: statusBody(lateOrganization),
  });
  await page.goto("/manage?view=health");
  const block = organizationBlock(page);
  await expect(block.getByRole("definition")).toHaveText([
    /^Late/,
    /^2 jobs failed in the last 7 days/,
    /^1 failed sign-in and 2 lockouts in the last 7 days/,
  ]);
  await expect(block).toContainText("Latest run: Failed");
  await expect(block).toContainText(
    "The person who runs your server manages backups.",
  );
  await expect(
    block.getByRole("link", { name: "Open Jobs", exact: true }),
  ).toHaveAttribute("href", "/manage?view=jobs");
  await expect(
    block.getByRole("link", { name: "Open Security in Access", exact: true }),
  ).toHaveAttribute("href", "/access?view=security");
  await expect(block.getByRole("link", { name: "Open Backup" })).toHaveCount(0);
  // Block 3 sits between the parts and About this system.
  await expect(page.getByRole("heading", { level: 2 })).toContainText([
    "Parts of Slate Operations",
    "Your organization",
    "About this system",
    "When something goes wrong",
  ]);
  // The block made no request of its own: one status read, and no read of
  // Jobs, Security events or Backup.
  expect(requests.filter((path) => path === "/api/system/status")).toEqual([
    "/api/system/status",
  ]);
  expect(
    requests.filter((path) =>
      /^\/api\/(jobs|security-events|backups|audit-logs)/.test(path),
    ),
  ).toEqual([]);
});

test("S3-C5: a member sees no organization block and makes no extra request", async ({
  page,
}) => {
  await signedInAs(page, { id: adminId, role: "member" });
  const requests = await installStatus(page, { json: statusBody(null) });
  await page.goto("/manage?view=health");
  await expect(
    page.getByRole("heading", { name: "About this system", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Slate Operations is working normally."),
  ).toBeVisible();
  await expect(organizationBlock(page)).toHaveCount(0);
  await expect(page.getByText("Your organization")).toHaveCount(0);
  expect(requests.filter((path) => path === "/api/system/status")).toEqual([
    "/api/system/status",
  ]);
  // D6-C1: a member gives references to the administrator.
  await expect(
    page.getByRole("region", { name: "When something goes wrong" }),
  ).toContainText("If it still does not load, tell your administrator.");
});

test("D6-C1: an admin's failed status read names the person who runs the server", async ({
  page,
}) => {
  await signedInAs(page, { id: adminId, role: "admin", operator: false });
  await installStatus(page, { status: 500 });
  await page.goto("/manage?view=health");
  const alert = page
    .getByRole("region", { name: "The status cannot be checked now." })
    .getByRole("alert");
  await expect(alert).toContainText(
    "The status could not be loaded. Try Check again in a minute.",
  );
  await expect(alert).toContainText(
    "Give this reference to the person who runs your server.",
  );
  await expectAnsweredReference(alert);
  await expect(
    page.getByRole("region", { name: "When something goes wrong" }),
  ).toContainText(
    "If it still does not load, tell the person who runs your server.",
  );
  // Before any result block 3 shows dashes and keeps its links (D8.6).
  const block = organizationBlock(page);
  await expect(block.getByRole("definition")).toHaveText([
    "—",
    /^—Open Jobs$/,
    /^—Open Security in Access$/,
  ]);
});
