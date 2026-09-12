import { expect, test } from "@playwright/test";
import {
  createPolicyBundle,
  parsePolicyBundle,
  planPolicyImport,
  type AccessPolicyBundleV1,
} from "../../../src/components/sample/access/policy-bundle";
import {
  initialAccessDefaults,
  initialAccessGroups,
  initialAccessRules,
  initialAccessTemplates,
} from "../../../src/components/sample/access/policy";
import { initialRoles } from "../../../src/components/sample/access/model";

function bundle(): AccessPolicyBundleV1 {
  return createPolicyBundle({
    defaults: initialAccessDefaults,
    groups: initialAccessGroups,
    roles: initialRoles,
    rules: initialAccessRules,
    templates: initialAccessTemplates,
  });
}

test("policy export contains configuration but excludes identities and sensitive material", () => {
  const value = bundle();
  const json = JSON.stringify(value);

  expect(value.version).toBe(1);
  expect(Object.keys(value).sort()).toEqual([
    "defaults",
    "groups",
    "roles",
    "rules",
    "templates",
    "version",
  ]);
  expect(json).not.toMatch(
    /email|session|credential|token|secret|password|sponsorId|ownerId|memberIds/i,
  );
  expect(value.rules.every((rule) => rule.subject.kind !== "identity")).toBe(
    true,
  );
  expect(value.roles.every((role) => !("builtin" in role))).toBe(true);

  const described = createPolicyBundle({
    defaults: initialAccessDefaults,
    groups: initialAccessGroups,
    roles: [
      ...initialRoles,
      {
        id: "role:described",
        name: "Described",
        description: "Persist this policy purpose.",
        builtin: false,
        grants: [],
      },
    ],
    rules: initialAccessRules,
    templates: initialAccessTemplates,
  });
  expect(described.roles[0].description).toBe("Persist this policy purpose.");
});

test("strict parsing accepts a valid bundle and rejects unknown or sensitive fields", () => {
  expect(parsePolicyBundle(JSON.stringify(bundle()))).toEqual({
    ok: true,
    value: bundle(),
  });

  const withIdentity = {
    ...bundle(),
    identities: [{ id: "person:eli", email: "eli@example.invalid" }],
  };
  expect(parsePolicyBundle(JSON.stringify(withIdentity))).toMatchObject({
    ok: false,
  });

  const identityRule = bundle();
  identityRule.rules.push({
    id: "identity-rule",
    subject: { kind: "identity", id: "person:eli" },
    scope: { kind: "workspace", id: "workspace" },
    permissionId: "records.read",
    decision: "allow",
  });
  expect(parsePolicyBundle(JSON.stringify(identityRule))).toMatchObject({
    ok: false,
  });

  expect(parsePolicyBundle("{".padEnd(1_048_577, " "))).toEqual({
    ok: false,
    error: "Policy bundle exceeds the 1 MiB limit.",
  });
});

test("parsing rejects malformed cross-field policy configuration", () => {
  const malformed = bundle();
  malformed.defaults.guestDurationDays = 0;
  expect(parsePolicyBundle(JSON.stringify(malformed))).toMatchObject({
    ok: false,
  });

  const unknownDecision = structuredClone(bundle()) as unknown as {
    rules: { decision: string }[];
  };
  unknownDecision.rules[0].decision = "sometimes";
  expect(parsePolicyBundle(JSON.stringify(unknownDecision))).toMatchObject({
    ok: false,
  });
});

test("merge and replace plans are deterministic and preserve protected built-ins", () => {
  const current = bundle();
  current.roles = [
    { id: "role:current", name: "Current", description: "", grants: [] },
  ];
  const incoming = bundle();
  incoming.roles = [
    { id: "role:new", name: "New", description: "", grants: [] },
  ];

  const merged = planPolicyImport(current, incoming, "merge", initialRoles);
  expect(merged.bundle.roles.map((role) => role.id)).toEqual([
    "role:current",
    "role:new",
  ]);
  expect(merged.summary).toContain("Merge");

  const replaced = planPolicyImport(current, incoming, "replace", initialRoles);
  expect(replaced.bundle.roles.map((role) => role.id)).toEqual(["role:new"]);
  expect(replaced.protectedRoles.map((role) => role.id)).toEqual([
    "sample-admin",
    "sample-member",
  ]);
  expect(replaced.summary).toContain("Replace");
});
