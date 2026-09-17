import type {
  AccessDecision,
  AccessRule,
  AccessScopeRef,
  AccessSubjectRef,
  EffectiveAccessResult,
  ResolveEffectiveAccessInput,
} from "../domain/policy";

export type NormalizedLegacyGrant = {
  legacyGrant: string;
  scope: AccessScopeRef;
  permissionId: string;
};

export type AccessAdapter = {
  id: "sandbox" | "boards" | "openview" | "comms";
  scopes: readonly AccessScopeRef[];
  permissions: readonly { id: string; name: string }[];
  supportedSubjectKinds: readonly AccessSubjectRef["kind"][];
  readRules: () => readonly AccessRule[];
  writeDecision: (input: {
    subject: AccessSubjectRef;
    scope: AccessScopeRef;
    permissionId: string;
    decision: AccessDecision;
  }) => readonly AccessRule[];
  resolve: (input: ResolveEffectiveAccessInput) => EffectiveAccessResult;
};

function stableId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function normalizeLegacyGrant(
  grant: string,
): NormalizedLegacyGrant | null {
  const parts = grant.split(" · ");
  if (parts.length !== 2) return null;
  const [category, label] = parts;
  const id = stableId(label);
  if (!id) return null;
  if (category === "Action")
    return {
      legacyGrant: grant,
      scope: { kind: "workspace", id: "workspace" },
      permissionId: `action.${id}`,
    };
  const kinds = {
    Department: "department",
    Module: "module",
    Board: "board",
    Field: "field",
  } as const;
  const kind = kinds[category as keyof typeof kinds];
  if (!kind) return null;
  return {
    legacyGrant: grant,
    scope: { kind, id: `${kind}:${id}` },
    permissionId: kind === "board" ? "boards.view" : "scope.view",
  };
}

export function projectLegacyGrants(
  grants: readonly (NormalizedLegacyGrant | null)[],
): string[] {
  return [
    ...new Set(
      grants
        .filter((grant): grant is NormalizedLegacyGrant => grant !== null)
        .map((grant) => grant.legacyGrant),
    ),
  ];
}
