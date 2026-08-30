import { expect, test } from "@playwright/test";
import recordFieldValidationCases from "../../contracts/record-field-validation-cases.json";
import {
  buildFieldSchema,
  buildModuleSchema,
  serializeFormValues,
} from "../src/lib/field-schema";
import type { Field, FieldType } from "../src/lib/api";

function field(type: FieldType, overrides: Partial<Field> = {}): Field {
  return {
    id: `${type}-field`,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
    module_id: "module",
    name: type,
    type,
    required: true,
    position: 0,
    config: {},
    relationship_target_module_id: null,
    relationship_multiple_targets: null,
    relationship_multiple_sources: null,
    ...overrides,
  };
}

test.describe("dynamic field schemas", () => {
  test("matches the shared record field validation cases", () => {
    for (const item of recordFieldValidationCases.cases) {
      const schema = buildFieldSchema(
        field(item.type as FieldType, { config: item.config }),
      );
      const validResult = schema.safeParse(item.valid);
      const invalidResult = schema.safeParse(item.invalid);

      if (item.validAccepted) {
        expect(validResult, item.type).toEqual({
          success: true,
          data: item.normalized,
        });
        expect(invalidResult.success, item.type).toBe(false);
      } else {
        expect(validResult.success, item.type).toBe(false);
        expect(invalidResult.success, item.type).toBe(false);
      }
    }
  });

  test("canonicalizes decimals and compares bounds without losing precision", () => {
    const schema = buildFieldSchema(
      field("decimal", { config: { minimum: "-1.2", maximum: "2.5" } }),
    );

    expect(schema.safeParse("1.2300")).toMatchObject({
      success: true,
      data: "1.23",
    });
    expect(schema.safeParse("-0.000")).toMatchObject({
      success: true,
      data: "0",
    });
    expect(schema.safeParse("2.5001").success).toBe(false);
    expect(schema.safeParse("01.2").success).toBe(false);
    expect(schema.safeParse(`1.${"1".repeat(19)}`).success).toBe(false);
    expect(schema.safeParse(`${"1".repeat(39)}`).success).toBe(false);
  });

  test("fails closed for malformed metadata and excludes inactive links", () => {
    expect(
      buildFieldSchema(field("text", { config: { minLength: "2" } })).safeParse(
        "valid",
      ).success,
    ).toBe(false);
    expect(
      buildFieldSchema(
        field("select", { config: { options: ["open", 2] } }),
      ).safeParse("open").success,
    ).toBe(false);

    const active = field("text", { id: "active" });
    const closed = field("text", {
      id: "closed",
      is_deleted: true,
    });
    const relationship = field("relationship", {
      id: "relationship",
      required: false,
    });
    const result = buildModuleSchema([active, closed, relationship]).safeParse({
      active: "value",
    });

    expect(result).toMatchObject({ success: true, data: { active: "value" } });
    if (result.success) {
      expect(result.data).not.toHaveProperty("closed");
      expect(result.data).not.toHaveProperty("relationship");
    }
  });

  test("serializes form values without null blanks or decimal coercion", () => {
    const fields = [
      field("text", { id: "blank", required: false }),
      field("number", { id: "number", required: false }),
      field("int", { id: "int", required: false }),
      field("decimal", { id: "decimal", required: false }),
      field("boolean", { id: "boolean", required: false }),
    ];

    expect(
      serializeFormValues(fields, {
        blank: "",
        number: "2.5",
        int: "2.5",
        decimal: "1.2300",
        boolean: false,
      }),
    ).toEqual({
      number: 2.5,
      int: 2.5,
      decimal: "1.2300",
      boolean: false,
    });
  });

  test("keeps invalid datetime form input rejectable after serialization", () => {
    const datetimeField = field("datetime", { id: "datetime" });
    const invalidInput = "not-a-datetime";

    expect(() =>
      serializeFormValues([datetimeField], { datetime: invalidInput }),
    ).not.toThrow();

    const serialized = serializeFormValues([datetimeField], {
      datetime: invalidInput,
    });
    expect(
      buildFieldSchema(datetimeField).safeParse(serialized.datetime).success,
    ).toBe(false);
  });

  test("accepts an empty record for a relationship-only module", () => {
    expect(buildModuleSchema([field("relationship")]).safeParse({})).toEqual({
      success: true,
      data: {},
    });
  });
});
