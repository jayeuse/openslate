import { canvasFieldId, projectedField } from "./bridge";
import {
  normalizeRule,
  relationshipFieldTypesAreCompatible,
  type Design,
  type Field,
  type Module,
  type RelationshipFieldMapping,
  type SandboxDesignTarget,
} from "../domain/model";

export function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function joinedImpact(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

export function mappingFieldReference(
  moduleId: string,
  fieldId: string,
): string {
  return `${moduleId}\u0000${fieldId}`;
}

function mappingReferencesFields(
  relationship: Design["relationships"][number],
  mapping: RelationshipFieldMapping,
  fieldReferences: ReadonlySet<string>,
): boolean {
  return (
    fieldReferences.has(
      mappingFieldReference(relationship.source, mapping.sourceFieldId),
    ) ||
    fieldReferences.has(
      mappingFieldReference(relationship.target, mapping.targetFieldId),
    )
  );
}

export function relationshipMappingCountForFields(
  relationships: Design["relationships"],
  fieldReferences: ReadonlySet<string>,
): number {
  return relationships.reduce(
    (count, relationship) =>
      count +
      relationship.fieldMappings.filter((mapping) =>
        mappingReferencesFields(relationship, mapping, fieldReferences),
      ).length,
    0,
  );
}

export function pruneRelationshipMappingsForFields(
  relationships: Design["relationships"],
  fieldReferences: ReadonlySet<string>,
): Design["relationships"] {
  return relationships.map((relationship) => {
    const fieldMappings = relationship.fieldMappings.filter(
      (mapping) =>
        !mappingReferencesFields(relationship, mapping, fieldReferences),
    );
    return fieldMappings.length === relationship.fieldMappings.length
      ? relationship
      : { ...relationship, fieldMappings };
  });
}

function affectedRuleReferences(
  design: Design,
  moduleIds: ReadonlySet<string>,
  fieldTargets: ReadonlySet<string>,
): number {
  let count = 0;
  for (const rule of design.rules) {
    const { config } = normalizeRule(rule, design);
    if (
      config.trigger.kind !== "schedule" &&
      (moduleIds.has(config.trigger.moduleId) ||
        ("fieldId" in config.trigger &&
          fieldTargets.has(
            canvasFieldId(config.trigger.moduleId, config.trigger.fieldId),
          )))
    )
      count += 1;
    if (
      config.condition.kind === "field-comparison" &&
      (moduleIds.has(config.condition.moduleId) ||
        fieldTargets.has(
          canvasFieldId(config.condition.moduleId, config.condition.fieldId),
        ))
    )
      count += 1;
    if (
      (config.action.kind === "create-record" ||
        config.action.kind === "update-field") &&
      (moduleIds.has(config.action.moduleId) ||
        fieldTargets.has(
          canvasFieldId(config.action.moduleId, config.action.fieldId),
        ))
    )
      count += 1;
  }
  return count;
}

/** The sentence for trigger steps that lose a deleted field or module. */
function triggerNote(references: number): string {
  if (!references) return "";
  return ` ${plural(references, "trigger step")} ${references === 1 ? "uses" : "use"} it and may stop working.`;
}

/**
 * Whether deleting a field needs a review first: a trigger step or a
 * relationship's linked field uses it (S26). Other fields delete at once
 * with Undo.
 */
export function fieldDeletionNeedsReview(
  design: Design,
  fieldTargetId: string,
): boolean {
  const match = projectedField(design, fieldTargetId);
  if (!match) return true;
  return (
    relationshipMappingCountForFields(
      design.relationships,
      new Set([mappingFieldReference(match.moduleId, match.field.id)]),
    ) > 0 ||
    affectedRuleReferences(
      design,
      new Set(),
      new Set([canvasFieldId(match.moduleId, match.field.id)]),
    ) > 0
  );
}

export function deletionImpact(
  design: Design,
  target: SandboxDesignTarget | null,
  bound = false,
): { title: string; detail: string; action: string } | null {
  if (!target) return null;
  if (bound) {
    const impact = deletionImpact(design, target);
    return impact
      ? {
          ...impact,
          detail: "On publish, the live item closes. Its data is kept.",
        }
      : null;
  }
  if (target.kind === "link") {
    const relationship = design.relationships.find(
      (item) => item.id === target.id,
    );
    const name = relationship?.name || "Unnamed relationship";
    return {
      title: `Delete relationship ${name}?`,
      detail:
        "Removes it from both connected modules. Undo restores the complete change.",
      action: "Delete relationship",
    };
  }
  if (target.kind === "field") {
    const match = projectedField(design, target.id);
    const name = match?.field.name ?? "Unknown field";
    const fieldReferences = new Set(
      match ? [mappingFieldReference(match.moduleId, match.field.id)] : [],
    );
    const mappings = relationshipMappingCountForFields(
      design.relationships,
      fieldReferences,
    );
    const ruleReferences = affectedRuleReferences(
      design,
      new Set(),
      new Set(match ? [canvasFieldId(match.moduleId, match.field.id)] : []),
    );
    return {
      title: `Delete field ${name}?`,
      detail: `Removes it from its module${mappings ? ` with ${plural(mappings, "linked field")}` : ""}.${triggerNote(ruleReferences)} Undo restores the complete change.`,
      action: "Delete field",
    };
  }
  const moduleIds = new Set(
    design.modules
      .filter((item) =>
        target.kind === "department"
          ? item.department === target.id
          : item.id === target.id,
      )
      .map((item) => item.id),
  );
  const modules = design.modules.filter((item) => moduleIds.has(item.id));
  const fieldCount = modules.reduce(
    (total, item) => total + item.fields.length,
    0,
  );
  const fieldTargets = new Set(
    modules.flatMap((item) =>
      item.fields.map((field) => canvasFieldId(item.id, field.id)),
    ),
  );
  const relationships = design.relationships.filter(
    (item) => moduleIds.has(item.source) || moduleIds.has(item.target),
  ).length;
  const ruleReferences = affectedRuleReferences(
    design,
    moduleIds,
    fieldTargets,
  );
  const entity =
    target.kind === "department"
      ? design.departments.find((item) => item.id === target.id)
      : design.modules.find((item) => item.id === target.id);
  const name = entity?.name ?? `Unknown ${target.kind}`;
  const parts = [
    ...(target.kind === "department" ? [plural(modules.length, "module")] : []),
    plural(fieldCount, "field"),
    plural(relationships, "relationship"),
  ];
  return {
    title: `Delete ${target.kind} ${name}?`,
    detail: `Removes it with ${joinedImpact(parts)}.${triggerNote(ruleReferences)} Undo restores the complete change.`,
    action: `Delete ${target.kind}`,
  };
}

export function deletionTargetName(
  design: Design,
  target: SandboxDesignTarget,
): string | null {
  if (target.kind === "department")
    return (
      design.departments.find((item) => item.id === target.id)?.name ?? null
    );
  if (target.kind === "module")
    return design.modules.find((item) => item.id === target.id)?.name ?? null;
  if (target.kind === "field")
    return projectedField(design, target.id)?.field.name ?? null;
  return (
    design.relationships.find((item) => item.id === target.id)?.name ?? null
  );
}

function openFieldsForRelationship(sandboxModule: Module | undefined): Field[] {
  return sandboxModule?.fields.filter((field) => !field.closed) ?? [];
}

export function compatibleRelationshipMappings(
  design: Design,
  sourceId: string,
  targetId: string,
  mappings: RelationshipFieldMapping[],
): RelationshipFieldMapping[] {
  const sourceFields = openFieldsForRelationship(
    design.modules.find((item) => item.id === sourceId),
  );
  const targetFields = openFieldsForRelationship(
    design.modules.find((item) => item.id === targetId),
  );
  const keys = new Set<string>();
  return mappings.filter((mapping) => {
    const source = sourceFields.find(
      (item) => item.id === mapping.sourceFieldId,
    );
    const target = targetFields.find(
      (item) => item.id === mapping.targetFieldId,
    );
    const key = `${mapping.sourceFieldId}\u0000${mapping.targetFieldId}`;
    if (
      !source ||
      !target ||
      !relationshipFieldTypesAreCompatible(source, target) ||
      keys.has(key)
    )
      return false;
    keys.add(key);
    return true;
  });
}
