import { expect, test } from "@playwright/test";
import { parseSandboxDocument } from "../../../src/components/systems/sandbox/domain/document";
import {
  mergeProjectedDesign,
  projectSandboxDocument,
} from "../../../src/components/systems/sandbox/domain/document-bridge";
import {
  documentSelectField,
  documentTextField,
} from "../../helpers/sandbox-fixtures";

const selectedOptionId = "00000000-0000-4000-8000-000000000031";
const userId = "00000000-0000-4000-8000-000000000032";

type DocumentV4Fixture = {
  kind: "openslate-sandbox";
  schemaVersion: 4;
  design: {
    departments: Array<{ id: string; name: string; closed: boolean }>;
    modules: Array<{
      id: string;
      departmentId: string;
      name: string;
      closed: boolean;
      titleFieldId: string | null;
      fields: Array<{
        id: string;
        name: string;
        type: string;
        required: boolean;
        closed: boolean;
        config: Record<string, unknown>;
      }>;
    }>;
    relationships: Array<Record<string, unknown>>;
    layout: Record<
      string,
      { x: number; y: number; width: number; height: number }
    >;
  };
  triggers: unknown[];
  scenarios: Array<{
    id: string;
    name: string;
    records: Array<{
      id: string;
      moduleId: string;
      values: Record<string, string | null>;
    }>;
    links: unknown[];
  }>;
};

function documentFixture(): DocumentV4Fixture {
  return {
    kind: "openslate-sandbox",
    schemaVersion: 4,
    design: {
      departments: [{ id: "ops", name: "Operations", closed: false }],
      modules: [
        {
          id: "requests",
          departmentId: "ops",
          name: "Requests",
          closed: false,
          titleFieldId: "title",
          fields: [
            documentTextField({ id: "title", name: "Title", required: true }),
            documentSelectField({
              id: "status",
              name: "Status",
              defaultValue: selectedOptionId,
              options: [{ id: selectedOptionId, label: "Open" }],
            }),
            {
              id: "assignee",
              name: "Assignee",
              type: "User",
              required: false,
              closed: false,
              config: { kind: "user" },
            },
          ],
        },
      ],
      relationships: [],
      layout: {
        ops: { x: 0, y: 0, width: 360, height: 240 },
        requests: { x: 24, y: 48, width: 280, height: 160 },
      },
    },
    triggers: [],
    scenarios: [
      {
        id: "open-request",
        name: "Open request",
        records: [
          {
            id: "request-1",
            moduleId: "requests",
            values: {
              title: "Printer unavailable",
              status: selectedOptionId,
              assignee: userId,
            },
          },
        ],
        links: [],
      },
    ],
  };
}

test("v4 preserves stable select option IDs, User values, and the selected title field", () => {
  const fixture = documentFixture();
  const parsed = parseSandboxDocument(JSON.stringify(fixture));
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.ok).toBe(true);

  const document = parsed.document as unknown as DocumentV4Fixture;
  expect(document.schemaVersion).toBe(4);
  expect(document.design.modules[0]?.titleFieldId).toBe("title");
  expect(document.design.modules[0]?.fields[1]?.config).toEqual({
    kind: "select",
    defaultValue: selectedOptionId,
    options: [{ id: selectedOptionId, label: "Open" }],
  });
  expect(document.design.modules[0]?.fields[2]).toMatchObject({
    type: "User",
    config: { kind: "user" },
  });
  expect(document.scenarios[0]?.records[0]?.values).toEqual({
    title: "Printer unavailable",
    status: selectedOptionId,
    assignee: userId,
  });
});

test("v4 rejects duplicate choice IDs even when their labels differ", () => {
  const fixture = documentFixture();
  const status = fixture.design.modules[0]?.fields[1];
  if (!status) throw new Error("A Status select field is required");
  status.config = {
    kind: "select",
    defaultValue: selectedOptionId,
    options: [
      { id: selectedOptionId, label: "Open" },
      { id: selectedOptionId, label: "Active" },
    ],
  };

  const parsed = parseSandboxDocument(JSON.stringify(fixture));
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.error).toMatch(/option|choice/i);
});

test("the Designer projection and merge retain the selected title field", () => {
  const source = documentFixture() as unknown as Parameters<
    typeof projectSandboxDocument
  >[0];
  const projected = projectSandboxDocument(source);
  const projectedModule = projected.modules[0] as
    | ((typeof projected.modules)[number] & { titleFieldId?: string | null })
    | undefined;
  expect(projectedModule?.titleFieldId).toBe("title");

  const merged = mergeProjectedDesign(source, projected, projected);
  const document = merged as unknown as DocumentV4Fixture;
  expect(document.design.modules[0]?.titleFieldId).toBe("title");
});

test("renaming a select label through the Designer bridge preserves its option ID", () => {
  const source = documentFixture() as unknown as Parameters<
    typeof projectSandboxDocument
  >[0];
  const projected = projectSandboxDocument(source);
  const nextDesign = structuredClone(projected);
  const status = nextDesign.modules[0]?.fields.find(
    (field) => field.id === "status",
  );
  if (!status) throw new Error("The Status select field is required");
  const current = status.config as unknown as {
    kind: "select";
    defaultValue: string | null;
    options: Array<{ id: string; label: string }>;
  };
  (status as unknown as { value: string }).value = selectedOptionId;
  (status as unknown as { options: string }).options = "Active";
  (status as unknown as { config: unknown }).config = {
    ...current,
    options: current.options.map((option) =>
      option.id === selectedOptionId ? { ...option, label: "Active" } : option,
    ),
  };

  const merged = mergeProjectedDesign(source, projected, nextDesign);
  const document = merged as unknown as DocumentV4Fixture;
  const saved = document.design.modules[0]?.fields.find(
    (field) => field.id === "status",
  );
  expect(saved?.config).toEqual({
    kind: "select",
    defaultValue: selectedOptionId,
    options: [{ id: selectedOptionId, label: "Active" }],
  });
});
