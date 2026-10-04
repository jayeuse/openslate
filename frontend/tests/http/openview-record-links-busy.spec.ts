import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "./helpers/test";
import { installOpenViewEventSource } from "./helpers/openview-event-source";

const userId = "00000000-0000-4000-8000-000000000001";
const departmentId = "00000000-0000-4000-8000-000000000011";
const sourceModuleId = "00000000-0000-4000-8000-000000000010";
const targetModuleId = "00000000-0000-4000-8000-000000000020";
const viewId = "00000000-0000-4000-8000-000000000030";
const recordId = "00000000-0000-4000-8000-000000000040";
const targetRecordId = "00000000-0000-4000-8000-000000000050";
const sourceNameFieldId = "00000000-0000-4000-8000-000000000060";
const targetNameFieldId = "00000000-0000-4000-8000-000000000061";
const relationshipFieldId = "00000000-0000-4000-8000-000000000062";
const relationshipId = "00000000-0000-4000-8000-000000000070";
const handoverFieldId = "00000000-0000-4000-8000-000000000063";
const handoverRecordId = "00000000-0000-4000-8000-000000000051";
const handoverRelationshipId = "00000000-0000-4000-8000-000000000071";
const otherDepartmentId = "00000000-0000-4000-8000-000000000012";
const incomingFieldId = "00000000-0000-4000-8000-000000000064";
const incomingRelationshipId = "00000000-0000-4000-8000-000000000072";

type Relationship = {
  id: string;
  field_id: string;
  source_record_id: string;
  target_record_id: string;
  created_at: string;
  visibility: "available";
};

type WriteMode = "success" | "busy-committed" | "busy-not-committed";

type HarnessOptions = {
  initialLink?: boolean;
  createModes?: WriteMode[];
  deleteModes?: WriteMode[];
  failedRelationshipReads?: number;
  failedRelationshipReadStatus?: number;
  handoverLink?: boolean;
  /** Put the linked data source in a second department. */
  targetInOtherDepartment?: boolean;
  /** Add a link from a Service visit to the open record. */
  incomingLink?: boolean;
  /** Leave Service visits out of the readable data sources. */
  targetUnreadable?: boolean;
};

function pageResponse<T>(items: T[]) {
  return {
    items,
    pagination: {
      limit: 100,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}

function record(id: string, moduleId: string, name: string) {
  const fieldId =
    moduleId === sourceModuleId ? sourceNameFieldId : targetNameFieldId;
  return {
    id,
    module_id: moduleId,
    data: { [fieldId]: name },
    display_values: {},
    created_at: "2026-09-30T08:00:00Z",
    updated_at: "2026-09-30T08:00:00Z",
    deleted_at: null,
    is_deleted: false,
    performed_by: userId,
  };
}

const sourceRecord = record(
  recordId,
  sourceModuleId,
  "Loading Bay service review",
);
const targetRecord = record(
  targetRecordId,
  targetModuleId,
  "Loading Bay follow-up visit",
);
const handoverRecord = record(
  handoverRecordId,
  targetModuleId,
  "Loading Bay handover visit",
);

function savedView() {
  return {
    id: viewId,
    module_id: sourceModuleId,
    name: "Service requests",
    is_default: true,
    definition: {
      version: 1,
      logic: "and",
      columns: [{ field_id: sourceNameFieldId, expected_type: "text" }],
      filters: [],
      sort: [],
      deleted: "exclude",
      search: null,
      search_fields: [],
    },
    presentation: {
      version: 1,
      layout: "table",
      column_field_ids: [sourceNameFieldId],
      pinned_field_ids: [],
      density: "comfortable",
      wrap: false,
      card_size: "comfortable",
      primary_field_id: sourceNameFieldId,
      secondary_field_id: null,
      date_field_id: null,
      group_by_field_id: null,
      date_range: "month",
      scale: null,
    },
    revision: 1,
    is_deleted: false,
    can_edit: true,
    created_at: "2026-09-30T08:00:00Z",
    updated_at: "2026-09-30T08:00:00Z",
  };
}

function relationship(): Relationship {
  return {
    id: relationshipId,
    field_id: relationshipFieldId,
    source_record_id: recordId,
    target_record_id: targetRecordId,
    created_at: "2026-09-30T08:05:00Z",
    visibility: "available",
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function captureReviewState(page: Page, state: string, anchor: Locator) {
  if (process.env.PHASE_1_LINK_SCREENSHOTS !== "1") return;
  const directory = resolve(process.cwd(), "../.agent-runtime/phase-1-screens");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const viewport of [
    { width: 1440, height: 900, suffix: "1440x900" },
    { width: 390, height: 844, suffix: "390x844" },
  ]) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await anchor.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(directory, `record-link-${state}-${viewport.suffix}.png`),
    });
  }
}

