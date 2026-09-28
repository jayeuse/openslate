import { expect, test } from "@playwright/test";
import { parseSandboxDocument } from "../../../src/components/systems/sandbox/domain/document";
import { SANDBOX_ORGANIZATION_TEMPLATES } from "../../../src/components/systems/sandbox/domain/templates";

test("organization templates are detailed valid v4 baselines", () => {
  expect(SANDBOX_ORGANIZATION_TEMPLATES.map((template) => template.id)).toEqual(
    [
      "inventory-procurement",
      "finance-accounting-sales",
      "retail-commerce",
      "professional-services",
      "field-service-maintenance",
      "light-manufacturing",
    ],
  );

  for (const template of SANDBOX_ORGANIZATION_TEMPLATES) {
    const parsed = parseSandboxDocument(JSON.stringify(template.document));
    expect(parsed, template.name).toEqual({
      ok: true,
      document: template.document,
    });

    const fieldCount = template.document.design.modules.reduce(
      (total, module) => total + module.fields.length,
      0,
    );
    expect(template.description.length, template.name).toBeGreaterThan(50);
    expect(template.recommendedFor.length, template.name).toBeGreaterThan(1);
    expect(
      template.document.design.departments.length,
      template.name,
    ).toBeGreaterThanOrEqual(3);
    expect(
      template.document.design.modules.length,
      template.name,
    ).toBeGreaterThanOrEqual(6);
    expect(fieldCount, template.name).toBeGreaterThanOrEqual(30);
    expect(
      template.document.design.relationships.length,
      template.name,
    ).toBeGreaterThanOrEqual(5);
    const departmentsByModule = new Map(
      template.document.design.modules.map((module) => [
        module.id,
        module.departmentId,
      ]),
    );
    expect(
      template.document.design.relationships.every(
        (relationship) =>
          departmentsByModule.get(relationship.sourceModuleId) ===
          departmentsByModule.get(relationship.targetModuleId),
      ),
      `${template.name} contains a relationship that cannot be published`,
    ).toBe(true);
    expect(
      template.document.triggers.length,
      template.name,
    ).toBeGreaterThanOrEqual(3);
    expect(
      template.document.triggers.every(
        (recordTrigger) => recordTrigger.enabled,
      ),
      template.name,
    ).toBe(true);
    expect(template.document.scenarios, template.name).toEqual([]);
  }
});

test("template documents are isolated from consumer mutations", () => {
  const first = SANDBOX_ORGANIZATION_TEMPLATES[0];
  const originalName = first.document.design.departments[0]?.name;
  const copy = first.createDocument();

  copy.design.departments[0]!.name = "Changed locally";

  expect(first.document.design.departments[0]?.name).toBe(originalName);
  expect(first.createDocument().design.departments[0]?.name).toBe(originalName);
});

test("template status triggers make a meaningful change", () => {
  for (const template of SANDBOX_ORGANIZATION_TEMPLATES) {
    let checked = 0;
    for (const recordTrigger of template.document.triggers) {
      for (const action of recordTrigger.actions) {
        if (action.kind !== "set-field" || action.value.kind !== "literal")
          continue;
        checked += 1;
        const actionValue = action.value.value;
        const noOpCondition = recordTrigger.conditionGroup.conditions.find(
          (condition) =>
            condition.operator === "=" &&
            condition.value.kind === "literal" &&
            condition.field.moduleId === action.target.moduleId &&
            condition.field.fieldId === action.target.fieldId &&
            condition.value.value === actionValue,
        );
        expect(noOpCondition, `${template.name}: ${recordTrigger.name}`).toBe(
          undefined,
        );
      }
    }
    expect(checked, template.name).toBeGreaterThanOrEqual(5);
  }
});

test("template identifier fields use readable singular labels", () => {
  const expected = [
    ["finance-accounting-sales", "Opportunities", "Opportunity ID"],
    ["finance-accounting-sales", "Journal entries", "Journal entry ID"],
    ["professional-services", "Time entries", "Time entry ID"],
    ["retail-commerce", "Stores and channels", "Store and channel ID"],
    ["retail-commerce", "Returns and refunds", "Return and refund ID"],
    ["light-manufacturing", "Bills of material", "Bill of material ID"],
  ] as const;

  for (const [templateId, moduleName, fieldName] of expected) {
    const template = SANDBOX_ORGANIZATION_TEMPLATES.find(
      (item) => item.id === templateId,
    );
    const moduleDefinition = template?.document.design.modules.find(
      (item) => item.name === moduleName,
    );
    expect(
      moduleDefinition?.fields[0]?.name,
      `${templateId}: ${moduleName}`,
    ).toBe(fieldName);
  }
});
