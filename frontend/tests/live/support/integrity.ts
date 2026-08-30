import type { LiveRecord, LiveRelationship } from "./api";
import type {
  RelationshipCardinality,
  RelationshipDefinition,
} from "./catalog";
import {
  LIVE_ASSERTION_STATUSES,
  type LiveAssertionResult,
  type LiveAssertionStatus,
} from "./manifest";
import { sanitizeEvidence } from "./sanitize";

export type CardinalityEdge = Pick<
  LiveRelationship,
  "id" | "source_record_id" | "target_record_id" | "is_deleted"
>;

export type CardinalityFieldSummary = Readonly<{
  key: string;
  cardinality: RelationshipCardinality;
  activeEdges: number;
  sourceCount: number;
  targetCount: number;
  representative: boolean;
  violations: readonly string[];
}>;

export type CardinalitySummary = Readonly<{
  fields: readonly CardinalityFieldSummary[];
  byCardinality: Readonly<
    Record<
      RelationshipCardinality,
      Readonly<{
        fields: number;
        activeEdges: number;
        representativeFields: number;
      }>
    >
  >;
}>;

const CARDINALITIES: readonly RelationshipCardinality[] = [
  "one-to-one",
  "many-to-one",
  "one-to-many",
  "many-to-many",
];

const BEARER_SENTINEL = /__VG_BEARER_TOKEN_[A-Za-z0-9]+__/g;

function sanitizedAssertionDetail(detail: string): string {
  return String(sanitizeEvidence(detail)).replace(
    BEARER_SENTINEL,
    "[REDACTED]",
  );
}

function activeEdges(
  edges: readonly CardinalityEdge[],
): readonly CardinalityEdge[] {
  return edges.filter((edge) => !edge.is_deleted);
}

function duplicateIds(values: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

export function validateRelationshipCardinality(
  definition: Pick<RelationshipDefinition, "key" | "cardinality">,
  edges: readonly CardinalityEdge[],
): CardinalityFieldSummary {
  const current = activeEdges(edges);
  const sources = new Set(current.map((edge) => edge.source_record_id));
  const targets = new Set(current.map((edge) => edge.target_record_id));
  const violations: string[] = [];

  if (
    definition.cardinality === "one-to-one" ||
    definition.cardinality === "many-to-one"
  ) {
    const duplicates = duplicateIds(
      current.map((edge) => edge.source_record_id),
    );
    if (duplicates.length > 0) {
      violations.push("source has more than one active target");
    }
  }
  if (
    definition.cardinality === "one-to-one" ||
    definition.cardinality === "one-to-many"
  ) {
    const duplicates = duplicateIds(
      current.map((edge) => edge.target_record_id),
    );
    if (duplicates.length > 0) {
      violations.push("target has more than one active source");
    }
  }

  return {
    key: definition.key,
    cardinality: definition.cardinality,
    activeEdges: current.length,
    sourceCount: sources.size,
    targetCount: targets.size,
    representative: current.length > 0,
    violations,
  };
}

export function auditRelationshipCardinality(
  definitions: readonly Pick<RelationshipDefinition, "key" | "cardinality">[],
  edgesByKey: ReadonlyMap<string, readonly CardinalityEdge[]>,
): CardinalitySummary {
  const fields = definitions.map((definition) =>
    validateRelationshipCardinality(
      definition,
      edgesByKey.get(definition.key) ?? [],
    ),
  );
  const byCardinality = Object.fromEntries(
    CARDINALITIES.map((cardinality) => {
      const matching = fields.filter(
        (field) => field.cardinality === cardinality,
      );
      return [
        cardinality,
        {
          fields: matching.length,
          activeEdges: matching.reduce(
            (total, field) => total + field.activeEdges,
            0,
          ),
          representativeFields: matching.filter((field) => field.representative)
            .length,
        },
      ];
    }),
  ) as Record<
    RelationshipCardinality,
    Readonly<{
      fields: number;
      activeEdges: number;
      representativeFields: number;
    }>
  >;
  const invalid = fields.filter((field) => field.violations.length > 0);
  if (invalid.length > 0) {
    throw new Error(
      `Relationship cardinality violations: ${invalid
        .map((field) => `${field.key} (${field.violations.join(", ")})`)
        .join("; ")}`,
    );
  }
  const missingRepresentatives = fields.filter(
    (field) => !field.representative,
  );
  if (missingRepresentatives.length > 0) {
    throw new Error(
      `Relationship cardinality representatives are missing: ${missingRepresentatives
        .map((field) => field.key)
        .join(", ")}`,
    );
  }
  const missingCategories = CARDINALITIES.filter(
    (cardinality) => byCardinality[cardinality].representativeFields === 0,
  );
  if (missingCategories.length > 0) {
    throw new Error(
      `Relationship cardinality categories lack representatives: ${missingCategories.join(", ")}`,
    );
  }
  return { fields, byCardinality };
}

export const validateCardinality = validateRelationshipCardinality;
export const auditCardinalities = auditRelationshipCardinality;

export type StateEntity = Readonly<{ id: string }>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function stateValue<Item extends StateEntity>(items: readonly Item[]): string {
  return JSON.stringify(
    [...items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => stableValue(item)),
  );
}

export type StateComparison = Readonly<{
  unchanged: boolean;
  before: string;
  after: string;
}>;

export function compareStateBeforeAfter<Item extends StateEntity>(
  before: readonly Item[],
  after: readonly Item[],
): StateComparison {
  const beforeValue = stateValue(before);
  const afterValue = stateValue(after);
  return {
    unchanged: beforeValue === afterValue,
    before: beforeValue,
    after: afterValue,
  };
}

export function assertStateUnchanged<Item extends StateEntity>(
  before: readonly Item[],
  after: readonly Item[],
  context = "State",
): void {
  const comparison = compareStateBeforeAfter(before, after);
  if (!comparison.unchanged) {
    throw new Error(`${context} changed after a rejected mutation`);
  }
}

export type SafeTargetOptions = Readonly<{
  targetModuleId?: string;
  sourceRecordId?: string;
  currentTargetId?: string;
  excludeRecordIds?: readonly string[];
}>;

export function selectSafeTargetRecord(
  records: readonly LiveRecord[],
  options: SafeTargetOptions = {},
): LiveRecord | undefined {
  const excluded = new Set(options.excludeRecordIds ?? []);
  return records.find(
    (record) =>
      !record.is_deleted &&
      (!options.targetModuleId ||
        record.module_id === options.targetModuleId) &&
      record.id !== options.sourceRecordId &&
      record.id !== options.currentTargetId &&
      !excluded.has(record.id),
  );
}

export function createIntegrityAssertion(
  id: string,
  name: string,
  status: LiveAssertionStatus,
  detail: string,
): LiveAssertionResult {
  if (!id || !name)
    throw new Error("Integrity assertions require an ID and name");
  if (!(LIVE_ASSERTION_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Unsupported integrity assertion status: ${status}`);
  }
  return {
    id,
    name,
    status,
    detail: sanitizedAssertionDetail(detail),
  };
}

export function sanitizeAssertionResult(
  assertion: LiveAssertionResult,
): LiveAssertionResult {
  return createIntegrityAssertion(
    assertion.id,
    assertion.name,
    assertion.status,
    assertion.detail ?? "",
  );
}
