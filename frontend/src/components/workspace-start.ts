import { listOpenViewDataSources } from "@/components/systems/openview/adapters/views-api";
import { listSandboxTests } from "@/components/systems/sandbox/state/api";
import { getAuthMe } from "@/lib/auth-api";
import { readUserPreferences } from "@/lib/user-theme-preferences";
import { accessNavigationFor } from "./workspace-navigation";

const preferredRoutes = {
  sandbox: "/sandbox",
  boards: "/boards",
  comms: "/comms",
  access: "/access",
  openview: "/openview",
  manage: "/manage",
  platform: "/platform",
} as const;
type StartRoute =
  | (typeof preferredRoutes)[keyof typeof preferredRoutes]
  | "/access?view=groups";

/**
 * Where a signed-in person starts. A workspace with nothing published has
 * nothing to show in OpenView yet, so a person who can open the Sandbox
 * starts there, where the organization gets designed. Everyone else, and any
 * failed check, goes to OpenView, which explains its own state.
 */
export async function workspaceStartRoute(): Promise<StartRoute> {
  try {
    const identity = await getAuthMe();
    const preference = await readUserPreferences(identity.id);
    // The request can settle after a different person signs in. Admission and
    // ownership use a fresh identity, not the identity captured at its start.
    const current = await getAuthMe();
    if (current.id === identity.id) {
      const selected = preference.appearance.start_page;
      if (selected === "sandbox") {
        await listSandboxTests({ limit: 1 });
        if ((await getAuthMe()).id === current.id) return "/sandbox";
      } else if (selected === "access") {
        const access = accessNavigationFor(current);
        if (access === "all") return "/access";
        if (access === "groups") return "/access?view=groups";
      } else if (selected !== "automatic") return preferredRoutes[selected];
    }
  } catch {
    // Failed/refused preferences do not become confirmed defaults or writes.
    // Preserve the established Automatic fallback below.
  }
  try {
    const sources = await listOpenViewDataSources({ limit: 1 });
    if (sources.items.length > 0) return "/openview";
    // A one-item Test list needs the same read access as the Sandbox
    // document, without downloading the document before the page loads it.
    await listSandboxTests({ limit: 1 });
    return "/sandbox";
  } catch {
    return "/openview";
  }
}
