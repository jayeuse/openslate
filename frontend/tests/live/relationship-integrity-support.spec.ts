import { expect, test } from "@playwright/test";

import type { LiveRecord, LiveRelationship } from "./support/api";
import {
  auditRelationshipCardinality,
  assertStateUnchanged,
  compareStateBeforeAfter,
  createIntegrityAssertion,
  sanitizeAssertionResult,
  selectSafeTargetRecord,
  validateRelationshipCardinality,
} from "./support/integrity";

const EDGE = (id: string, source: string, target: string): LiveRelationship =>
  ({
    id,
    source_record_id: source,
    target_record_id: target,
    field_id: "field",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
    visibility: "available",
    hidden_reasons: [],
  }) as LiveRelationship;

function record(id: string, moduleId: string, isDeleted = false): LiveRecord {
  return {
    id,
    module_id: moduleId,
    data: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: isDeleted ? "2026-01-02T00:00:00.000Z" : null,
    is_deleted: isDeleted,
    performed_by: null,
  };
}

test.describe("relationship integrity support", () => {
  test("validates each cardinality against active edges and ignores deleted history", () => {
    const one = validateRelationshipCardinality(
      { key: "one", cardinality: "one-to-one" },
      [
        { ...EDGE("deleted", "s", "t"), is_deleted: true },
        EDGE("active", "s", "t"),
      ],
    );
    expect(one).toMatchObject({ activeEdges: 1, representative: true });
    expect(() =>
      auditRelationshipCardinality(
        [
          { key: "one", cardinality: "one-to-one" },
          { key: "many-one", cardinality: "many-to-one" },
          { key: "one-many", cardinality: "one-to-many" },
          { key: "many-many", cardinality: "many-to-many" },
        ],
        new Map([
          ["one", [EDGE("1", "s1", "t1")]],
          ["many-one", [EDGE("2", "s2", "t2"), EDGE("3", "s3", "t2")]],
          ["one-many", [EDGE("4", "s4", "t4"), EDGE("5", "s4", "t5")]],
          ["many-many", [EDGE("6", "s6", "t6"), EDGE("7", "s6", "t7")]],
        ]),
      ),
    ).not.toThrow();
    expect(
      validateRelationshipCardinality(
        { key: "one", cardinality: "one-to-one" },
        [EDGE("1", "s", "t1"), EDGE("2", "s", "t2")],
      ),
    ).toMatchObject({ violations: ["source has more than one active target"] });
  });

  test("compares complete before and after state without depending on order", () => {
    const before = [EDGE("2", "s2", "t2"), EDGE("1", "s1", "t1")];
    const after = [EDGE("1", "s1", "t1"), EDGE("2", "s2", "t2")];
    expect(compareStateBeforeAfter(before, after).unchanged).toBe(true);
    expect(() =>
      assertStateUnchanged(before, after, "Rejected link"),
    ).not.toThrow();
    expect(() =>
      assertStateUnchanged(
        before,
        [{ ...before[0], target_record_id: "other" }],
        "Rejected link",
      ),
    ).toThrow(/Rejected link/);
  });

  test("creates sanitized assertion results and selects only safe active targets", () => {
    const records = [
      record("archived", "target", true),
      record("source", "source"),
      record("current", "target"),
      record("occupied", "target"),
      record("safe", "target"),
    ];
    expect(
      selectSafeTargetRecord(records, {
        targetModuleId: "target",
        sourceRecordId: "source",
        currentTargetId: "current",
        excludeRecordIds: ["occupied"],
      })?.id,
    ).toBe("safe");
    expect(
      selectSafeTargetRecord(records, {
        targetModuleId: "target",
        excludeRecordIds: ["safe"],
      })?.id,
    ).toBe("current");
    const assertion = createIntegrityAssertion(
      "check",
      "Check",
      "Fail",
      "password=hidden and __VG_BEARER_TOKEN_4378650e74bd__",
    );
    expect(sanitizeAssertionResult(assertion)).toEqual({
      id: "check",
      name: "Check",
      status: "Fail",
      detail: "password=[REDACTED] and [REDACTED]",
    });
  });
});
