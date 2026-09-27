import {
  canonicalFieldType,
  normalizeField,
  normalizeRule,
  relationshipFieldTypesAreCompatible,
  type Design,
  type Rule,
  type RuleConfig,
} from "./model";
import {
  fieldDefaultMatches,
  validateFieldConfig,
  validateFieldValue,
} from "./field-validation";
import {
  issue,
  warning,
  SANDBOX_LIMITS,
  type SandboxValidationIssue,
} from "./validation-types";

export { validateFieldValue } from "./field-validation";
export {
  SANDBOX_LIMITS,
  type SandboxValidationIssue,
} from "./validation-types";

function validateName(
  value: string,
  targetId: string,
  kind: string,
): SandboxValidationIssue[] {
  if (!value.trim())
    return [issue(`${kind}.name_required`, "Name is required", targetId)];
  if (value.length > SANDBOX_LIMITS.nameCharacters)
    return [
      issue(
        `${kind}.name_too_long`,
        "Name is longer than 80 characters",
        targetId,
      ),
    ];
  return [];
}

function validateId(value: string, kind: string): SandboxValidationIssue[] {
  if (!value.trim())
    return [issue(`${kind}.id_required`, `${kind} ID is required`)];
  if (value.length > SANDBOX_LIMITS.textCharacters)
    return [issue(`${kind}.id_too_long`, `${kind} ID is too long`, value)];
  return [];
}

function duplicateIds(ids: string[], kind: string): SandboxValidationIssue[] {
  const seen = new Set<string>();
  const issues: SandboxValidationIssue[] = [];
  for (const id of ids) {
    if (seen.has(id))
      issues.push(issue(`${kind}.id_duplicate`, `Duplicate ${kind} ID`, id));
    seen.add(id);
  }
  return issues;
}

function validateRuleDependency(
  design: Design,
  rule: Rule,
  moduleId: string,
  fieldId?: string,
): SandboxValidationIssue[] {
  const sandboxModule = design.modules.find((item) => item.id === moduleId);
  if (!sandboxModule)
    return [
      issue(
        "rule.module_missing",
        `${rule.name} references a missing module`,
        rule.id,
      ),
    ];
  if (sandboxModule.closed)
    return [
      issue(
        "rule.module_closed",
        `${rule.name} references the closed module ${sandboxModule.name}`,
        rule.id,
      ),
    ];
  if (fieldId === undefined) return [];
  const field = sandboxModule.fields.find((item) => item.id === fieldId);
  if (!field)
    return [
      issue(
        "rule.field_missing",
        `${rule.name} references a missing field in ${sandboxModule.name}`,
        rule.id,
      ),
    ];
  return field.closed
    ? [
        issue(
          "rule.field_closed",
          `${rule.name} references the closed field ${field.name}`,
          rule.id,
        ),
      ]
    : [];
}

