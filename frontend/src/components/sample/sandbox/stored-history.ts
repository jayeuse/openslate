import { z } from "zod";
import type {
  Department,
  Design,
  Field,
  FieldConfig,
  Module,
  Relationship,
  Rule,
  RuleAction,
  RuleCondition,
  RuleConfig,
  RuleTrigger,
  Version,
} from "./model";
import type { SandboxCommand } from "./controller";
import { SANDBOX_LIMITS } from "./validation";

const MAX_TEXT = 1_000;
const text = z.string().max(MAX_TEXT);
const optionText = z.string().max(MAX_TEXT);
const legacyOptions = z.string().max(12_000);
const coordinate = z.number().finite().min(-100_000).max(100_000);
const size = z.number().finite().positive().max(100_000);

const fieldConfigSchema: z.ZodType<FieldConfig> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["text", "long-text", "email", "url"]),
    defaultValue: text,
    maxLength: z.number().finite().optional(),
  }),
  z.strictObject({
    kind: z.enum(["number", "integer"]),
    defaultValue: z.number().finite().nullable(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().optional(),
  }),
  z.strictObject({
    kind: z.enum(["date", "datetime"]),
    defaultValue: text.nullable(),
    earliest: text.optional(),
    latest: text.optional(),
  }),
  z.strictObject({ kind: z.literal("checkbox"), defaultValue: z.boolean() }),
  z.strictObject({
    kind: z.literal("select"),
    defaultValue: optionText.nullable(),
    options: z.array(optionText).max(100),
  }),
]);

const fieldSchema = z.strictObject({
  id: text,
  name: text,
  type: text,
  required: z.boolean(),
  value: text,
  options: legacyOptions,
  closed: z.boolean(),
  description: text.optional(),
  config: fieldConfigSchema.optional(),
}) satisfies z.ZodType<Field>;

const departmentSchema = z.strictObject({
  id: text,
  name: text,
  closed: z.boolean(),
}) satisfies z.ZodType<Department>;

const moduleSchema = z.strictObject({
  id: text,
  department: text,
  name: text,
  closed: z.boolean(),
  fields: z.array(fieldSchema).max(5_000),
  x: coordinate,
  y: coordinate,
}) satisfies z.ZodType<Module>;

const relationshipSchema = z.strictObject({
  id: text,
  name: text,
  source: text,
  target: text,
  cardinality: text,
}) satisfies z.ZodType<Relationship>;

const operator = z.enum([">", ">=", "<", "<=", "=", "!="]);
const triggerSchema: z.ZodType<RuleTrigger> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("new-record"), moduleId: text }),
  z.strictObject({
    kind: z.literal("field-change"),
    moduleId: text,
    fieldId: text,
  }),
  z.strictObject({
    kind: z.literal("threshold"),
    moduleId: text,
    fieldId: text,
    operator,
    value: text,
  }),
  z.strictObject({
    kind: z.literal("schedule"),
    frequency: z.enum(["daily", "weekly"]),
    time: text,
    weekday: z.number().finite().optional(),
  }),
]);

const conditionSchema: z.ZodType<RuleCondition> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("always") }),
  z.strictObject({
    kind: z.literal("field-comparison"),
    moduleId: text,
    fieldId: text,
    operator,
    value: text,
  }),
]);

const actionSchema: z.ZodType<RuleAction> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("notification"), message: text }),
  z.strictObject({ kind: z.literal("channel-message"), channel: text }),
  z.strictObject({
    kind: z.literal("create-record"),
    moduleId: text,
    fieldId: text,
    value: text,
  }),
  z.strictObject({
    kind: z.literal("update-field"),
    moduleId: text,
    fieldId: text,
    value: text,
  }),
  z.strictObject({ kind: z.literal("assign-task"), assignee: text }),
]);

const ruleConfigSchema: z.ZodType<RuleConfig> = z.strictObject({
  trigger: triggerSchema,
  condition: conditionSchema,
  action: actionSchema,
});

const ruleSchema = z.strictObject({
  id: text,
  name: text,
  trigger: text,
  condition: text,
  action: text,
  enabled: z.boolean(),
  config: ruleConfigSchema.optional(),
}) satisfies z.ZodType<Rule>;

const layoutBox = z.strictObject({
  x: coordinate,
  y: coordinate,
  width: size,
  height: size,
});
const layoutSchema = z
  .record(z.string().max(MAX_TEXT), layoutBox)
  .refine((layout) => Object.keys(layout).length <= 1_000);

