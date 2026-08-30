import { expect, test } from "@playwright/test";

import { LIVE_CATALOG } from "./support/catalog";
import {
  controlRoleForField,
  generateSanityFormValues,
  mapSanityFormValuesToFields,
  recordPayloadFromFormValues,
  relationshipTargetAccessibleName,
  type SeedFieldDescriptor,
} from "./support/seed-helpers";
import { getLiveSeedEnvironment } from "./support/preflight";

test.describe("live seed helpers", () => {
  const RUN_ID = "run-20260830-001-00000000000000000000000000000001";

  test("generates deterministic values for every primitive field type", () => {
    const catalogModule = LIVE_CATALOG.modules[4];
    const first = generateSanityFormValues(catalogModule, 1, RUN_ID);
    const second = generateSanityFormValues(catalogModule, 1, RUN_ID);

    expect(first).toEqual(second);
    expect(first[`${catalogModule.key}.run-marker`]).toBe(
      `${RUN_ID}:leave-requests:record-1`,
    );
    expect(first[`${catalogModule.key}.sequence`]).toBe("401");
    expect(first[`${catalogModule.key}.amount`]).toBe("4010.25");
    expect(first[`${catalogModule.key}.active`]).toBe(true);
    expect(first[`${catalogModule.key}.effective-at`]).toBe("2026-08-06T09:00");
    expect(first[`${catalogModule.key}.status`]).toBe("planned");
  });

  test("maps generated form values to exact primitive payload keys", () => {
    const catalogModule = LIVE_CATALOG.modules[0];
    const fields: SeedFieldDescriptor[] = [
      ...catalogModule.primitiveFields.map((field, index) => ({
        id: `field-${index}`,
        name: field.name,
        type: field.type,
      })),
      { id: "relationship-field", name: "Manager", type: "relationship" },
    ];
    const formValues = mapSanityFormValuesToFields(
      catalogModule,
      fields,
      2,
      RUN_ID,
    );

    expect(recordPayloadFromFormValues(fields, formValues)).toEqual({
      "field-0": `${RUN_ID}:employees:record-2`,
      "field-1": 2,
      "field-2": "20.25",
      "field-3": false,
      "field-4": new Date("2026-08-03T09:00").toISOString(),
      "field-5": "active",
    });
    expect(formValues).not.toHaveProperty("relationship-field");
  });

  test("maps controls semantically and reports missing live seed environment clearly", () => {
    expect(controlRoleForField("boolean")).toBe("checkbox");
    expect(controlRoleForField("select")).toBe("combobox");
    expect(controlRoleForField("int")).toBe("spinbutton");
    expect(controlRoleForField("number")).toBe("spinbutton");
    expect(controlRoleForField("decimal")).toBe("textbox");
    expect(controlRoleForField("datetime")).toBe("textbox");
    expect(relationshipTargetAccessibleName("run Manager")).toBe(
      "run Manager target",
    );
    expect(() =>
      getLiveSeedEnvironment({
        LIVE_API_BASE_URL: "http://127.0.0.1:8000",
        LIVE_BASE_URL: "http://127.0.0.1:3000",
        BACKEND_URL: "http://127.0.0.1:8000",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
        LIVE_ADMIN_EMAIL: "admin@example.com",
        LIVE_ADMIN_PASSWORD: "not-a-real-password",
      }),
    ).toThrow("LIVE_RUN_ID");
  });
});
