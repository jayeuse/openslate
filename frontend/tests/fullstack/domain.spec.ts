import { expect, test } from "@playwright/test";
import { z } from "zod";
import { fixture, signIn } from "./fixture";

const Entity = z.object({ id: z.uuid() });

test("schema, record edits and relationship changes persist through the real stack", async ({
  page,
}) => {
  await signIn(page, fixture.admin);
  const name = `Smoke ${fixture.runId}`;
  // Observe the real UI mutation; never replay a failed write.
  async function save(path: string, button: string, method = "POST") {
    const response = page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname === `/bff${path}` &&
        result.request().method() === method,
    );
    await page.getByRole("button", { name: button, exact: true }).click();
    const result = await response;
    expect(result.ok()).toBe(true);
    return result;
  }
  await page.goto("/departments/new");
  await page.getByLabel("Department name", { exact: true }).fill(name);
  const department = Entity.parse(
    await (await save("/departments", "Create department")).json(),
  );
  await expect(page).toHaveURL(`/departments/${department.id}`);
  await page.getByLabel("Module name", { exact: true }).fill("Items");
  const sourceModule = Entity.parse(
    await (await save("/modules", "Create module")).json(),
  );
  await page.goto(`/modules/${sourceModule.id}/schema`);
  await page.getByLabel("Field name", { exact: true }).fill("Title");
  await page.getByLabel("Type", { exact: true }).selectOption("text");
  const field = Entity.parse(await (await save("/fields", "Add field")).json());
  await save(`/modules/${sourceModule.id}/schema/accept`, "Accept Schema");
  await page.goto(`/modules/${sourceModule.id}/records/new`);
  await page.getByLabel("Title", { exact: true }).fill("Original item");
  const record = Entity.parse(
    await (await save("/records", "Create record")).json(),
  );
  await expect(page).toHaveURL(
    `/modules/${sourceModule.id}/records/${record.id}/edit`,
  );
  await page.getByLabel("Title", { exact: true }).fill("Updated item");
  await save(`/records/${record.id}`, "Save changes", "PATCH");
  await page.goto(`/modules/${sourceModule.id}/records/${record.id}/edit`);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Updated item",
  );
  const persisted = await page.request.get(`/bff/records/${record.id}`);
  expect(persisted.status()).toBe(200);
  expect((await persisted.json()).data[field.id]).toBe("Updated item");

  // Minimal target fixtures use the same authenticated BFF and disposable runner.
  async function prepare(path: string, data: unknown) {
    const result = await page.request.post(`/bff${path}`, {
      headers: { Origin: fixture.baseURL },
      data,
    });
    expect(result.ok()).toBe(true);
    return Entity.parse(await result.json());
  }
  const targetModule = await prepare("/modules", {
    department_id: department.id,
    module_name: "Owners",
  });
  const targetField = await prepare("/fields", {
    module_id: targetModule.id,
    name: "Name",
    type: "text",
    position: 0,
  });
  await prepare(`/modules/${targetModule.id}/schema/accept`, {});
  const target = await prepare("/records", {
    module_id: targetModule.id,
    data: { [targetField.id]: "Smoke owner" },
  });
  const relationship = await prepare("/fields", {
    module_id: sourceModule.id,
    name: "Owner",
    type: "relationship",
    position: 1,
    relationship_target_module_id: targetModule.id,
    relationship_multiple_targets: false,
    relationship_multiple_sources: true,
  });
  await page.goto(`/modules/${sourceModule.id}/schema`);
  await save(`/modules/${sourceModule.id}/schema/accept`, "Accept Schema");
  await page.goto(`/modules/${sourceModule.id}/records/${record.id}/edit`);
  await page
    .getByRole("combobox", { name: "Owner target", exact: true })
    .click();
  const linked = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname ===
        `/bff/relationships/fields/${relationship.id}/sources/${record.id}` &&
      result.request().method() === "PUT",
  );
  await page.getByRole("option", { name: new RegExp(target.id) }).click();
  const linkResponse = await linked;
  expect(linkResponse.status()).toBe(200);
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Owner target", exact: true }),
  ).toHaveAttribute("title", target.id);
  await page
    .getByRole("combobox", { name: "Owner target", exact: true })
    .click();
  const unlinked = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname ===
        `/bff/relationships/fields/${relationship.id}/sources/${record.id}` &&
      result.request().method() === "PUT",
  );
  await page.getByRole("option", { name: "No target", exact: true }).click();
  expect((await unlinked).status()).toBe(200);
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Owner target", exact: true }),
  ).toContainText("No target");
});
