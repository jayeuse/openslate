import type { FieldConfig, FieldTypeName } from "./model";

/** The Sandbox document format version that this client reads and writes. */
export const SANDBOX_DOCUMENT_SCHEMA_VERSION = 4;
/** Shown when a file or saved design uses a format before version 4. */
export const SANDBOX_OLDER_FORMAT_MESSAGE =
  "This design uses an older format and cannot be opened.";

export const SANDBOX_DOCUMENT_LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  departments: 100,
  modules: 500,
  fields: 5_000,
  relationships: 1_000,
  triggers: 500,
  scenarios: 500,
  recordsPerScenario: 5_000,
  fieldMappings: 1_000,
  conditionsPerTrigger: 20,
  actionsPerTrigger: 20,
  versions: 50,
  nameCharacters: 80,
  textCharacters: 1_000,
  selectOptions: 100,
  selectOptionCharacters: 100,
  layoutCoordinate: 100_000,
} as const;

export type SandboxFieldValue = string | number | boolean | null;
export type SandboxLayoutBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type SandboxDocumentField = {
  id: string;
  name: string;
  type: FieldTypeName;
  required: boolean;
  closed: boolean;
  description?: string;
  config: FieldConfig;
};
export type SandboxDocumentDepartment = {
  id: string;
  name: string;
  closed: boolean;
};
export type SandboxDocumentModule = {
  id: string;
  departmentId: string;
  name: string;
  closed: boolean;
  titleFieldId: string | null;
  fields: SandboxDocumentField[];
};
export type SandboxFieldMapping = {
  sourceFieldId: string;
  targetFieldId: string;
};
export type SandboxRelationship = {
  id: string;
  name: string;
  sourceModuleId: string;
  targetModuleId: string;
  cardinality: "one-to-one" | "one-to-many" | "many-to-many";
  fieldMappings: SandboxFieldMapping[];
};
export type SandboxFieldReference = {
  moduleId: string;
  fieldId: string;
  relationshipId?: string;
};
export type SandboxValueSource =
  | { kind: "literal"; value: SandboxFieldValue }
  | ({ kind: "field-reference" } & SandboxFieldReference);
export type SandboxTriggerEvent =
  | { kind: "record-created"; moduleId: string }
  | { kind: "field-changed"; moduleId: string; fieldId: string }
  | {
      kind: "threshold-crossed";
      moduleId: string;
      fieldId: string;
      operator: SandboxComparisonOperator;
      value: SandboxValueSource;
    }
  | {
      kind: "schedule";
      /** Absent only in imported legacy documents. New authoring always sets it. */
      moduleId?: string;
      frequency: "daily" | "weekly";
      time: string;
      weekday?: number;
    };
export type SandboxComparisonOperator = ">" | ">=" | "<" | "<=" | "=" | "!=";
export type SandboxTriggerCondition = {
  id: string;
  field: SandboxFieldReference;
  operator: SandboxComparisonOperator;
  value: SandboxValueSource;
};
export type SandboxTriggerAction =
  | { id: string; kind: "notification"; message: string }
  | { id: string; kind: "channel-message"; channel: string }
  | { id: string; kind: "assign-task"; assignee: string }
  | {
      id: string;
      kind: "set-field";
      target: SandboxFieldReference;
      value: SandboxValueSource;
    }
  | {
      id: string;
      kind: "create-record";
      moduleId: string;
      values: Array<{ fieldId: string; value: SandboxValueSource }>;
    };
export type SandboxTrigger = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  trigger: SandboxTriggerEvent;
  conditionGroup: {
    operator: "all" | "any";
    conditions: SandboxTriggerCondition[];
  };
  actions: SandboxTriggerAction[];
};
export type SandboxSyntheticRecord = {
  id: string;
  moduleId: string;
  values: Record<string, SandboxFieldValue>;
};
export type SandboxScenarioLink = {
  relationshipId: string;
  sourceRecordId: string;
  targetRecordId: string;
};
export type SandboxScenarioTemplate = {
  id: string;
  name: string;
  records: SandboxSyntheticRecord[];
  links: SandboxScenarioLink[];
};
export type SandboxDocumentDesign = {
  departments: SandboxDocumentDepartment[];
  modules: SandboxDocumentModule[];
  relationships: SandboxRelationship[];
  layout: Record<string, SandboxLayoutBox>;
};
export type SandboxVersionSnapshot = {
  id: string;
  label: string;
  kind: "checkpoint" | "published" | "imported";
  document: Omit<SandboxDocumentV4, "kind" | "schemaVersion" | "versions">;
  published: boolean;
  date: string;
  note?: string;
};
export type SandboxDocumentV4 = {
  kind: "openslate-sandbox";
  schemaVersion: typeof SANDBOX_DOCUMENT_SCHEMA_VERSION;
  design: SandboxDocumentDesign;
  triggers: SandboxTrigger[];
  scenarios: SandboxScenarioTemplate[];
  versions?: SandboxVersionSnapshot[];
};
export type SandboxDocumentParseResult =
  { ok: true; document: SandboxDocumentV4 } | { ok: false; error: string };
