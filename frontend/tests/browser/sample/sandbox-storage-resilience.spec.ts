import { readFile } from "node:fs/promises";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

const SAMPLE_STORAGE_KEY = "openslate.sample.v1";
const VIEW_PREFERENCES_KEY = "openslate.sample.sandbox.view.v1";

async function mockSandboxRequests(page: Page): Promise<void> {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unavailable" } }),
  );
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route)))
      await route.fulfill({ json: { items: [], has_more: false } });
  });
}

function captureBffWrites(context: BrowserContext): string[] {
  const writes: string[] = [];
  context.on("request", (request) => {
    if (request.url().includes("/bff/") && request.method() !== "GET")
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return writes;
}

async function createDepartment(page: Page, name: string): Promise<void> {
  await page.getByLabel("Create", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Department", exact: true }).click();
  await page.getByLabel("Department name", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: `Select department ${name}`,
      exact: true,
    }),
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await mockSandboxRequests(page);
  await page.goto("/sandbox");
});

test("sandbox drafts remain isolated to their originating tab", async ({
  context,
  page,
}) => {
  const writes = captureBffWrites(context);

  await createDepartment(page, "Tab A logistics");
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Select department Tab A logistics",
      exact: true,
    }),
  ).toBeVisible();

  const secondPage = await context.newPage();
  await mockSandboxRequests(secondPage);
  await secondPage.goto("/sandbox");
  await expect(
    secondPage.getByRole("button", {
      name: "Select department Operations",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    secondPage.getByRole("button", {
      name: "Select department Tab A logistics",
      exact: true,
    }),
  ).toHaveCount(0);

  await createDepartment(secondPage, "Tab B support");
  await page.bringToFront();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Select department Tab A logistics",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Select department Tab B support",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("storage write denial keeps editing, undo, and JSON export available in memory", async ({
  context,
  page,
}) => {
  const writes = captureBffWrites(context);
  await page.addInitScript(
    ({ sampleKey, viewKey }) => {
      const originalSetItem = Storage.prototype.setItem;
      Object.defineProperty(Storage.prototype, "setItem", {
        configurable: true,
        value(this: Storage, key: string, value: string) {
          let isSessionStorage = false;
          try {
            isSessionStorage = this === window.sessionStorage;
          } catch {
            // Opaque documents can deny access before the app origin loads.
          }
          if (isSessionStorage && (key === sampleKey || key === viewKey))
            throw new DOMException(
              "Storage quota unavailable",
              "QuotaExceededError",
            );
          return originalSetItem.call(this, key, value);
        },
      });
    },
    { sampleKey: SAMPLE_STORAGE_KEY, viewKey: VIEW_PREFERENCES_KEY },
  );
  await page.reload();

  const warning = page.getByText("Changes cannot be saved in this browser.", {
    exact: true,
  });
  await expect(warning).toBeVisible();

  await createDepartment(page, "In-memory dispatch");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Select department In-memory dispatch",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Select department In-memory dispatch",
      exact: true,
    }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Import or export", exact: true })
    .click();
  const portability = page.getByRole("dialog", {
    name: "Sandbox import and export",
    exact: true,
  });
  const downloadPromise = page.waitForEvent("download");
  await portability
    .getByRole("button", { name: "Export JSON", exact: true })
    .click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (downloadPath === null)
    throw new Error("Sandbox export had no local path");
  const exported: unknown = JSON.parse(await readFile(downloadPath, "utf8"));
  const departmentNames = (
    exported as {
      design?: { departments?: Array<{ name?: unknown }> };
    }
  ).design?.departments?.map((department) => department.name);
  expect(departmentNames).toContain("In-memory dispatch");
  await expect(warning).toBeVisible();
  expect(writes).toEqual([]);
});

test("corrupt sandbox history recovers defaults without clearing unrelated sample data", async ({
  context,
  page,
}) => {
  const writes = captureBffWrites(context);
  await expect(
    page.getByRole("button", {
      name: "Select department Operations",
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate((key) => {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<
      string,
      unknown
    >;
    stored["unrelated-sample-marker"] = "preserve-me";
    stored["sandbox.design"] = {
      past: [],
      present: {
        departments: [{ id: "corrupt", name: "Corrupt department" }],
        modules: [],
        relationships: [],
        rules: [],
      },
      future: [],
    };
    sessionStorage.setItem(key, JSON.stringify(stored));
  }, SAMPLE_STORAGE_KEY);
  await page.reload();

  await expect(
    page.getByRole("button", {
      name: "Select department Operations",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Select department Corrupt department",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          (
            JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<
              string,
              unknown
            >
          )["unrelated-sample-marker"],
        SAMPLE_STORAGE_KEY,
      ),
    )
    .toBe("preserve-me");
  expect(writes).toEqual([]);
});
