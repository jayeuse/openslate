import type {
  SandboxFieldType,
  SandboxState,
  UpdateSandboxFieldPatch,
} from "@/lib/sandbox/model";
import { normalizeField, type Design, type Field } from "../domain/model";

export const canvasFieldId = (moduleId: string, fieldId: string) =>
  `sandbox-field:${encodeURIComponent(moduleId)}:${encodeURIComponent(fieldId)}`;
export function projectedField(design: Design, projectedId: string) {
  for (const item of design.modules) {
    const field = item.fields.find(
      (entry) => canvasFieldId(item.id, entry.id) === projectedId,
    );
    if (field) return { moduleId: item.id, field };
  }
  return undefined;
}
export const fieldTypeNames: Record<SandboxFieldType, string> = {
  text: "Text",
  "long-text": "Long text",
  int: "Integer",
  decimal: "Number",
  boolean: "Checkbox",
  date: "Date",
  datetime: "Date/Time",
  select: "Select",
  email: "Email",
  url: "URL",
};
function canvasType(type: string): SandboxFieldType {
  if (type === "Long text") return "long-text";
  if (type === "Integer") return "int";
  if (type === "Number" || type === "Decimal") return "decimal";
  if (type === "Checkbox") return "boolean";
  if (type === "Date") return "date";
  if (type === "Date time" || type === "Date/Time") return "datetime";
  if (type === "Select") return "select";
  if (type === "Email") return "email";
  if (type === "URL") return "url";
  return "text";
}
export function projectDesign(
  design: Design,
  selectedCellId: string | null,
): SandboxState {
  return {
    selectedCellId,
    departments: design.departments.map((item) => ({
      id: item.id,
      name: item.name,
      moduleIds: design.modules
        .filter((module) => module.department === item.id)
        .map((module) => module.id),
      closed: item.closed,
    })),
    modules: design.modules.map((item) => ({
      id: item.id,
      name: item.name,
      departmentId: item.department,
      fieldIds: item.fields.map((field) => canvasFieldId(item.id, field.id)),
      closed: item.closed,
    })),
    fields: design.modules.flatMap((item) =>
      item.fields.map((field) => ({
        id: canvasFieldId(item.id, field.id),
        moduleId: item.id,
        name: field.name,
        type: canvasType(field.type),
        required: field.required,
        description: field.description ?? "",
        closed: field.closed,
      })),
    ),
    links: design.relationships.map((item) => ({
      id: item.id,
      sourceModuleId: item.source,
      targetModuleId: item.target,
      label: item.name,
      relationshipType: item.cardinality,
      direction: "directed",
    })),
  };
}
export function updateProjectedField(
  design: Design,
  id: string,
  patch: UpdateSandboxFieldPatch,
): Design {
  const target = projectedField(design, id);
  if (!target) return design;
  const metadata: Partial<Field> = {};
  if (patch.name !== undefined) metadata.name = patch.name;
  if (patch.required !== undefined) metadata.required = patch.required;
  if (patch.description !== undefined) metadata.description = patch.description;
  const nextType = patch.type === undefined ? null : fieldTypeNames[patch.type];
  const typeChanged =
    nextType !== null && patch.type !== canvasType(target.field.type);
  if (typeChanged) metadata.type = nextType;
  return {
    ...design,
    modules: design.modules.map((item) =>
      item.id === target.moduleId
        ? {
            ...item,
            fields: item.fields.map((field) => {
              if (field.id !== target.field.id) return field;
              const updated = { ...field, ...metadata };
              return typeChanged
                ? normalizeField({
                    ...updated,
                    value: "",
                    options: "",
                    config: undefined,
                  })
                : updated;
            }),
          }
        : item,
    ),
  };
}
