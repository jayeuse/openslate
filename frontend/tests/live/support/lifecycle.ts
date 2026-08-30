export type LifecycleTargetType = "department" | "module" | "field" | "record";
export type LifecycleOperation = "close" | "purge";

export type LiveLifecycleRow = Readonly<{
  entity_type: string;
  entity_id: string;
  is_deleted: boolean;
  deleted_at: string | null;
  updated_at: string;
  state_fingerprint: string;
}>;

export type LiveLifecycleExternalImpact = Readonly<{
  edge_id: string;
  field_id: string;
  external_record_id: string;
  external_module_id: string;
  external_module_name: string;
  external_department_id: string;
  external_department_name: string;
}>;

export type LiveLifecycleKeyStrip = Readonly<{
  record_id: string;
  module_id: string;
  field_id: string;
  key: string;
}>;

export type LiveLifecycleBlocker = Readonly<{
  code: string;
  entity_type: string;
  entity_id: string;
  detail: string;
}>;

export type LiveLifecycleImpact = Readonly<{
  target_type: LifecycleTargetType;
  target_id: string;
  operation: LifecycleOperation;
  actor_id: string | null;
  rows: readonly LiveLifecycleRow[];
  external_impacts: readonly LiveLifecycleExternalImpact[];
  key_strips: readonly LiveLifecycleKeyStrip[];
  blockers: readonly LiveLifecycleBlocker[];
  impact_digest: string;
}>;

export type LiveLifecyclePreview = Readonly<{
  impact: LiveLifecycleImpact;
  token: string;
  expires_at: string;
  confirmation_name: string;
}>;

export type LiveLifecycleMutation = Readonly<{
  impact: LiveLifecycleImpact;
  operation_id: string | null;
}>;

export type LifecycleRowsByEntity = Readonly<{
  departments: readonly string[];
  modules: readonly string[];
  fields: readonly string[];
  records: readonly string[];
}>;

export type LifecycleImpactExpectation = Readonly<{
  operation: LifecycleOperation;
  targetType: LifecycleTargetType;
  targetId: string;
  actorId: string;
  expectedRows: LifecycleRowsByEntity;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLifecycleRow(value: unknown): value is LiveLifecycleRow {
  return (
    isRecord(value) &&
    typeof value.entity_type === "string" &&
    typeof value.entity_id === "string" &&
    typeof value.is_deleted === "boolean" &&
    (value.deleted_at === null || typeof value.deleted_at === "string") &&
    typeof value.updated_at === "string" &&
    typeof value.state_fingerprint === "string"
  );
}

function isExternalImpact(
  value: unknown,
): value is LiveLifecycleExternalImpact {
  return (
    isRecord(value) &&
    typeof value.edge_id === "string" &&
    typeof value.field_id === "string" &&
    typeof value.external_record_id === "string" &&
    typeof value.external_module_id === "string" &&
    typeof value.external_module_name === "string" &&
    typeof value.external_department_id === "string" &&
    typeof value.external_department_name === "string"
  );
}

function isKeyStrip(value: unknown): value is LiveLifecycleKeyStrip {
  return (
    isRecord(value) &&
    typeof value.record_id === "string" &&
    typeof value.module_id === "string" &&
    typeof value.field_id === "string" &&
    typeof value.key === "string"
  );
}

function isBlocker(value: unknown): value is LiveLifecycleBlocker {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.entity_type === "string" &&
    typeof value.entity_id === "string" &&
    typeof value.detail === "string"
  );
}

export function isLiveLifecycleImpact(
  value: unknown,
): value is LiveLifecycleImpact {
  if (!isRecord(value)) return false;
  return (
    (value.target_type === "department" ||
      value.target_type === "module" ||
      value.target_type === "field" ||
      value.target_type === "record") &&
    typeof value.target_id === "string" &&
    (value.operation === "close" || value.operation === "purge") &&
    (value.actor_id === null || typeof value.actor_id === "string") &&
    Array.isArray(value.rows) &&
    value.rows.every(isLifecycleRow) &&
    Array.isArray(value.external_impacts) &&
    value.external_impacts.every(isExternalImpact) &&
    Array.isArray(value.key_strips) &&
    value.key_strips.every(isKeyStrip) &&
    Array.isArray(value.blockers) &&
    value.blockers.every(isBlocker) &&
    typeof value.impact_digest === "string"
  );
}

export function isLiveLifecyclePreview(
  value: unknown,
): value is LiveLifecyclePreview {
  if (!isRecord(value) || !isLiveLifecycleImpact(value.impact)) return false;
  return (
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.expires_at === "string" &&
    typeof value.confirmation_name === "string" &&
    value.confirmation_name.length > 0
  );
}

export function isLiveLifecycleMutation(
  value: unknown,
): value is LiveLifecycleMutation {
  if (!isRecord(value) || !isLiveLifecycleImpact(value.impact)) return false;
  return value.operation_id === null || typeof value.operation_id === "string";
}

function rowKey(
  row: Pick<LiveLifecycleRow, "entity_type" | "entity_id">,
): string {
  return `${row.entity_type}:${row.entity_id}`;
}

function expectedRowKeys(expected: LifecycleRowsByEntity): Set<string> {
  return new Set([
    ...expected.departments.map((id) => `departments:${id}`),
    ...expected.modules.map((id) => `modules:${id}`),
    ...expected.fields.map((id) => `fields:${id}`),
    ...expected.records.map((id) => `records:${id}`),
  ]);
}

export function assertExactLifecycleRows(
  rows: readonly LiveLifecycleRow[],
  expected: LifecycleRowsByEntity,
  context = "lifecycle",
): void {
  const actual = rows.map(rowKey);
  const expectedKeys = expectedRowKeys(expected);
  const actualKeys = new Set(actual);
  const missing = [...expectedKeys].filter((key) => !actualKeys.has(key));
  const unexpected = [...actualKeys].filter((key) => !expectedKeys.has(key));
  if (
    actualKeys.size !== actual.length ||
    missing.length > 0 ||
    unexpected.length > 0
  ) {
    throw new Error(
      `${context} rows are not an exact match (missing: ${missing.join(",")}; unexpected: ${unexpected.join(",")})`,
    );
  }
}

export function assertExactLifecycleImpact(
  impact: LiveLifecycleImpact,
  expectation: LifecycleImpactExpectation,
): void {
  if (
    impact.operation !== expectation.operation ||
    impact.target_type !== expectation.targetType ||
    impact.target_id !== expectation.targetId ||
    impact.actor_id !== expectation.actorId
  ) {
    throw new Error("Lifecycle impact target, operation, or actor changed");
  }
  if (impact.blockers.length > 0) {
    throw new Error("Lifecycle impact contains blockers");
  }
  if (impact.external_impacts.length > 0) {
    throw new Error("Lifecycle impact contains unexpected external impacts");
  }
  if (impact.key_strips.length > 0) {
    throw new Error("Lifecycle impact contains unexpected key strips");
  }
  assertExactLifecycleRows(
    impact.rows,
    expectation.expectedRows,
    "Exact lifecycle",
  );
}

export function lifecycleConfirmationPayload(
  preview: Pick<LiveLifecyclePreview, "token" | "confirmation_name">,
  password: string,
): Readonly<{ token: string; confirmation_name: string; password: string }> {
  return {
    token: preview.token,
    confirmation_name: preview.confirmation_name,
    password,
  };
}