const designSchema: z.ZodType<Design> = z
  .strictObject({
    layout: layoutSchema.optional(),
    departments: z.array(departmentSchema).max(100),
    modules: z.array(moduleSchema).max(500),
    relationships: z.array(relationshipSchema).max(1_000),
    rules: z.array(ruleSchema).max(500),
  })
  .superRefine((design, context) => {
    if (
      design.modules.reduce(
        (count, sandboxModule) => count + sandboxModule.fields.length,
        0,
      ) > 5_000
    )
      context.addIssue({
        code: "custom",
        message: "Sandbox field limit exceeded",
      });
  });

const modulePatch = z
  .strictObject({ name: text, department: text, closed: z.boolean() })
  .partial();
const fieldPatch = fieldSchema.omit({ id: true }).partial();
const relationshipPatch = relationshipSchema.omit({ id: true }).partial();
const rulePatch = ruleSchema.omit({ id: true }).partial();

const commandSchema: z.ZodType<SandboxCommand> = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("rename-department"),
    departmentId: text,
    name: text,
  }),
  z.strictObject({
    type: z.literal("update-module"),
    moduleId: text,
    patch: modulePatch,
  }),
  z.strictObject({
    type: z.literal("update-field"),
    moduleId: text,
    fieldId: text,
    patch: fieldPatch,
  }),
  z.strictObject({
    type: z.literal("update-relationship"),
    relationshipId: text,
    patch: relationshipPatch,
  }),
  z.strictObject({
    type: z.literal("update-rule"),
    ruleId: text,
    patch: rulePatch,
  }),
  z.strictObject({ type: z.literal("set-layout"), layout: layoutSchema }),
  z.strictObject({ type: z.literal("replace-design"), design: designSchema }),
]);

const entrySchema = z.strictObject({
  command: commandSchema,
  before: designSchema,
  after: designSchema,
});
const legacyHistorySchema = z.strictObject({
  past: z.array(designSchema).max(50),
  present: designSchema,
  future: z.array(designSchema).max(50),
});
const currentHistorySchema = z.strictObject({
  past: z.array(entrySchema).max(50),
  present: designSchema,
  future: z.array(entrySchema).max(50),
});

type DecodedEntry = { before: Design; after: Design };
export type DecodedSandboxHistory = {
  past: DecodedEntry[];
  present: Design;
  future: DecodedEntry[];
};

const versionSchema = z.strictObject({
  id: text.refine((value) => value.trim().length > 0),
  label: z
    .string()
    .max(SANDBOX_LIMITS.nameCharacters)
    .refine((value) => value.trim().length > 0),
  design: designSchema,
  published: z.boolean(),
  date: text,
  note: z.string().max(500).optional(),
}) satisfies z.ZodType<Version>;

const versionsSchema = z
  .array(versionSchema)
  .max(SANDBOX_LIMITS.versions)
  .superRefine((versions, context) => {
    const ids = new Set<string>();
    for (const [index, version] of versions.entries()) {
      if (ids.has(version.id)) {
        context.addIssue({
          code: "custom",
          message: "Version IDs must be unique",
          path: [index, "id"],
        });
      }
      ids.add(version.id);
    }
  });

export function decodeStoredSandboxVersions(value: unknown): Version[] | null {
  const result = versionsSchema.safeParse(value);
  return result.success ? result.data : null;
}

function isCurrentEntry(
  item: Design | z.infer<typeof entrySchema>,
): item is z.infer<typeof entrySchema> {
  return "before" in item;
}

export function decodeStoredSandboxHistory(
  value: unknown,
): DecodedSandboxHistory | null {
  const result = z
    .union([legacyHistorySchema, currentHistorySchema])
    .safeParse(value);
  if (!result.success) return null;
  const stored = result.data;
  const past: DecodedEntry[] = [];
  stored.past.forEach((item, index) => {
    if (isCurrentEntry(item)) {
      past.push({ before: item.before, after: item.after });
      return;
    }
    const next = stored.past[index + 1];
    let after = stored.present;
    if (next && !isCurrentEntry(next)) after = next;
    past.push({ before: item, after });
  });
  let previous = stored.present;
  const future = stored.future.map((item) => {
    if (isCurrentEntry(item)) {
      previous = item.after;
      return { before: item.before, after: item.after };
    }
    const entry = { before: previous, after: item };
    previous = item;
    return entry;
  });
  return { past, present: stored.present, future };
}
