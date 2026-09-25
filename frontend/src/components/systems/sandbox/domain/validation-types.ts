export type SandboxValidationIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  targetId?: string;
  moduleId?: string;
};

export const SANDBOX_LIMITS = {
  fileBytes: 2 * 1024 * 1024,
  departments: 100,
  modules: 500,
  fields: 5_000,
  relationships: 1_000,
  relationshipMappings: 1_000,
  rules: 500,
  versions: 50,
  nameCharacters: 80,
  textCharacters: 1_000,
  selectOptions: 100,
  selectOptionCharacters: 100,
  layoutCoordinate: 100_000,
} as const;

export function issue(
  code: string,
  message: string,
  targetId?: string,
): SandboxValidationIssue {
  return { code, severity: "error", message, targetId };
}

export function warning(
  code: string,
  message: string,
  targetId?: string,
): SandboxValidationIssue {
  return { code, severity: "warning", message, targetId };
}
