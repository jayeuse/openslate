import { expect, test } from "../coverage";
import {
  CONTACTS_FIELD_ID,
  CONTACT_EDGE_ID,
  DEPARTMENT_ID,
  HIDDEN_EDGE_ID,
  INCOMING_SOURCE_RECORD_ID,
  NAME_FIELD_ID,
  NEW_OWNER_RECORD_ID,
  NEW_TARGET_RECORD_ID,
  NOTES_FIELD_ID,
  OWNER_FIELD_ID,
  SECOND_TARGET_RECORD_ID,
  SOURCE_MODULE_ID,
  SOURCE_RECORD_ID,
  TARGET_RECORD_ID,
  makeState,
  type CapturedRequest,
} from "../helpers/relationships-data";
import {
  installMocks,
  pathFor,
  requestMatching,
} from "../helpers/relationships-fixtures";

function compactId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-8)}`;
}

function lastRequestMatching(
  requests: CapturedRequest[],
  method: string,
  path: string,
): CapturedRequest {
  const request = [...requests]
    .reverse()
    .find((item) => item.method === method && item.path === path);
  if (!request) throw new Error(`No ${method} request captured for ${path}`);
  return request;
}

test.describe("relationship UI", () => {
  test("manages outgoing links while keeping primitive edits separate and incoming links read-only", async ({
    page,
  }) => {
    const state = makeState();
    const requests = await installMocks(page, state);

    await page.goto(
      `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/records/${SOURCE_RECORD_ID}/edit`,
    );
    await expect(
      page.getByRole("heading", { name: "Edit record" }),
    ).toBeVisible();
    await expect(page.getByLabel("Notes")).toHaveValue("Initial notes");
    await expect(page.getByText(/Manage relationships/i)).toBeVisible();

    const ownerTarget = page.getByRole("combobox", {
      name: "Owner target",
    });
    await expect(ownerTarget).toHaveAttribute("title", TARGET_RECORD_ID);
    await ownerTarget.click();
    const ownerSearch = page.getByRole("combobox", {
      name: "Search loaded records for Owner",
    });
    await expect(ownerSearch).toBeVisible();
    await expect(page.getByRole("option", { name: /Owner One/ })).toBeVisible();
    const ownerPut = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        pathFor(response.request()) ===
          `/relationships/fields/${OWNER_FIELD_ID}/sources/${SOURCE_RECORD_ID}`,
    );
    await ownerSearch.fill("Owner Two");
    await page.getByRole("option", { name: /Owner Two/ }).click();
    await ownerPut;
    expect(
      lastRequestMatching(
        requests,
        "PUT",
        `/relationships/fields/${OWNER_FIELD_ID}/sources/${SOURCE_RECORD_ID}`,
      ).body,
    ).toEqual({ target_record_id: NEW_OWNER_RECORD_ID });
    await expect(ownerTarget).toHaveAttribute("title", NEW_OWNER_RECORD_ID);

    await ownerTarget.click();
    const clearOwnerPut = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        pathFor(response.request()) ===
          `/relationships/fields/${OWNER_FIELD_ID}/sources/${SOURCE_RECORD_ID}`,
    );
    await page.getByRole("option", { name: "No target" }).click();
    await clearOwnerPut;
    expect(
      lastRequestMatching(
        requests,
        "PUT",
        `/relationships/fields/${OWNER_FIELD_ID}/sources/${SOURCE_RECORD_ID}`,
      ).body,
    ).toEqual({ target_record_id: null });

    const contactsTarget = page.getByRole("combobox", {
      name: "Related contacts target",
    });
    await contactsTarget.click();
    await page
      .getByRole("combobox", {
        name: "Search loaded records for Related contacts",
      })
      .fill(NEW_TARGET_RECORD_ID);
    await page
      .getByRole("option", {
        name: new RegExp(NEW_TARGET_RECORD_ID.slice(0, 8)),
      })
      .click();
    const addRelationship = page.waitForRequest(
      (request) =>
        request.method() === "POST" && pathFor(request) === "/relationships",
    );
    await page.getByRole("button", { name: /Add link/i }).click();
    await addRelationship;
    expect(requestMatching(requests, "POST", "/relationships").body).toEqual({
      field_id: CONTACTS_FIELD_ID,
      source_record_id: SOURCE_RECORD_ID,
      target_record_id: NEW_TARGET_RECORD_ID,
    });

    const visibleRelationship = page
      .getByText(compactId(SECOND_TARGET_RECORD_ID), { exact: true })
      .locator("..");
    const visibleUnlink = visibleRelationship.getByRole("button", {
      name: /Unlink/i,
    });
    await expect(visibleUnlink).toBeVisible();
    const visibleDelete = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        pathFor(request) === `/relationships/${CONTACT_EDGE_ID}`,
    );
    await visibleUnlink.click();
    await visibleDelete;

    await expect(page.getByText(/target record archived/i)).toBeVisible();
    const hiddenRelationship = page
      .getByText(/target record archived/i)
      .locator("..");
    const hiddenUnlink = hiddenRelationship.getByRole("button", {
      name: /Unlink/i,
    });
    await expect(hiddenUnlink).toBeVisible();
    const hiddenDelete = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        pathFor(request) === `/relationships/${HIDDEN_EDGE_ID}`,
    );
    await hiddenUnlink.click();
    await hiddenDelete;

    const incoming = page.getByRole("region", { name: /Incoming links/i });
    await expect(incoming).toContainText(compactId(INCOMING_SOURCE_RECORD_ID));
    const incomingRequest = requests.find(
      (request) =>
        request.method === "GET" &&
        request.path === "/relationships" &&
        request.url.includes(`target_record_id=${SOURCE_RECORD_ID}`),
    );
    expect(incomingRequest).toBeDefined();
    await expect(
      incoming.getByRole("button", { name: /Unlink|Remove/i }),
    ).toHaveCount(0);

    await page.getByLabel("Notes").fill("Updated notes");
    const patchRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" &&
        pathFor(request) === `/records/${SOURCE_RECORD_ID}`,
    );
    await page.getByRole("button", { name: /Save changes/i }).click();
    await patchRequest;
    expect(
      requestMatching(requests, "PATCH", `/records/${SOURCE_RECORD_ID}`).body,
    ).toEqual({
      data: {
        [NAME_FIELD_ID]: "Asset Alpha",
        [NOTES_FIELD_ID]: "Updated notes",
      },
    });
  });

  test("offers a bounded retry when the target page fails", async ({
    page,
  }) => {
    const state = makeState();
    state.targetRecordsFailures = 1;
    await installMocks(page, state);

    await page.goto(
      `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/records/${SOURCE_RECORD_ID}/edit`,
    );
    const ownerTarget = page.getByRole("combobox", {
      name: "Owner target",
    });
    await ownerTarget.click();
    await expect(page.getByText("Targets could not be loaded.")).toBeVisible();
    await page
      .getByRole("button", { name: "Try loading targets again", exact: true })
      .click();
    await expect(
      page.getByText("3 records loaded", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("option", { name: /Owner One/ })).toBeVisible();
  });
});