async function installLinksApi(page: Page, options: HarnessOptions = {}) {
  await installOpenViewEventSource(page);
  const state = {
    links: [
      ...(options.initialLink ? [relationship()] : []),
      ...(options.handoverLink
        ? [
            {
              ...relationship(),
              id: handoverRelationshipId,
              field_id: handoverFieldId,
              target_record_id: handoverRecordId,
            },
          ]
        : []),
      ...(options.incomingLink
        ? [
            {
              ...relationship(),
              id: incomingRelationshipId,
              field_id: incomingFieldId,
              source_record_id: handoverRecordId,
              target_record_id: recordId,
            },
          ]
        : []),
    ] as Relationship[],
    createCount: 0,
    deleteCount: 0,
    relationshipReads: 0,
    readFailuresRemaining: options.failedRelationshipReads ?? 0,
    holdNextRead: false,
    readStarted: deferred(),
    releaseRead: deferred(),
  };
  const createModes = options.createModes ?? ["success"];
  const deleteModes = options.deleteModes ?? ["success"];

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/api/auth/session")
      return route.fulfill({
        json: { authenticated: true, user_id: userId, setup_required: false },
      });
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: { id: userId, role: "admin", access: [] },
      });
    if (url.pathname === "/api/departments")
      return route.fulfill({
        json: pageResponse(
          [
            [departmentId, "Field service"],
            [otherDepartmentId, "Dispatch"],
          ].map(([id, name]) => ({
            id,
            department_name: name,
            created_at: "2026-09-30T08:00:00Z",
            updated_at: "2026-09-30T08:00:00Z",
            deleted_at: null,
            is_deleted: false,
            performed_by: userId,
          })),
        ),
      });
    if (url.pathname === "/api/views/data-sources")
      return route.fulfill({
        json: pageResponse([
          {
            id: sourceModuleId,
            name: "Service requests",
            department_id: departmentId,
            title_field_id: sourceNameFieldId,
          },
          ...(options.targetUnreadable
            ? []
            : [
                {
                  id: targetModuleId,
                  name: "Service visits",
                  department_id: options.targetInOtherDepartment
                    ? otherDepartmentId
                    : departmentId,
                  title_field_id: targetNameFieldId,
                },
              ]),
        ]),
      });
    if (
      url.pathname.startsWith("/api/views/data-sources/") &&
      url.pathname.endsWith("/fields")
    ) {
      const moduleId = url.pathname.split("/")[4];
      const isSource = moduleId === sourceModuleId;
      return route.fulfill({
        json: pageResponse([
          {
            id: isSource ? sourceNameFieldId : targetNameFieldId,
            module_id: moduleId,
            name: isSource ? "Request title" : "Visit title",
            type: "text",
            required: true,
            position: 0,
            config: {},
          },
        ]),
      });
    }
    if (url.pathname === "/api/views" && method === "GET")
      return route.fulfill({ json: pageResponse([savedView()]) });
    if (url.pathname === `/api/views/${viewId}` && method === "GET")
      return route.fulfill({ json: savedView() });
    if (url.pathname === "/api/fields")
      return route.fulfill({
        json: pageResponse([
          {
            id: relationshipFieldId,
            module_id: sourceModuleId,
            name: "Follow-up visit",
            type: "relationship",
            is_deleted: false,
            position: 1,
            relationship_target_module_id: targetModuleId,
            relationship_multiple_targets: true,
            relationship_multiple_sources: true,
          },
          ...(options.handoverLink
            ? [
                {
                  id: handoverFieldId,
                  module_id: sourceModuleId,
                  name: "Handover visit",
                  type: "relationship",
                  is_deleted: false,
                  position: 2,
                  relationship_target_module_id: targetModuleId,
                  relationship_multiple_targets: true,
                  relationship_multiple_sources: true,
                },
              ]
            : []),
        ]),
      });
    if (url.pathname === "/api/relationships" && method === "GET") {
      state.relationshipReads += 1;
      const checkingWriteResult = state.createCount + state.deleteCount > 0;
      if (state.holdNextRead && checkingWriteResult) {
        state.holdNextRead = false;
        state.readStarted.resolve();
        await state.releaseRead.promise;
      }
      if (checkingWriteResult && state.readFailuresRemaining > 0) {
        state.readFailuresRemaining -= 1;
        return route.fulfill({
          status: options.failedRelationshipReadStatus ?? 503,
          json: { detail: "Relationship status could not be checked." },
        });
      }
      const incident = url.searchParams.get("incident_record_id");
      const field = url.searchParams.get("field_id");
      const links = state.links.filter(
        (link) =>
          (!incident ||
            link.source_record_id === incident ||
            link.target_record_id === incident) &&
          (!field || link.field_id === field),
      );
      return route.fulfill({ json: pageResponse(links) });
    }
    if (url.pathname === "/api/relationships" && method === "POST") {
      state.createCount += 1;
      const mode = createModes[state.createCount - 1] ?? "success";
      const body = request.postDataJSON() as {
        field_id: string;
        source_record_id: string;
        target_record_id: string;
      };
      const next = { ...relationship(), ...body };
      if (mode === "busy-committed") {
        state.links.push(next);
        return route.fulfill({
          status: 503,
          json: {
            detail: "Relationship operation is temporarily unavailable",
          },
        });
      }
      if (mode === "busy-not-committed")
        return route.fulfill({
          status: 503,
          json: {
            detail: "Relationship operation is temporarily unavailable",
          },
        });
      state.links.push(next);
      return route.fulfill({ status: 201, json: next });
    }
    if (url.pathname.startsWith("/api/relationships/") && method === "DELETE") {
      state.deleteCount += 1;
      const mode = deleteModes[state.deleteCount - 1] ?? "success";
      const removedId = url.pathname.split("/").at(-1);
      const remove = () => {
        state.links = state.links.filter((link) => link.id !== removedId);
      };
      if (mode === "busy-committed") remove();
      if (mode !== "success")
        return route.fulfill({
          status: 503,
          json: {
            detail: "Relationship operation is temporarily unavailable",
          },
        });
      remove();
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.pathname === "/api/records/query" && method === "POST") {
      const body = request.postDataJSON() as { module_id: string };
      return route.fulfill({
        json: pageResponse([
          body.module_id === targetModuleId ? targetRecord : sourceRecord,
        ]),
      });
    }
    if (url.pathname === `/api/records/${targetRecordId}` && method === "GET")
      return route.fulfill({ json: targetRecord });
    if (url.pathname === `/api/records/${handoverRecordId}` && method === "GET")
      return route.fulfill({ json: handoverRecord });
    return route.fulfill({ status: 404, json: { detail: "Not found" } });
  });

  return {
    state,
    pauseNextRelationshipRead() {
      state.holdNextRead = true;
      state.readStarted = deferred();
      state.releaseRead = deferred();
    },
    waitForRelationshipRead() {
      return state.readStarted.promise;
    },
    releaseRelationshipRead() {
      state.releaseRead.resolve();
    },
  };
}