function validateRuleConfig(
  design: Design,
  rule: Rule,
  config: RuleConfig,
): SandboxValidationIssue[] {
  const issues: SandboxValidationIssue[] = [];
  const trigger = config.trigger;
  if (trigger.kind === "schedule") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time))
      issues.push(
        issue(
          "rule.schedule_time_invalid",
          `${rule.name} has an invalid schedule time`,
          rule.id,
        ),
      );
    if (
      trigger.frequency === "weekly" &&
      (!Number.isInteger(trigger.weekday) ||
        (trigger.weekday ?? 0) < 1 ||
        (trigger.weekday ?? 0) > 7)
    )
      issues.push(
        issue(
          "rule.schedule_weekday_invalid",
          `${rule.name} must choose a schedule weekday`,
          rule.id,
        ),
      );
  } else {
    issues.push(
      ...validateRuleDependency(
        design,
        rule,
        trigger.moduleId,
        "fieldId" in trigger ? trigger.fieldId : undefined,
      ),
    );
    if (trigger.kind === "threshold") {
      const field = design.modules
        .find((item) => item.id === trigger.moduleId)
        ?.fields.find((item) => item.id === trigger.fieldId);
      const config = field ? normalizeField(field).config : null;
      const message = field
        ? config?.kind === "number" || config?.kind === "integer"
          ? validateFieldValue(field, trigger.value, true)
          : `${field.name} must be numeric for a threshold`
        : null;
      if (message)
        issues.push(issue("rule.threshold_value_invalid", message, rule.id));
    }
  }
  const condition = config.condition;
  if (condition.kind === "field-comparison") {
    issues.push(
      ...validateRuleDependency(
        design,
        rule,
        condition.moduleId,
        condition.fieldId,
      ),
    );
    if (!condition.value.trim())
      issues.push(
        issue(
          "rule.condition_value_required",
          `${rule.name} must provide a comparison value`,
          rule.id,
        ),
      );
    else {
      const field = design.modules
        .find((item) => item.id === condition.moduleId)
        ?.fields.find((item) => item.id === condition.fieldId);
      const message = field
        ? validateFieldValue(field, condition.value, true)
        : null;
      if (message)
        issues.push(issue("rule.condition_value_invalid", message, rule.id));
    }
  }
  const action = config.action;
  if (action.kind === "create-record" || action.kind === "update-field") {
    issues.push(
      ...validateRuleDependency(design, rule, action.moduleId, action.fieldId),
    );
    if (!action.value.trim())
      issues.push(
        issue(
          "rule.action_value_required",
          `${rule.name} must provide an action value`,
          rule.id,
        ),
      );
    else {
      const field = design.modules
        .find((item) => item.id === action.moduleId)
        ?.fields.find((item) => item.id === action.fieldId);
      const message = field
        ? validateFieldValue(field, action.value, true)
        : null;
      if (message)
        issues.push(issue("rule.action_value_invalid", message, rule.id));
    }
  } else {
    const value =
      action.kind === "notification"
        ? action.message
        : action.kind === "channel-message"
          ? action.channel
          : action.assignee;
    if (!value.trim())
      issues.push(
        issue(
          "rule.action_parameter_required",
          `${rule.name} must configure its action`,
          rule.id,
        ),
      );
  }
  return issues;
}

