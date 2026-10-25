import type { AccessNavigation } from "@/components/workspace-navigation";
import type { UserPreferences } from "@/lib/user-theme-preferences";

export type StartPage = UserPreferences["appearance"]["start_page"];

export type StartPageOption = {
  value: StartPage;
  label: string;
  disabled: boolean;
};

const startPages: readonly [StartPage, string][] = [
  ["automatic", "Automatic"],
  ["sandbox", "Sandbox"],
  ["boards", "Boards"],
  ["comms", "OpenComms"],
  ["access", "Access"],
  ["openview", "OpenView"],
  ["manage", "Manage"],
  ["platform", "Platform"],
];

/** Whether the sidebar shows this section to the person (`getWorkspaceNavigation`). */
function opens(page: StartPage, access: AccessNavigation): boolean {
  if (page === "sandbox") return access === "all";
  if (page === "access") return access !== "none";
  return true;
}

/**
 * The Start page choices (PD62): the sections the sidebar shows this
 * person. A saved section the person can no longer open stays in its place,
 * marked "(not available)" and not choosable, so the saved value is never
 * lost or replaced in silence.
 */
export function startPageOptions(
  access: AccessNavigation,
  saved: StartPage | undefined,
): StartPageOption[] {
  return startPages.flatMap(([value, label]): StartPageOption[] =>
    opens(value, access)
      ? [{ value, label, disabled: false }]
      : value === saved
        ? [{ value, label: `${label} (not available)`, disabled: true }]
        : [],
  );
}