async function openLinksPanel(page: Page) {
  await page.goto(
    `/openview?section=views&module=${sourceModuleId}&view=${viewId}&record=${recordId}`,
  );
  await expect(
    page.getByRole("dialog", { name: "Record details" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Linked records" }).click();
  await expect(
    page.getByRole("heading", { name: "Follow-up visit" }),
  ).toBeVisible();
}

async function chooseFollowUp(page: Page) {
  await linkField(page, "Follow-up visit")
    .getByRole("button", { name: "Add link" })
    .click();
  const search = page.getByRole("textbox", {
    name: "Find a record in Service visits",
  });
  await search.fill("Loading Bay");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  return {
    search,
    link: page.getByRole("button", {
      name: "Link Loading Bay follow-up visit",
    }),
  };
}

function linkField(page: Page, name: string) {
  // Link fields have a heading but no named region; use its nearest section,
  // excluding the encompassing OpenView section that contains every field.
  return page
    .getByRole("heading", { name, exact: true })
    .locator("xpath=ancestor::section[1]");
}

test("a busy link save is reconciled before it is reported as saved", async ({
  page,
}) => {
  const api = await installLinksApi(page, { createModes: ["busy-committed"] });
  await openLinksPanel(page);
  const { link } = await chooseFollowUp(page);
  api.pauseNextRelationshipRead();

  await link.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Checking whether the link was saved" }),
  ).toBeVisible();
  await expect(
    page.getByText("Checking whether the link was saved…", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await api.waitForRelationshipRead();
  const checking = page.getByRole("button", {
    name: "Checking whether Loading Bay follow-up visit was saved",
  });
  await expect(checking).toBeDisabled();
  expect(api.state.createCount).toBe(1);
  await captureReviewState(page, "busy-check", checking);

  api.releaseRelationshipRead();
  await expect(page.getByText("Loading Bay follow-up visit")).toBeVisible();
  await expect(page.getByText("Linked in Follow-up visit.")).toBeVisible();
  expect(api.state.createCount).toBe(1);
  await captureReviewState(
    page,
    "saved",
    page.getByText("Loading Bay follow-up visit", { exact: true }),
  );
});

test("a missing busy link offers an explicit retry and keeps the search", async ({
  page,
}) => {
  const api = await installLinksApi(page, {
    createModes: ["busy-not-committed", "success"],
  });
  await openLinksPanel(page);
  const { search, link } = await chooseFollowUp(page);

  await link.click();
  const retry = page.getByRole("button", { name: /Try again/ });
  await expect(retry).toBeEnabled();
  await expect(search).toHaveValue("Loading Bay");
  await expect(
    page.getByRole("alert").filter({ hasText: "The link was not saved" }),
  ).toHaveText("The link was not saved. Try again.");
  expect(api.state.createCount).toBe(1);
  await captureReviewState(
    page,
    "missing",
    page.getByRole("button", { name: /Try again/ }),
  );

  await retry.click();
  await expect(page.getByText("Loading Bay follow-up visit")).toBeVisible();
  expect(api.state.createCount).toBe(2);
});

test("Cancel after a missing-link retry releases other Add and Remove controls", async ({
  page,
}) => {
  const api = await installLinksApi(page, {
    handoverLink: true,
    createModes: ["busy-not-committed", "busy-not-committed", "success"],
  });
  await openLinksPanel(page);
  const followUp = linkField(page, "Follow-up visit");
  const handover = linkField(page, "Handover visit");
  const { link } = await chooseFollowUp(page);

  await link.click();
  const retry = followUp.getByRole("button", { name: /Try again to link/ });
  await expect(retry).toBeEnabled();
  expect(api.state.createCount).toBe(1);
  expect(api.state.deleteCount).toBe(0);

  await retry.click();
  await expect.poll(() => api.state.createCount).toBe(2);
  await expect(retry).toBeEnabled();
  expect(api.state.createCount).toBe(2);
  expect(api.state.deleteCount).toBe(0);
  await followUp.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(followUp.getByRole("textbox")).toHaveCount(0);
  await expect(
    followUp.getByRole("button", { name: "Add link" }),
  ).toBeFocused();
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByRole("tab", { name: "Linked records" }).click();
  await expect(followUp.getByRole("textbox")).toHaveCount(0);
  const addHandover = handover.getByRole("button", { name: "Add link" });
  const removeHandover = handover
    .getByRole("listitem")
    .filter({ hasText: "Loading Bay handover visit" })
    .getByRole("button", { name: "Remove link" });
  await expect(addHandover).toBeEnabled();
  await expect(removeHandover).toBeEnabled();
  expect(api.state.createCount).toBe(2);
  expect(api.state.deleteCount).toBe(0);

  await addHandover.click();
  await handover.getByRole("textbox").fill("Loading Bay");
  await handover.getByRole("button", { name: "Search", exact: true }).click();
  await handover
    .getByRole("button", {
      name: "Link Loading Bay follow-up visit",
      exact: true,
    })
    .click();
  await expect(page.getByText("Linked in Handover visit.")).toBeVisible();
  expect(api.state.createCount).toBe(3);
  expect(api.state.deleteCount).toBe(0);
  await expect(removeHandover).toBeEnabled();
  await removeHandover.click();
  await expect(
    page.getByText("Link removed from Handover visit."),
  ).toBeVisible();
  expect(api.state.createCount).toBe(3);
  expect(api.state.deleteCount).toBe(1);
});

test("a failed status check offers a read-only check again action", async ({
  page,
}) => {
  const api = await installLinksApi(page, {
    createModes: ["busy-not-committed"],
    failedRelationshipReads: 1,
    failedRelationshipReadStatus: 403,
    handoverLink: true,
  });
  await openLinksPanel(page);
  const { search, link } = await chooseFollowUp(page);

  await link.click();
  const checkAgain = page.getByRole("button", { name: "Check again" });
  await expect(checkAgain).toBeEnabled();
  await expect(search).toHaveValue("Loading Bay");
  await expect(link).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  const handover = linkField(page, "Handover visit");
  await expect(
    handover.getByRole("button", { name: "Add link" }),
  ).toBeDisabled();
  await expect(
    handover.getByRole("button", { name: "Remove link" }),
  ).toBeDisabled();
  expect(api.state.createCount).toBe(1);

  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByRole("tab", { name: "Linked records" }).click();
  await expect(search).toHaveValue("Loading Bay");
  await expect(link).toBeDisabled();
  await expect(page.getByRole("button", { name: "Check again" })).toBeEnabled();
  await expect(
    handover.getByRole("button", { name: "Add link" }),
  ).toBeDisabled();
  await expect(
    handover.getByRole("button", { name: "Remove link" }),
  ).toBeDisabled();

  await checkAgain.click();
  await expect(page.getByRole("button", { name: /Try again/ })).toBeEnabled();
  await expect(
    handover.getByRole("button", { name: "Add link" }),
  ).toBeEnabled();
  await expect(
    handover.getByRole("button", { name: "Remove link" }),
  ).toBeEnabled();
  expect(api.state.createCount).toBe(1);
});

test("a busy removal is reconciled when the link is already gone", async ({
  page,
}) => {
  const api = await installLinksApi(page, {
    initialLink: true,
    deleteModes: ["busy-committed"],
  });
  await openLinksPanel(page);
  await expect(page.getByText("Loading Bay follow-up visit")).toBeVisible();
  api.pauseNextRelationshipRead();
  await page.getByRole("button", { name: "Remove link" }).click();
  await api.waitForRelationshipRead();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Checking whether the link was removed…" }),
  ).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(api.state.deleteCount).toBe(1);
  api.releaseRelationshipRead();

  await expect(page.getByText("No linked records.")).toBeVisible();
  await expect(
    page.getByText("Link removed from Follow-up visit."),
  ).toBeVisible();
  expect(api.state.deleteCount).toBe(1);
});

test("a busy removal still present can be retried explicitly", async ({
  page,
}) => {
  const api = await installLinksApi(page, {
    initialLink: true,
    deleteModes: ["busy-not-committed", "success"],
  });
  await openLinksPanel(page);
  await expect(page.getByText("Loading Bay follow-up visit")).toBeVisible();
  await page.getByRole("button", { name: "Remove link" }).click();
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeEnabled();
  expect(api.state.deleteCount).toBe(1);

  await retry.click();
  await expect(page.getByText("No linked records.")).toBeVisible();
  expect(api.state.deleteCount).toBe(2);
});

test("a link to another department names that department beside the record", async ({
  page,
}) => {
  const api = await installLinksApi(page, {
    initialLink: true,
    incomingLink: true,
    targetInOtherDepartment: true,
  });
  await openLinksPanel(page);

  // The open record is in Field service; Service visits is in Dispatch.
  const followUp = linkField(page, "Follow-up visit");
  await expect(followUp.getByRole("listitem")).toContainText(
    "Loading Bay follow-up visitService visits · Dispatch",
  );
  const linkedFrom = page
    .getByRole("heading", { name: "Linked from", exact: true })
    .locator("xpath=ancestor::section[1]");
  await expect(linkedFrom.getByRole("listitem")).toContainText(
    "Loading Bay handover visitService visits · Dispatch",
  );

  const add = followUp.getByRole("button", { name: "Add link" });
  await add.click();
  const search = page.getByRole("textbox", {
    name: "Find a record in Service visits · Dispatch",
    exact: true,
  });
  await search.fill("Loading Bay");

  // Leaving mid-search writes nothing and returns to Add link.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(api.state.createCount).toBe(0);
  await expect(followUp.getByRole("listitem")).toHaveCount(1);
});

test("a link inside the record's department shows no department name", async ({
  page,
}) => {
  await installLinksApi(page, { initialLink: true });
  await openLinksPanel(page);

  await expect(
    linkField(page, "Follow-up visit").getByRole("listitem"),
  ).toContainText("Loading Bay follow-up visitService visits");
  await expect(page.getByText(/· Field service/)).toHaveCount(0);
  await linkField(page, "Follow-up visit")
    .getByRole("button", { name: "Add link" })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: "Find a record in Service visits",
      exact: true,
    }),
  ).toBeVisible();
});

test("a link field into a data source the person cannot read offers no Add link", async ({
  page,
}) => {
  const api = await installLinksApi(page, { targetUnreadable: true });
  await openLinksPanel(page);

  const followUp = linkField(page, "Follow-up visit");
  await expect(followUp.getByText("No linked records.")).toBeVisible();
  await expect(
    followUp.getByRole("button", { name: /^(Add|Replace) link$/ }),
  ).toHaveCount(0);
  expect(api.state.createCount).toBe(0);
});
