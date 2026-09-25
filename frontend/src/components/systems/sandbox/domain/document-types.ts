import type { FieldConfig, FieldTypeName } from "./model";

export const SANDBOX_DOCUMENT_LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  departments: 100,
  modules: 500,
  fields: 5_000,
  relationships: 1_000,
  automations: 500,
  scenarios: 500,
  recordsPerScenario: 5_000,
  fieldMappings: 1_000,
  conditionsPerAutomation: 20,
  actionsPerAutomation: 20,
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
export type SandboxAutomationTrigger =
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
export type SandboxAutomationCondition = {
  id: string;
  field: SandboxFieldReference;
  operator: SandboxComparisonOperator;
  value: SandboxValueSource;
};
export type SandboxAutomationAction =
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
export type SandboxAutomation = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  trigger: SandboxAutomationTrigger;
  conditionGroup: {
    operator: "all" | "any";
    conditions: SandboxAutomationCondition[];
  };
  actions: SandboxAutomationAction[];
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
  document: Omit<SandboxDocumentV2, "kind" | "schemaVersion" | "versions">;
  published: boolean;
  date: string;
  note?: string;
};
export type SandboxDocumentV2 = {
  kind: "openslate-sandbox";
  schemaVersion: 2;
  design: SandboxDocumentDesign;
  automations: SandboxAutomation[];
  scenarios: SandboxScenarioTemplate[];
  versions?: SandboxVersionSnapshot[];
};
export type SandboxDocumentParseResult =
  { ok: true; document: SandboxDocumentV2 } | { ok: false; error: string };
