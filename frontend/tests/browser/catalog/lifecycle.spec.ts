import { expect, test } from "@playwright/test";
import { testSecret } from "../../helpers/test-secret";
import {
  DEPARTMENT_ID,
  departmentFixture,
  installSessionMocks,
  json,
  listResponse,
  MODULE_ID,
  moduleFixture,
  pathFor,
  type JsonObject,
} from "../helpers/lifecycle-fixtures";

const confirmationPassword = testSecret();

const previewToken = testSecret();

const RECORD_ID = "33333333-3333-4333-8333-333333333333";

const FIELD_ID = "66666666-6666-4666-8666-666666666666";

const EDGE_ID = "77777777-7777-4777-8777-777777777777";

function lifecycleImpact(operation: "close" | "purge", isDeleted = false) {
  return {
    target_type: "department",
    target_id: DEPARTMENT_ID,
    operation,
    actor_id: null,
    rows: [
      {
        entity_type: "department",
        entity_id: DEPARTMENT_ID,
        is_deleted: isDeleted,
        deleted_at: null,
        updated_at: "2026-01-01T00:00:00.000Z",
        state_fingerprint: "fingerprint",
      },
    ],
    external_impacts: [
      {
        edge_id: EDGE_ID,
        field_id: FIELD_ID,
        external_record_id: RECORD_ID,
        external_module_id: MODULE_ID,
        external_module_name: "Assets",
        external_department_id: DEPARTMENT_ID,
        external_department_name: "Operations",
      },
    ],
    key_strips: [],
    blockers: [],
    impact_digest: "digest",
  };
}

test("completes the Close preview, exact-name, and password steps", async ({
  page,
}) => {
  await installSessionMocks(page);
  const requests: { path: string; body: JsonObject }[] = [];
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathFor(route);
    const body: JsonObject =
      request.method() === "GET" ? {} : (request.postDataJSON() as JsonObject);
    if (request.method() !== "GET") requests.push({ path, body });
    if (
      request.method() === "GET" &&
      path === `/departments/${DEPARTMENT_ID}`
    ) {
      await json(route, 200, departmentFixture());
    } else if (request.method() === "GET" && path === "/modules") {
      await json(route, 200, listResponse([moduleFixture()]));
    } else if (
      request.method() === "POST" &&
      path === `/departments/${DEPARTMENT_ID}/close/preview`
    ) {
      await json(route, 200, {
        impact: lifecycleImpact("close"),
        token: previewToken,
        expires_at: "2099-01-01T00:00:00.000Z",
        confirmation_name: "Operations",
      });
    } else if (
      request.method() === "POST" &&
      path === `/departments/${DEPARTMENT_ID}/close`
    ) {
      await json(route, 200, {
        impact: lifecycleImpact("close", true),
        operation_id: null,
      });
    } else {
      await json(route, 404, {
        detail: `Unhandled ${request.method()} ${path}`,
      });
    }
  });

  await page.goto(`/departments/${DEPARTMENT_ID}`);
  const dangerZone = page.getByTestId("department-danger-zone");
  await expect(dangerZone).toBeVisible();
  expect(
    await dangerZone.evaluate(
      (node) => node.parentElement?.lastElementChild === node,
    ),
  ).toBe(true);
  await expect(
    dangerZone.getByRole("button", { name: "Close", exact: true }),
  ).toHaveClass(/bg-destructive/);
  await page
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "External relationship impacts" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel(/Type Operations to continue/).fill("Operations");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Your password").fill(confirmationPassword);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();

  const closeRequest = requests.find(
    (request) => request.path === `/departments/${DEPARTMENT_ID}/close`,
  );
  expect(closeRequest?.body).toEqual({
    token: previewToken,
    confirmation_name: "Operations",
    password: confirmationPassword,
  });
});

test("reopen confirmation focuses cancel, supports dismissal, and disables while pending", async ({
  page,
}) => {
  await installSessionMocks(page);
  let reopenBody: unknown;
  let releaseReopen!: () => void;
  const reopenResponse = new Promise<void>((resolve) => {
    releaseReopen = resolve;
  });
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathFor(route);
    if (
      request.method() === "GET" &&
      path === `/departments/${DEPARTMENT_ID}`
    ) {
      await json(route, 200, departmentFixture(true));
    } else if (request.method() === "GET" && path === "/modules") {
      await json(route, 200, listResponse([]));
    } else if (
      request.method() === "POST" &&
      path === `/departments/${DEPARTMENT_ID}/reopen`
    ) {
      reopenBody = request.postDataJSON();
      await reopenResponse;
      await json(route, 200, {
        impact: lifecycleImpact("close"),
        operation_id: null,
      });
    } else {
      await json(route, 404, { detail: "Unhandled mock route" });
    }
  });

  await page.goto(`/departments/${DEPARTMENT_ID}`);
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  const cancel = confirmation.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(confirmation).toHaveCount(0);
  expect(reopenBody).toBeUndefined();

  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.getByRole("alertdialog").press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(reopenBody).toBeUndefined();

  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  const pendingDialog = page.getByRole("alertdialog");
  await pendingDialog.getByRole("button", { name: "Reopen" }).click();
  await expect.poll(() => reopenBody).toEqual({ confirmed: true });
  await expect(
    pendingDialog.getByRole("button", { name: "Working…" }),
  ).toBeDisabled();
  await expect(
    pendingDialog.getByRole("button", { name: "Cancel" }),
  ).toBeDisabled();
  releaseReopen();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(
    page.getByText("Operations reopened.", { exact: true }),
  ).toBeVisible();
});
