import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { constants, gzipSync } from "node:zlib";
import type { Request } from "@playwright/test";
import {
  expect,
  expectNoHorizontalScroll,
  signedInAs,
  test,
} from "./helpers/test";
import { profilePreferences } from "./helpers/profile-api";
import { installCommsLiveApi } from "./helpers/comms-live-api";

// Asset metrics only: traces can retain response bodies and signed-in state.
test.use({
  trace: "off",
  video: "off",
  viewport: { width: 1440, height: 900 },
});

const gzip = {
  level: 9,
  windowBits: 15,
  memLevel: 8,
  strategy: constants.Z_DEFAULT_STRATEGY,
};
// The strict S04 target stays deferred to S31; S28 uses S27's recorded baseline.
const s04BaselineColdGzipBytes = 546_979;
const baselineColdGzipBytes = 577_199;
const maximumColdGzipBytes = Math.floor(baselineColdGzipBytes * 1.05);

function manifestChunks(value: unknown): string[] {
  if (typeof value === "string") {
    if (/^\/_next\/static\/.*\.js$/.test(value)) return [value];
    if (/^static\/.*\.js$/.test(value)) return [`/_next/${value}`];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap(manifestChunks);
  return value && typeof value === "object"
    ? Object.values(value).flatMap(manifestChunks)
    : [];
}

async function otherRouteChunks() {
  const root = ".next/server/app";
  const own = "(app)/(workspace)/comms/page_client-reference-manifest.js";
  const names = (await readdir(root, { recursive: true })).filter((name) =>
    name.endsWith("page_client-reference-manifest.js"),
  );
  if (!names.includes(own))
    throw new Error("The current Comms client build manifest is required");
  const routes = await Promise.all(
    names.map(async (name) => {
      const text = await readFile(`${root}/${name}`, "utf8");
      const assignment = text.indexOf(
        " = ",
        text.indexOf("globalThis.__RSC_MANIFEST["),
      );
      const data: unknown = JSON.parse(
        text
          .slice(assignment + 3)
          .trim()
          .replace(/;$/, ""),
      );
      if (!data || typeof data !== "object" || !("clientModules" in data))
        throw new Error(`Invalid client build manifest: ${name}`);
      const chunks = manifestChunks(data.clientModules);
      if (!chunks.length)
        throw new Error(`Empty client build manifest: ${name}`);
      return { name, chunks };
    }),
  );
  const framework: unknown = JSON.parse(
    await readFile(".next/build-manifest.json", "utf8"),
  );
  const protectedChunks = new Set([
    ...routes.find((route) => route.name === own)!.chunks,
    ...manifestChunks(framework),
  ]);
  const exclusive = new Map<string, string[]>();
  for (const route of routes)
    for (const chunk of route.chunks) {
      if (route.name === own || protectedChunks.has(chunk)) continue;
      exclusive.set(chunk, [...(exclusive.get(chunk) ?? []), route.name]);
    }
  return exclusive;
}

async function measure(requests: Request[]) {
  return Promise.all(
    requests.map(async (request) => {
      const response = await request.response();
      if (!response || !response.ok())
        throw new Error(`JavaScript asset did not load: ${request.url()}`);
      await response.finished();
      const bytes = await response.body();
      const sizes = await request.sizes();
      return {
        path: new URL(request.url()).pathname,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        decoded_bytes: bytes.length,
        gzip_bytes: gzipSync(bytes, gzip).length,
        content_encoding:
          (await response.headerValue("content-encoding")) ?? "identity",
        encoded_body_bytes: sizes.responseBodySize,
        response_header_bytes: sizes.responseHeadersSize,
      };
    }),
  );
}

test("cold Comms JavaScript and on-demand settings and tools have recorded asset budgets", async ({
  page,
  browser,
}, testInfo) => {
  await signedInAs(page, {
    id: "00000000-0000-4000-8000-000000000101",
    role: "admin",
  });
  const server = await installCommsLiveApi(page, {
    userId: "00000000-0000-4000-8000-000000000101",
    channelName: "operations",
  });
  try {
    const requests = new Map<string, Request>();
    const linkedRouteRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (/^\/openview(?:\.txt)?\/?$/.test(url.pathname))
        linkedRouteRequests.push(
          `${url.pathname}?${new URLSearchParams([...url.searchParams].filter(([key]) => key === "record" || key === "section")).toString()}`,
        );
      if (url.pathname.endsWith(".js"))
        requests.set(request.url(), requests.get(request.url()) ?? request);
    });
    const captured = new Set<string>();
    async function checkpoint() {
      const pending = [...requests].filter(([url]) => !captured.has(url));
      for (const [url] of pending) captured.add(url);
      const assets = await measure(pending.map(([, request]) => request));
      return {
        gzip_bytes: assets.reduce((sum, asset) => sum + asset.gzip_bytes, 0),
        assets,
      };
    }

    await page.goto("/comms");
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: /^operations(,|$)/ }),
    ).toBeVisible();
    const coldRaw = await checkpoint();
    const otherRoutes = await otherRouteChunks();
    const excludedAssets = coldRaw.assets
      .filter((asset) => otherRoutes.has(asset.path))
      .map((asset) => ({
        ...asset,
        reason:
          "Declared only in other-route client build manifests; absent from Comms and framework manifests",
        owner_manifests: otherRoutes.get(asset.path),
      }));
    const assets = coldRaw.assets.filter(
      (asset) => !otherRoutes.has(asset.path),
    );
    const cold = {
      assets,
      gzip_bytes: assets.reduce((sum, asset) => sum + asset.gzip_bytes, 0),
    };
    expect(cold.assets.length).toBeGreaterThan(0);

    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    const settingsDialog = page.getByRole("dialog", {
      name: "Channel settings",
      exact: true,
    });
    await expect(
      settingsDialog.getByLabel("Channel name", { exact: true }),
    ).toHaveValue("operations");
    const settings = await checkpoint();
    await settingsDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page
      .getByRole("button", { name: "OpenComms menu", exact: true })
      .first()
      .click();
    await page
      .getByRole("menuitem", { name: "Admin tools", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Moderation", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Moderation", exact: true }),
    ).toBeVisible();
    const tools = await checkpoint();
    const growthBytes = cold.gzip_bytes - baselineColdGzipBytes;
    const growthPercent = (growthBytes / baselineColdGzipBytes) * 100;

    const report = {
      budget_slice: "S28",
      previous_committed_slice: "S27@978b3f86",
      comparison:
        "Recorded S27 closure measurement, not a newly measured baseline",
      strict_cap_deferred_to: "S31",
      strict_cap_met: cold.gzip_bytes < s04BaselineColdGzipBytes,
      s04_baseline_cold_gzip_bytes: s04BaselineColdGzipBytes,
      deferred_target_exclusive_gzip_bytes: s04BaselineColdGzipBytes,
      baseline_cold_gzip_bytes: baselineColdGzipBytes,
      maximum_cold_gzip_bytes: maximumColdGzipBytes,
      growth_bytes: growthBytes,
      growth_percent: growthPercent,
      linked_route_requests: linkedRouteRequests,
      build_id: (await readFile(".next/BUILD_ID", "utf8")).trim(),
      lock_sha256: createHash("sha256")
        .update(await readFile("package-lock.json"))
        .digest("hex"),
      node: process.version,
      zlib: process.versions.zlib,
      browser: browser.version(),
      gzip,
      readiness:
        "verified /comms with enabled Message composer and visible operations row; include JS requests already started",
      cold,
      cold_including_other_route_prefetch: coldRaw,
      excluded_other_route_prefetch: excludedAssets,
      settings,
      tools,
    };
    await writeFile(
      testInfo.outputPath("js-assets.json"),
      JSON.stringify(report, null, 2),
    );
    await testInfo.attach("JavaScript asset metrics", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    console.info(
      `Cold JavaScript gzip: raw=${coldRaw.gzip_bytes} bytes; Comms+shell=${cold.gzip_bytes} bytes; other-route-only=${coldRaw.gzip_bytes - cold.gzip_bytes} bytes; growth=${growthBytes} bytes / ${growthPercent}%; limit=${maximumColdGzipBytes} bytes.`,
    );
    expect(cold.gzip_bytes).toBeLessThanOrEqual(maximumColdGzipBytes);
  } finally {
    server.close();
  }
});

test("Comms retains its desktop and phone frame in light and dark", async ({
  page,
}, testInfo) => {
  const userId = "00000000-0000-4000-8000-000000000101";
  await signedInAs(page, { id: userId, role: "admin" });
  const server = await installCommsLiveApi(page, {
    userId,
    channelName: "operations",
  });
  try {
    await page.route(`**/api/users/${userId}/preferences`, (route) =>
      route.fulfill({
        json: { ...profilePreferences(userId), theme: "system" },
      }),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme });
        await page.goto("/comms");
        if (viewport.width < 640)
          await page.getByRole("button", { name: /^operations(,|$)/ }).click();
        await expect(
          page.getByRole("textbox", { name: "Message", exact: true }),
        ).toBeEnabled();
        await expect(
          page.getByRole("heading", { name: "operations", exact: true }),
        ).toBeVisible();
        if (theme === "dark")
          await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
        await expectNoHorizontalScroll(page);
        await page.mouse.move(0, 0);
        const path = testInfo.outputPath(
          `comms-${viewport.width}-${theme}.png`,
        );
        await page.screenshot({ path, animations: "disabled" });
        await testInfo.attach(`Comms ${viewport.width} ${theme}`, {
          path,
          contentType: "image/png",
        });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    server.close();
  }
});