export function validateSandboxDesign(
  design: Design,
): SandboxValidationIssue[] {
  const issues: SandboxValidationIssue[] = [];
  const fields = design.modules.flatMap((module) => module.fields);
  if (design.departments.length > SANDBOX_LIMITS.departments)
    issues.push(issue("design.department_limit", "Department limit exceeded"));
  if (design.modules.length > SANDBOX_LIMITS.modules)
    issues.push(issue("design.module_limit", "Module limit exceeded"));
  if (fields.length > SANDBOX_LIMITS.fields)
    issues.push(issue("design.field_limit", "Field limit exceeded"));
  if (design.relationships.length > SANDBOX_LIMITS.relationships)
    issues.push(
      issue("design.relationship_limit", "Relationship limit exceeded"),
    );
  if (design.rules.length > SANDBOX_LIMITS.rules)
    issues.push(issue("design.rule_limit", "Automation limit exceeded"));

  issues.push(
    ...duplicateIds(
      design.departments.map((item) => item.id),
      "department",
    ),
  );
  issues.push(
    ...duplicateIds(
      design.modules.map((item) => item.id),
      "module",
    ),
  );
  issues.push(
    ...duplicateIds(
      design.relationships.map((item) => item.id),
      "relationship",
    ),
  );
  issues.push(
    ...duplicateIds(
      design.rules.map((item) => item.id),
      "rule",
    ),
  );

  const departmentIds = new Set(design.departments.map((item) => item.id));
  const moduleIds = new Set(design.modules.map((item) => item.id));
  for (const department of design.departments) {
    issues.push(...validateId(department.id, "department"));
    issues.push(...validateName(department.name, department.id, "department"));
  }
  for (const sandboxModule of design.modules) {
    issues.push(...validateId(sandboxModule.id, "module"));
    issues.push(
      ...validateName(sandboxModule.name, sandboxModule.id, "module"),
    );
    issues.push(
      ...duplicateIds(
        sandboxModule.fields.map((item) => item.id),
        "field",
      ),
    );
    if (!departmentIds.has(sandboxModule.department))
      issues.push(
        issue(
          "module.department_missing",
          "Module department does not exist",
          sandboxModule.id,
        ),
      );
    for (const value of [sandboxModule.x, sandboxModule.y])
      if (
        !Number.isFinite(value) ||
        Math.abs(value) > SANDBOX_LIMITS.layoutCoordinate
      )
        issues.push(
          issue(
            "module.position_invalid",
            "Module position is outside the supported range",
            sandboxModule.id,
          ),
        );
    for (const field of sandboxModule.fields) {
      const fieldIssueStart = issues.length;
      issues.push(...validateId(field.id, "field"));
      issues.push(...validateName(field.name, field.id, "field"));
      const type = canonicalFieldType(field.type);
      if (!type)
        issues.push(
          issue(
            "field.type_unsupported",
            "Field type is unsupported",
            field.id,
          ),
        );
      else if (
        field.config &&
        field.config.kind !==
          normalizeField({ ...field, config: undefined }).config.kind
      )
        issues.push(
          issue(
            "field.config_type_mismatch",
            "Field configuration does not match its type",
            field.id,
          ),
        );
      else if (!fieldDefaultMatches(field))
        issues.push(
          issue(
            "field.default_type_mismatch",
            "Field default does not match its type or options",
            field.id,
          ),
        );
      issues.push(...validateFieldConfig(field));
      if ((field.description?.length ?? 0) > SANDBOX_LIMITS.textCharacters)
        issues.push(
          issue(
            "field.description_too_long",
            "Description is too long",
            field.id,
          ),
        );
      if (field.value.length > SANDBOX_LIMITS.textCharacters)
        issues.push(
          issue(
            "field.default_too_long",
            "Default value is too long",
            field.id,
          ),
        );
      const normalized = normalizeField(field);
      if (normalized.config.kind === "select") {
        if (normalized.config.options.length > SANDBOX_LIMITS.selectOptions)
          issues.push(
            issue(
              "field.options_limit",
              "Select option limit exceeded",
              field.id,
            ),
          );
        if (
          normalized.config.options.some(
            (option) => option.length > SANDBOX_LIMITS.selectOptionCharacters,
          )
        )
          issues.push(
            issue(
              "field.option_too_long",
              "A select option is too long",
              field.id,
            ),
          );
      }
      for (let index = fieldIssueStart; index < issues.length; index += 1)
        issues[index] = { ...issues[index], moduleId: sandboxModule.id };
    }
  }

  const relationshipKeys = new Set<string>();
  for (const relationship of design.relationships) {
    issues.push(...validateId(relationship.id, "relationship"));
    issues.push(
      ...validateName(relationship.name, relationship.id, "relationship"),
    );
    if (!moduleIds.has(relationship.source))
      issues.push(
        issue(
          "relationship.source_missing",
          "Relationship source module does not exist",
          relationship.id,
        ),
      );
    if (!moduleIds.has(relationship.target))
      issues.push(
        issue(
          "relationship.target_missing",
          "Relationship target module does not exist",
          relationship.id,
        ),
      );
    const sourceDepartment = design.modules.find(
      (item) => item.id === relationship.source,
    )?.department;
    const targetDepartment = design.modules.find(
      (item) => item.id === relationship.target,
    )?.department;
    if (
      sourceDepartment !== undefined &&
      targetDepartment !== undefined &&
      sourceDepartment !== targetDepartment
    )
      issues.push(
        warning(
          "relationship.cross_department",
          "Relationship crosses departments; review access and ownership",
          relationship.id,
        ),
      );
    if (relationship.source === relationship.target)
      issues.push(
        issue(
          "relationship.self_link",
          "Relationship cannot link a module to itself",
          relationship.id,
        ),
      );
    const key = `${relationship.source}\u0000${relationship.target}`;
    if (relationshipKeys.has(key))
      issues.push(
        issue(
          "relationship.duplicate",
          "Relationship duplicates an existing link",
          relationship.id,
        ),
      );
    relationshipKeys.add(key);
    if (
      !["One-to-one", "One-to-many", "Many-to-many"].includes(
        relationship.cardinality,
      )
    )
      issues.push(
        issue(
          "relationship.cardinality_invalid",
          "Relationship cardinality is invalid",
          relationship.id,
        ),
      );
    if (relationship.fieldMappings.length > SANDBOX_LIMITS.relationshipMappings)
      issues.push(
        issue(
          "relationship.mapping_limit",
          "Relationship field mapping limit exceeded",
          relationship.id,
        ),
      );
    const sourceModule = design.modules.find(
      (item) => item.id === relationship.source,
    );
    const targetModule = design.modules.find(
      (item) => item.id === relationship.target,
    );
    const mappingKeys = new Set<string>();
    for (const mapping of relationship.fieldMappings) {
      const sourceField = sourceModule?.fields.find(
        (item) => item.id === mapping.sourceFieldId,
      );
      const targetField = targetModule?.fields.find(
        (item) => item.id === mapping.targetFieldId,
      );
      if (!sourceField)
        issues.push(
          issue(
            "relationship.mapping_source_missing",
            "Relationship mapping source field does not exist",
            relationship.id,
          ),
        );
      else if (sourceField.closed)
        issues.push(
          issue(
            "relationship.mapping_source_closed",
            "Relationship mapping source field is closed",
            relationship.id,
          ),
        );
      if (!targetField)
        issues.push(
          issue(
            "relationship.mapping_target_missing",
            "Relationship mapping target field does not exist",
            relationship.id,
          ),
        );
      else if (targetField.closed)
        issues.push(
          issue(
            "relationship.mapping_target_closed",
            "Relationship mapping target field is closed",
            relationship.id,
          ),
        );
      if (
        sourceField &&
        targetField &&
        !relationshipFieldTypesAreCompatible(sourceField, targetField)
      )
        issues.push(
          issue(
            "relationship.mapping_type_incompatible",
            "Relationship mapping fields must have compatible types",
            relationship.id,
          ),
        );
      const mappingKey = `${mapping.sourceFieldId}\u0000${mapping.targetFieldId}`;
      if (mappingKeys.has(mappingKey))
        issues.push(
          issue(
            "relationship.mapping_duplicate",
            "Relationship mapping duplicates an existing field mapping",
            relationship.id,
          ),
        );
      mappingKeys.add(mappingKey);
    }
  }
  for (const rule of design.rules) {
    issues.push(...validateId(rule.id, "rule"));
    issues.push(...validateName(rule.name, rule.id, "rule"));
    for (const value of [rule.trigger, rule.condition, rule.action])
      if (value.length > SANDBOX_LIMITS.textCharacters)
        issues.push(
          issue("rule.text_too_long", "Automation text is too long", rule.id),
        );
    issues.push(
      ...validateRuleConfig(design, rule, normalizeRule(rule, design).config),
    );
  }
  for (const [targetId, box] of Object.entries(design.layout ?? {})) {
    for (const value of [box.x, box.y, box.width, box.height])
      if (
        !Number.isFinite(value) ||
        Math.abs(value) > SANDBOX_LIMITS.layoutCoordinate
      )
        issues.push(
          issue(
            "layout.value_invalid",
            "Layout value is outside the supported range",
            targetId,
          ),
        );
    if (box.width <= 0 || box.height <= 0)
      issues.push(
        issue("layout.size_invalid", "Layout size must be positive", targetId),
      );
  }
  return issues;
}
