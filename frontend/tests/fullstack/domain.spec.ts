import { expect, test } from "@playwright/test";
import { z } from "zod";
import { fixture, signIn } from "./fixture";

const Entity = z.object({ id: z.uuid() });
const Relationship = Entity.extend({
  field_id: z.uuid(),
  source_record_id: z.uuid(),
  target_record_id: z.uuid(),
});

function assertDisposableMutation() {
  if (
    process.env.E2E_ALLOW_MUTATIONS !== "true" ||
    fixture.baseURL !== "http://localhost:3008" ||
    fixture.authURL !== "http://127.0.0.1:55321" ||
    fixture.runId !== process.env.OPENSLATE_FULLSTACK_RUN_ID
  )
    throw new Error("Disposable mutation guard failed");
}

test("schema, record edits and relationship changes persist through the authenticated BFF", async ({
  page,
}) => {
  await signIn(page, fixture.admin);
  // These real service contracts remain supported after the legacy editors retire.
  async function mutate(
    path: string,
    data: unknown,
    method: "POST" | "PATCH" | "PUT" = "POST",
  ) {
    assertDisposableMutation();
    const result = await page.request.fetch(`/bff${path}`, {
      method,
      headers: { Origin: fixture.baseURL },
      data,
    });
    expect(result.ok()).toBe(true);
    return result;
  }
  async function create(path: string, data: unknown) {
    return Entity.parse(await (await mutate(path, data)).json());
  }
  const department = await create("/departments", {
    department_name: `Smoke ${fixture.runId}`,
  });
  const sourceModule = await create("/modules", {
    department_id: department.id,
    module_name: "Items",
  });
  const field = await create("/fields", {
    module_id: sourceModule.id,
    name: "Title",
    type: "text",
    position: 0,
  });
  await mutate(`/modules/${sourceModule.id}/schema/accept`, {});
  const record = await create("/records", {
    module_id: sourceModule.id,
    data: { [field.id]: "Original item" },
  });
  await mutate(
    `/records/${record.id}`,
    { data: { [field.id]: "Updated item" } },
    "PATCH",
  );
  const persisted = await page.request.get(`/bff/records/${record.id}`);
  expect(persisted.status()).toBe(200);
  expect(
    z
      .object({ data: z.record(z.string(), z.unknown()) })
      .parse(await persisted.json()).data[field.id],
  ).toBe("Updated item");

  const targetModule = await create("/modules", {
    department_id: department.id,
    module_name: "Owners",
  });
  const targetField = await create("/fields", {
    module_id: targetModule.id,
    name: "Name",
    type: "text",
    position: 0,
  });
  await mutate(`/modules/${targetModule.id}/schema/accept`, {});
  const target = await create("/records", {
    module_id: targetModule.id,
    data: { [targetField.id]: "Smoke owner" },
  });
  const relationship = await create("/fields", {
    module_id: sourceModule.id,
    name: "Owner",
    type: "relationship",
    position: 1,
    relationship_target_module_id: targetModule.id,
    relationship_multiple_targets: false,
    relationship_multiple_sources: true,
  });
  await mutate(`/modules/${sourceModule.id}/schema/accept`, {});
  const assignmentPath = `/relationships/fields/${relationship.id}/sources/${record.id}`;
  const linked = await mutate(
    assignmentPath,
    { target_record_id: target.id },
    "PUT",
  );
  expect(linked.status()).toBe(200);
  const edge = Relationship.parse(await linked.json());
  const persistedLink = await page.request.get(`/bff/relationships/${edge.id}`);
  expect(persistedLink.status()).toBe(200);
  expect(Relationship.parse(await persistedLink.json())).toEqual({
    id: edge.id,
    field_id: relationship.id,
    source_record_id: record.id,
    target_record_id: target.id,
  });
  const unlinked = await mutate(
    assignmentPath,
    { target_record_id: null },
    "PUT",
  );
  expect(unlinked.status()).toBe(200);
  expect(await unlinked.json()).toBeNull();
  const remaining = await page.request.get("/bff/relationships", {
    params: { field_id: relationship.id, source_record_id: record.id },
  });
  expect(remaining.status()).toBe(200);
  expect(
    z.object({ items: z.array(Relationship) }).parse(await remaining.json())
      .items,
  ).toEqual([]);
});
